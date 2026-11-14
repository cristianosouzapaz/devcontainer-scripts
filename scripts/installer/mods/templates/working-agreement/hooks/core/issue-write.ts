import { findDecisionDefect, listUnreviewed, readRecordKind, readReviewedDecision } from '../domain/delegated-decision'
import { stop, unknown } from '../domain/outcome'
import { checkIssueFields, listSetupLabels, parseIssuesConfig, reviewLabel, setupHint } from '../domain/issue-fields'
import type { IssueInput, IssuesConfig } from '../domain/issue-fields'
import { readAuthoredComments, readGhLogin, readGraphql, readMarkedComments, runGh } from '../lib/github'
import { isRecord } from '../lib/guards'
import { filterRecords, parseJson, toStringOrEmpty } from '../lib/json'
import { runProcess } from '../lib/process'
import type { ProcessPort } from '../lib/process'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { recordDecision } from './delegated-step'
import type { EnginePort } from './engine-port'
import { readRepositoryRoot } from './repository'
import { isVerifyApproved } from './verify'
import { configPath, readRepositoryConfig } from './verify-config'

/** The repository's label names and the native issue types GitHub reports, empty where it has none. */
interface RepoFacts { labels: Set<string>; issueTypes: string[] }

/** An issue as read back after a write. */
interface IssueState { state: string; stateReason: string; labels: string[]; assignees: string[]; parent: number | null; blockedBy: number[] }

/** A created issue's requested assignees as its read-back shows them: those it does not carry, and what could not be read back. */
interface AssigneeCheck { missing: string[]; unread: string[] }

/** What an edit asked for: labels added and removed, assignees, parent and blockers, and the fields no read-back shows. */
interface EditRequest { added: string[]; removed: string[]; assignees: string[]; parent: number | undefined; blockedBy: number[]; unread: string[] }

/** A create or edit's outcome, with the issue it wrote, which stands even when its read-back failed. */
export interface IssueWrite { result: Result<string>; written: number | null }

/** Refuses an edit from the issue's labels before it, or lets it through with undefined. */
export type EditGuard = (current: string[]) => Promise<string | undefined>

/** What a write must have left on the issue; every field left out is not checked. */
interface Expected { assignee?: boolean; labels?: string[]; parent?: number; blockedBy?: number[]; state?: string; stateReason?: string }

/** A comment or issue a write may have made, as its read-back lists it. */
interface Written { url: string; text: string; author: string; createdAt: string }

/** Lists what a write may have made. */
type WrittenList = (processes: ProcessPort) => Promise<Result<Written[]>>

/** What a read-back found: the write, nothing that rules it out, or nothing. */
type Landed = { kind: 'found'; url: string } | { kind: 'uncertain' } | { kind: 'none' }

/** A write made once: the URL it made, with gh's error when gh failed after it landed, or why it failed and whether it may have landed. */
type OnceWrite = { isOk: true; url: string; error?: string } | { isOk: false; error: string; isUncertain: boolean }

// why: GitHub lists a write a moment after it lands, so a read-back at once could miss one that did.
const settleSeconds = 2
// why: the read-back compares the local clock with GitHub's; a match within this much before the write cannot be told from a write the skew hid, so it is uncertain rather than a reason to send again.
const clockSlackMs = 60000

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
  const labels = await runGh(processes, ['api', 'repos/{owner}/{repo}/labels', '--paginate', '--jq', '.[].name'], 'read')
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
 * Tells whether a list of GitHub logins holds a login, which GitHub matches regardless of case and reads back in the account's own spelling.
 * @param logins - The logins, as a read-back gives them.
 * @param login - The login asked about.
 * @returns Whether it is there.
 */
const hasLogin = (logins: readonly string[], login: string): boolean => logins.some(each => each.toLowerCase() === login.toLowerCase())

/**
 * Judges a failed edit by reading the issue back, since gh may fail after some of its requests landed: a change found on the issue makes
 * it a stop naming what was and was not applied, none a refusal, and an issue that cannot be read back, or fields no read-back shows, an
 * unfinished call.
 * @param processes - The engine's process runner.
 * @param number - The issue number.
 * @param before - The issue as read before the edit.
 * @param asked - The edit's requests: labels added and removed, assignees, parent and blockers, and the fields no read-back shows.
 * @param error - gh's error.
 * @returns The stop, refusal or unfinished call.
 */
async function judgeFailedEdit(processes: ProcessPort, number: number, before: IssueState, asked: EditRequest, error: string): Promise<Result<string>> {
  const failed = `gh issue edit failed: ${error}`
  const after = await readIssueState(processes, number)
  if (!after.isOk) return unknown(`${failed}; ${after.error}`, `#${number} on GitHub before editing it again`)
  const { labels, assignees, parent, blockedBy } = after.value
  // why: gh resolves @me to the token's login, so the read-back can only check it once the login is known.
  const me = asked.assignees.includes('@me') ? await readGhLogin(processes) : null
  const logins = asked.assignees.flatMap(login => login !== '@me' ? [login] : me?.isOk ? [me.value] : [])
  const unreadFields = [...asked.unread, ...me && !me.isOk ? ['assignee @me'] : []]
  const changes = [
    ...asked.added.map(label => ({ what: `label ${label} added`, isApplied: labels.includes(label) })),
    ...asked.removed.map(label => ({ what: `label ${label} removed`, isApplied: !labels.includes(label) })),
    ...logins.filter(login => !hasLogin(before.assignees, login)).map(login => ({ what: `assignee ${login}`, isApplied: hasLogin(assignees, login) })),
    ...(asked.parent && asked.parent !== before.parent ? [{ what: `parent #${asked.parent}`, isApplied: parent === asked.parent }] : []),
    ...asked.blockedBy.filter(blocker => !before.blockedBy.includes(blocker)).map(blocker => ({ what: `blocked by #${blocker}`, isApplied: blockedBy.includes(blocker) })),
  ]
  const applied = changes.filter(change => change.isApplied).map(change => change.what)
  const missing = changes.filter(change => !change.isApplied).map(change => change.what)
  const unread = unreadFields.length ? `${unreadFields.join(', ')} not read back; ` : ''
  if (applied.length) return stop(`#${number}: ${applied.join(', ')} applied; ${missing.length ? `${missing.join(', ')} not applied; ` : ''}${unread}${failed}`)
  if (unread) return unknown(`${failed}; nothing the read-back shows was applied, and ${unreadFields.join(', ')} cannot be read back`, `#${number} on GitHub before editing it again`)
  return fail(`${failed}; nothing was applied`)
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
  const created = await writeOnce(port, ['issue', 'create', '--title', input.title, '--body', checked.value.body ?? '',
    ...repeat('--label', checked.value.labels), ...repeat('--assignee', assignees),
    ...(milestone ? ['--milestone', milestone] : []), ...(project ? ['--project', project] : []), ...(type ? ['--type', type] : []),
    ...(input.parent ? ['--parent', String(input.parent)] : []), ...repeat('--blocked-by', input.blockedBy ?? [])], input.title, readCreatedIssues)
  if (!created.isOk) {
    const issues = await readIssuesUrl(port.processes)
    return { result: created.isUncertain ? unknown(`gh issue create may have been written: ${created.error}`, `${issues} before creating it again`)
      : fail(`gh issue create failed: ${created.error}`), written: null }
  }
  const url = created.url
  const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1])
  // why: gh exited zero, so the issue most likely exists; only its number is unknown.
  if (!number) return { result: unknown(`gh issue create printed no issue URL: ${url || 'nothing'}`, `${await readIssuesUrl(port.processes)} before creating it again`), written: null }
  const confirmed = await confirm(port.processes, number, { assignee: true, labels: checked.value.labels, ...(input.parent ? { parent: input.parent } : {}), ...(input.blockedBy ? { blockedBy: input.blockedBy } : {}) })
  if (created.error === undefined) return { result: confirmed.isOk ? succeed(`Created ${url}`) : stop(`Created ${url}, but ${confirmed.error}`), written: number }
  // why: after gh failed only the read-back is established; confirm checks just one assignee, and milestone, project and type go unread.
  const assigned = await checkAssignees(port.processes, number, assignees)
  const unread = [...[milestone && 'milestone', project && 'project', type && 'type'].filter((field): field is string => typeof field === 'string'), ...assigned.unread]
  const gaps = [...unread.length ? [`${unread.join(', ')} not read back`] : [], ...assigned.missing.map(login => `assignee ${login} not applied`), ...confirmed.isOk ? [] : [confirmed.error]]
  const failed = `gh issue create failed: ${created.error}`
  if (gaps.length) return { result: stop(`Created ${url}; ${gaps.join('; ')}; ${failed}`), written: number }
  return { result: succeed(`Created ${url}; its labels, assignees, parent and blockers read back, its body is not read back, and ${failed}`), written: number }
}

/**
 * Checks each requested assignee of a created issue on its read-back, resolving @me to the gh login, as confirm checks only that one exists.
 * @param processes - The engine's process runner.
 * @param number - The issue number.
 * @param assignees - The requested logins, @me included.
 * @returns The logins the issue does not carry, and what could not be read back.
 */
async function checkAssignees(processes: ProcessPort, number: number, assignees: string[]): Promise<AssigneeCheck> {
  const state = await readIssueState(processes, number)
  if (!state.isOk) return { missing: [], unread: ['assignees'] }
  const me = assignees.includes('@me') ? await readGhLogin(processes) : null
  const logins = assignees.flatMap(login => login !== '@me' ? [login] : me?.isOk ? [me.value] : [])
  return { missing: logins.filter(login => !hasLogin(state.value.assignees, login)), unread: me && !me.isOk ? ['assignee @me'] : [] }
}

/**
 * Judges a failed reopen by reading the issue back: a reopen that landed, or an edit made before it, makes it a stop; a bare reopen that
 * left the issue closed a refusal; an issue that cannot be read back an unfinished call.
 * @param processes - The engine's process runner.
 * @param number - The issue number.
 * @param isEdited - Whether an edit of other fields succeeded before the reopen.
 * @param error - gh's error.
 * @returns The stop, refusal or unfinished call.
 */
async function judgeFailedReopen(processes: ProcessPort, number: number, isEdited: boolean, error: string): Promise<Result<string>> {
  const failed = `gh issue reopen failed: ${error}`
  const edited = isEdited ? `Edited #${number}; ` : ''
  const after = await readIssueState(processes, number)
  if (!after.isOk) return unknown(`${edited}${failed}; ${after.error}`, `#${number} on GitHub before reopening it again`)
  const isOpen = after.value.state === 'OPEN'
  if (!isEdited && !isOpen) return fail(`${failed}; #${number} is still closed`)
  return stop(`${edited}#${number} is ${isOpen ? 'open' : 'still closed'}; ${failed}`)
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
  const flags = [
    ...(input.title ? ['--title', input.title] : []), ...(checked.value.body === undefined ? [] : ['--body', checked.value.body]),
    ...repeat('--add-label', added), ...repeat('--remove-label', removed), ...repeat('--add-assignee', input.assignees ?? []),
    ...(input.milestone ? ['--milestone', input.milestone] : []), ...(input.project ? ['--add-project', input.project] : []), ...(type ? ['--type', type] : []),
    ...(input.parent ? ['--parent', String(input.parent)] : []), ...repeat('--add-blocked-by', input.blockedBy ?? [])]
  // why: gh issue edit refuses an empty flag list when not interactive, which must not block a bare reopen.
  const edited = flags.length ? await runGh(port.processes, ['issue', 'edit', String(input.number), ...flags]) : succeed('')
  if (!edited.isOk) {
    const unread = [input.title && 'title', checked.value.body !== undefined && 'body', input.milestone && 'milestone', input.project && 'project', type && 'type']
      .filter((field): field is string => typeof field === 'string')
    const asked = { added, removed, assignees: input.assignees ?? [], parent: input.parent, blockedBy: input.blockedBy ?? [], unread }
    return { result: await judgeFailedEdit(port.processes, input.number, current.value, asked, edited.error), written: input.number }
  }
  if (input.state === 'open') {
    const reopened = await runGh(port.processes, ['issue', 'reopen', String(input.number)])
    if (!reopened.isOk) return { result: await judgeFailedReopen(port.processes, input.number, flags.length > 0, reopened.error), written: input.number }
  }
  const confirmed = await confirm(port.processes, input.number, { assignee: true, labels: checked.value.labels, ...(input.parent ? { parent: input.parent } : {}),
    ...(input.blockedBy ? { blockedBy: input.blockedBy } : {}), ...(input.state === 'open' ? { state: 'OPEN' } : {}) })
  return { result: confirmed.isOk ? succeed(`Edited #${input.number}`) : stop(`Edited #${input.number}, but ${confirmed.error}`), written: input.number }
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
    ...(input.comment ? ['--comment', input.comment] : []), ...(input.duplicateOf ? ['--duplicate-of', String(input.duplicateOf)] : [])], input.comment ? 'once' : 'idempotent')
  if (!closed.isOk) {
    // why: a close that posts a comment is never sent again, as a resend would post the comment twice.
    return input.comment && closed.isOutcomeUnknown ? unknown(`gh issue close may have been written: ${closed.error}`, `${await readIssuesUrl(port.processes)}/${input.number} before closing it again`)
      : fail(`gh issue close failed: ${closed.error}`)
  }
  const confirmed = await confirm(port.processes, input.number, { state: 'CLOSED', stateReason: reason.toUpperCase().replace(' ', '_') })
  return confirmed.isOk ? succeed(`Closed #${input.number} as ${reason}`) : stop(`Closed #${input.number}, but ${confirmed.error}`)
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
  // why: a decision is all or nothing: one posted without its label stays out of the review queue, and a retry duplicates it.
  if (kind === 'decision') {
    const missing = await findMissingReviewLabel(port.processes)
    if (missing) return fail(missing)
  }
  const number = input.number
  const posted = await writeOnce(port, ['issue', 'comment', String(number), '--body', input.body], input.body, processes => readCommentsAsWritten(processes, number))
  if (!posted.isOk) {
    return posted.isUncertain ? unknown(`gh issue comment may have been written: ${posted.error}`, `${await readIssuesUrl(port.processes)}/${number} before posting it again`)
      : fail(`gh issue comment failed: ${posted.error}`)
  }
  const url = posted.url
  if (!url.includes('#issuecomment-')) return unknown(`gh issue comment printed no comment URL: ${url || 'nothing'}`, `${await readIssuesUrl(port.processes)}/${number} before posting it again`)
  // why: a coordinator's step tools rest only on a decision its own mod saw posted, so the record is written once the post succeeded.
  const unrecorded = kind === 'decision' ? await recordDecision(port, input.number, url, input.body).then(() => '', (error: unknown) => formatErrorLine(error)) : ''
  if (unrecorded) return stop(`Commented ${url}, but its provenance record was not written (${unrecorded}), so no step tool can rest on it — tell the user.`)
  const flag = kind === 'decision' ? '--add-label'
    : kind === 'review' && !listUnreviewed([...before.value, { url, body: input.body }]).length ? '--remove-label' : undefined
  if (!flag) return succeed(`Commented ${url}`)
  const labelled = await runGh(port.processes, ['issue', 'edit', String(input.number), flag, reviewLabel])
  if (!labelled.isOk) return stop(`Commented ${url}, but gh issue edit ${flag} ${reviewLabel} failed: ${labelled.error} — ${setupHint}.`)
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

/**
 * Makes a write that a repeat would duplicate. A transient failure is read back instead of repeated: a write found is
 * success, one the read-back cannot rule out is uncertain, and only one whose failed request never left and that the
 * read-back rules out is sent again, once.
 * @param port - The engine calls.
 * @param args - The gh arguments.
 * @param text - The comment body or issue title the write sends.
 * @param list - Lists what the write may have made.
 * @param isResend - Whether this is the one resend.
 * @returns The URL gh printed or the read-back found, or the failure and whether the write may have landed.
 */
async function writeOnce(port: EnginePort, args: string[], text: string, list: WrittenList, isResend = false): Promise<OnceWrite> {
  const started = await port.now()
  const sent = await runGh(port.processes, args, 'once')
  if (sent.isOk) return { isOk: true, url: sent.value.trim().split('\n').pop() ?? '' }
  const landed = await findLanded(port.processes, started, text, list)
  // why: one gh command sends several requests, so a permanent failure of a later one may follow a first that landed.
  if (!sent.isOutcomeUnknown) return landed.kind === 'found' ? { isOk: true, url: landed.url, error: sent.error } : { isOk: false, error: sent.error, isUncertain: landed.kind === 'uncertain' }
  // why: gh failed after the write landed, so its later requests, such as a project add no read-back checks, may not have.
  if (landed.kind === 'found') return { isOk: true, url: landed.url, error: sent.error }
  // why: GitHub may finish a write whose request went out after the read-back looked, so only one never sent is sent again.
  if (landed.kind === 'uncertain' || isResend || !sent.isNeverSent) return { isOk: false, error: sent.error, isUncertain: true }
  return writeOnce(port, args, text, list, true)
}

/**
 * Reads back a write whose outcome is unknown, after a short settle wait. It landed when the gh login wrote the same
 * text no earlier than the second the write started, by the local clock against GitHub's creation time; the same text
 * written just before is uncertain, so a fast local clock fails closed rather than resends.
 * @param processes - The engine's process runner.
 * @param started - When the write started.
 * @param text - The comment body or issue title the write sent.
 * @param list - Lists what the write may have made.
 * @returns The landed write's URL, uncertain when the read-back fails or is ambiguous, or none.
 */
async function findLanded(processes: ProcessPort, started: number, text: string, list: WrittenList): Promise<Landed> {
  await runProcess(processes, ['sleep', String(settleSeconds)])
  const login = await readGhLogin(processes)
  const written = await list(processes)
  if (!login.isOk || !written.isOk) return { kind: 'uncertain' }
  // why: GitHub stamps creation to the second, so the start is floored to match.
  const since = Math.floor(started / 1000) * 1000
  const matches = written.value.filter(each => each.text === text && each.author === login.value)
  const found = matches.find(each => Date.parse(each.createdAt) >= since)
  if (found) return { kind: 'found', url: found.url }
  return matches.some(each => Date.parse(each.createdAt) >= since - clockSlackMs) ? { kind: 'uncertain' } : { kind: 'none' }
}

/**
 * Lists an issue's comments as a read-back compares them.
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @returns The comments, or the read failure.
 */
async function readCommentsAsWritten(processes: ProcessPort, issue: number): Promise<Result<Written[]>> {
  const comments = await readAuthoredComments(processes, issue)
  return comments.isOk ? succeed(comments.value.map(comment => ({ url: comment.url, text: comment.body, author: comment.author, createdAt: comment.createdAt }))) : comments
}

/**
 * Lists the repository's newest issues as a read-back compares them.
 * @param processes - The engine's process runner.
 * @returns The issues, or the read failure.
 */
async function readCreatedIssues(processes: ProcessPort): Promise<Result<Written[]>> {
  const listed = await runGh(processes, ['api', 'repos/{owner}/{repo}/issues?state=all&sort=created&direction=desc&per_page=30', '--jq',
    '.[] | {url: .html_url, text: .title, author: .user.login, createdAt: .created_at}'], 'read')
  if (!listed.isOk) return listed
  const rows = filterRecords(listed.value.split('\n').filter(Boolean).map(line => parseJson(line)).map(row => row.isOk ? row.value : null))
  return succeed(rows.map(row => ({ url: toStringOrEmpty(row.url), text: toStringOrEmpty(row.text), author: toStringOrEmpty(row.author), createdAt: toStringOrEmpty(row.createdAt) })))
}

/**
 * Reads the repository's issues page, where a user checks a write that may have landed.
 * @param processes - The engine's process runner.
 * @returns Its URL, or a pointer to it when the repository cannot be read.
 */
async function readIssuesUrl(processes: ProcessPort): Promise<string> {
  const repository = await readGraphql(processes, 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){url}}')
  return repository.isOk && typeof repository.value.url === 'string' ? `${repository.value.url}/issues` : "the repository's issues"
}
