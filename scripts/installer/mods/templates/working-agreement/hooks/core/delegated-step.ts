import { isCoordinatorSession } from '../domain/coordinator'
import { readDecisionReasoning } from '../domain/delegated-decision'
import { coversIssues } from '../domain/delegation'
import { describeDiagnoseNeed } from '../domain/instruction'
import { clipText, coordinatorAddress, envelopeVersion, unitAddress } from '../domain/mail'
import type { Envelope, StepTerms } from '../domain/mail'
import { deriveReplyId } from '../domain/mail-reply'
import { markForAgent } from '../domain/messages'
import { pinDiagnosedRed } from '../domain/records'
import { choiceRelayLimit, composeStepCommand, describeUnpinned, relayContract, judgeStepDecision, nameStep, parseStepCommand } from '../domain/user-step'
import type { UserStep } from '../domain/user-step'
import { isNonEmptyString, isRecord, isSafeInteger } from '../lib/guards'
import { readAuthoredComment, readGhLogin } from '../lib/github'
import type { AuthoredComment } from '../lib/github'
import { readJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import { fail, formatErrorLine, settle, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { readDiagnoseWait } from './approval-gate'
import { findLiveDelegation, readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { sendMail } from './mailbox'
import { replyStepDone } from './owed-done'
import { atomicCreate, atomicReplace, readCommonDir, readSession, recordsPath } from './record-store'
import { readLatestRetirement } from './retire'
import { progressPath, readProgressFile, readSpawnedSession } from './spawn'
import { sessionMemory, withRecordLock } from './session-memory'
import { runApproveStep, runFollowUpStep, runSkipStep } from './user-steps'
import { readFullKeeping } from './process-state'

/**
 * A step's outcome a module returned to its agent with the decision's Choice, kept until a later injection point of that module clears it:
 * a process that ends first leaves it for this session's next process to show again. `outcome` is the sentence the agent was shown.
 */
interface PendingShow { session: string; step: string; from: string; issue: number; seq: number; createdAt: string; outcome: string }

/** Where a delegated decision came from, written by the coordinator's own mod when it posted the comment, and whether a step used it. */
interface DecisionRecord {
  v: 1; url: string; issue: number; coordinatorSessionId: string; bodySha256: string; at: string
  /** The unit session that claimed the decision's step, before it ran: a decision authorises one step, once. */
  consumedBy?: string; consumedAt?: string
  /** The step message that claimed it and the claim's token, written with consumedBy. */
  step?: string; claim?: string
  /** The step's outcome, written once it is known: a claim with none is a step whose effect is unknown, never run again. */
  outcome?: string
  /** How often each step message about the decision was tried, so one that keeps throwing is closed. */
  attempts?: Record<string, number>
  /** The step outcome shown with this decision's Choice that no later injection point acknowledged yet; claim ownership never depends on it. */
  pending?: PendingShow
}

/** A decision a check accepted: its record and its comment as read now. */
interface CheckedDecision { record: DecisionRecord; comment: AuthoredComment }

/** A decision record as read: found, confirmed absent or no valid record, or unreadable, where what it holds is unknown. */
type DecisionRead = { kind: 'found'; record: DecisionRecord } | { kind: 'none' } | { kind: 'unreadable'; error: string }

/** What a close shows of its decision's terms: the Choice or a note on why it cannot be shown, or nothing, with why for the done. */
type CloseTerms = StepTerms | { kind: 'none'; why: string }

/**
 * Which path reached a close, which sets the words before its outcome: only a close whose check ran says the decision was checked.
 * `earlier` is a claim this session took after a check in an earlier try.
 */
type ClosePath = 'checked' | 'earlier' | 'unchecked' | 'unreadable' | 'other' | 'capped'

/** A claim's outcome: taken; not taken, with nothing changed; or written but not read back, so the step did not run. */
type Claim = { kind: 'claimed' } | { kind: 'refused'; text: string } | { kind: 'unknown'; text: string }

/** What a close returns: the entry the model is shown, the terms that follow it, and the decision whose pending mark it wrote. */
export interface StepClose { body: string; terms: StepTerms | null; marked: string | null }

/** A step outcome shown again from its pending mark, with its terms and its decision's URL. */
interface Recovered { envelope: Envelope; terms: StepTerms; url: string }

/** What an injection point found of the pending marks: the outcomes to show again, and the notes new to the agent. */
export interface PendingCheck { recovered: Recovered[]; notes: string[] }

/** A step message's check: passed, with the step and its Choice, or refused, with the path its refusal reached. */
type StepCheck = { kind: 'passed'; step: UserStep; choice: string } | { kind: 'refused'; path: ClosePath; error: string }

/** What a pending mark's write established: whether it was written, and whether it also recorded an outcome its own write had lost. */
interface MarkWrite { error: string | null; isOutcomeKept: boolean }

const bucket = 'dd'
// why: a step that throws stays claimed in cur/ and is tried again at each injection point, so a fault that persists needs an end.
const attemptCap = 3
// why: a step's command and outcome carry the user's free reason, so the done keeps only their start and stays within one message.
const stepCommandChars = 200
const stepTextChars = 2000
// why: the done carries the shown-or-not line after the outcome, so the outcome is cut first and the line always fits in one message.
const doneOutcomeChars = 6000
const shownLine = 'its decision\'s Choice is shown to the agent with this outcome'
const pathWords: Record<ClosePath, string> = {
  checked: 'checked its delegated decision', earlier: 'checked its delegated decision, when this session claimed it,', unchecked: 'did not check its delegated decision',
  unreadable: 'could not read the decision record of', other: 'found', capped: 'stopped trying the step on its delegated decision',
}

/**
 * Names a decision's provenance record, by the comment's id.
 * @param common - The git common directory.
 * @param url - The decision comment's URL.
 * @returns The path, or null when the URL names no comment.
 */
function decisionPath(common: string, url: string): string | null {
  const id = /#issuecomment-(\d+)$/.exec(url)?.[1]
  return id ? recordsPath(common, bucket, `${id}.json`) : null
}

/**
 * Hashes a comment body as GitHub keeps it, line endings and outer whitespace aside.
 * @param body - The markdown.
 * @returns The SHA-256, in hex.
 */
async function hashBody(body: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.replace(/\r\n/g, '\n').trim()))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Records where a delegated decision came from, once its comment is posted from a coordinator session: only this record lets a step rest on it.
 * Units and the user's own sessions never write one.
 * @param port - The engine calls.
 * @param issue - The issue commented on.
 * @param url - The posted comment's URL.
 * @param body - The posted body.
 * @returns Once written; a session that is no coordinator writes nothing.
 */
export async function recordDecision(port: EnginePort, issue: number, url: string, body: string): Promise<void> {
  if (!isCoordinatorSession(await readSession(port))) return
  const common = await readCommonDir(port)
  const path = common ? decisionPath(common, url) : null
  if (!common || !path) return
  const record: DecisionRecord = { v: 1, url, issue, coordinatorSessionId: await port.readSessionId(), bodySha256: await hashBody(body), at: new Date(await port.now()).toISOString() }
  await executeProcess(port.processes, ['mkdir', '-p', '--', recordsPath(common, bucket)])
  await atomicCreate(port, recordsPath(common, bucket), path, JSON.stringify(record))
}

/**
 * Reads a decision's provenance record, telling a record that is not there from one that could not be read.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param url - The decision comment's URL.
 * @returns The record; none when there is none or it is no valid record; unreadable, with the error, when the file could not be read or parsed.
 */
async function readDecisionRecord(port: EnginePort, common: string, url: string): Promise<DecisionRead> {
  const path = decisionPath(common, url)
  if (!path) return { kind: 'none' }
  const read = await readJson(port.files, path).then(value => ({ value }), (error: unknown) => ({ error: formatErrorLine(error) }))
  if ('error' in read) return { kind: 'unreadable', error: read.error }
  const record = parseDecisionRecord(read.value, url)
  return record ? { kind: 'found', record } : { kind: 'none' }
}

/**
 * Reads a decision record from its parsed file.
 * @param value - The parsed file.
 * @param url - The decision comment's URL it must name.
 * @returns The record, or null when it is no valid record of that decision.
 */
function parseDecisionRecord(value: unknown, url: string): DecisionRecord | null {
  if (!isRecord(value) || value.v !== 1 || value.url !== url || typeof value.issue !== 'number' || typeof value.coordinatorSessionId !== 'string'
    || typeof value.bodySha256 !== 'string' || typeof value.at !== 'string') return null
  const attempts = isRecord(value.attempts) ? Object.fromEntries(Object.entries(value.attempts).filter((entry): entry is [string, number] => typeof entry[1] === 'number')) : undefined
  return { v: 1, url, issue: value.issue, coordinatorSessionId: value.coordinatorSessionId, bodySha256: value.bodySha256, at: value.at,
    ...typeof value.consumedBy === 'string' ? { consumedBy: value.consumedBy } : {}, ...typeof value.consumedAt === 'string' ? { consumedAt: value.consumedAt } : {},
    ...typeof value.step === 'string' ? { step: value.step } : {}, ...typeof value.claim === 'string' ? { claim: value.claim } : {},
    ...typeof value.outcome === 'string' ? { outcome: value.outcome } : {}, ...attempts ? { attempts } : {}, ...parsePending(value.pending) }
}

/**
 * Reads a record's pending mark, dropping one that is not well-formed.
 * @param value - The parsed field.
 * @returns The mark as a record field, or no field.
 */
function parsePending(value: unknown): { pending?: PendingShow } {
  if (!isRecord(value)) return {}
  const { session, step, from, issue, seq, createdAt, outcome } = value
  return isNonEmptyString(session) && isNonEmptyString(step) && isNonEmptyString(from) && isSafeInteger(issue) && isSafeInteger(seq) && typeof createdAt === 'string'
    && typeof outcome === 'string' ? { pending: { session, step, from, issue, seq, createdAt, outcome } } : {}
}

/**
 * Words who claimed a decision and what the record holds of the outcome: consumedBy is written before the step runs, so it names a claim, never an application.
 * @param record - The decision's record.
 * @returns The phrase, such as `claimed by <session> for step <id> at <time> (no outcome recorded)`.
 */
const describeClaim = (record: DecisionRecord): string => `claimed by ${record.consumedBy ?? 'an unrecorded session'} for step ${record.step ?? '(unrecorded)'} `
  + `at ${record.consumedAt ?? 'an unrecorded time'} (${record.outcome ? `outcome: ${clipText(record.outcome, stepCommandChars)}` : 'no outcome recorded'})`

/**
 * Words a decision record that could not be read, naming the file to check.
 * @param common - The git common directory.
 * @param url - The decision comment's URL.
 * @param error - Why the read failed.
 * @returns The phrase.
 */
const describeUnreadable = (common: string, url: string, error: string): string => `its decision record ${decisionPath(common, url) ?? url} could not be read (${error})`

/**
 * Checks a decision against the step it authorises: recorded by this coordinator for this issue, its live body unchanged since, not used yet,
 * and its text naming the step and citing what it rests on.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param check - The decision's URL, its issue, the coordinator it must come from, the step, and an approval's red command.
 * @returns The record and the comment read now, or the first unmet check.
 */
async function checkDecision(port: EnginePort, common: string, check: { url: string; issue: number; coordinator: string; step: UserStep; red: string }): Promise<Result<CheckedDecision>> {
  const { url, issue, coordinator, step, red } = check
  if (!new RegExp(`/issues/${issue}#issuecomment-\\d+$`).test(url)) return fail(`${url} is not a comment of #${issue}`)
  const read = await readDecisionRecord(port, common, url)
  if (read.kind === 'unreadable') return fail(`${describeUnreadable(common, url, read.error)}, so whether it authorises ${nameStep(step)} is unknown; check that file`)
  const record = read.kind === 'found' ? read.record : null
  if (!record || record.issue !== issue) return fail(`${url} is not a delegated decision this coordinator's mod recorded on #${issue}: post it with issue_comment from the coordinator first`)
  if (record.coordinatorSessionId !== coordinator) return fail(`${url} was recorded by another coordinator session than ${coordinator}`)
  if (record.consumedBy) return fail(`${url} was already ${describeClaim(record)}: a decision authorises one step, once`)
  const comment = await readAuthoredComment(port.processes, issue, url)
  if (!comment.isOk) return comment
  if (await hashBody(comment.value.body) !== record.bodySha256) return fail(`${url} was edited after the coordinator posted it`)
  const defect = judgeStepDecision(comment.value.body, step, red)
  return defect ? fail(`${url} does not authorise ${nameStep(step)}: ${defect}`) : succeed({ record, comment: comment.value })
}

/**
 * Relays a user's step to a delegated unit as a step message, after checking its decision as the unit will: the message authorises nothing
 * by itself, and the unit's mod applies the step only after its own check.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @param decision - The delegated decision comment's URL.
 * @param step - The step.
 * @param red - For an approval, the red command the diagnosis was written on; empty otherwise.
 * @returns What was sent, or the first unmet check.
 */
export async function relayStep(port: EnginePort, issue: number, decision: string, step: UserStep, red = ''): Promise<Result<string>> {
  const scope = await readOwnScope(port)
  if (!scope || !coversIssues(scope, [issue])) return fail(`#${issue} is not in this coordinator's delegation scope, so ${nameStep(step)} there is the user's`)
  if (!await readSpawnedSession(port, issue, false)) return fail(`#${issue} has no unit spawn started: start it with spawn`)
  const common = await readCommonDir(port)
  if (!common) return fail('this session is not inside a git repository, which holds the records')
  const checked = await checkDecision(port, common, { url: decision, issue, coordinator: scope.sessionId, step, red })
  if (!checked.isOk) return checked
  const choice = readDecisionReasoning(checked.value.comment.body)?.choice ?? ''
  if (choice.length > choiceRelayLimit) {
    return fail(`${decision} does not authorise ${nameStep(step)}: its Choice is ${choice.length} characters, over the ${choiceRelayLimit} a step carries to the unit whole; `
      + 'shorten the Choice and move the detail to a linked comment, then post a new decision.')
  }
  const sent = await sendMail(port, { kind: 'step', to: unitAddress(issue), issue, body: composeStepCommand(step),
    refs: [decision, ...step.kind === 'approve' ? [step.diagnosis] : []] })
  return sent.isOk ? succeed(markForAgent(`Sent ${nameStep(step)} to #${issue} as step ${sent.value}; the unit's mod checks ${decision} again before it acts. `
    + `${relayContract} The done arrives in this session's mailbox.`)) : sent
}

/**
 * Reads when this issue's unit was started: a decision posted earlier belongs to an earlier unit, such as one since retired.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @param url - The decision comment's URL, which the failure names.
 * @returns The time in epoch ms, the latest retirement's for a unit spawn started before it kept one, else 0; or why the spawn record could not be read.
 */
async function readUnitStart(port: EnginePort, common: string, issue: number, url: string): Promise<Result<number>> {
  const progress = await settle(readProgressFile(port, common, issue, true))
  if (!progress.isOk) {
    return fail(`the spawn record ${progressPath(common, issue)} could not be read (${progress.error.split('\n')[0]}), so whether ${url} was posted after this unit started is unknown; check that file`)
  }
  const started = Date.parse(progress.value.startedAt ?? '')
  return succeed(Number.isFinite(started) ? started : (await readLatestRetirement(port, issue))?.at ?? 0)
}

/**
 * Checks a step message a unit received, everything the coordinator checked and more: from the live coordinator of its delegation, about a
 * decision on the unit's issue that this coordinator recorded, unchanged, unused, newer than the unit, written by the gh user, and for an
 * approval while the Diagnose waits, the red pinned before the diagnosis.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param envelope - The step message.
 * @returns The step and its decision's Choice as checked, or the first unmet check with the path it reached: unchecked before the decision is read.
 */
async function checkStepMail(port: EnginePort, common: string, envelope: Envelope): Promise<StepCheck> {
  const refuse = (path: ClosePath, error: string): StepCheck => ({ kind: 'refused', path, error })
  const step = parseStepCommand(envelope.body)
  if (!step) return refuse('unchecked', 'the message carries no step command')
  const scope = await findLiveDelegation(port, [envelope.issue])
  if (!scope || envelope.from !== coordinatorAddress(scope.sessionId)) return refuse('unchecked', `${envelope.from} is not the live coordinator that delegates #${envelope.issue}`)
  const decision = envelope.refs[0] ?? ''
  const red = step.kind === 'approve' ? await readApprovalRed(port, step.diagnosis, step.red) : succeed('')
  if (!red.isOk) return refuse('unchecked', red.error)
  const checked = await checkDecision(port, common, { url: decision, issue: envelope.issue, coordinator: scope.sessionId, step, red: red.value })
  if (!checked.isOk) return refuse('checked', checked.error)
  const start = await readUnitStart(port, common, envelope.issue, decision)
  if (!start.isOk) return refuse('checked', start.error)
  if (Date.parse(checked.value.comment.createdAt) <= start.value) return refuse('checked', `${decision} was posted before this unit started`)
  const login = await readGhLogin(port.processes)
  if (!login.isOk) return refuse('checked', login.error)
  if (checked.value.comment.author !== login.value) return refuse('checked', `${decision} was written by ${checked.value.comment.author || 'someone else'}, not by ${login.value}`)
  return { kind: 'passed', step, choice: readDecisionReasoning(checked.value.comment.body)?.choice ?? '' }
}

/**
 * Reads the red an approval of a diagnosis pins, once this unit's Diagnose waits for it: the cited red before the diagnosis comment, or
 * the only one when the step cites none, as an older coordinator's relay does.
 * @param port - The engine calls.
 * @param diagnosis - The diagnosis comment's URL.
 * @param cited - The red the step cites, as its exact argv.
 * @returns The red command, argv joined by spaces, or why there is nothing to approve.
 */
async function readApprovalRed(port: EnginePort, diagnosis: string, cited?: string[]): Promise<Result<string>> {
  const session = await readSession(port)
  const wait = session.unit ? await readDiagnoseWait(port, session.unit, session.flow) : null
  if (!wait) return fail('this unit has no Diagnose to approve')
  if (wait.judgement.done) return fail('this unit\'s Diagnose is already approved')
  if (!wait.judgement.isWaitingApproval) return fail(wait.unread ?? `this unit's Diagnose is not waiting for approval: ${describeDiagnoseNeed(wait.judgement.need, session.unit?.issues ?? [])}`)
  const comment = wait.comments.find(each => each.url === diagnosis)
  if (!comment) return fail(`${diagnosis} is not a comment of this unit's issues`)
  const pin = pinDiagnosedRed(wait.unit.runs, Date.parse(comment.createdAt), cited)
  return pin.kind === 'pinned' ? succeed(pin.red.argv.join(' ')) : fail(describeUnpinned(pin, diagnosis, cited))
}

/**
 * Counts a try of a step message on its decision's record, before anything else runs, so a step that throws on every try is closed at
 * the cap whatever threw. A decision another step claimed is left as it is, since that step is refused.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param envelope - The step message.
 * @returns The record as written, or as read when there is none to count on or it could not be read.
 */
async function countAttempt(port: EnginePort, common: string, envelope: Envelope): Promise<DecisionRead> {
  const path = decisionPath(common, envelope.refs[0] ?? '')
  const read = await readDecisionRecord(port, common, envelope.refs[0] ?? '')
  if (!path || read.kind !== 'found' || (read.record.consumedBy && read.record.step !== envelope.id)) return read
  const counted = { ...read.record, attempts: { ...read.record.attempts, [envelope.id]: (read.record.attempts?.[envelope.id] ?? 0) + 1 } }
  await atomicReplace(port, path, JSON.stringify(counted))
  return { kind: 'found', record: counted }
}

/**
 * Claims a checked decision for a step message before the step runs: consumedBy, the step and a token, read back so a claim that lost
 * a race is never taken for this one.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param envelope - The step message.
 * @param token - This claim's token.
 * @returns Claimed; refused, with its outcome line, when nothing changed; or unknown when the claim was written but not read back; a failed write rejects.
 */
async function claimDecision(port: EnginePort, common: string, envelope: Envelope, token: string): Promise<Claim> {
  const url = envelope.refs[0] ?? ''
  const path = decisionPath(common, url)
  const read = await readDecisionRecord(port, common, url)
  if (read.kind === 'unreadable') return { kind: 'refused', text: `refused: ${describeUnreadable(common, url, read.error)} to claim it; nothing changed` }
  if (!path || read.kind === 'none') return { kind: 'refused', text: `refused: ${url} has no decision record left to claim; nothing changed` }
  if (read.record.consumedBy) return { kind: 'refused', text: `refused: ${url} was already ${describeClaim(read.record)}: a decision authorises one step, once; nothing changed` }
  await atomicReplace(port, path, JSON.stringify({ ...read.record, consumedBy: await port.readSessionId(), consumedAt: new Date(await port.now()).toISOString(), step: envelope.id, claim: token }))
  const back = await readDecisionRecord(port, common, url)
  if (back.kind === 'found' && back.record.claim === token) return { kind: 'claimed' }
  // why: the claim was written, so a read-back that fails or finds another claim leaves the step not run, and the record's state is unknown or someone else's.
  if (back.kind === 'unreadable') {
    return { kind: 'unknown', text: `did not finish: the claim was written but ${describeUnreadable(common, url, back.error)} back, so the step did not run and whether its decision stays claimed is unknown; check that file before relaying it again` }
  }
  return { kind: 'refused', text: `refused: ${url} was ${back.kind === 'found' && back.record.consumedBy ? describeClaim(back.record) : 'left unclaimed'} meanwhile, so this try did not run the step` }
}

/**
 * Records a claimed step's outcome on its decision's record.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param envelope - The step message.
 * @param token - The claim's token.
 * @param outcome - The outcome line.
 * @returns Once written; a failed write, or a claim that is no longer this one, rejects.
 */
async function recordOutcome(port: EnginePort, common: string, envelope: Envelope, token: string, outcome: string): Promise<void> {
  const url = envelope.refs[0] ?? ''
  const path = decisionPath(common, url)
  const read = await readDecisionRecord(port, common, url)
  if (read.kind === 'unreadable') throw new Error(describeUnreadable(common, url, read.error))
  const record = read.kind === 'found' ? read.record : null
  if (!path || record?.claim !== token) throw new Error('the decision record no longer holds this claim')
  await atomicReplace(port, path, JSON.stringify({ ...record, outcome }))
}

/**
 * Releases a claim whose step refused, so its decision may authorise the step again: a refusal changed nothing.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param envelope - The step message.
 * @param token - The claim's token.
 * @returns Once written; a failed write, or a claim that is no longer this one, rejects.
 */
async function releaseClaim(port: EnginePort, common: string, envelope: Envelope, token: string): Promise<void> {
  const url = envelope.refs[0] ?? ''
  const path = decisionPath(common, url)
  const read = await readDecisionRecord(port, common, url)
  if (read.kind === 'unreadable') throw new Error(describeUnreadable(common, url, read.error))
  const record = read.kind === 'found' ? read.record : null
  if (!path || record?.claim !== token) throw new Error('the decision record no longer holds this claim')
  await atomicReplace(port, path, JSON.stringify({ ...record, consumedBy: undefined, consumedAt: undefined, step: undefined, claim: undefined, outcome: undefined }))
}

/**
 * Closes a step message with the mod's done and words what the model is shown in place of its body. A close that shows the Choice marks
 * its decision's record pending first, so a process that ends before the block is injected leaves it for the next one to show again;
 * the done then says whether the Choice is shown, never the Choice itself.
 * @param port - The engine calls.
 * @param envelope - The step message.
 * @param common - The git common directory, null outside a repository.
 * @param close - The path that reached the close, the outcome, such as `applied: …` or `refused: …; nothing changed`, the terms, and an
 * outcome whose own write on the decision failed, with its error, which the pending mark records instead when it can.
 * @returns The entry the model sees, its terms, and the decision whose pending mark was written.
 */
async function closeStep(port: EnginePort, envelope: Envelope, common: string | null,
  close: { path: ClosePath; outcome: string; terms: CloseTerms; unrecorded?: { outcome: string; error: string } }): Promise<StepClose> {
  const url = envelope.refs[0] ?? ''
  const isShown = close.terms.kind === 'shown'
  const head = `this session's mod ${pathWords[close.path]} ${url}${close.path === 'other' ? ' claimed by another session' : ''} and `
  const mark = isShown && common ? await markPending(port, common, envelope, `${head}${clipText(close.outcome, doneOutcomeChars)}`, close.unrecorded?.outcome) : null
  const unmarked = mark?.error ?? null
  const lost = close.unrecorded
  // why: the mark records an outcome its own write lost, so a recovery shows it rather than reporting it unknown.
  const kept = !lost ? '' : mark?.isOutcomeKept ? `; its outcome's own write failed (${lost.error}), but it was recorded with its pending mark, so a recovery of this step shows it`
    : `; its outcome was not recorded (${lost.error}), so a recovery of this step reports it as unknown`
  const outcome = clipText(`${close.outcome}${kept}`, doneOutcomeChars)
  const text = `${head}${outcome}`
  const command = envelope.body.split('\n')[0] ?? ''
  // why: an approval's command holds only the diagnosis URL and the cited red, both of which the coordinator needs whole.
  const shown = clipText(command, command.startsWith('/flow approve ') ? stepTextChars : stepCommandChars)
  const done = await replyStepDone(port, envelope, `Step ${envelope.id} (${shown}) ${outcome}; ${describeTermsLine(close.terms, unmarked)}.`)
  return { body: markForAgent(`The coordinator relayed a step; ${text}. ${done}`), terms: close.terms.kind === 'none' ? null : close.terms,
    marked: isShown && common && unmarked === null ? url : null }
}

/**
 * Words the done's last line: whether the decision's Choice is shown to the agent with this outcome, and why not.
 * @param terms - The close's terms.
 * @param unmarked - Why the pending mark of a shown Choice could not be written, null when it was.
 * @returns The line.
 */
function describeTermsLine(terms: CloseTerms, unmarked: string | null): string {
  if (terms.kind === 'shown') {
    return unmarked === null ? shownLine : `${shownLine}, but ${unmarked}, so if this session's process ends before the agent receives it, `
      + 'it is not shown again; check the unit\'s pane with unit_read'
  }
  const why = terms.kind === 'unread' ? `the decision comment could not be read again: ${terms.error}`
    : terms.kind === 'changed' ? 'the decision body differs from its recorded hash' : terms.why
  return `its decision's Choice is not shown (${why})`
}

/**
 * Reads a claimed decision's Choice again from its comment, for a close that did not check it now: shown only when the body still has
 * the hash recorded when it was checked.
 * @param port - The engine calls.
 * @param record - The decision's record.
 * @returns The terms, or why they are not shown.
 */
async function readTermsAgain(port: EnginePort, record: DecisionRecord): Promise<StepTerms> {
  const comment = await readAuthoredComment(port.processes, record.issue, record.url).catch((error: unknown) => fail(formatErrorLine(error)))
  if (!comment.isOk) return { kind: 'unread', url: record.url, error: comment.error }
  if (await hashBody(comment.value.body) !== record.bodySha256) return { kind: 'changed', url: record.url }
  const reasoning = readDecisionReasoning(comment.value.body)
  return reasoning ? { kind: 'shown', url: record.url, choice: reasoning.choice } : { kind: 'unread', url: record.url, error: 'it is no well-formed delegated decision' }
}

/**
 * Marks a decision's record with the step outcome about to be shown with its Choice, keeping whoever claimed it.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param envelope - The step message.
 * @param outcome - The sentence the agent is shown.
 * @param lost - The step's outcome whose own write failed, recorded with the mark while this session's claim of the step holds none.
 * @returns Null once written, or why it was not, naming the record, and whether the lost outcome was recorded with it.
 */
async function markPending(port: EnginePort, common: string, envelope: Envelope, outcome: string, lost?: string): Promise<MarkWrite> {
  const url = envelope.refs[0] ?? ''
  const path = decisionPath(common, url)
  const failed = (error: string): MarkWrite => ({ error, isOutcomeKept: false })
  if (!path) return failed(`its pending mark has no decision record to go in, since ${url} names no comment`)
  return withRecordLock(async () => {
    const read = await readDecisionRecord(port, common, url)
    if (read.kind === 'unreadable') return failed(`its pending mark could not be written to ${path}, which could not be read (${read.error})`)
    if (read.kind === 'none') return failed(`its pending mark could not be written to ${path}, which holds no decision record`)
    const session = await port.readSessionId()
    const pending: PendingShow = { session, step: envelope.id, from: envelope.from, issue: envelope.issue, seq: envelope.seq, createdAt: envelope.created_at, outcome }
    const isOutcomeKept = lost !== undefined && !read.record.outcome && read.record.step === envelope.id && read.record.consumedBy === session
    return atomicReplace(port, path, JSON.stringify({ ...read.record, ...isOutcomeKept ? { outcome: lost } : {}, pending })).then(() => ({ error: null, isOutcomeKept }),
      (error: unknown) => failed(`its pending mark could not be written to ${path} (${formatErrorLine(error)})`))
  })
}

/**
 * Words a step whose claim this session recorded earlier: its recorded outcome with the done it was sent as, or, with none recorded,
 * an effect the mod cannot establish. The step never runs again.
 * @param envelope - The step message.
 * @param record - Its decision's record.
 * @returns The outcome.
 */
function describeReplay(envelope: Envelope, record: DecisionRecord): string {
  if (!record.outcome) return `did not finish (it was claimed at ${record.consumedAt ?? 'an unrecorded time'} and no outcome was recorded): `
    + 'it may have done part of the step; check /flow status before relaying it again'
  // why: a run that threw records "did not finish", which was tried, not applied.
  const verb = record.outcome.startsWith('applied') ? 'applied' : 'tried'
  return `${verb} earlier (done ${deriveReplyId(envelope.id, unitAddress(envelope.issue))}): ${record.outcome}; check the coordinator's mailbox or /flow status`
}

/**
 * Applies a step message a unit received, after checking it: through the same code the user's typed command runs. The decision is
 * claimed before the step runs and its outcome recorded after, so a step tried again after a throw or a kill is replayed, never run
 * twice. The mod closes the conversation itself with a done naming the outcome, and the model is shown that outcome, then the decision's
 * Choice once the step ran or was found claimed.
 * @param port - The engine calls.
 * @param envelope - The step message, claimed in cur/.
 * @returns What the model sees in place of the message's body, with its terms; a throw leaves the step claimed and owed, to try again.
 */
export async function applyStepMail(port: EnginePort, envelope: Envelope): Promise<StepClose> {
  const refused: CloseTerms = { kind: 'none', why: 'the step was refused' }
  const common = await readCommonDir(port)
  if (!common) return closeStep(port, envelope, null, { path: 'unchecked', outcome: 'refused: this session is not inside a git repository, which holds the records; nothing changed', terms: refused })
  // why: one session owns a unit's mailbox, so this process's record lock serialises every write of the record, and no host-wide lock is taken.
  const url = envelope.refs[0] ?? ''
  // why: a full keeping refuses the step before it is tried, so it never counts against the attempts, and the coordinator is told what it can read.
  const full = await readFullKeeping(port)
  if (full !== null) {
    return closeStep(port, envelope, common, { path: 'unchecked', terms: refused,
      outcome: `refused: ${full} start prompts already wait for this unit's session to be idle, the most it keeps, so the step was not applied; nothing changed and no attempt was counted. Relay it again once they are delivered: unit_read shows how many still wait on the unit's pane, in its Process row` })
  }
  // why: a cross-process race on the claim's token is accepted, since one session owns a unit's mailbox.
  const counted = await withRecordLock(() => countAttempt(port, common, envelope))
  if (counted.kind === 'unreadable') {
    return closeStep(port, envelope, common, { path: 'unreadable', terms: { kind: 'none', why: 'its decision record could not be read' },
      outcome: `did not finish: ${describeUnreadable(common, url, counted.error)}, so whether the step ran is unknown; check that file and /flow status before relaying it again` })
  }
  const record = counted.kind === 'found' ? counted.record : null
  if (record?.step === envelope.id && record.consumedBy === await port.readSessionId()) {
    return closeStep(port, envelope, common, { path: 'earlier', outcome: describeReplay(envelope, record), terms: await readTermsAgain(port, record) })
  }
  // why: a claim another session holds, such as a retired unit's, says nothing this session can establish about the effect.
  if (record?.step === envelope.id && record.consumedBy) {
    return closeStep(port, envelope, common, { path: 'other', terms: await readTermsAgain(port, record),
      outcome: `did not finish here: its decision was ${describeClaim(record)} in another session, so whether the step ran is unknown; check /flow status before relaying it again` })
  }
  if ((record?.attempts?.[envelope.id] ?? 0) > attemptCap) return closeStep(port, envelope, common, { path: 'capped', outcome: `refused after ${attemptCap} tries, none of which applied it; nothing changed`, terms: refused })
  const checked = await checkStepMail(port, common, envelope)
  if (checked.kind === 'refused') return closeStep(port, envelope, common, { path: checked.path, outcome: `refused: ${clipText(checked.error, stepTextChars)}; nothing changed`, terms: refused })
  const token = crypto.randomUUID()
  const claimed = await withRecordLock(() => claimDecision(port, common, envelope, token))
  if (claimed.kind !== 'claimed') {
    return closeStep(port, envelope, common, { path: 'checked', outcome: clipText(claimed.text, stepTextChars),
      terms: claimed.kind === 'unknown' ? { kind: 'none', why: 'the step did not run' } : refused })
  }
  const step = checked.step
  const command = composeStepCommand(step)
  const tail = command.slice(command.indexOf(' ', '/flow '.length) + 1)
  // why: a step that throws may have done part of its work, and its done is still owed to the coordinator.
  const settled = await settle(step.kind === 'approve' ? runApproveStep(port, tail) : step.kind === 'skip' ? runSkipStep(port, tail) : runFollowUpStep(port, tail))
  // why: the user's free reason may fill a message, so it is cut and the mod's own words after it always survive.
  const result = settled.isOk ? settled.value : null
  if (result && !result.isOk) {
    const kept = await withRecordLock(() => releaseClaim(port, common, envelope, token)).then(() => '', (error: unknown) => formatErrorLine(error))
    return closeStep(port, envelope, common, { path: 'checked', terms: refused, outcome: `refused: ${clipText(result.error, stepTextChars)}; ${kept
      ? `the step changed nothing, but releasing its decision failed (${kept}), so it may stay claimed; check ${decisionPath(common, url) ?? url} before relaying it again` : 'nothing changed'}` })
  }
  const outcome = result?.isOk ? `applied: ${clipText(result.value, stepTextChars)}`
    : `did not finish (${settled.isOk ? '' : settled.error.split('\n')[0]}): it may have done part of the step; check /flow status before relaying it again`
  // why: the step already ran, so a failed record must still reach the done rather than drop it.
  const unrecorded = await withRecordLock(() => recordOutcome(port, common, envelope, token, outcome)).then(() => '', (error: unknown) => formatErrorLine(error))
  return closeStep(port, envelope, common, { path: 'checked', terms: { kind: 'shown', url, choice: checked.choice }, outcome,
    ...unrecorded ? { unrecorded: { outcome, error: unrecorded } } : {} })
}

/**
 * Settles the pending marks at an injection point: clears those this module returned at an earlier one, whose hook has finished, and,
 * until one scan of the decision records succeeded in this module, finds this session's marks that no module here returned, as a process
 * that ended before injecting its block leaves them, to show their outcome and terms again. A failure is named once per state and tried
 * again at the next injection point, never taken for a mark cleared or absent.
 * @param port - The engine calls.
 * @param skipped - The steps this injection point shows or replays itself, whose marks it leaves alone.
 * @returns The outcomes to show again, the decisions they mark by step, and the notes new to the agent.
 */
export async function checkPendingMarks(port: EnginePort, skipped: ReadonlySet<string>): Promise<PendingCheck> {
  const check: PendingCheck = { recovered: [], notes: [] }
  const common = await readCommonDir(port)
  if (!common) return check
  const session = await port.readSessionId()
  for (const [url, step] of sessionMemory.shownMarks) {
    const cleared = await withRecordLock(() => clearPending(port, common, url, step, session)).then(() => null, (error: unknown) => formatErrorLine(error))
    noteOnce(check, `clear:${url}`, cleared === null ? null : markForAgent(`The mod could not clear the pending mark of step ${step} in ${decisionPath(common, url) ?? url} `
      + `(${cleared}): its outcome was shown here, but a new process of this session may show it again; it tries again at the next prompt, Stop or denied call; nothing to do.`))
    if (cleared === null) sessionMemory.shownMarks.delete(url)
  }
  // why: a mark whose Choice was not shown yet, as one whose comment could not be read, is read again until it is, and never cleared before.
  for (const [url, step] of sessionMemory.unshownMarks) {
    const path = decisionPath(common, url) ?? url
    const read = await readDecisionRecord(port, common, url)
    noteOnce(check, `read:${path}`, read.kind === 'unreadable' ? markForAgent(`The mod could not read the decision record ${path} (${read.error}), so whether it holds a step's `
      + 'outcome and terms to show again is unknown; it tries again at the next prompt, Stop or denied call; check that file.') : null)
    if (read.kind === 'unreadable' || skipped.has(step)) continue
    const pending = read.kind === 'found' ? read.record.pending : undefined
    if (read.kind !== 'found' || pending?.step !== step || pending.session !== session) {
      sessionMemory.unshownMarks.delete(url)
      continue
    }
    check.recovered.push({ envelope: recoverEnvelope(url, pending), terms: await readTermsAgain(port, read.record), url })
  }
  if (sessionMemory.isPendingScanned) return check
  const directory = recordsPath(common, bucket)
  const names = await listRecords(port, directory)
  noteOnce(check, 'scan', typeof names === 'string' ? markForAgent(`The mod could not list the decision records in ${directory} (${names}), so whether a step's outcome `
    + 'and terms wait to be shown again after a restart is unknown; it tries again at the next prompt, Stop or denied call; to check, look for "pending" in that directory\'s files.') : null)
  if (typeof names === 'string') return check
  const unread: string[] = []
  for (const name of names.filter(each => each.endsWith('.json'))) {
    const path = recordsPath(common, bucket, name)
    const read = await readJson(port.files, path).then(value => ({ value }), (error: unknown) => ({ error: formatErrorLine(error) }))
    noteOnce(check, `read:${path}`, 'error' in read ? markForAgent(`The mod could not read the decision record ${path} (${read.error}), so whether it holds a step's outcome `
      + 'and terms to show again is unknown; it tries again at the next prompt, Stop or denied call; check that file.') : null)
    if ('error' in read) unread.push(path)
    const url = 'value' in read && isRecord(read.value) && typeof read.value.url === 'string' ? read.value.url : ''
    const record = 'value' in read ? parseDecisionRecord(read.value, url) : null
    const pending = record?.pending
    if (!record || !pending || pending.session !== session || sessionMemory.shownMarks.has(url) || sessionMemory.unshownMarks.has(url)) continue
    // why: a step this injection point replays shows its own Choice, but one whose comment cannot be read then leaves the mark to read again.
    if (skipped.has(pending.step)) {
      sessionMemory.unshownMarks.set(url, pending.step)
      continue
    }
    check.recovered.push({ envelope: recoverEnvelope(url, pending), terms: await readTermsAgain(port, record), url })
  }
  sessionMemory.isPendingScanned = unread.length === 0
  return check
}

/**
 * Adds a note to a check when its state is new, and forgets the state once its failure is gone, so a failure that comes back is named again.
 * @param check - The check.
 * @param key - What the note is about.
 * @param note - The note, or null when there is no failure.
 */
function noteOnce(check: PendingCheck, key: string, note: string | null): void {
  if (note === null) {
    sessionMemory.pendingNotes.delete(key)
    return
  }
  if (sessionMemory.pendingNotes.has(key)) return
  sessionMemory.pendingNotes.set(key, 'failed')
  check.notes.push(note)
}

/**
 * Lists the decision records, telling a bucket confirmed missing from one that could not be listed.
 * @param port - The engine calls.
 * @param directory - The bucket.
 * @returns The file names, none for a bucket confirmed missing, or why it could not be listed.
 */
async function listRecords(port: EnginePort, directory: string): Promise<string[] | string> {
  const listed = await port.files.list(directory).then(entries => entries.map(entry => entry.name), (error: unknown) => formatErrorLine(error))
  if (typeof listed !== 'string') return listed
  // why: the engine's rejection carries no documented missing-path code, so only an exists that says no and a stat that finds nothing confirm absence.
  const isPresent = await port.files.exists(directory).then(exists => exists || port.files.stat(directory).then(() => true, () => false), () => true)
  return isPresent ? listed : []
}

/**
 * Clears a decision's pending mark once the block that showed it was returned: only this session's mark for that step, whoever claimed it.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param url - The decision's URL.
 * @param step - The step whose outcome was shown.
 * @param session - This session.
 * @returns Once cleared or found gone; a record that cannot be read or written rejects.
 */
async function clearPending(port: EnginePort, common: string, url: string, step: string, session: string): Promise<void> {
  const path = decisionPath(common, url)
  const read = await readDecisionRecord(port, common, url)
  if (read.kind === 'unreadable') throw new Error(`it could not be read (${read.error})`)
  if (!path || read.kind === 'none' || read.record.pending?.step !== step || read.record.pending.session !== session) return
  await atomicReplace(port, path, JSON.stringify({ ...read.record, pending: undefined }))
}

/**
 * Builds the entry of a step outcome shown again from its pending mark, as the mod's: no done is sent again and nothing is applied again.
 * @param url - The decision's URL.
 * @param pending - The mark.
 * @returns The envelope shown in place of the step message.
 */
function recoverEnvelope(url: string, pending: PendingShow): Envelope {
  return { v: envelopeVersion, id: pending.step, kind: 'step', from: pending.from, to: unitAddress(pending.issue), issue: pending.issue, in_reply_to: '',
    seq: pending.seq, created_at: pending.createdAt, expects: '', attempt: 1, refs: [url], author: 'mod', options: [],
    body: markForAgent(`The coordinator relayed step ${pending.step}; its outcome is shown again: this session may not have received it. ${pending.outcome}. `
      + 'Its done was already sent to the coordinator, or is kept for a resend; nothing was applied again: send nothing about it.') }
}
