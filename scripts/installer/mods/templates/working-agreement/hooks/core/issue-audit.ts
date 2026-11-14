import type { AuditFinding, AuditResult, IssueAudit, ProcessState } from '../../types'
import { auditIssue, describeAuditRunning, describeAuditUnfinished, describeStartUnread, describeTrackingFailure, describeUnsearchedBefore } from '../domain/issue-audit'
import type { AuditedIssue } from '../domain/issue-audit'
import type { Session } from '../domain/records'
import { isFiniteNumber, isRecord, isStringArray } from '../lib/guards'
import { parseJson, readText, toStringOrEmpty } from '../lib/json'
import type { ProcessPort } from '../lib/process'
import { fail, settle, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { readGraphql, readRepositoryIdentity, runGh } from '../lib/github'
import type { EnginePort } from './engine-port'
import { readIssuesConfig } from './issue-write'
import { isReplacedIn, readLoadId, readProcessState, updateProcessState } from './process-state'
import { readSession, unitLogPath, updateSession } from './record-store'
import { sessionMemory, unknownChat, withRecordLock } from './session-memory'
import { moduleState } from '../lib/module-state'

/** The turn-end audit this load runs now, which a handoff waits for; null before the first. */
interface AuditRun { current: Promise<void> | null }

const auditRun = moduleState((): AuditRun => ({ current: null }))

/**
 * Reads the audit's window: the session's start, or the window a handoff carried when it opened earlier, as `/clear` restarts the start.
 * @param port - The engine calls.
 * @param carried - The window a handoff carried, if any.
 * @returns The window's start in epoch milliseconds, or why the session's start could not be read.
 */
async function readWindow(port: EnginePort, carried: number | undefined): Promise<Result<number>> {
  const started = await settle(port.readSessionStart())
  if (!started.isOk) return started
  return succeed(carried === undefined ? started.value : Math.min(started.value, carried))
}

/**
 * Reads the repository's owner/name, which the checks the audit names run against.
 * @param port - The engine calls.
 * @returns The owner/name, or why it could not be read.
 */
async function readRepositoryName(port: EnginePort): Promise<Result<string>> {
  const read = await settle(readGraphql(port.processes, 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){nameWithOwner defaultBranchRef{name}}}'))
  const repository = read.isOk ? read.value : read
  if (!repository.isOk) return repository
  const identity = readRepositoryIdentity(repository.value)
  return identity ? succeed(identity.nameWithOwner) : fail('unreadable gh output')
}

/**
 * Reads the UTC day the unit's flow was declared, the first line of its flow log, from which a search by hand finds every write of it.
 * @param port - The engine calls.
 * @param session - The session.
 * @returns The day as YYYY-MM-DD, or why it could not be read.
 */
async function readDeclarationDay(port: EnginePort, session: Session): Promise<Result<string>> {
  const declared = await readDeclarationTime(port, session)
  return declared.isOk ? succeed(new Date(declared.value).toISOString().slice(0, 10)) : declared
}

/**
 * Reads when the unit's flow was declared, the first line of its flow log, which bounds every write of the unit.
 * @param port - The engine calls.
 * @param session - The session.
 * @returns The time in epoch milliseconds, or why it could not be read.
 */
async function readDeclarationTime(port: EnginePort, session: Session): Promise<Result<number>> {
  const unit = session.unit
  if (!unit) return fail('this chat declares no unit')
  const text = await settle(unitLogPath(port, unit).then(path => readText(port.files, path)))
  if (!text.isOk) return text
  if (text.value === undefined) return fail('the unit\'s flow log does not exist')
  const first = parseJson(text.value.split('\n')[0] ?? '')
  return first.isOk && isRecord(first.value) && isFiniteNumber(first.value.at) ? succeed(first.value.at) : fail('the first line of the unit\'s flow log carries no time')
}

/**
 * Words why the issues created outside the tools were not searched, with the search to run by hand.
 * @param port - The engine calls.
 * @param session - The session.
 * @param why - Why the session's start could not be read.
 * @returns The pending reason.
 */
async function describeUnsearched(port: EnginePort, session: Session, why: string): Promise<string> {
  return describeStartUnread(why, await readRepositoryName(port), await readDeclarationDay(port, session))
}

/**
 * Adds an issue an issue tool wrote to the ones the audit re-reads.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns Once the issue is on record.
 * @throws When the record could not be written.
 */
export async function trackIssue(port: EnginePort, issue: number): Promise<void> {
  await withRecordLock(() => updateSession(port, session => {
    const audit = session.audit ?? { issues: [] }
    return audit.issues.includes(issue) ? null : { ...session, audit: { ...audit, issues: [...audit.issues, issue] } }
  }))
}

/**
 * Words an issue tool's answer when its write landed and tracking the issue failed, naming the check to run by hand.
 * @param port - The engine calls.
 * @param outcome - The tool's own outcome.
 * @param issue - The written issue.
 * @param why - Why the tracking write failed.
 * @returns The answer's text.
 */
export async function describeUntracked(port: EnginePort, outcome: string, issue: number, why: string): Promise<string> {
  return describeTrackingFailure(outcome, issue, why, await readRepositoryName(port))
}

/**
 * Builds the audit a handoff carries into the new chat once the ending turn's audit settled: its tracked issues and last result, and
 * its window, read before `/clear` restarts the session's start. When that read fails, the window is the unit's declaration; when that
 * cannot be read either, the new chat searches from the handoff, and a note names the window before it as unsearched.
 * @param port - The engine calls.
 * @param previous - The chat the handoff leaves.
 * @returns The audit to carry.
 */
export async function carryAudit(port: EnginePort, previous: Session): Promise<IssueAudit> {
  // why: the turn the handoff ends runs its audit beside it, and the new chat carries that turn's result, never the one before it or the marker.
  await auditRun.current
  const read = await settle(readSession(port))
  const recorded = (read.isOk ? read.value.audit : previous.audit) ?? { issues: [] }
  // why: the note is this chat's, which the new chat's id never reads, so a result it marks as not recorded is carried as pending.
  const note = read.isOk ? read.value.auditNote : undefined
  const stale = !read.isOk ? `the audit could not be read before the handoff (${read.error})`
    : note ? `the last audit's result was ${note.kind === 'unrecorded' ? 'not recorded' : 'not known to be recorded'} before the handoff (${note.reason})` : null
  const audit = stale ? { ...recorded, result: carryPending(recorded.result, `${stale}; it runs again at the next turn end`) } : recorded
  const window = await readWindow(port, audit.since)
  if (window.isOk) return { ...audit, since: window.value }
  // why: the start is gone once /clear restarts it, so a window this read cannot give is taken from the unit's declaration, which bounds every write of the unit.
  const declared = audit.since === undefined ? await readDeclarationTime(port, previous) : succeed(audit.since)
  if (declared.isOk) return { ...audit, since: declared.value }
  // why: the new chat searches from the handoff on, so the note names exactly the window before it that no audit searches.
  const at = await port.now()
  const unsearched = describeUnsearchedBefore(at, window.error, await readRepositoryName(port), fail(declared.error))
  return { ...audit, since: at, unsearched }
}

/**
 * Turns a result a handoff cannot vouch for into a pending one, keeping every finding it held so none is hidden.
 * @param result - The result on record.
 * @param reason - Why it is pending.
 * @returns The pending result.
 */
function carryPending(result: AuditResult | undefined, reason: string): AuditResult {
  const findings = result?.state === 'violations' || result?.state === 'pending' ? result.findings ?? [] : []
  return { state: 'pending', reason, ...findings.length ? { findings } : {} }
}

/**
 * Finds the issues the user's account opened since the window opened whose body references one of the unit's issues,
 * the trace of a write that bypassed the issue tools.
 * @param processes - The engine's process runner.
 * @param since - When the window opened, in epoch milliseconds.
 * @param referenced - The unit's issues.
 * @returns The issue numbers, or the read failure.
 */
async function findAuthored(processes: ProcessPort, since: number, referenced: number[]): Promise<Result<number[]>> {
  const created = new Date(since).toISOString().replace(/\.\d+Z$/, 'Z')
  // why: search reads the creation date and the author, which the issues endpoint cannot filter on; gh fills {owner}/{repo} in the endpoint.
  const query = `repo:{owner}/{repo} is:issue author:@me created:>=${created}`
  const listed = await runGh(processes, ['api', `search/issues?per_page=100&q=${encodeURIComponent(query).replace(/%7B/g, '{').replace(/%7D/g, '}')}`,
    '--jq', `.items[] | select((.body // "") | test("#(${referenced.join('|')})\\b")) | .number`], 'read')
  return listed.isOk ? succeed(listed.value.split('\n').filter(Boolean).map(Number)) : fail(`cannot list the issues opened this session: ${listed.error}`)
}

/**
 * Reads back the fields the audit checks.
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @returns The issue, or the read failure.
 */
async function readAuditedIssue(processes: ProcessPort, issue: number): Promise<Result<AuditedIssue>> {
  const viewed = await runGh(processes, ['api', `repos/{owner}/{repo}/issues/${issue}`, '--jq', '{title, body, labels: [.labels[].name], assignees: [.assignees[].login]}'], 'read')
  const data = viewed.isOk ? parseJson(viewed.value) : viewed
  if (!data.isOk) return fail(`cannot read #${issue}: ${data.error}`)
  if (!isRecord(data.value) || !isStringArray(data.value.labels) || !isStringArray(data.value.assignees)) return fail(`cannot read #${issue}: unreadable gh output`)
  return succeed({ number: issue, title: toStringOrEmpty(data.value.title), body: toStringOrEmpty(data.value.body), labels: data.value.labels, assignees: data.value.assignees })
}

/**
 * Re-reads every issue the session wrote, through the issue tools or around them, and checks it against the issues config. A window or a
 * search that could not be read still re-reads the tracked issues, and an issue that cannot be read leaves the others read: the audit is
 * then pending with every reason and every finding it established.
 * @param port - The engine calls.
 * @param session - The session, whose unit's issues a bypassing write references.
 * @param window - When the window opened, or why the session's start could not be read.
 * @returns The audit's result, pending on any failed read; undefined when the session wrote no issue.
 */
async function auditSession(port: EnginePort, session: Session, window: Result<number>): Promise<AuditResult | undefined> {
  const referenced = session.issues
  const failures: string[] = []
  // why: with no unit issue to reference, no write around the tools can be found, so an unreadable window hides nothing.
  if (!window.isOk && referenced.length) failures.push(await describeUnsearched(port, session, window.error))
  const authored = window.isOk && referenced.length ? await findAuthored(port.processes, window.value, referenced) : succeed([])
  if (!authored.isOk) failures.push(authored.error)
  const issues = [...new Set([...session.audit?.issues ?? [], ...authored.isOk ? authored.value : []])].sort((a, b) => a - b)
  const findings: AuditFinding[] = []
  const config = issues.length ? await readIssuesConfig(port) : null
  if (config && !config.isOk) failures.push(config.error)
  // why: a read that fails leaves the audit pending, never short of the issues still readable, so every finding it can establish is shown.
  const rules = config?.isOk ? config.value : null
  for (const issue of rules ? issues : []) {
    const read = await readAuditedIssue(port.processes, issue)
    if (read.isOk && rules) findings.push(...auditIssue(rules, read.value))
    else if (!read.isOk) failures.push(read.error)
  }
  if (failures.length) return { state: 'pending', reason: failures.join('; '), ...findings.length ? { findings } : {} }
  if (!issues.length) return undefined
  return findings.length ? { state: 'violations', findings } : { state: 'compliant' }
}

/**
 * Writes the audit's result on the session record, leaving the tracked issues and the carried window as they are.
 * @param port - The engine calls.
 * @param result - The result, undefined when the session wrote no issue.
 * @returns Once written, or at once when the record already holds it.
 * @throws When the record could not be written.
 */
async function writeResult(port: EnginePort, result: AuditResult | undefined): Promise<void> {
  await withRecordLock(() => updateSession(port, current => {
    if (!current.audit && !result) return null
    const { result: previous, ...rest } = current.audit ?? { issues: [] }
    if (JSON.stringify(previous) === JSON.stringify(result)) return null
    return { ...current, audit: result ? { ...rest, result } : rest }
  }))
}

/**
 * Sets or clears a chat's note in the process state, which only the load the state records may change.
 * @param state - The process state.
 * @param sessionId - The chat.
 * @param why - Why its result was not written, or null once it was.
 * @returns The next state.
 */
function withAuditNote(state: ProcessState, sessionId: string, why: string | null): ProcessState {
  if (state.loadId !== readLoadId()) return state
  const notes = { ...state.auditUnrecorded }
  if (why === null) delete notes[sessionId]
  else notes[sessionId] = why
  const next: ProcessState = { ...state, auditUnrecorded: notes }
  if (!Object.keys(notes).length) delete next.auditUnrecorded
  return next
}

/**
 * Keeps in this process's state why a chat's last audit result is not on its record, or clears it once a result is, so the pane and the
 * PR step show it across a reload. When the state cannot take the change, this load keeps it in memory, so the PR step stays held; a
 * reload then loses it. A new process starts the state empty, so a crash, then a resume, loses the note, and the record's result stands
 * until the next turn-end audit writes one.
 * @param port - The engine calls.
 * @param why - Why the result was not written, or null once it was.
 * @returns Once kept.
 */
async function noteUnrecorded(port: EnginePort, why: string | null): Promise<void> {
  // why: a chat whose id cannot be read keeps the note in this load's memory under its own key, which every chat this load shows reads; the state has no key a reader would find.
  const sessionId = await port.readSessionId().catch(() => unknownChat)
  const held = await readProcessState(port)
  // why: a load a reload replaced owns neither the pane nor the state, so it leaves the note to the newer load, whose own turn-end audit writes a result or the note.
  if (held && isReplacedIn(held)) return
  const isOwner = !!held && held.loadId === readLoadId() && sessionId !== unknownChat
  const written = !isOwner ? fail(sessionId === unknownChat ? 'the chat\'s id could not be read' : !held ? 'it could not be read'
    : held.loadId === undefined ? 'this mod load is not recorded in the process state yet' : 'the process state records another mod load')
    : held.auditUnrecorded?.[sessionId] === (why ?? undefined) ? succeed(held)
      : await settle(updateProcessState(port, state => withAuditNote(state, sessionId, why)))
  if (written.isOk) for (const key of [sessionId, unknownChat]) sessionMemory.auditUnrecorded.delete(key)
  // why: the state may still hold a note this clear could not remove, which this load's null overrides while it runs.
  else sessionMemory.auditUnrecorded.set(sessionId, why === null ? null : `${why}; the process state could not keep this note either (${written.error}), so a reload loses it`)
}

/**
 * Audits the session's issues and records the result, so the pane lists every finding and the PR step waits on them. The record says
 * an audit runs before it starts, so an earlier result never stands as this turn's; a result that cannot be written is replaced by
 * one saying the audit did not finish.
 * @param port - The engine calls.
 * @returns Why the audit's result is not on the record, or null when it is or there was nothing to audit.
 */
async function auditAndRecord(port: EnginePort): Promise<string | null> {
  const session = await readSession(port)
  if (!session.audit && !session.issues.length) return null
  const marked = await settle(writeResult(port, { state: 'pending', reason: describeAuditRunning(await port.now()) }))
  // why: a marker that did not land leaves the earlier result standing while the audit runs, which this process's state says until a result lands.
  if (!marked.isOk) await noteUnrecorded(port, marked.error)
  const result = await auditSession(port, session, await readWindow(port, session.audit?.since))
  const written = await settle(writeResult(port, result))
  if (written.isOk) return null
  const unfinished = await settle(writeResult(port, { state: 'pending', reason: describeAuditUnfinished(written.error) }))
  return unfinished.isOk ? null : written.error
}

/**
 * Runs the turn-end audit and says on the pane, through this process's state, when its result could not be recorded. The run is held
 * from its first step, so a handoff that ends this turn carries the result it writes.
 * @param port - The engine calls.
 * @returns Once the result or its absence is recorded.
 */
export function runIssueAudit(port: EnginePort): Promise<void> {
  const run = (async (): Promise<void> => {
    const recorded = await settle(auditAndRecord(port))
    await noteUnrecorded(port, recorded.isOk ? recorded.value : recorded.error)
  })()
  auditRun.current = run
  return run
}
