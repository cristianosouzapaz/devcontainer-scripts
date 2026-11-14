import { bodyLimit, clipText, unitAddress } from '../domain/mail'
import type { Envelope } from '../domain/mail'
import { deriveReplyId } from '../domain/mail-reply'
import { markForAgent } from '../domain/messages'
import { removeFile } from '../lib/files'
import { isNonEmptyString, isRecord } from '../lib/guards'
import { readJson } from '../lib/json'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { hasMessage, readOwnAddresses, sendMail } from './mailbox'
import { atomicReplace, readCommonDir, recordsPath } from './record-store'
import { withRecordLock } from './session-memory'
import { moduleState } from '../lib/module-state'

/**
 * A step's done the mod owes, as `owed/<step id>.json` holds it; the sender is the unit's address for the issue. `attempts` counts the
 * failed resends, `error` keeps the last one, and `isTold` says whether a prompt already named it as stuck.
 */
interface OwedDone { step: string; replyId: string; to: string; issue: number; outcome: string; attempts: number; error: string; isTold: boolean }

/** An owed record as read from its file: the done, or why it cannot be read. */
type OwedRead = { path: string; owed: OwedDone } | { path: string; error: string }

const bucket = 'owed'
// why: past this many failed resends the failure is no longer a blip, so the agent and /flow status are told.
const quietResends = 3
// why: a write fault is told at once, and the user only once it repeats; the count lives in this module load, since the record itself could not be written. An unreadable record's owner is unknown, so every session's prompt could name it; each load names it once.
const told = moduleState(() => ({ unrecordedPrompts: new Map<string, number>(), unreadable: new Set<string>() }))
// why: the done carries the mod's prefix besides the outcome, and a message longer than bodyLimit is refused for good.
const outcomeChars = bodyLimit - 100

/**
 * Reads an owed done's record.
 * @param value - The parsed file.
 * @returns The record, or null when it is not one.
 */
function parseOwedDone(value: unknown): OwedDone | null {
  if (!isRecord(value) || typeof value.issue !== 'number' || typeof value.attempts !== 'number' || typeof value.error !== 'string' || typeof value.isTold !== 'boolean') return null
  const { step, replyId, to, outcome } = value
  return isNonEmptyString(step) && isNonEmptyString(replyId) && isNonEmptyString(to) && isNonEmptyString(outcome)
    ? { step, replyId, to, issue: value.issue, outcome, attempts: value.attempts, error: value.error, isTold: value.isTold } : null
}

/**
 * Sends an owed done; a reply already in the receiver's mailbox counts as sent, since a failure may have followed its write.
 * @param port - The engine calls.
 * @param owed - The done.
 * @returns The reply's id, or why it was not sent.
 */
async function sendOwedDone(port: EnginePort, owed: OwedDone): Promise<Result<string>> {
  const sent = await sendMail(port, { kind: 'done', author: 'mod', to: owed.to, issue: owed.issue, body: markForAgent(owed.outcome),
    reply: { inReplyTo: owed.step, id: owed.replyId, from: unitAddress(owed.issue) } }).catch((error: unknown) => fail(formatErrorLine(error)))
  if (sent.isOk) return sent
  const common = await readCommonDir(port)
  return common && await hasMessage(port, common, owed.to, owed.replyId) ? succeed(owed.replyId) : sent
}

/**
 * Words a done the mod gave up on, for the agent to pass to the user, who reads the pane: no mail reaches the coordinator from here.
 * @param owed - The done.
 * @param why - Why it is not sent.
 * @returns The sentence.
 */
const tellUser = (owed: OwedDone, why: string): string =>
  `Stop and tell the user: the coordinator was not told step ${owed.step}'s outcome (${why}), which is: ${owed.outcome}`

/**
 * Replies done to a step message with the mod's outcome. A done that cannot be sent is kept on disk for {@link resendOwedDones}; one
 * that cannot be kept either is never retried, and the agent is told to tell the user.
 * @param port - The engine calls.
 * @param envelope - The step message.
 * @param outcome - The mod's outcome line, such as `Step <id> (<command>) applied: ….`.
 * @returns The sentence the model reads about the done.
 */
export async function replyStepDone(port: EnginePort, envelope: Envelope, outcome: string): Promise<string> {
  const owed: OwedDone = { step: envelope.id, replyId: deriveReplyId(envelope.id, unitAddress(envelope.issue)), to: envelope.from, issue: envelope.issue,
    outcome: clipText(outcome, outcomeChars), attempts: 0, error: '', isTold: false }
  const sent = await sendOwedDone(port, owed)
  if (sent.isOk) return 'The mod already replied done to the coordinator: send nothing about it.'
  const common = await readCommonDir(port)
  const kept = common ? await atomicReplace(port, recordsPath(common, bucket, `${owed.step}.json`), JSON.stringify({ ...owed, error: sent.error }))
    .then(() => null, (error: unknown) => formatErrorLine(error)) : 'this session is not inside a git repository, which holds the records'
  if (kept === null) return `The mod tried to reply done to the coordinator, but the done was not sent (${sent.error}); this session's mod resends it at its next prompt; nothing to do.`
  // why: inside a repository the step stays claimed and owed in cur/, so the next injection point closes it again from its decision's record.
  if (common) return `The mod tried to reply done to the coordinator, but the done was not sent and cannot be kept for a resend; the step stays claimed, so this session's mod `
    + `tries its done again at the next prompt, Stop or denied call. ${tellUser(owed, `${sent.error}; ${kept}`)}`
  return `The mod tried to reply done to the coordinator, but the done was not sent and cannot be kept for a resend, so the mod will not retry it. ${tellUser(owed, `${sent.error}; ${kept}`)}`
}

/**
 * Names the steps whose done this session's mod keeps for a resend, which {@link resendOwedDones} sends rather than a recovery.
 * @param port - The engine calls.
 * @returns The step ids, none outside a repository.
 */
export async function listOwedSteps(port: EnginePort): Promise<string[]> {
  const common = await readCommonDir(port)
  if (!common) return []
  // why: the bucket exists only once a done was kept.
  return (await port.files.list(recordsPath(common, bucket)).catch(() => [])).map(({ name }) => /^(.+)\.json$/.exec(name)?.[1] ?? '').filter(Boolean)
}

/**
 * Reads one owed record, telling a record gone from one that cannot be read or is not an owed done.
 * @param port - The engine calls.
 * @param path - The record.
 * @returns The done, why it cannot be read, or null when no record is there.
 */
async function readOwedRecord(port: EnginePort, path: string): Promise<OwedRead | null> {
  const read = await readJson(port.files, path).then(value => ({ value }), (error: unknown) => ({ error: formatErrorLine(error) }))
  if ('error' in read) return { path, error: read.error }
  if (read.value === undefined) return null
  const owed = parseOwedDone(read.value)
  return owed ? { path, owed } : { path, error: 'not an owed-done record' }
}

/**
 * Reads the dones this session's mod owes, and every owed record that cannot be read, whose owner is unknown.
 * @param port - The engine calls.
 * @returns Each record this session owes and each unreadable one, or none outside a repository.
 */
async function readOwedDones(port: EnginePort): Promise<OwedRead[]> {
  const common = await readCommonDir(port)
  if (!common) return []
  const own = await readOwnAddresses(port)
  // why: the bucket exists only once a done was owed, so a failed listing reads as empty.
  const names = (await port.files.list(recordsPath(common, bucket)).catch(() => [])).filter(({ name }) => name.endsWith('.json'))
  const reads = await Promise.all(names.map(({ name }) => readOwedRecord(port, recordsPath(common, bucket, name))))
  return reads.filter((read): read is OwedRead => read !== null && ('error' in read || own.includes(unitAddress(read.owed.issue))))
}

/**
 * Words an owed done that kept failing, with what to check.
 * @param owed - The done.
 * @returns The line.
 */
const describeStuck = (owed: OwedDone): string =>
  `step ${owed.step}'s done not sent after ${owed.attempts} resends (${owed.error}) · check the records directory's owed/ and its disk`

/**
 * Words an owed record that cannot be read.
 * @param path - The record.
 * @param error - Why it cannot be read.
 * @returns The line.
 */
const describeUnreadable = (path: string, error: string): string =>
  `owed record ${path} cannot be read (${error}) · the done it holds, for whichever unit, is not resent · check that file`

/**
 * Sends every done this session's mod owes, clearing each record once its done is sent and counting each failure; run at each prompt
 * and tick. Only a prompt names a done: once when it first counts as stuck, and at once when its count cannot be written, since a count
 * that never rises would never name it. A Stop or a deny never carries the note, which they would repeat forever. An owed record that
 * cannot be read is named once per process.
 * @param port - The engine calls.
 * @param isPrompt - Whether a prompt runs it, which may name a done to the agent.
 * @returns What the agent is told, empty unless a prompt runs it.
 */
export async function resendOwedDones(port: EnginePort, isPrompt = false): Promise<string[]> {
  const notes: string[] = []
  for (const read of await readOwedDones(port)) {
    if ('error' in read) {
      // why: the streak counts only prompts in a row whose count write failed, so any other outcome for the record ends it.
      if (isPrompt) told.unrecordedPrompts.delete(read.path)
      if (isPrompt && !told.unreadable.has(read.path)) notes.push(`The mod cannot resend a done: ${describeUnreadable(read.path, read.error)}.`)
      if (isPrompt) told.unreadable.add(read.path)
      continue
    }
    const { path, owed } = read
    // why: sendMail takes the record lock itself, so the send stays outside it, and the record is read again under it.
    const sent = await sendOwedDone(port, owed)
    const note = await withRecordLock(async () => {
      const current = await readOwedRecord(port, path)
      if (isPrompt && (!current || 'error' in current)) told.unrecordedPrompts.delete(path)
      if (!current) return ''
      if ('error' in current) {
        return isPrompt ? `The mod ${sent.isOk ? 'sent' : 'failed to resend'} step ${owed.step}'s done but cannot read its owed record ${path} again (${current.error}), `
          + `so ${sent.isOk ? 'the record is not removed' : 'the failure is not counted'}. Check that file.` : ''
      }
      return sent.isOk ? clearOwedDone(port, path, current.owed, isPrompt) : countFailedResend(port, path, current.owed, sent.error, isPrompt)
    })
    if (note) notes.push(note)
  }
  return notes
}

/**
 * Removes the record of a done its resend just sent.
 * @param port - The engine calls.
 * @param path - The record.
 * @param owed - The done.
 * @param isPrompt - Whether a prompt runs it, which may name the record left behind.
 * @returns What the agent is told, empty when nothing is.
 */
async function clearOwedDone(port: EnginePort, path: string, owed: OwedDone, isPrompt: boolean): Promise<string> {
  told.unrecordedPrompts.delete(path)
  const removed = await removeFile(port.processes, path)
  const unremoved = !removed.isOk ? removed.error : removed.value.exitCode !== 0 ? removed.value.stderr.trim() || `rm exited ${removed.value.exitCode}` : ''
  // why: a record left behind is found again by the next resend, whose reply already exists, so that resend tries the removal again.
  return isPrompt && unremoved ? `Step ${owed.step}'s done is now sent, but its owed record ${path} could not be removed (${unremoved}); `
    + `the mod tries again at its next prompt or tick. Check ${path}.` : ''
}

/**
 * Counts a failed resend on the record; a prompt names the done once when it first counts as stuck, and names a count it cannot write.
 * @param port - The engine calls.
 * @param path - The record.
 * @param owed - The done, as read under the lock.
 * @param error - Why the resend failed.
 * @param isPrompt - Whether a prompt runs it.
 * @returns What the agent is told, empty when nothing is.
 */
async function countFailedResend(port: EnginePort, path: string, owed: OwedDone, error: string, isPrompt: boolean): Promise<string> {
  const isTelling = isPrompt && !owed.isTold && owed.attempts + 1 >= quietResends
  const failed = { ...owed, attempts: owed.attempts + 1, error, isTold: owed.isTold || isTelling }
  const unwritten = await atomicReplace(port, path, JSON.stringify(failed)).then(() => '', (failure: unknown) => formatErrorLine(failure))
  if (!isPrompt) return ''
  const faults = unwritten ? (told.unrecordedPrompts.get(path) ?? 0) + 1 : 0
  if (faults) told.unrecordedPrompts.set(path, faults)
  else told.unrecordedPrompts.delete(path)
  if (faults) {
    // why: one failed write may be a blip, so only a write that failed at two prompts in a row asks the agent to tell the user.
    return `The mod could not count a failed resend of step ${owed.step}'s done (${unwritten}); it keeps resending the done at each prompt and tick. `
      + `Check ${path}.${faults >= 2 ? ` That write failed at ${faults} prompts in a row. ${tellUser(failed, error)}` : ''}`
  }
  return isTelling ? `The mod still owes a done: ${describeStuck(failed)}. ${tellUser(failed, error)}` : ''
}

/**
 * Lists the dones this session's mod owes that kept failing, and every owed record that cannot be read, for /flow status.
 * @param port - The engine calls.
 * @returns One line each.
 */
export async function listStuckDones(port: EnginePort): Promise<string[]> {
  return (await readOwedDones(port)).flatMap(read => 'error' in read ? [describeUnreadable(read.path, read.error)]
    : read.owed.attempts >= quietResends ? [describeStuck(read.owed)] : [])
}
