import { bodyLimit, mailFileName, parseEnvelope, userAddress } from '../domain/mail'
import type { Envelope } from '../domain/mail'
import { deriveReplyId, withArticle } from '../domain/mail-reply'
import { stop } from '../domain/outcome'
import { isNonEmptyString, isRecord, isStringArray } from '../lib/guards'
import { readJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { logFailure } from './best-effort'
import type { EnginePort } from './engine-port'
import { findMessage, mailPath, readOwnAddresses, sendMail } from './mailbox'
import { atomicCreate, atomicReplace, readCommonDir, recordsPath } from './record-store'
import { isFromRetiredSession } from './retire'
import { withRecordLock } from './session-memory'
import { replyDeadlineMs } from './timing'
import { readForward } from './user-inbox'

/** A message that ran out of attempts or went stale: it ends its conversation; the replies that still came, and who was not told of it, are recorded on it. */
interface DeadLetter { v: 1; id: string; reason: string; at: string; envelope: Envelope; replies: string[]; untold?: string[] }

/** How many dead letters there are, and how many of them have a notice that was not delivered. */
interface DeadLetterCounts { deadLetters: number; untold: number }

/** A message's latest attempt in its receiver's mailbox, with the directory it is in and the file's time: its send while in new/, its ack once in cur/. */
interface Attempt { box: 'new' | 'cur'; envelope: Envelope; mtimeMs: number }

/** How many attempts a message gets before it is dead-lettered to the user. */
const maxAttempts = 3

/** The kinds that wait for a reply within the reply deadline of each attempt's transport ack. */
const repliedKinds: readonly string[] = ['question', 'blocked', 'cancel']

/**
 * Sends a new attempt of every message this session sent whose deadline expired, or dead-letters it after the last attempt; run by the
 * session's tick. A question, blocked or cancel must be replied to within the reply deadline of each attempt's ack; a message never acked,
 * however long its receiver's turn, waits on the receiver's liveness instead. Mail to the user and a forwarded question are never retried.
 * @param port - The engine calls.
 * @returns Once every expired message got its new attempt or its dead letter.
 */
export async function retryOwnMail(port: EnginePort): Promise<void> {
  const common = await readCommonDir(port)
  const own = await readOwnAddresses(port)
  if (!common || !own.length) return
  const now = await port.now()
  // why: the mail directory may not exist yet, so a failed listing reads as empty.
  for (const { name: receiver } of await port.files.list(recordsPath(common, 'mail')).catch(() => [])) {
    // why: a question to the user never expires, and the user's mailbox holds nothing else that waits.
    if (receiver === userAddress) continue
    for (const latest of await readLatestAttempts(port, common, receiver)) {
      if (own.includes(latest.envelope.from) && await isOverdue(port, common, latest, now)) await expire(port, common, latest)
    }
  }
}

/**
 * Reads a dead letter.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param id - The message's id.
 * @returns The record, or null when the message was never dead-lettered.
 */
export async function readDeadLetter(port: EnginePort, common: string, id: string): Promise<DeadLetter | null> {
  return parseDeadLetter(await readJson(port.files, deadLetterPath(common, id)), id)
}

/**
 * Records a reply that came after its message's dead letter on that dead letter; the reply itself is delivered as usual.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param inReplyTo - The id replied to.
 * @param replyId - The reply's id.
 * @returns Whether the message had a dead letter the reply was recorded on.
 */
export async function recordLateReply(port: EnginePort, common: string, inReplyTo: string, replyId: string): Promise<boolean> {
  return withRecordLock(async () => {
    const letter = await readDeadLetter(port, common, inReplyTo)
    if (!letter) return false
    if (!letter.replies.includes(replyId)) await atomicReplace(port, deadLetterPath(common, inReplyTo), JSON.stringify({ ...letter, replies: [...letter.replies, replyId] }))
    return true
  })
}

/**
 * Sets aside a message whose expects no longer holds, before it is acknowledged: it leaves new/ for the dead letters, and only the injection
 * whose move wins records it, dead-lettered as stale with its sender told.
 * @param port - The engine calls.
 * @param address - The mailbox it reached.
 * @param name - Its file name.
 * @param envelope - The message.
 * @param reason - The stale reason, naming the step it was written for and the step the unit was at.
 * @returns Once set aside, or when another injection moved it first.
 */
export async function setStaleAside(port: EnginePort, address: string, name: string, envelope: Envelope, reason: string): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  await executeProcess(port.processes, ['mkdir', '-p', '--', recordsPath(common, 'deadletters')])
  const moved = await executeProcess(port.processes, ['mv', '-f', '--', `${mailPath(common, address, 'new')}/${name}`, recordsPath(common, 'deadletters', `${name.slice(0, -'.json'.length)}.mail`)])
  if (moved.exitCode !== 0) return
  logFailure(port, 'dead-letter notice', await deadLetter(port, common, envelope, reason, address))
}

/**
 * Reads every dead letter; an inform is not one: its records predate expects being refused on an inform, when a stale one was dropped untold.
 * @param port - The engine calls.
 * @returns The dead letters.
 */
async function readDeadLetters(port: EnginePort): Promise<DeadLetter[]> {
  const common = await readCommonDir(port)
  if (!common) return []
  // why: the bucket exists only once a message was dead-lettered, so a failed listing reads as empty.
  const names = (await port.files.list(recordsPath(common, 'deadletters')).catch(() => [])).filter(({ name }) => name.endsWith('.json'))
  const letters = await Promise.all(names.map(async ({ name }) => readDeadLetter(port, common, name.slice(0, -'.json'.length))))
  return letters.filter((letter): letter is DeadLetter => !!letter && letter.envelope.kind !== 'inform')
}

/**
 * Counts the dead letters about some issues, and those whose notice to the user or the sender was not delivered.
 * @param port - The engine calls.
 * @param issues - The issues, such as a coordinator's scope.
 * @returns How many, and how many with an undelivered notice.
 */
export async function countDeadLetters(port: EnginePort, issues: readonly number[]): Promise<DeadLetterCounts> {
  const letters = (await readDeadLetters(port)).filter(letter => issues.includes(letter.envelope.issue))
  return { deadLetters: letters.length, untold: letters.filter(letter => letter.untold?.length).length }
}

/**
 * Lists the dead letters whose notice to the user or the sender was not delivered, for /flow status.
 * @param port - The engine calls.
 * @returns One line each, naming the message and who was not told.
 */
export async function listUntoldDeadLetters(port: EnginePort): Promise<string[]> {
  return (await readDeadLetters(port)).flatMap(letter => letter.untold?.length
    ? [`dead letter ${letter.id} about #${letter.envelope.issue} · ${letter.untold.join('; ')}`] : [])
}

/**
 * Names a dead letter's record.
 * @param common - The git common directory.
 * @param id - The message's id.
 * @returns The path.
 */
const deadLetterPath = (common: string, id: string): string => recordsPath(common, 'deadletters', `${id}.json`)

/**
 * Validates a dead letter read from its record.
 * @param value - The parsed record.
 * @param id - The id its name gives.
 * @returns The record, or null when it is not one.
 */
function parseDeadLetter(value: unknown, id: string): DeadLetter | null {
  if (!isRecord(value) || value.v !== 1 || value.id !== id || !isNonEmptyString(value.reason) || typeof value.at !== 'string' || !isStringArray(value.replies)) return null
  const envelope = isRecord(value.envelope) && typeof value.envelope.to === 'string'
    ? parseEnvelope(mailFileName({ id, attempt: Number(value.envelope.attempt) }), JSON.stringify(value.envelope), value.envelope.to) : null
  return envelope ? { v: 1, id, reason: value.reason, at: value.at, envelope, replies: value.replies, ...isStringArray(value.untold) ? { untold: value.untold } : {} } : null
}

/**
 * Reads the latest attempt of every message in a mailbox.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The receiver.
 * @returns One attempt per id: the highest.
 */
async function readLatestAttempts(port: EnginePort, common: string, address: string): Promise<Attempt[]> {
  const read = await Promise.all((['new', 'cur'] as const).map(async box => {
    // why: a mailbox directory may not exist yet, so a failed listing reads as empty.
    const entries = await port.files.list(mailPath(common, address, box)).catch(() => [])
    // why: another session may move a file meanwhile, so one that cannot be read counts as gone.
    return Promise.all(entries.map(async ({ name, mtimeMs }) => {
      const envelope = parseEnvelope(name, await port.files.read(`${mailPath(common, address, box)}/${name}`).catch(() => ''), address)
      return envelope ? [{ box, envelope, mtimeMs }] : []
    }))
  }))
  const latest = new Map<string, Attempt>()
  for (const attempt of read.flat(2)) {
    const held = latest.get(attempt.envelope.id)
    if (!held || held.envelope.attempt < attempt.envelope.attempt) latest.set(attempt.envelope.id, attempt)
  }
  return [...latest.values()]
}

/**
 * Tells whether a message's latest attempt is past its deadline and still waits: a question, blocked or cancel acked and not replied to.
 * A message never acked waits on the receiver's liveness, not on a new attempt: a busy receiver's Stop delivers it, and a stalled or dead one is reported.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param attempt - The latest attempt.
 * @param now - The time, in epoch ms.
 * @returns Whether it needs a new attempt or its dead letter.
 */
async function isOverdue(port: EnginePort, common: string, attempt: Attempt, now: number): Promise<boolean> {
  const { box, envelope, mtimeMs } = attempt
  if (!repliedKinds.includes(envelope.kind) || box !== 'cur' || now - mtimeMs < replyDeadlineMs) return false
  if (await readDeadLetter(port, common, envelope.id) || await isFromRetiredSession(port, envelope)) return false
  // why: a forwarded question is the user's to answer, and a question to the user never expires.
  return !await findMessage(port, common, envelope.from, deriveReplyId(envelope.id, envelope.to)) && !await readForward(port, common, envelope.id)
}

/**
 * Sends a message's next attempt, labelled a repeat at injection, or dead-letters it after the last one; only an acked attempt expires.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param attempt - The expired attempt.
 * @returns Once sent or dead-lettered.
 */
async function expire(port: EnginePort, common: string, attempt: Attempt): Promise<void> {
  const { envelope } = attempt
  if (envelope.attempt >= maxAttempts) {
    logFailure(port, 'dead-letter notice', await deadLetter(port, common, envelope, `not replied to after ${maxAttempts} attempts`, envelope.from))
    return
  }
  const staging = mailPath(common, envelope.to, 'tmp')
  const inbox = mailPath(common, envelope.to, 'new')
  const next = { ...envelope, attempt: envelope.attempt + 1 }
  await atomicCreate(port, staging, `${inbox}/${mailFileName(next)}`, JSON.stringify(next))
}

/**
 * Dead-letters a message to the user's mailbox with its reason, and tells its sender; a message already dead-lettered is left as it is.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param envelope - The message, as its latest attempt holds it.
 * @param reason - Why it is dead-lettered.
 * @param writer - The session whose mod writes the two informs, from its own address: the sender for a retry, the receiver for a stale message.
 * @returns The dead letter, or a stop naming who was not told; a message already dead-lettered succeeds with nothing to say.
 */
async function deadLetter(port: EnginePort, common: string, envelope: Envelope, reason: string, writer: string): Promise<Result<string>> {
  const record: DeadLetter = { v: 1, id: envelope.id, reason, at: new Date(await port.now()).toISOString(), envelope, replies: [] }
  const isNew = await withRecordLock(() => atomicCreate(port, recordsPath(common, 'deadletters'), deadLetterPath(common, envelope.id), JSON.stringify(record)))
  if (!isNew) return succeed('')
  const about = `${withArticle(envelope.kind)} ${envelope.id} from ${envelope.from} to ${envelope.to} about #${envelope.issue}`
  const told = { kind: 'inform' as const, author: 'mod' as const, from: writer, issue: envelope.issue }
  const user = await sendMail(port, { ...told, to: userAddress, body: `Dead letter: ${about}, ${reason}. Its text:\n${envelope.body}`.slice(0, bodyLimit) })
    .catch((error: unknown) => fail(formatErrorLine(error)))
  // why: once the record exists the message is never dead-lettered again, so who was not told is kept on it rather than lost.
  const keepUntold = (untold: string[]): Promise<string> => withRecordLock(async () => {
    const letter = await readDeadLetter(port, common, envelope.id) ?? record
    await atomicReplace(port, deadLetterPath(common, envelope.id), JSON.stringify({ ...letter, untold }))
  }).then(() => '', (error: unknown) => formatErrorLine(error))
  const userUntold = user.isOk ? [] : [`the user was not told (${user.error})`]
  // why: /flow status lists only a dead letter whose record keeps who was not told, so the sender hears that only once it is kept.
  const userUnkept = userUntold.length ? await keepUntold(userUntold) : ''
  const userNote = user.isOk ? '' : `, but the user was not told (${user.error}); ${userUnkept
    ? `the dead letter is at ${deadLetterPath(common, envelope.id)}, which /flow status cannot list (${userUnkept})` : 'the dead letter is kept, and /flow status lists it'}`
  const sender = await sendMail(port, { ...told, to: envelope.from, body: `Your ${envelope.kind} ${envelope.id} to ${envelope.to} about #${envelope.issue} was dead-lettered to the user's mailbox: ${reason}${userNote}. `
    + 'A reply that still comes reaches this mailbox and is recorded on the dead letter.' }).catch((error: unknown) => fail(formatErrorLine(error)))
  const untold = [...userUntold, ...sender.isOk ? [] : [`${envelope.from} was not told (${sender.error})`]]
  if (!untold.length) return succeed(`dead-lettered ${envelope.id}`)
  const unkept = sender.isOk ? userUnkept : await keepUntold(untold)
  return stop(`dead-lettered ${envelope.id}; ${untold.join('; ')}${unkept ? `; not kept on the dead letter (${unkept})` : ''}`)
}
