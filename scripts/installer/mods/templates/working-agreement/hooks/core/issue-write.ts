import { findDecisionDefect, listUnreviewed, readRecordKind, readReviewedDecision } from '../domain/delegated-decision'
import { checkIssueFields, listSetupLabels, parseIssuesConfig, reviewLabel, setupHint } from '../domain/issue-fields'
import type { IssueInput, IssuesConfig } from '../domain/issue-fields'
import { readGraphql, readMarkedComments, runGh } from '../lib/github'
import { isRecord } from '../lib/guards'
import { filterRecords, toStringOrEmpty } from '../lib/json'
import type { ProcessPort } from '../lib/process'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { readRepositoryRoot } from './repository'
import { isVerifyApproved } from './verify'
import { configPath, readRepositoryConfig } from './verify-config'

/** The repository's label names and the native issue types GitHub reports, empty where it has none. */
interface RepoFacts { labels: Set<string>; issueTypes: string[] }

/** An issue as read back after a write. */
interface IssueState { state: string; stateReason: string; labels: string[]; assignees: string[]; parent: number | null; blockedBy: number[] }

/** A create or edit's outcome, with the issue it wrote, which stands even when its read-back failed. */
export interface IssueWrite { result: Result<string>; written: number | null }

/** Refuses an edit from the issue's labels before it, or lets it through with undefined. */
export type EditGuard = (current: string[]) => Promise<string | undefined>

/** What a write must have left on the issue; every field left out is not checked. */
interface Expected { assignee?: boolean; labels?: string[]; parent?: number; blockedBy?: number[]; state?: string; stateReason?: string }

/**
 * Reads the `issues` section from the working tree's config when the user approved that exact blob, as for Verify, so an agent
 * cannot relax the rules by editing the file; otherwise the strict built-in defaults apply.
 * @param port - The engine calls.
 * @returns The config, or why the file cannot be used.
 */
export async function readIssuesConfig(port: EnginePort): Promise<Result<IssuesConfig>> {
  const config = await readRepositoryConfig(port, await readRepositoryRoot(port))
  if (config.kind === 'invalid') return fail(`${configPath}: ${config.fact}`)
  return succeed(config.kind === 'valid' && await isVerifyApproved(port, config.blob) ? config.config.issues : parseIssuesConfig(undefined))
}

/**
 * Reads the repository's labels and native issue types.
 * @param processes - The engine's process runner.
 * @returns The facts, or the read failure.
 */
async function readRepoFacts(processes: ProcessPort): Promise<Result<RepoFacts>> {
  const labels = await readLabelNames(processes)
  if (!labels.isOk) return labels
  const types = await readGraphql(processes, 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issueTypes(first:50){nodes{name}}}}')
  if (!types.isOk) return fail(`cannot read the repository issue types: ${types.error}`)
  const issueTypes = filterRecords(isRecord(types.value.issueTypes) ? types.value.issueTypes.nodes : null).map(node => toStringOrEmpty(node.name))
  return succeed({ labels: new Set(labels.value), issueTypes })
}

/**
 * Reads the names of the repository's labels.
 * @param processes - The engine's process runner.
 * @returns The names, or the read failure.
 */
async function readLabelNames(processes: ProcessPort): Promise<Result<string[]>> {
  const labels = await runGh(processes, ['api', 'repos/{owner}/{repo}/labels', '--paginate', '--jq', '.[].name'])
  return labels.isOk ? succeed(labels.value.split('\n').filter(Boolean)) : fail(`cannot read the repository labels: ${labels.error}`)
}

/**
 * Checks that the repository carries the delegated-review label a decision needs.
 * @param processes - The engine's process runner.
 * @returns Why a decision cannot be posted, or undefined when the label exists.
 */
export async function findMissingReviewLabel(processes: ProcessPort): Promise<string | undefined> {
  const labels = await readLabelNames(processes)
  if (!labels.isOk) return labels.error
  return labels.value.includes(reviewLabel) ? undefined : `The repository lacks the label ${reviewLabel} — ${setupHint}.`
}

/**
 * Reads back the fields an issue write sets.
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @returns The issue's state, or the read failure.
 */
async function readIssueState(processes: ProcessPort, issue: number): Promise<Result<IssueState>> {
  const query = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issue(number:${issue}){state stateReason ` +
    'labels(first:100){nodes{name}} assignees(first:20){nodes{login}} parent{number} blockedBy(first:50){nodes{number}}}}}'
  const read = await readGraphql(processes, query, [], { fallback: 'not found' })
  if (!read.isOk) return fail(`cannot read #${issue} back: ${read.error}`)
  const fields = read.value.issue
  if (!isRecord(fields)) return fail(`cannot read #${issue} back: unreadable gh output`)
  const nodes = (connection: unknown) => filterRecords(isRecord(connection) ? connection.nodes : null)
  return succeed({
    state: toStringOrEmpty(fields.state), stateReason: toStringOrEmpty(fields.stateReason),
    labels: nodes(fields.labels).map(node => toStringOrEmpty(node.name)), assignees: nodes(fields.assignees).map(node => toStringOrEmpty(node.login)),
    parent: isRecord(fields.parent) && typeof fields.parent.number === 'number' ? fields.parent.number : null,
    blockedBy: nodes(fields.blockedBy).map(node => Number(node.number)),
  })
}

/**
 * Reads the issue back and names every field the write did not leave as asked.
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @param expected - What the write must have left.
 * @returns Nothing when the issue matches, or the mismatches.
 */
async function confirm(processes: ProcessPort, issue: number, expected: Expected): Promise<Result<undefined>> {
  const read = await readIssueState(processes, issue)
  if (!read.isOk) return read
  const actual = read.value
  const mismatches = [
    ...(expected.labels ?? []).filter(label => !actual.labels.includes(label)).map(label => `label ${label} missing`),
    ...(expected.assignee && !actual.assignees.length ? ['no assignee'] : []),
    ...(expected.parent === undefined || actual.parent === expected.parent ? [] : [`parent is ${actual.parent === null ? 'unset' : `#${actual.parent}`}, not #${expected.parent}`]),
    ...(expected.blockedBy ?? []).filter(number => !actual.blockedBy.includes(number)).map(number => `not blocked by #${number}`),
    ...(expected.state === undefined || actual.state === expected.state ? [] : [`state is ${actual.state}, not ${expected.state}`]),
    ...(expected.stateReason === undefined || actual.stateReason === expected.stateReason ? [] : [`state reason is ${actual.stateReason || 'unset'}, not ${expected.stateReason}`]),
  ]
  return mismatches.length ? fail(`#${issue} does not match what was written: ${mismatches.join('; ')}`) : succeed(undefined)
}

/**
 * Names the native issue type for a type, only when the repository reports it.
 * @param config - The issues config.
 * @param facts - The repository facts.
 * @param type - The issue's type.
 * @returns The native type's name, or undefined when none applies.
 */
function nativeType(config: IssuesConfig, facts: RepoFacts, type: string | undefined): string | undefined {
  if (type === undefined) return undefined
  const name = config.nativeTypes[type] ?? type
  return facts.issueTypes.find(candidate => candidate.toLowerCase() === name.toLowerCase())
}

/**
 * Repeats a flag once per value.
 * @param flag - The gh flag.
 * @param values - Its values.
 * @returns The arguments.
 */
const repeat = (flag: string, values: readonly (string | number)[]): string[] => values.flatMap(value => [flag, String(value)])

/**
 * Words a refused issue write, which wrote no issue.
 * @param error - Why the write was refused.
 * @returns The refusal.
 */
function refuse(error: string): IssueWrite {
  return { result: fail(error), written: null }
}

/**
 * Creates an issue after checking every field, then reads it back.
 * @param port - The engine calls.
 * @param config - The issues config.
 * @param input - The call's fields.
 * @returns The new issue's URL, or the refusal or failure, with the issue once it exists.
 */
export async function createIssue(port: EnginePort, config: IssuesConfig, input: IssueInput): Promise<IssueWrite> {
  if (input.title === undefined || input.sections === undefined || input.triage === undefined) return refuse('title, kind, sections and triage are required.')
  const assignees = input.assignees ?? ['@me']
  if (!assignees.length) return refuse('At least one assignee is required (default @me).')
  const facts = await readRepoFacts(port.processes)
  if (!facts.isOk) return refuse(facts.error)
  const checked = checkIssueFields(config, input, facts.value.labels)
  if (!checked.isOk) return refuse(checked.error)
  const milestone = input.milestone ?? config.milestone
  const project = input.project ?? config.project
  const type = nativeType(config, facts.value, input.type)
  const created = await runGh(port.processes, ['issue', 'create', '--title', input.title, '--body', checked.value.body ?? '',
    ...repeat('--label', checked.value.labels), ...repeat('--assignee', assignees),
    ...(milestone ? ['--milestone', milestone] : []), ...(project ? ['--project', project] : []), ...(type ? ['--type', type] : []),
    ...(input.parent ? ['--parent', String(input.parent)] : []), ...repeat('--blocked-by', input.blockedBy ?? [])])
  if (!created.isOk) return refuse(`gh issue create failed: ${created.error}`)
  const url = created.value.trim().split('\n').pop() ?? ''
  const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1])
  if (!number) return refuse(`gh issue create printed no issue URL: ${created.value.trim()}`)
  const confirmed = await confirm(port.processes, number, { assignee: true, labels: checked.value.labels, ...(input.parent ? { parent: input.parent } : {}), ...(input.blockedBy ? { blockedBy: input.blockedBy } : {}) })
  return { result: confirmed.isOk ? succeed(`Created ${url}`) : fail(`Created ${url}, but ${confirmed.error}`), written: number }
}

/**
 * Edits an issue so it still carries every required field, then reads it back.
 * @param port - The engine calls.
 * @param config - The issues config.
 * @param input - The call's fields.
 * @param guard - What may refuse the edit once the issue's labels are read.
 * @returns The confirmation, or the refusal or failure.
 */
export async function editIssue(port: EnginePort, config: IssuesConfig, input: IssueInput, guard?: EditGuard): Promise<IssueWrite> {
  if (input.number === undefined) return refuse('number is required.')
  const current = await readIssueState(port.processes, input.number)
  if (!current.isOk) return refuse(current.error)
  const refusal = await guard?.(current.value.labels)
  if (refusal) return refuse(refusal)
  if (!current.value.assignees.length && !input.assignees?.length) return refuse(`#${input.number} has no assignee: pass assignees (e.g. @me).`)
  const facts = await readRepoFacts(port.processes)
  if (!facts.isOk) return refuse(facts.error)
  const checked = checkIssueFields(config, input, facts.value.labels, current.value.labels)
  if (!checked.isOk) return refuse(checked.error)
  const added = checked.value.labels.filter(label => !current.value.labels.includes(label))
  const removed = current.value.labels.filter(label => !checked.value.labels.includes(label))
  const type = nativeType(config, facts.value, input.type)
  const edited = await runGh(port.processes, ['issue', 'edit', String(input.number),
    ...(input.title ? ['--title', input.title] : []), ...(checked.value.body === undefined ? [] : ['--body', checked.value.body]),
    ...repeat('--add-label', added), ...repeat('--remove-label', removed), ...repeat('--add-assignee', input.assignees ?? []),
    ...(input.milestone ? ['--milestone', input.milestone] : []), ...(input.project ? ['--add-project', input.project] : []), ...(type ? ['--type', type] : []),
    ...(input.parent ? ['--parent', String(input.parent)] : []), ...repeat('--add-blocked-by', input.blockedBy ?? [])])
  if (!edited.isOk) return refuse(`gh issue edit failed: ${edited.error}`)
  if (input.state === 'open') {
    const reopened = await runGh(port.processes, ['issue', 'reopen', String(input.number)])
    if (!reopened.isOk) return { result: fail(`Edited #${input.number}, but gh issue reopen failed: ${reopened.error}`), written: input.number }
  }
  const confirmed = await confirm(port.processes, input.number, { assignee: true, labels: checked.value.labels, ...(input.parent ? { parent: input.parent } : {}),
    ...(input.blockedBy ? { blockedBy: input.blockedBy } : {}), ...(input.state === 'open' ? { state: 'OPEN' } : {}) })
  return { result: confirmed.isOk ? succeed(`Edited #${input.number}`) : fail(`Edited #${input.number}, but ${confirmed.error}`), written: input.number }
}

/**
 * Closes an issue with a state reason, then reads it back.
 * @param port - The engine calls.
 * @param input - The call's fields.
 * @returns The confirmation, or the failure.
 */
export async function closeIssue(port: EnginePort, input: IssueInput): Promise<Result<string>> {
  if (input.number === undefined) return fail('number is required.')
  const reason = input.reason ?? 'completed'
  if (reason === 'duplicate' && input.duplicateOf === undefined) return fail('A duplicate needs duplicateOf.')
  const closed = await runGh(port.processes, ['issue', 'close', String(input.number), '--reason', reason,
    ...(input.comment ? ['--comment', input.comment] : []), ...(input.duplicateOf ? ['--duplicate-of', String(input.duplicateOf)] : [])])
  if (!closed.isOk) return fail(`gh issue close failed: ${closed.error}`)
  const confirmed = await confirm(port.processes, input.number, { state: 'CLOSED', stateReason: reason.toUpperCase().replace(' ', '_') })
  return confirmed.isOk ? succeed(`Closed #${input.number} as ${reason}`) : fail(`Closed #${input.number}, but ${confirmed.error}`)
}

/**
 * Posts a comment on an issue of this repository; one marked as a delegated decision or review must be well-formed.
 * A decision puts the delegated-review label on the issue; the review of its last unreviewed decision takes it off.
 * @param port - The engine calls.
 * @param input - The call's fields.
 * @returns The comment's URL, or the failure.
 */
export async function commentIssue(port: EnginePort, input: IssueInput): Promise<Result<string>> {
  if (input.number === undefined || input.body === undefined) return fail('number and body are required.')
  const defect = findDecisionDefect(input.body)
  if (defect) return fail(defect)
  const kind = readRecordKind(input.body)
  const before = kind === 'review' ? await readMarkedComments(port.processes, input.number) : succeed([])
  if (!before.isOk) return before
  if (kind === 'review' && !listUnreviewed(before.value).includes(readReviewedDecision(input.body))) {
    return fail(`${readReviewedDecision(input.body)} is not an unreviewed delegated decision on #${input.number}.`)
  }
  // A decision is all or nothing: one posted without its label stays out of the review queue, and a retry duplicates it.
  if (kind === 'decision') {
    const missing = await findMissingReviewLabel(port.processes)
    if (missing) return fail(missing)
  }
  const posted = await runGh(port.processes, ['issue', 'comment', String(input.number), '--body', input.body])
  if (!posted.isOk) return fail(`gh issue comment failed: ${posted.error}`)
  const url = posted.value.trim().split('\n').pop() ?? ''
  if (!url.includes('#issuecomment-')) return fail(`gh issue comment printed no comment URL: ${posted.value.trim()}`)
  const flag = kind === 'decision' ? '--add-label'
    : kind === 'review' && !listUnreviewed([...before.value, { url, body: input.body }]).length ? '--remove-label' : undefined
  if (!flag) return succeed(`Commented ${url}`)
  const labelled = await runGh(port.processes, ['issue', 'edit', String(input.number), flag, reviewLabel])
  if (!labelled.isOk) return fail(`Commented ${url}, but gh issue edit ${flag} ${reviewLabel} failed: ${labelled.error} — ${setupHint}.`)
  return succeed(`Commented ${url} — #${input.number} ${flag === '--add-label' ? `carries ${reviewLabel}` : `has every delegated decision reviewed; ${reviewLabel} removed`}`)
}

/**
 * Creates or updates every configured label; re-running changes nothing.
 * @param port - The engine calls.
 * @returns The labels set, or the first failure.
 */
export async function setUpLabels(port: EnginePort): Promise<Result<string>> {
  const config = await readIssuesConfig(port)
  if (!config.isOk) return config
  const labels = listSetupLabels(config.value)
  for (const [name, spec] of labels) {
    const set = await runGh(port.processes, ['label', 'create', name, '--force',
      ...(spec.color ? ['--color', spec.color] : []), ...(spec.description ? ['--description', spec.description] : [])])
    if (!set.isOk) return fail(`gh label create ${name} failed: ${set.error}`)
  }
  return succeed(`Labels set up: ${labels.map(([name]) => name).join(', ')}`)
}
