import type { IssueComment, PrFields, SubIssueInfo } from '../../types'
import { filterRecords, parseJson, toStringOrEmpty } from './json'
import { isNonEmptyString, isRecord } from './guards'
import { parseClosingIssues } from './closing-keywords'
import { isPrFields, isActiveRule, isCheckRun, isClosingPullRequest, isComparison, isCompleteConnection, isCrossReference, isPullRequestCandidate, isReferencingPullRequest, isRequiredCheckRule, isRuleset, isStatus } from './github-rows'
import type { PullRequestRow } from './github-rows'
import { hasExitedZero, runProcess } from './process'
import type { ProcessPort } from './process'
import { fail, succeed } from './result'
import type { Result } from './result'

/** Whether gh reaches GitHub: logged in and answering, not logged in, or not answering. */
type GithubAccess = 'connected' | 'unauth' | 'unreachable'
/** Holds GitHub reachability and the reason it is unavailable. */
export type GithubProbe = GithubConnected | GithubUnavailable
interface GithubConnected { status: 'connected'; error: null }
interface GithubUnavailable { status: Exclude<GithubAccess, 'connected'>; error: string }

/** An issue as GitHub reports it: its state, title and label names. */
export interface IssueSnapshot { state: string; title: string; labels: string[] }

/** A same-repository PR from a unit's head branch, into the base it names, with the issues it closes there. */
export interface PullRequestCandidate { number: number; state: string; url: string; headRefOid: string; baseRefName: string; closingIssuesReferences: number[] }

/** An immutable comparison of two GitHub commits. */
export interface Comparison { status: string; aheadBy: number }

type CommitCheckState = 'passing' | 'failing' | 'pending'

/** A named check or status reduced to the state the unit judges. */
export interface CommitCheck { name: string; state: CommitCheckState }

/** The default branch's required contexts and an unavailable-rules response retained for status. */
export interface RequiredChecks { contexts: string[]; error?: string }
/** Holds an active branch ruleset and the current user's bypass permission. */
export interface BranchRuleset { id: number; types: string[]; bypass: string | null }

/** An issue's closing PR that can host a Follow-up. */
export interface ClosingPullRequest { number: number; state: string; headRefName: string }

interface GraphqlFailures { fallback?: string; unreadable?: string; errors?: string }
/** The repository a GraphQL read answered for, with GitHub's default branch when it has one. */
interface RepositoryIdentity { nameWithOwner: string; defaultBranch: string | null }

/** How long the reachability probe may take: it runs on every refresh that has no cached answer. */
const probeTimeoutMs = 8000

/**
 * Reads one REST endpoint with its response head and selected failure policy.
 * @param processes - The process runner.
 * @param endpoint - The REST path.
 * @param decode - The successful body decoder.
 * @param isOptional - Whether HTTP 404 means absence and other failures retain the first stderr line.
 * @returns The decoded body, null for an optional HTTP 404, or the selected HTTP-status or stderr failure.
 */
async function readRest<T>(processes: ProcessPort, endpoint: string, decode: (body: unknown) => Result<T>, isOptional = false): Promise<Result<T | null>> {
  const run = await runProcess(processes, ['gh', 'api', '--include', endpoint])
  if (!run.isOk) return run
  const { stdout, stderr, exitCode } = run.value
  const split = /\r?\n\r?\n/.exec(stdout)
  const status = /^HTTP\/\S+ (\d{3})\b/.exec(stdout)?.[1]
  const body = split ? stdout.slice(split.index + split[0].length) : ''
  const data = parseJson(body)
  if (exitCode === 0) return data.isOk ? decode(data.value) : fail('unreadable gh output')
  if (isOptional) return status === '404' ? succeed(null) : fail(stderr.trim().split('\n')[0] || 'exited non-zero')
  if (!status) return fail(stderr.trim() || 'exited non-zero')
  return fail(`HTTP ${status} · ${data.isOk && isRecord(data.value) && typeof data.value.message === 'string' ? data.value.message : body.trim()}`)
}

/**
 * Rejects branch-rule responses that cannot support required-check discovery.
 * @param processes - The engine's process runner.
 * @param base - The target branch name.
 * @returns The branch-rule records, or a process or response failure.
 */
async function readBranchRules(processes: ProcessPort, base: string): Promise<Result<Record<string, unknown>[]>> {
  const data = await readRest(processes, `repos/{owner}/{repo}/rules/branches/${encodeURIComponent(base)}`, succeed)
  if (!data.isOk) return data
  return Array.isArray(data.value) && data.value.every(isRecord) ? succeed(filterRecords(data.value)) : fail('unreadable gh output')
}

/**
 * Asks GitHub who is logged in, to tell whether gh can reach it.
 *
 * @param processes - The engine's process runner.
 * @returns Connected, unauth when gh asks for a login, or unreachable on any other failure.
 */
export async function probeGithub(processes: ProcessPort): Promise<GithubProbe> {
  const run = await runProcess(processes, ['gh', 'api', 'user', '--jq', '.login'], probeTimeoutMs)
  if (run.isOk && run.value.exitCode === 0) return { status: 'connected', error: null }
  const error = run.isOk ? run.value.stderr.trim() : run.error
  return { status: run.isOk && /auth login|not logged|authenticat/i.test(run.value.stderr) ? 'unauth' : 'unreachable', error }
}

/**
 * Reads an issue.
 *
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @returns Its state, title and labels, or a failure with gh's first error line.
 */
export async function readIssue(processes: ProcessPort, issue: number): Promise<Result<IssueSnapshot>> {
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issue(number:${issue}){state title labels(first:100){nodes{name}}}}}`
  const repository = await readGraphql(processes, query, [], { fallback: 'not found' })
  if (!repository.isOk) return repository
  const fields = isRecord(repository.value.issue) ? repository.value.issue : null
  if (!fields) return fail('unreadable gh output')
  return succeed({ state: toStringOrEmpty(fields.state), title: toStringOrEmpty(fields.title), labels: filterRecords(isRecord(fields.labels) ? fields.labels.nodes : null).map(label => toStringOrEmpty(label.name)) })
}

/**
 * Reads an issue's sub-issues through REST: `gh issue view` does not include their labels.
 *
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @returns Their state and label names, or a failure with gh's first error line.
 */
export async function readSubIssues(processes: ProcessPort, issue: number): Promise<Result<SubIssueInfo[]>> {
  const rows = await readRows(processes, ['gh', 'api', `repos/{owner}/{repo}/issues/${issue}/sub_issues`, '--paginate', '--jq', '.[] | {state, labels: [.labels[].name]}'])
  return rows.isOk ? succeed(rows.value.map(value => ({ state: toStringOrEmpty(value.state),
    labels: Array.isArray(value.labels) ? value.labels.filter((label): label is string => typeof label === 'string') : [] }))) : rows
}

/**
 * Reads issue comment identities and creation times across every REST page.
 * @param processes - The engine's process runner.
 * @param issue - The declared issue number.
 * @returns Its comments or a read failure.
 */
export async function readIssueComments(processes: ProcessPort, issue: number): Promise<Result<IssueComment[]>> {
  const rows = await readRows(processes, ['gh', 'api', `repos/{owner}/{repo}/issues/${issue}/comments`, '--paginate', '--jq', '.[] | {url: .html_url, createdAt: .created_at}'], 'unreadable issue comments')
  if (!rows.isOk) return rows
  const comments: IssueComment[] = []
  for (const row of rows.value) {
    if (!isNonEmptyString(row.url) || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) return fail('unreadable issue comments')
    comments.push({ url: row.url, createdAt: row.createdAt })
  }
  return succeed(comments)
}

/**
 * Opens an issue in the browser.
 *
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @returns Success, or a failure with gh's first error line.
 */
export async function openIssueInBrowser(processes: ProcessPort, issue: number): Promise<Result<undefined>> {
  const run = hasExitedZero(await runProcess(processes, ['gh', 'issue', 'view', String(issue), '--web']))
  return run.isOk ? succeed(undefined) : run
}

/**
 * Lists all candidate PRs from a head branch, into any base, without guessing when the capped response may be incomplete.
 * @param processes - The process runner.
 * @param branch - The unit's head branch.
 * @returns Same-repository candidates, or an unreadable-list failure.
 */
export async function listPullRequests(processes: ProcessPort, branch: string): Promise<Result<PullRequestCandidate[]>> {
  const query = 'query($owner:String!,$name:String!,$head:String!){repository(owner:$owner,name:$name){nameWithOwner defaultBranchRef{name} pullRequests(headRefName:$head,states:[OPEN,MERGED,CLOSED],first:100){nodes{number state url headRefOid baseRefName body isCrossRepository closingIssuesReferences(first:100){nodes{number} pageInfo{hasNextPage}}} pageInfo{hasNextPage}}}}'
  const repository = await readGraphql(processes, query, [`head=${branch}`], {
    unreadable: 'PR candidate list incomplete or unreadable', errors: 'unreadable gh output',
  })
  if (!repository.isOk) return repository
  const identity = readRepositoryIdentity(repository.value)
  if (!identity) return fail('unreadable gh output')
  const connection = repository.value.pullRequests
  if (!isCompleteConnection(connection) || !Array.isArray(connection.nodes)) return fail('PR candidate list incomplete or unreadable')
  const rows: unknown[] = connection.nodes
  if (rows.some(row => isRecord(row) && !isCompleteConnection(row.closingIssuesReferences))) return fail('PR candidate list incomplete or unreadable')
  // Preserve the original string coercion after the numeric guards, including non-string JSON values.
  const candidates: PullRequestRow[] = []
  for (const row of rows) {
    const candidate = isRecord(row) && typeof row.number === 'number' && Number.isSafeInteger(row.number) && row.number > 0 ? { ...row, state: String(row.state) } : row
    if (!isPullRequestCandidate(candidate)) return fail('unreadable gh output')
    candidates.push(candidate)
  }
  return succeed(candidates.filter(row => row.isCrossRepository === false).map(row => {
    const linked = row.closingIssuesReferences.nodes.map(issue => issue.number)
    return { number: row.number, state: row.state, url: row.url, headRefOid: row.headRefOid, baseRefName: row.baseRefName,
      closingIssuesReferences: row.baseRefName === identity.defaultBranch ? linked
        : [...new Set([...linked, ...parseClosingIssues(row.body, identity.nameWithOwner)])] }
  }))
}

/**
 * Compares commit ancestry on GitHub; a commit not pushed yet has no comparison.
 * @param processes - The process runner.
 * @param from - The ancestor SHA.
 * @param to - The candidate descendant SHA.
 * @returns The comparison, null for HTTP 404, or an unreadable comparison failure.
 */
export async function compareCommits(processes: ProcessPort, from: string, to: string): Promise<Result<Comparison | null>> {
  return readRest(processes, `repos/{owner}/{repo}/compare/${from}...${to}`, body => {
    const value = isRecord(body) ? { ...body, status: String(body.status) } : body
    return isComparison(value) ? succeed({ status: value.status, aheadBy: value.ahead_by }) : fail('unreadable gh output')
  }, true)
}

/**
 * Reads the latest check runs and every commit status, without the misleading combined state for zero statuses.
 * @param processes - The process runner.
 * @param sha - The slice end SHA.
 * @returns Named check states, or a failure when either endpoint is unreadable.
 */
export async function readCommitChecks(processes: ProcessPort, sha: string): Promise<Result<CommitCheck[]>> {
  const checks = await readRows(processes, ['gh', 'api', '--paginate', `repos/{owner}/{repo}/commits/${sha}/check-runs`, '--jq', '.check_runs[] | {name, status, conclusion}'])
  if (!checks.isOk) return checks
  const statuses = await readRows(processes, ['gh', 'api', '--paginate', `repos/{owner}/{repo}/commits/${sha}/status`, '--jq', '.statuses[] | {context, state}'])
  if (!statuses.isOk) return statuses
  if (!checks.value.every(isCheckRun)) return fail('unreadable gh output')
  if (!statuses.value.every(isStatus)) return fail('unreadable gh output')
  return succeed([
    ...checks.value.map((row): CommitCheck => ({ name: row.name, state: row.status !== 'completed' ? 'pending'
      : row.conclusion !== null && ['success', 'neutral', 'skipped'].includes(row.conclusion) ? 'passing' : 'failing' })),
    ...statuses.value.map((row): CommitCheck => ({ name: row.context, state: row.state === 'success' ? 'passing' : row.state === 'pending' ? 'pending' : 'failing' })),
  ])
}

/**
 * Reads rule-required checks, retaining GitHub's unavailable-feature error without interpreting its wording.
 * @param processes - The process runner.
 * @param base - The default branch.
 * @returns Required contexts; HTTP 403 and 404 mean no rule-required contexts.
 */
export async function readRequiredChecks(processes: ProcessPort, base: string): Promise<Result<RequiredChecks>> {
  const result = await readBranchRules(processes, base)
  if (!result.isOk) return /^HTTP (403|404)\b/.test(result.error) ? succeed({ contexts: [], error: result.error }) : result
  const rules = result.value.filter(rule => rule.type === 'required_status_checks')
  if (!rules.every(isRequiredCheckRule)) return fail('unreadable gh output')
  return succeed({ contexts: rules.flatMap(rule => rule.parameters.required_status_checks.map(check => check.context)) })
}

/**
 * Reads active branch rules and the current user's bypass permission for status.
 * @param processes - The process runner.
 * @param base - The default branch.
 * @returns Active rulesets, or a read failure.
 */
export async function readBranchRulesets(processes: ProcessPort, base: string): Promise<Result<BranchRuleset[]>> {
  const rules = await readBranchRules(processes, base)
  if (!rules.isOk) return rules
  const grouped = new Map<number, string[]>()
  const active = rules.value.map(rule => ({ ...rule, ruleset_id: Number(rule.ruleset_id) })).filter(isActiveRule)
  for (const rule of active) grouped.set(rule.ruleset_id, [...(grouped.get(rule.ruleset_id) ?? []), typeof rule.type === 'string' ? rule.type : 'unknown'])
  // GitHub's ruleset list leaves current_user_can_bypass null; only the single-ruleset read carries it.
  const rulesets = await Promise.all([...grouped.keys()].map(id => readRest(processes, `repos/{owner}/{repo}/rulesets/${id}`, succeed)))
  const failure = rulesets.find(ruleset => !ruleset.isOk)
  if (failure && !failure.isOk) return failure
  return succeed([...grouped.entries()].map(([id, types], index) => {
    const ruleset = rulesets[index]
    const row = ruleset?.isOk ? ruleset.value : null
    return { id, types, bypass: isRuleset(row) && typeof row.current_user_can_bypass === 'string' ? row.current_user_can_bypass : null }
  }))
}

/**
 * Reads whether the default branch has classic protection enabled for status.
 * @param processes - The process runner.
 * @param base - The default branch.
 * @returns Whether classic protection is enabled, or a read failure.
 */
export async function readBranchProtection(processes: ProcessPort, base: string): Promise<Result<boolean>> {
  const data = await readRest(processes, `repos/{owner}/{repo}/branches/${encodeURIComponent(base)}`, succeed)
  if (!data.isOk) return data
  // GitHub sets `protected` for a ruleset too; `protection.enabled` is the classic rule alone.
  const protection = isRecord(data.value) ? data.value.protection : null
  return isRecord(protection) && typeof protection.enabled === 'boolean' ? succeed(protection.enabled) : fail('unreadable gh output')
}

/**
 * Reads an issue's closing PRs, including merged PRs and refusing a partial connection or timeline.
 * GitHub links a closing keyword only for a PR into the default branch, so a PR into another base closes the issue when its body says so.
 * @param processes - The process runner.
 * @param issue - The declared issue number.
 * @returns Open or merged PRs based in this repository, or an unreadable-connection failure.
 */
export async function readClosingPullRequests(processes: ProcessPort, issue: number): Promise<Result<ClosingPullRequest[]>> {
  const fields = 'number state headRefName isCrossRepository baseRepository{nameWithOwner}'
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner defaultBranchRef{name} issue(number:${issue}){closedByPullRequestsReferences(first:100,includeClosedPrs:true){nodes{${fields}} pageInfo{hasNextPage}} timelineItems(itemTypes:[CROSS_REFERENCED_EVENT],first:100){nodes{... on CrossReferencedEvent{source{__typename ... on PullRequest{${fields} baseRefName body}}}} pageInfo{hasNextPage}}}}}`
  const result = await readGraphql(processes, query)
  if (!result.isOk) return result
  const identity = readRepositoryIdentity(result.value)
  if (!identity) return fail('unreadable gh output')
  const [owner, name] = identity.nameWithOwner.split('/')
  if (!owner || !name) return fail('unreadable repository')
  const issueData = isRecord(result.value.issue) ? result.value.issue : null
  const connection = issueData?.closedByPullRequestsReferences
  const timeline = issueData?.timelineItems
  if (!isCompleteConnection(connection) || !Array.isArray(connection.nodes) || !connection.nodes.every(isClosingPullRequest)
    || !isCompleteConnection(timeline) || !Array.isArray(timeline.nodes) || !timeline.nodes.every(isCrossReference)) return fail('closing PR list incomplete or unreadable')
  const sources: unknown[] = timeline.nodes.map(event => event.source).filter(source => source.__typename === 'PullRequest')
  if (!sources.every(isReferencingPullRequest)) return fail('closing PR list incomplete or unreadable')
  const referenced = sources.filter(row => row.baseRefName !== identity.defaultBranch && parseClosingIssues(row.body, identity.nameWithOwner).includes(issue))
  const closing = [...connection.nodes, ...referenced].filter((row, index, rows) => rows.findIndex(other => other.number === row.number) === index)
  return succeed(closing.filter(row => row.isCrossRepository === false && row.baseRepository.nameWithOwner === identity.nameWithOwner
    && ['OPEN', 'MERGED'].includes(row.state)).map(row => ({ number: row.number, state: row.state, headRefName: row.headRefName })))
}

/**
 * Reads which repository a GraphQL read answered for.
 * @param repository - The repository payload.
 * @returns Its name and default branch, or null when the name is unreadable.
 */
function readRepositoryIdentity(repository: Record<string, unknown>): RepositoryIdentity | null {
  if (typeof repository.nameWithOwner !== 'string') return null
  const ref = repository.defaultBranchRef
  return { nameWithOwner: repository.nameWithOwner, defaultBranch: isRecord(ref) && typeof ref.name === 'string' ? ref.name : null }
}

/**
 * Validates line-delimited GitHub output before exposing its records.
 * @param processes - The engine's process runner.
 * @param args - The GitHub command and arguments.
 * @param unreadable - The failure message for malformed rows.
 * @returns The parsed records, or a process or response failure.
 */
async function readRows(processes: ProcessPort, args: string[], unreadable = 'unreadable gh output'): Promise<Result<Record<string, unknown>[]>> {
  const run = hasExitedZero(await runProcess(processes, args))
  if (!run.isOk) return run
  const rows = run.value.stdout.trim() ? run.value.stdout.trim().split('\n').map(parseJson) : []
  if (!rows.every(row => row.isOk && isRecord(row.value))) return fail(unreadable)
  return succeed(rows.flatMap(row => row.isOk && isRecord(row.value) ? [row.value] : []))
}

/**
 * Reads the protected PR fields fresh, without a candidate-list cache.
 * @param processes - The process runner.
 * @param number - The unit's PR number.
 * @returns The complete field set, or a read failure.
 */
export async function readPrFields(processes: ProcessPort, number: number): Promise<Result<PrFields>> {
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){pullRequest(number:${number}){state closedAt autoMergeRequest{authorEmail commitBody commitHeadline enabledAt enabledBy{login} mergeMethod} isInMergeQueue reviews{totalCount}}}}`
  const repository = await readGraphql(processes, query, [], { unreadable: 'unreadable PR fields' })
  if (!repository.isOk) return repository
  const fields = repository.value.pullRequest
  // Rebuild in a fixed order: GraphQL object key order must not change a fact's identity.
  return isPrFields(fields) ? succeed({ state: fields.state, closedAt: fields.closedAt,
    autoMergeRequest: fields.autoMergeRequest ? {
      authorEmail: fields.autoMergeRequest.authorEmail, commitBody: fields.autoMergeRequest.commitBody, commitHeadline: fields.autoMergeRequest.commitHeadline,
      enabledAt: fields.autoMergeRequest.enabledAt, enabledBy: fields.autoMergeRequest.enabledBy ? { login: fields.autoMergeRequest.enabledBy.login } : null,
      mergeMethod: fields.autoMergeRequest.mergeMethod,
    } : null,
    isInMergeQueue: fields.isInMergeQueue, reviews: { totalCount: fields.reviews.totalCount } }) : fail('unreadable PR fields')
}

/**
 * Limits GraphQL results to a readable repository payload and preserves failure policy.
 * @param processes - The engine's process runner.
 * @param query - The repository query.
 * @param variables - The additional GraphQL variable assignments.
 * @param failures - The messages for command, GraphQL and payload failures.
 * @returns The repository payload, or the corresponding failure.
 */
async function readGraphql(processes: ProcessPort, query: string, variables: string[] = [], failures: GraphqlFailures = {}): Promise<Result<Record<string, unknown>>> {
  const run = hasExitedZero(await runProcess(processes, ['gh', 'api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', ...variables.flatMap(value => ['-f', value]), '-f', `query=${query}`]), failures.fallback)
  if (!run.isOk) return run
  const data = parseJson(run.value.stdout)
  if (data.isOk && isRecord(data.value) && data.value.errors !== undefined) return fail(failures.errors ?? failures.unreadable ?? 'unreadable gh output')
  return data.isOk && isRecord(data.value) && isRecord(data.value.data) && isRecord(data.value.data.repository)
    ? succeed(data.value.data.repository) : fail(failures.unreadable ?? 'unreadable gh output')
}
