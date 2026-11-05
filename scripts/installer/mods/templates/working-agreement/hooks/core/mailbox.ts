import { isCoordinatorSession } from '../domain/coordinator'
import { bodyLimit, coordinatorAddress, doorbellText, envelopeVersion, mailBoxes, mailFileName, orderMail, parseEnvelope, unitAddress, userAddress } from '../domain/mail'
import type { Envelope, MailAuthor, MailKind } from '../domain/mail'
import { removeFile } from '../lib/files'
import { readJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { bestEffort } from './best-effort'
import { isExpectationHeld } from './mail-expects'
import { setStaleAside } from './mail-retry'
import type { EnginePort } from './engine-port'
import { atomicCreate, atomicReplace, readCommonDir, recordsPath } from './record-store'
import { sessionMemory, withRecordLock } from './session-memory'
import { deriveSessionId, readProgressFile } from './spawn'
import { tickMs } from './timing'

/** A message read from one of this session's mailboxes, with the file it came from. */
interface Delivery { address: string; name: string; envelope: Envelope }

/** What a sender gives `send`; the mod fills in every other field. A reply carries the id it answers, the id derived from it, and the address it was sent to;
 * `from` names a sender that is no session's own address, the user's inbox. */
export interface Outgoing {
  kind: MailKind; to: string; issue: number; body: string; refs?: string[]; author?: MailAuthor; options?: string[]; from?: string; expects?: string
  reply?: { inReplyTo: string; id: string; from: string }
}

/**
 * Names a mailbox, or one of its directories.
 * @param common - The git common directory.
 * @param address - The participant.
 * @param box - The directory, or none for the mailbox itself.
 * @returns The path.
 */
export const mailPath = (common: string, address: string, box?: typeof mailBoxes[number]): string =>
  `${recordsPath(common, 'mail')}/${address}${box ? `/${box}` : ''}`

/**
 * Names the mailboxes this session receives in: a coordinator's own, and a unit's for each issue whose spawn record names this session.
 * @param port - The engine calls.
 * @returns The addresses, empty for a session nobody can write to.
 */
export async function readOwnAddresses(port: EnginePort): Promise<string[]> {
  const sessionId = await port.readSessionId()
  // why: the engine's raw value, since reading the session through the record store seeds a fresh session's record.
  if (isCoordinatorSession((await port.readSessionState()).value ?? {})) return [coordinatorAddress(sessionId)]
  const common = await readCommonDir(port)
  if (!common) return []
  // The spawn bucket may not exist yet.
  const names = await port.files.list(recordsPath(common, 'spawn')).catch(() => [])
  const issues = await Promise.all(names.map(async ({ name }) => {
    const issue = Number(/^(\d+)\.json$/.exec(name)?.[1])
    if (!issue) return []
    const progress = await readProgressFile(port, common, issue, false)
    // why: a record from before spawn kept the session id names the one the derivation gives.
    const recorded = progress.sessionId ?? (progress.isStarted ? await deriveSessionId(common, issue) : undefined)
    return recorded === sessionId ? [unitAddress(issue)] : []
  }))
  return issues.flat()
}

/**
 * Sends a message: takes the sender's address from its own records and its next sequence number under the record lock, then
 * writes the file in the receiver's tmp/ and links it into new/, never over another.
 * @param port - The engine calls.
 * @param message - What to send.
 * @returns The message's id, or why it was not sent.
 */
export async function sendMail(port: EnginePort, message: Outgoing): Promise<Result<string>> {
  if (message.body.length > bodyLimit) return fail(`the text is ${message.body.length} characters, over the ${bodyLimit} a message carries: put the rest in an issue comment and send its URL`)
  const common = await readCommonDir(port)
  if (!common) return fail('this session is not inside a git repository, which holds the mailboxes')
  const from = message.from ?? message.reply?.from ?? (await readOwnAddresses(port))[0]
  if (!from) return fail('this session has no mailbox to send from: only a coordinator session and a unit session spawn started have one')
  for (const address of new Set([from, message.to])) await makeMailbox(port, common, address)
  return withRecordLock(async () => {
    const id = message.reply?.id ?? crypto.randomUUID()
    // why: a reply's id is derived, so a second reply to one message collides here even after the first one was read and left new/.
    if (message.reply && await hasMessage(port, common, message.to, id)) return fail(`message ${message.reply.inReplyTo} already has this session's reply, and a message is replied to once`)
    const seq = await takeSequence(port, common, from)
    const envelope: Envelope = { v: envelopeVersion, id, kind: message.kind, from, to: message.to, issue: message.issue, in_reply_to: message.reply?.inReplyTo ?? '', seq,
      created_at: new Date(await port.now()).toISOString(), expects: message.expects ?? '', attempt: 1, body: message.body, refs: message.refs ?? [],
      author: message.author ?? 'agent', options: message.options ?? [] }
    const name = mailFileName(envelope)
    const isCreated = await atomicCreate(port, mailPath(common, message.to, 'tmp'), `${mailPath(common, message.to, 'new')}/${name}`, JSON.stringify(envelope))
    return isCreated ? succeed(id) : fail(`message ${id} is already in ${message.to}'s mailbox, so it was not sent again`)
  })
}

/**
 * Delivers a copy of a message to another mailbox, unchanged but for its receiver, so its sender, author, id and sequence stay its own.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param envelope - The message.
 * @param to - The new receiver.
 * @returns Whether the copy was delivered; false when that mailbox already holds it.
 */
export async function redirectMail(port: EnginePort, common: string, envelope: Envelope, to: string): Promise<boolean> {
  await makeMailbox(port, common, to)
  return atomicCreate(port, mailPath(common, to, 'tmp'), `${mailPath(common, to, 'new')}/${mailFileName(envelope)}`, JSON.stringify({ ...envelope, to }))
}

/**
 * Reads every message a mailbox holds, delivered or already read.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @returns The valid messages, each with the directory it is in.
 */
export async function readMailbox(port: EnginePort, common: string, address: string): Promise<{ box: 'new' | 'cur'; envelope: Envelope }[]> {
  const read = await Promise.all((['new', 'cur'] as const).map(async box => {
    // A mailbox, or one of its directories, may not exist yet.
    const names = await port.files.list(mailPath(common, address, box)).catch(() => [])
    // A file another session moved meanwhile reads as gone.
    const parsed = await Promise.all(names.map(async ({ name }) => parseEnvelope(name, await port.files.read(`${mailPath(common, address, box)}/${name}`).catch(() => ''), address)))
    return parsed.flatMap(envelope => envelope ? [{ box, envelope }] : [])
  }))
  return read.flat()
}

/**
 * Moves messages a person was shown from new/ to cur/, the transport ack of a mailbox no model reads.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @param mail - The messages shown.
 * @returns Once moved; one another session moved first is left as it is.
 */
export async function markShown(port: EnginePort, common: string, address: string, mail: readonly Envelope[]): Promise<void> {
  for (const envelope of mail) {
    await executeProcess(port.processes, ['mv', '-f', '--', `${mailPath(common, address, 'new')}/${mailFileName(envelope)}`, `${mailPath(common, address, 'cur')}/${mailFileName(envelope)}`])
  }
}

/**
 * Finds a message in a mailbox, delivered or already read, by its id, whatever its attempt.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @param id - The message's id.
 * @returns The message as its first valid file holds it, or null when the mailbox holds none.
 */
export async function findMessage(port: EnginePort, common: string, address: string, id: string): Promise<Envelope | null> {
  for (const box of ['new', 'cur'] as const) {
    // A mailbox, or one of its directories, may not exist yet.
    for (const { name } of await port.files.list(mailPath(common, address, box)).catch(() => [])) {
      if (!name.startsWith(`${id}.`)) continue
      // A file another injection moved meanwhile reads as gone.
      const envelope = parseEnvelope(name, await port.files.read(`${mailPath(common, address, box)}/${name}`).catch(() => ''), address)
      if (envelope?.id === id) return envelope
    }
  }
  return null
}

/**
 * Tells whether a mailbox holds a message, delivered or already read.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @param id - The message's id.
 * @returns Whether a file of it is in new/ or cur/.
 */
async function hasMessage(port: EnginePort, common: string, address: string, id: string): Promise<boolean> {
  const names = await Promise.all((['new', 'cur'] as const).map(box => port.files.list(mailPath(common, address, box)).catch(() => [])))
  return names.flat().some(({ name }) => name.startsWith(`${id}.`))
}

/**
 * Reads the unread mail of this session's mailboxes in injection order; a file that fails validation is moved to bad/.
 * @param port - The engine calls.
 * @returns The messages, still unread.
 */
async function readUnreadMail(port: EnginePort): Promise<Delivery[]> {
  const common = await readCommonDir(port)
  if (!common) return []
  const read = await Promise.all((await readOwnAddresses(port)).map(async address => {
    // The mailbox exists only once something was sent to it or its session watched it.
    const names = await port.files.list(mailPath(common, address, 'new')).catch(() => [])
    const mail = await Promise.all(names.map(async ({ name }): Promise<Delivery[]> => {
      const path = `${mailPath(common, address, 'new')}/${name}`
      // A file another injection already moved reads as gone.
      const text = await port.files.read(path).catch(() => null)
      if (text === null) return []
      const envelope = parseEnvelope(name, text, address)
      if (envelope) return [{ address, name, envelope }]
      await makeMailbox(port, common, address)
      await executeProcess(port.processes, ['mv', '-f', '--', path, `${mailPath(common, address, 'bad')}/${name}`])
      return []
    }))
    return mail.flat()
  }))
  return orderMail(read.flat())
}

/**
 * Writes the transport ack of messages the model was given: each moves from new/ to cur/, so it is never delivered as new again.
 * @param port - The engine calls.
 * @param mail - The messages injected.
 * @returns The messages this call moved; one another call moved first is left out.
 */
async function acknowledgeMail(port: EnginePort, mail: readonly Delivery[]): Promise<Delivery[]> {
  const common = await readCommonDir(port)
  if (!common) return []
  const moved = await Promise.all(mail.map(async delivery => {
    const read = `${mailPath(common, delivery.address, 'cur')}/${delivery.name}`
    const run = await executeProcess(port.processes, ['mv', '-f', '--', `${mailPath(common, delivery.address, 'new')}/${delivery.name}`, read])
    if (run.exitCode !== 0) return []
    // why: a rename keeps the send's time, and a reply deadline runs from the ack, so the file's time becomes the ack's.
    await executeProcess(port.processes, ['touch', '-c', '--', read])
    return [delivery]
  }))
  return moved.flat()
}

/**
 * Takes and acknowledges all unread mail of this session's mailboxes, in injection order.
 * @param port - The engine calls.
 * @returns The messages this call acknowledged; one another call moved first is left out.
 */
export async function takeEnvelopes(port: EnginePort): Promise<Envelope[]> {
  const unread = await readUnreadMail(port)
  const held = await Promise.all(unread.map(delivery => isExpectationHeld(port, delivery.envelope.expects)))
  // why: a message whose expects no longer holds was written for a state that is gone, so it is never acknowledged or injected.
  for (const delivery of unread.filter((_, index) => !held[index])) await setStaleAside(port, delivery.address, delivery.name, delivery.envelope)
  return (await acknowledgeMail(port, unread.filter((_, index) => held[index]))).map(delivery => delivery.envelope)
}

/**
 * Creates this session's mailboxes and names the directories its doorbell watches: their new/ directories and the mail root.
 * @param port - The engine calls.
 * @returns The directories to watch.
 */
export async function openOwnMailboxes(port: EnginePort): Promise<string[]> {
  const common = await readCommonDir(port)
  if (!common) return []
  const addresses = await readOwnAddresses(port)
  for (const address of [...addresses, userAddress]) await makeMailbox(port, common, address)
  // why: watches are set only at session start, and a session that becomes the coordinator later gets its mailbox then; the root's watch covers it.
  // The user's mailbox is watched by every session, so whichever becomes the coordinator later already notifies.
  const root = recordsPath(common, 'mail')
  const made = await executeProcess(port.processes, ['mkdir', '-p', '--', root])
  return [...[...addresses, userAddress].map(address => mailPath(common, address, 'new')), ...made.exitCode === 0 ? [root] : []]
}

/**
 * Tells whether a watched file event delivered mail to this session: an `add` under one of its new/ directories. The ack's move to cur/ raises an `unlink`, which never rings.
 * @param port - The engine calls.
 * @param path - The file the event names.
 * @param event - The event's type.
 * @returns Whether the doorbell should ring.
 */
export async function isMailArrival(port: EnginePort, path: string, event: string): Promise<boolean> {
  if (event !== 'add') return false
  const common = await readCommonDir(port)
  if (!common || !path.startsWith(`${recordsPath(common, 'mail')}/`)) return false
  return (await readOwnAddresses(port)).some(address => path.startsWith(`${mailPath(common, address, 'new')}/`))
}

/**
 * Tells whether unread mail waits in this session's mailboxes.
 * @param port - The engine calls.
 * @returns Whether any message is unread.
 */
export const hasUnreadMail = async (port: EnginePort): Promise<boolean> => (await readUnreadMail(port)).length > 0

/**
 * Rings this session's own doorbell: submits one prompt, deferred and never awaited in the hook, when unread mail waits, the main turn
 * is not live and no ring younger than one tick is pending. The prompt starts a turn in the idle session; the injection on its entry delivers the mail.
 * @param port - The engine calls.
 * @returns Once the ring is decided.
 */
export async function ringDoorbell(port: EnginePort): Promise<void> {
  const now = await port.now()
  const rungAt = sessionMemory.doorbellRungAt
  // why: a live turn's Stop delivers the mail, and a prompt rung now would queue until after it, so it would enter with nothing to carry.
  // A pending ring older than a tick is taken as lost: the engine may hold a plugin's prompt without settling it, as after an interrupt.
  if ((rungAt !== null && now - rungAt < tickMs) || sessionMemory.isTurnLive || !await hasUnreadMail(port)) return
  sessionMemory.doorbellRungAt = now
  port.defer(() => {
    // why: a turn may start, or an injection point deliver the mail, between the decision and this deferred submit.
    void bestEffort(port, 'doorbell', async () => { if (!sessionMemory.isTurnLive && await hasUnreadMail(port)) await port.submitPrompt(doorbellText) }, undefined)
      .finally(() => { if (sessionMemory.doorbellRungAt === now) sessionMemory.doorbellRungAt = null })
  })
}

/**
 * Removes a mailbox's staged files a crashed send left behind.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param expiry - Files older than this, in epoch ms, are removed.
 * @returns Once every mailbox's tmp/ was swept.
 */
export async function sweepMailStaging(port: EnginePort, common: string, expiry: number): Promise<void> {
  // The mail directory may not exist yet.
  for (const { name: address } of await port.files.list(recordsPath(common, 'mail')).catch(() => [])) {
    const staging = `${recordsPath(common, 'mail')}/${address}/tmp`
    for (const { name, mtimeMs } of await port.files.list(staging).catch(() => [])) {
      if (name.startsWith('.tmp-') && mtimeMs < expiry) await removeFile(port.processes, `${staging}/${name}`)
    }
  }
}

/**
 * Creates a mailbox's directories.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The participant.
 * @returns Once they exist.
 */
async function makeMailbox(port: EnginePort, common: string, address: string): Promise<void> {
  const run = await executeProcess(port.processes, ['mkdir', '-p', '--', ...mailBoxes.map(box => mailPath(common, address, box))])
  if (run.exitCode !== 0) throw new Error(run.stderr || `the mailbox of ${address} could not be created`)
}

/**
 * Takes a sender's next sequence number; the caller holds the record lock.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param from - The sender.
 * @returns The number, from 1.
 */
async function takeSequence(port: EnginePort, common: string, from: string): Promise<number> {
  const path = `${mailPath(common, from)}/seq.json`
  const last: unknown = await readJson(port.files, path)
  const next = (typeof last === 'number' && Number.isSafeInteger(last) && last > 0 ? last : 0) + 1
  await atomicReplace(port, path, JSON.stringify(next))
  return next
}

/**
 * Reads where a message stands in its receiver's mailbox, whatever its attempt: the transport ack is the move of any attempt from new/ to cur/.
 * @param port - The engine calls.
 * @param to - The receiver's address.
 * @param id - The message's id.
 * @returns `unread` in new/, `acknowledged` in cur/, and `none` when neither holds it.
 */
export async function readMailState(port: EnginePort, to: string, id: string): Promise<'unread' | 'acknowledged' | 'none'> {
  const common = await readCommonDir(port)
  if (!common) return 'none'
  return await isInBox(port, common, to, 'cur', id) ? 'acknowledged' : await isInBox(port, common, to, 'new', id) ? 'unread' : 'none'
}

/**
 * Tells whether a mailbox directory holds any attempt of a message.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @param box - The directory.
 * @param id - The message's id.
 * @returns Whether a file of it is there.
 */
async function isInBox(port: EnginePort, common: string, address: string, box: 'new' | 'cur', id: string): Promise<boolean> {
  // A mailbox directory may not exist yet.
  return (await port.files.list(mailPath(common, address, box)).catch(() => [])).some(({ name }) => /^(.+)\.\d+\.json$/.exec(name)?.[1] === id)
}

/**
 * Tells whether an acknowledged message is closed: replied to, or an assign a later cancel's done closed.
 * @param port - The engine calls.
 * @param to - The address the message was sent to.
 * @param id - The message's id.
 * @returns Whether it is closed; false when no attempt of the message is in cur/.
 */
export async function isMailAnswered(port: EnginePort, to: string, id: string): Promise<boolean> {
  const common = await readCommonDir(port)
  if (!common) return false
  return await isInBox(port, common, to, 'cur', id) && !(await readOwedMail(port, common, to)).some(envelope => envelope.id === id)
}

/**
 * Reads every message a mailbox holds, delivered or already read, one per id.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @returns The valid messages.
 */
export async function readAllMail(port: EnginePort, common: string, address: string): Promise<Envelope[]> {
  const read = await Promise.all((['new', 'cur'] as const).map(async box => {
    // A mailbox, or one of its directories, may not exist yet.
    const names = await port.files.list(mailPath(common, address, box)).catch(() => [])
    // A file another injection moved meanwhile reads as gone.
    return Promise.all(names.map(async ({ name }) => parseEnvelope(name, await port.files.read(`${mailPath(common, address, box)}/${name}`).catch(() => ''), address)))
  }))
  const valid = read.flat().filter((envelope): envelope is Envelope => envelope !== null)
  return valid.filter((envelope, index) => valid.findIndex(other => other.id === envelope.id) === index)
}

/**
 * Reads the messages a participant received and still owes a reply: an assign, cancel, question or step that no message from it in its sender's
 * mailbox names in `in_reply_to`; an assign received before a cancel it replied done to is closed by that done.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The receiver.
 * @returns The owed messages.
 */
export async function readOwedMail(port: EnginePort, common: string, address: string): Promise<Envelope[]> {
  const opened = (await readAllMail(port, common, address)).filter(envelope => ['assign', 'cancel', 'question', 'step'].includes(envelope.kind))
  const senders = [...new Set(opened.map(envelope => envelope.from))]
  const replies = (await Promise.all(senders.map(sender => readAllMail(port, common, sender)))).flat().filter(envelope => envelope.from === address)
  const isReplied = (envelope: Envelope): boolean => replies.some(reply => reply.in_reply_to === envelope.id)
  const closers = opened.filter(envelope => envelope.kind === 'cancel' && isReplied(envelope))
  // why: one sender's seq orders its messages even when their timestamps tie; across senders only the clock does.
  const isBefore = (assign: Envelope, cancel: Envelope): boolean => assign.from === cancel.from ? assign.seq < cancel.seq : assign.created_at <= cancel.created_at
  return opened.filter(envelope => !isReplied(envelope) && !(envelope.kind === 'assign' && closers.some(cancel => isBefore(envelope, cancel))))
}
