import { filterRecords, isRecord, parseJson, toStringOrEmpty } from './json'
import { hasExitedZero, runCommand } from './process'
import type { ProcessPort } from './process'
import { fail, succeed } from './result'
import type { Result } from './result'

/** Whether gh reaches GitHub: logged in and answering, not logged in, or not answering. */
export type GithubAccess = 'connected' | 'unauth' | 'unreachable'

/** What a PR's checks report: every check passed, one failed, some still run, or none is reported yet. */
export type CheckReport = 'passing' | 'failing' | 'pending' | 'none'

/** An issue as GitHub reports it: its state, title and label names. */
export interface IssueSnapshot { state: string; title: string; labels: string[] }

/** Which PRs a lookup counts: any, or only open ones. */
type PullRequestScope = 'all' | 'open'

/** A PR's number and state, as `gh pr list` reports them. */
interface PullRequestState { number: number; state: string }

/** A PR found by a search, with its head and body. */
interface PullRequestRef extends PullRequestState { headRefName: string; headRefOid: string; body: string }

/** A PR's body and head commit, as `gh pr view` reports them. */
interface PullRequestView { body: string; headRefOid: string }

/** An issue the logged-in user opened: its number, title and when GitHub created it, in milliseconds since the epoch. */
interface OwnIssue { number: number; title: string; createdAt: number }

/** How long the reachability probe may take: it runs on every refresh that has no cached answer. */
const probeTimeoutMs = 8000

/**
 * Asks GitHub who is logged in, to tell whether gh can reach it.
 *
 * @param processes - The engine's process runner.
 * @returns Connected, unauth when gh asks for a login, or unreachable on any other failure.
 */
export async function probeGithub(processes: ProcessPort): Promise<GithubAccess> {
  const run = await runCommand(processes, ['gh', 'api', 'user', '--jq', '.login'], probeTimeoutMs)
  if (run.isOk && run.value.exitCode === 0) return 'connected'
  return run.isOk && /auth login|not logged|authenticat/i.test(run.value.stderr) ? 'unauth' : 'unreachable'
}

/**
 * Reads an issue.
 *
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @returns Its state, title and labels, or a failure with gh's first error line.
 */
export async function readIssue(processes: ProcessPort, issue: number): Promise<Result<IssueSnapshot>> {
  const run = hasExitedZero(await runCommand(processes, ['gh', 'issue', 'view', String(issue), '--json', 'state,title,labels']), 'not found')
  if (!run.isOk) return run
  const data = parseJson(run.value.stdout)
  if (!data.isOk || !isRecord(data.value)) return fail('unreadable gh output')
  return succeed({ state: toStringOrEmpty(data.value.state), title: toStringOrEmpty(data.value.title), labels: filterRecords(data.value.labels).map(label => toStringOrEmpty(label.name)) })
}

/**
 * Counts an issue's sub-issues. It asks the REST API: older gh releases have no sub-issue field in `gh issue view`, and an unknown field fails the whole read.
 *
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @returns The count, or a failure with gh's first error line.
 */
export async function countSubIssues(processes: ProcessPort, issue: number): Promise<Result<number>> {
  const run = hasExitedZero(await runCommand(processes, ['gh', 'api', `repos/{owner}/{repo}/issues/${issue}`, '--jq', '.sub_issues_summary.total // 0']))
  if (!run.isOk) return run
  const count = Number(run.value.stdout.trim())
  return run.value.stdout.trim() && Number.isInteger(count) ? succeed(count) : fail('unreadable gh output')
}

/**
 * Lists the issues the logged-in user opened most recently, whatever their state. It reads the list, not the search
 * index, which can lag behind an issue created a moment ago.
 *
 * @param processes - The engine's process runner.
 * @returns Up to 20 issues, newest first, without those whose creation date does not parse, or a failure with gh's first error line.
 */
export async function listOwnIssues(processes: ProcessPort): Promise<Result<OwnIssue[]>> {
  const run = hasExitedZero(await runCommand(processes, ['gh', 'issue', 'list', '--author', '@me', '--state', 'all', '--limit', '20', '--json', 'number,title,createdAt']))
  if (!run.isOk) return run
  const data = parseJson(run.value.stdout)
  if (!data.isOk || !Array.isArray(data.value)) return fail('unreadable gh output')
  return succeed(filterRecords(data.value).flatMap(issue => {
    const createdAt = Date.parse(toStringOrEmpty(issue.createdAt))
    return typeof issue.number === 'number' && !Number.isNaN(createdAt) ? [{ number: issue.number, title: toStringOrEmpty(issue.title), createdAt }] : []
  }))
}

/**
 * Opens an issue in the browser.
 *
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @returns Success, or a failure with gh's first error line.
 */
export async function openIssueInBrowser(processes: ProcessPort, issue: number): Promise<Result<undefined>> {
  const run = hasExitedZero(await runCommand(processes, ['gh', 'issue', 'view', String(issue), '--web']))
  return run.isOk ? succeed(undefined) : run
}

/**
 * Reads what a PR's checks report. gh exits non-zero both when checks fail or still run and when it cannot answer,
 * so the outcome comes from the output: a list of checks, or gh's own word that none is reported.
 *
 * @param processes - The engine's process runner.
 * @param pullRequest - The PR as gh names it (number, URL or branch), or undefined for the current branch's.
 * @returns Failing when any check failed or was cancelled, else pending when any still runs, else passing; none when gh reports no check;
 *   a failure when gh cannot run or answers anything else.
 */
export async function readChecks(processes: ProcessPort, pullRequest?: string): Promise<Result<CheckReport>> {
  const run = await runCommand(processes, ['gh', 'pr', 'checks', ...(pullRequest ? [pullRequest] : []), '--json', 'bucket'])
  if (!run.isOk) return run
  const data = parseJson(run.value.stdout)
  if (!data.isOk || !Array.isArray(data.value)) {
    return run.value.stderr.includes('no checks reported') ? succeed('none') : fail(`gh pr checks failed: ${run.value.stderr.trim()}`)
  }
  const buckets = filterRecords(data.value).map(check => toStringOrEmpty(check.bucket))
  if (!buckets.length) return succeed('none')
  if (buckets.some(bucket => bucket === 'fail' || bucket === 'cancel')) return succeed('failing')
  return succeed(buckets.some(bucket => bucket === 'pending') ? 'pending' : 'passing')
}

/**
 * Finds the latest PR whose head is a branch.
 *
 * @param processes - The engine's process runner.
 * @param branch - The head branch.
 * @param scope - Which PRs count.
 * @returns The PR, null when there is none, or a failure when gh cannot list them.
 */
export async function findPullRequest(processes: ProcessPort, branch: string, scope: PullRequestScope): Promise<Result<PullRequestState | null>> {
  const run = hasExitedZero(await runCommand(processes, ['gh', 'pr', 'list', '--head', branch, '--state', scope, '--json', 'number,state', '--limit', '1']))
  if (!run.isOk) return run
  const data = parseJson(run.value.stdout)
  const found = filterRecords(data.isOk ? data.value : null)[0]
  return succeed(found && typeof found.number === 'number' ? { number: found.number, state: toStringOrEmpty(found.state) } : null)
}

/**
 * Searches every PR, whatever its state, for a text.
 *
 * @param processes - The engine's process runner.
 * @param query - The search text.
 * @returns Up to 50 matching PRs, or a failure when gh cannot search.
 */
export async function searchPullRequests(processes: ProcessPort, query: string): Promise<Result<PullRequestRef[]>> {
  const run = hasExitedZero(await runCommand(processes, ['gh', 'pr', 'list', '--state', 'all', '--search', query, '--json', 'number,state,headRefName,headRefOid,body', '--limit', '50']))
  if (!run.isOk) return run
  const data = parseJson(run.value.stdout)
  return succeed(filterRecords(data.isOk ? data.value : null).flatMap(pullRequest => (typeof pullRequest.number === 'number'
    ? [{
      number: pullRequest.number, state: toStringOrEmpty(pullRequest.state), headRefName: toStringOrEmpty(pullRequest.headRefName),
      headRefOid: toStringOrEmpty(pullRequest.headRefOid), body: toStringOrEmpty(pullRequest.body),
    }]
    : [])))
}

/**
 * Reads a PR's body and head commit.
 *
 * @param processes - The engine's process runner.
 * @param pullRequest - The PR number.
 * @returns Both, or a failure when gh cannot read them or reports them in another shape.
 */
export async function viewPullRequest(processes: ProcessPort, pullRequest: number): Promise<Result<PullRequestView>> {
  const run = hasExitedZero(await runCommand(processes, ['gh', 'pr', 'view', String(pullRequest), '--json', 'body,headRefOid']))
  if (!run.isOk) return run
  const data = parseJson(run.value.stdout)
  if (!data.isOk || !isRecord(data.value) || typeof data.value.body !== 'string' || typeof data.value.headRefOid !== 'string') return fail('unreadable gh output')
  return succeed({ body: data.value.body, headRefOid: data.value.headRefOid })
}
