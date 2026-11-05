import { isCoordinatorSession } from '../domain/coordinator'
import { coversIssues } from '../domain/delegation'
import { coordinatorAddress, unitAddress } from '../domain/mail'
import type { Envelope } from '../domain/mail'
import { deriveReplyId } from '../domain/mail-reply'
import { markForAgent } from '../domain/messages'
import { findLatestRedBefore } from '../domain/records'
import { composeStepCommand, judgeStepDecision, nameStep, parseStepCommand } from '../domain/user-step'
import type { UserStep } from '../domain/user-step'
import { isRecord } from '../lib/guards'
import { readAuthoredComment, readGhLogin } from '../lib/github'
import type { AuthoredComment } from '../lib/github'
import { readJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { readDiagnoseWait } from './approval-gate'
import { findLiveDelegation, readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { sendMail } from './mailbox'
import { atomicCreate, atomicReplace, readCommonDir, readSession, recordsPath } from './record-store'
import { readLatestRetirement } from './retire'
import { readProgressFile, readSpawnedSession } from './spawn'
import { runApproveStep, runFollowUpStep, runSkipStep } from './user-steps'

/** Where a delegated decision came from, written by the coordinator's own mod when it posted the comment, and whether a step used it. */
interface DecisionRecord {
  v: 1; url: string; issue: number; coordinatorSessionId: string; bodySha256: string; at: string
  /** The unit session that applied the decision's step: a decision authorises one step, once. */
  consumedBy?: string; consumedAt?: string
}

/** A decision a check accepted: its record and its comment as read now. */
interface CheckedDecision { record: DecisionRecord; comment: AuthoredComment }

const bucket = 'dd'

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
 * Reads a decision's provenance record.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param url - The decision comment's URL.
 * @returns The record, or null when there is none or it is no valid record.
 */
async function readDecisionRecord(port: EnginePort, common: string, url: string): Promise<DecisionRecord | null> {
  const path = decisionPath(common, url)
  const value = path ? await readJson(port.files, path).catch(() => undefined) : undefined
  if (!isRecord(value) || value.v !== 1 || value.url !== url || typeof value.issue !== 'number' || typeof value.coordinatorSessionId !== 'string'
    || typeof value.bodySha256 !== 'string' || typeof value.at !== 'string') return null
  return { v: 1, url, issue: value.issue, coordinatorSessionId: value.coordinatorSessionId, bodySha256: value.bodySha256, at: value.at,
    ...typeof value.consumedBy === 'string' ? { consumedBy: value.consumedBy } : {}, ...typeof value.consumedAt === 'string' ? { consumedAt: value.consumedAt } : {} }
}

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
  const record = await readDecisionRecord(port, common, url)
  if (!record || record.issue !== issue) return fail(`${url} is not a delegated decision this coordinator's mod recorded on #${issue}: post it with issue_comment from the coordinator first`)
  if (record.coordinatorSessionId !== coordinator) return fail(`${url} was recorded by another coordinator session than ${coordinator}`)
  if (record.consumedBy) return fail(`${url} already authorised a step, applied by ${record.consumedBy}: a decision authorises one step, once`)
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
  const sent = await sendMail(port, { kind: 'step', to: unitAddress(issue), issue, body: composeStepCommand(step),
    refs: [decision, ...step.kind === 'approve' ? [step.diagnosis] : []] })
  return sent.isOk ? succeed(markForAgent(`Sent ${nameStep(step)} to #${issue} as step ${sent.value}: the unit's mod checks ${decision} again, applies the step or refuses it, `
    + 'and replies done with the outcome; it arrives in this session\'s mailbox.')) : sent
}

/**
 * Reads when this issue's unit was started: a decision posted earlier belongs to an earlier unit, such as one since retired.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @returns The time in epoch ms; the latest retirement's for a unit spawn started before it kept one, else 0.
 */
async function readUnitStart(port: EnginePort, common: string, issue: number): Promise<number> {
  const started = Date.parse((await readProgressFile(port, common, issue, false)).startedAt ?? '')
  return Number.isFinite(started) ? started : (await readLatestRetirement(port, issue))?.at ?? 0
}

/**
 * Checks a step message a unit received, everything the coordinator checked and more: from the live coordinator of its delegation, about a
 * decision on the unit's issue that this coordinator recorded, unchanged, unused, newer than the unit, written by the gh user, and for an
 * approval while the Diagnose waits, the red pinned before the diagnosis.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param envelope - The step message.
 * @returns The step and its decision's record, or the first unmet check.
 */
async function checkStepMail(port: EnginePort, common: string, envelope: Envelope): Promise<Result<{ step: UserStep; record: DecisionRecord }>> {
  const step = parseStepCommand(envelope.body)
  if (!step) return fail('the message carries no step command')
  const scope = await findLiveDelegation(port, [envelope.issue])
  if (!scope || envelope.from !== coordinatorAddress(scope.sessionId)) return fail(`${envelope.from} is not the live coordinator that delegates #${envelope.issue}`)
  const decision = envelope.refs[0] ?? ''
  const red = step.kind === 'approve' ? await readApprovalRed(port, step.diagnosis) : succeed('')
  if (!red.isOk) return red
  const checked = await checkDecision(port, common, { url: decision, issue: envelope.issue, coordinator: scope.sessionId, step, red: red.value })
  if (!checked.isOk) return checked
  if (Date.parse(checked.value.comment.createdAt) <= await readUnitStart(port, common, envelope.issue)) return fail(`${decision} was posted before this unit started`)
  const login = await readGhLogin(port.processes)
  if (!login.isOk) return login
  if (checked.value.comment.author !== login.value) return fail(`${decision} was written by ${checked.value.comment.author || 'someone else'}, not by ${login.value}`)
  return succeed({ step, record: checked.value.record })
}

/**
 * Reads the red an approval of a diagnosis pins, once this unit's Diagnose waits for it: the latest red before the diagnosis comment.
 * @param port - The engine calls.
 * @param diagnosis - The diagnosis comment's URL.
 * @returns The red command, argv joined by spaces, or why there is nothing to approve.
 */
async function readApprovalRed(port: EnginePort, diagnosis: string): Promise<Result<string>> {
  const session = await readSession(port)
  const wait = session.unit ? await readDiagnoseWait(port, session.unit, session.flow) : null
  if (!wait) return fail('this unit has no Diagnose to approve')
  if (!wait.judgement.isWaitingApproval) return fail('this unit\'s Diagnose is not waiting for approval')
  const comment = wait.comments.find(each => each.url === diagnosis)
  if (!comment) return fail(`${diagnosis} is not a comment of this unit's issues`)
  const red = findLatestRedBefore(wait.unit.runs, Date.parse(comment.createdAt))
  return red ? succeed(red.argv.join(' ')) : fail(`${diagnosis} precedes the unit's red run, so it diagnoses no red`)
}

/**
 * Applies a step message a unit received, after checking it: through the same code the user's typed command runs, then marks its decision used.
 * The mod closes the conversation itself with a done naming the outcome, and the model is shown only that outcome.
 * @param port - The engine calls.
 * @param envelope - The step message, just acknowledged.
 * @returns The outcome line the model sees in place of the message's body.
 */
export async function applyStepMail(port: EnginePort, envelope: Envelope): Promise<string> {
  const common = await readCommonDir(port)
  const checked = common ? await checkStepMail(port, common, envelope) : fail('this session is not inside a git repository, which holds the records')
  const step = checked.isOk ? checked.value.step : null
  const command = step ? composeStepCommand(step) : ''
  const tail = command.slice(command.indexOf(' ', '/flow '.length) + 1)
  const applied = !checked.isOk ? checked : step?.kind === 'approve' ? await runApproveStep(port, tail)
    : step?.kind === 'skip' ? await runSkipStep(port, tail) : await runFollowUpStep(port, tail)
  if (applied.isOk && checked.isOk && common) {
    const path = decisionPath(common, checked.value.record.url)
    if (path) await atomicReplace(port, path, JSON.stringify({ ...checked.value.record, consumedBy: await port.readSessionId(), consumedAt: new Date(await port.now()).toISOString() }))
  }
  const outcome = applied.isOk ? `applied: ${applied.value}` : `refused: ${applied.error}; nothing changed`
  const address = unitAddress(envelope.issue)
  await sendMail(port, { kind: 'done', author: 'mod', to: envelope.from, issue: envelope.issue, body: markForAgent(`Step ${envelope.id} (${envelope.body.split('\n')[0]}) ${outcome}.`),
    reply: { inReplyTo: envelope.id, id: deriveReplyId(envelope.id, address), from: address } }).catch(() => fail('the done was not sent'))
  return markForAgent(`The coordinator relayed a step; this session's mod checked its delegated decision ${envelope.refs[0] ?? ''} and ${outcome}. `
    + 'The mod already replied done to the coordinator: send nothing about it.')
}
