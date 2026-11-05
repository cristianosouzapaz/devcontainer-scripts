import { bodyLimit, mailFileName, parseEnvelope, userAddress } from '../domain/mail'
import type { Envelope } from '../domain/mail'
import { deriveReplyId, withArticle } from '../domain/mail-reply'
import { isNonEmptyString, isRecord, isStringArray } from '../lib/guards'
import { readJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import type { EnginePort } from './engine-port'
import { findMessage, mailPath, readOwnAddresses, sendMail } from './mailbox'
import { atomicCreate, atomicReplace, readCommonDir, recordsPath } from './record-store'
import { isFromRetiredSession } from './retire'
import { withRecordLock } from './session-memory'
import { readProgressFile } from './spawn'
import { ackDeadlineMs, replyDeadlineMs } from './timing'
import { readForward } from './user-inbox'

/** A message that ran out of attempts or went stale: it ends its conversation, and the replies that still came are recorded on it. */
interface DeadLetter { v: 1; id: string; reason: string; at: string; envelope: Envelope; replies: string[] }

/** A message's latest attempt in its receiver's mailbox, with the directory it is in and the file's time: its send while in new/, its ack once in cur/. */
interface Attempt { box: 'new' | 'cur'; envelope: Envelope; mtimeMs: number }

/** How many attempts a message gets before it is dead-lettered to the user. */
const maxAttempts = 3

/** The kinds that wait for a reply within the reply deadline of each attempt's transport ack. */
const repliedKinds: readonly string[] = ['question', 'blocked', 'cancel']

/**
 * Sends a new attempt of every message this session sent whose deadline expired, or dead-letters it after the last attempt; run by the
 * session's tick. An assign must be acked within the ack deadline of each attempt's send; a question, blocked or cancel replied to within
 * the reply deadline of each attempt's ack. Spawn's start assignment, mail to the user and a forwarded question are never retried.
 * @param port - The engine calls.
 * @returns Once every expired message got its new attempt or its dead letter.
 */
export async function retryOwnMail(port: EnginePort): Promise<void> {
  const common = await readCommonDir(port)
  const own = await readOwnAddresses(port)
  if (!common || !own.length) return
  const now = await port.now()
  // The mail directory may not exist yet.
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
 * whose move wins records it. A stale inform is recorded and dropped; any other kind is dead-lettered as stale and its sender told.
 * @param port - The engine calls.
 * @param address - The mailbox it reached.
 * @param name - Its file name.
 * @param envelope - The message.
 * @returns Once set aside, or when another injection moved it first.
 */
export async function setStaleAside(port: EnginePort, address: string, name: string, envelope: Envelope): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  await executeProcess(port.processes, ['mkdir', '-p', '--', recordsPath(common, 'deadletters')])
  const moved = await executeProcess(port.processes, ['mv', '-f', '--', `${mailPath(common, address, 'new')}/${name}`, recordsPath(common, 'deadletters', `${name.slice(0, -'.json'.length)}.mail`)])
  if (moved.exitCode !== 0) return
  if (envelope.kind !== 'inform') return deadLetter(port, common, envelope, 'stale', address)
  const record: DeadLetter = { v: 1, id: envelope.id, reason: 'stale', at: new Date(await port.now()).toISOString(), envelope, replies: [] }
  await withRecordLock(() => atomicCreate(port, recordsPath(common, 'deadletters'), deadLetterPath(common, envelope.id), JSON.stringify(record)))
}

/**
 * Counts the dead letters about some issues; a stale inform, dropped rather than dead-lettered, is not one.
 * @param port - The engine calls.
 * @param issues - The issues, such as a coordinator's scope.
 * @returns How many.
 */
export async function countDeadLetters(port: EnginePort, issues: readonly number[]): Promise<number> {
  const common = await readCommonDir(port)
  if (!common) return 0
  // The bucket exists only once a message was dead-lettered.
  const names = (await port.files.list(recordsPath(common, 'deadletters')).catch(() => [])).filter(({ name }) => name.endsWith('.json'))
  const letters = await Promise.all(names.map(async ({ name }) => readDeadLetter(port, common, name.slice(0, -'.json'.length))))
  return letters.filter(letter => letter && letter.envelope.kind !== 'inform' && issues.includes(letter.envelope.issue)).length
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
  return envelope ? { v: 1, id, reason: value.reason, at: value.at, envelope, replies: value.replies } : null
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
    // A mailbox directory may not exist yet.
    const entries = await port.files.list(mailPath(common, address, box)).catch(() => [])
    // A file another session moved meanwhile reads as gone.
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
 * Tells whether a message's latest attempt is past its deadline and still waits: an assign not acked, or a question, blocked or cancel
 * acked and not replied to. A message never acked waits on the receiver's liveness, not on a new attempt.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param attempt - The latest attempt.
 * @param now - The time, in epoch ms.
 * @returns Whether it needs a new attempt or its dead letter.
 */
async function isOverdue(port: EnginePort, common: string, attempt: Attempt, now: number): Promise<boolean> {
  const { box, envelope, mtimeMs } = attempt
  const isAssignLate = envelope.kind === 'assign' && box === 'new' && now - mtimeMs >= ackDeadlineMs
  const isReplyLate = repliedKinds.includes(envelope.kind) && box === 'cur' && now - mtimeMs >= replyDeadlineMs
  if (!isAssignLate && !isReplyLate) return false
  if (await readDeadLetter(port, common, envelope.id) || await isFromRetiredSession(port, envelope)) return false
  // why: spawn's start assignment has its own start check, and a later spawn waits for that same message, so it never gets a second attempt.
  if (isAssignLate) return (await readProgressFile(port, common, envelope.issue, false)).assignId !== envelope.id
  // why: a forwarded question is the user's to answer, and a question to the user never expires.
  return !await findMessage(port, common, envelope.from, deriveReplyId(envelope.id, envelope.to)) && !await readForward(port, common, envelope.id)
}

/**
 * Sends a message's next attempt, labelled a repeat at injection, or dead-letters it after the last one. An attempt still unread leaves new/
 * first, so the model never gets two attempts as new; when the receiver acked it meanwhile the move fails and no repeat is sent.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param attempt - The expired attempt.
 * @returns Once sent or dead-lettered.
 */
async function expire(port: EnginePort, common: string, attempt: Attempt): Promise<void> {
  const { box, envelope } = attempt
  if (envelope.attempt >= maxAttempts) {
    return deadLetter(port, common, envelope, box === 'new' ? `not acknowledged after ${maxAttempts} attempts` : `not replied to after ${maxAttempts} attempts`, envelope.from)
  }
  const staging = mailPath(common, envelope.to, 'tmp')
  const inbox = mailPath(common, envelope.to, 'new')
  // why: named like a staged file, so the mailbox's staging sweep removes it.
  if (box === 'new' && (await executeProcess(port.processes, ['mv', '-f', '--', `${inbox}/${mailFileName(envelope)}`, `${staging}/.tmp-retried-${mailFileName(envelope)}`])).exitCode !== 0) return
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
 * @returns Once recorded and both told.
 */
async function deadLetter(port: EnginePort, common: string, envelope: Envelope, reason: string, writer: string): Promise<void> {
  const record: DeadLetter = { v: 1, id: envelope.id, reason, at: new Date(await port.now()).toISOString(), envelope, replies: [] }
  const isNew = await withRecordLock(() => atomicCreate(port, recordsPath(common, 'deadletters'), deadLetterPath(common, envelope.id), JSON.stringify(record)))
  if (!isNew) return
  const about = `${withArticle(envelope.kind)} ${envelope.id} from ${envelope.from} to ${envelope.to} about #${envelope.issue}`
  const told = { kind: 'inform' as const, author: 'mod' as const, from: writer, issue: envelope.issue }
  await sendMail(port, { ...told, to: userAddress, body: `Dead letter: ${about}, ${reason}. Its text:\n${envelope.body}`.slice(0, bodyLimit) })
  await sendMail(port, { ...told, to: envelope.from, body: `Your ${envelope.kind} ${envelope.id} to ${envelope.to} about #${envelope.issue} was dead-lettered to the user's mailbox: ${reason}. `
    + 'A reply that still comes reaches this mailbox and is recorded on the dead letter.' })
}
