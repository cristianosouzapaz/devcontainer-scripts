import { isCoordinatorSession } from '../domain/coordinator'
import { bodyLimit, coordinatorAddress, doorbellText, envelopeVersion, mailBoxes, mailFileName, orderMail, parseEnvelope, unitAddress, userAddress } from '../domain/mail'
import type { Envelope, MailAuthor, MailKind } from '../domain/mail'
import { removeFile } from '../lib/files'
import { readJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { bestEffort } from './best-effort'
import type { ProcessState } from '../../types'
import { readStaleness } from './mail-expects'
import { setStaleAside } from './mail-retry'
import type { EnginePort } from './engine-port'
import { readLoadId, readProcessState } from './process-state'
import { judgeNow, submitAttempt } from './attempts'
import { clearFault, raiseFault } from './fault-registry'
import { atomicCreate, atomicReplace, listRecordNames, readCommonDir, recordsPath } from './record-store'
import { sessionMemory, withRecordLock } from './session-memory'
import { readProgressFile, resolveSpawnedSession } from './spawn'
import { tickMs } from './timing'

/** A message read from one of this session's mailboxes, with the file it came from. */
interface Delivery { address: string; name: string; envelope: Envelope }

/** A message an injection could not take: its id, the unread file still holding it, and why its move failed. */
export interface Untaken { id: string; path: string; error: string }

/** What a sender gives `send`; the mod fills in every other field. A reply carries the id it answers, the id derived from it, and the address it was sent to;
 * `from` names a sender that is no session's own address, the user's inbox. */
export interface Outgoing {
  kind: MailKind; to: string; issue: number; body: string; refs?: string[]; author?: MailAuthor; options?: string[]; from?: string; expects?: string
  reply?: { inReplyTo: string; id: string; from: string }
}

/** Why a strict mailbox read knows nothing: a directory that could not be listed, or a listed message file that could not be read. */
export type MailFault = { kind: 'list'; directory: string } | { kind: 'read'; directory: string; file: string }

/** The fault a failed read of this session's own mailbox addresses raises, until one succeeds again. */
const addressFault = 'mail-addresses'

/** A failed read of this session's own mailbox addresses, which raised the Mail fault, so a caller may go on without them. */
export class AddressReadError extends Error {}

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
 * A failed read raises the mailbox fault the pane shows until a read succeeds again, so a disk fault never passes for no mail.
 * @param port - The engine calls.
 * @returns The addresses, empty for a session nobody can write to.
 * @throws {AddressReadError} When the spawn bucket cannot be listed or one of its records cannot be read: whether this session has a
 * mailbox is then unknown.
 */
export async function readOwnAddresses(port: EnginePort): Promise<string[]> {
  try {
    const addresses = await listOwnAddresses(port)
    clearFault(addressFault)
    return addresses
  } catch (error) {
    const cause = formatErrorLine(error)
    raiseFault(addressFault, { row: 'Mail', cause, text: `could not read this session's mail (${cause}), so whether mail waits is unknown; it tries again at the `
      + 'next prompt or tick; to check now, read the spawn/ records and list the new/ directories under working-agreement/mail/ in `git rev-parse --git-common-dir`' })
    throw new AddressReadError(cause)
  }
}

/**
 * Lists this session's mailbox addresses, reading every spawn record strictly.
 * @param port - The engine calls.
 * @returns The addresses.
 * @throws When the spawn bucket cannot be listed or a record cannot be read.
 */
async function listOwnAddresses(port: EnginePort): Promise<string[]> {
  const sessionId = await port.readSessionId()
  // why: the engine's raw value, since reading the session through the record store seeds a fresh session's record.
  if (isCoordinatorSession((await port.readSessionState()).value ?? {})) return [coordinatorAddress(sessionId)]
  const common = await readCommonDir(port)
  if (!common) return []
  const names = await listRecordNames(port, recordsPath(common, 'spawn'))
  const issues = await Promise.all(names.map(async name => {
    const issue = Number(/^(\d+)\.json$/.exec(name)?.[1])
    if (!issue) return []
    return await resolveSpawnedSession(common, issue, await readProgressFile(port, common, issue, true)) === sessionId ? [unitAddress(issue)] : []
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
  const own = message.from ?? message.reply?.from ?? await readOwnAddresses(port).then(addresses => addresses[0], (error: unknown) => fail(formatErrorLine(error)))
  if (typeof own === 'object') return fail(`this session's mailbox addresses could not be read (${own.error}), so nothing was sent; retry the send`)
  const from = own
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
    // why: a mailbox, or one of its directories, may not exist yet.
    const names = await port.files.list(mailPath(common, address, box)).catch(() => [])
    // why: a file another session moved meanwhile reads as gone.
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
    // why: a mailbox, or one of its directories, may not exist yet.
    for (const { name } of await port.files.list(mailPath(common, address, box)).catch(() => [])) {
      if (!name.startsWith(`${id}.`)) continue
      // why: a file another injection moved meanwhile reads as gone.
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
export async function hasMessage(port: EnginePort, common: string, address: string, id: string): Promise<boolean> {
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
    // why: the mailbox exists only once something was sent to it or its session watched it.
    const names = await port.files.list(mailPath(common, address, 'new')).catch(() => [])
    const mail = await Promise.all(names.map(async ({ name }): Promise<Delivery[]> => {
      const path = `${mailPath(common, address, 'new')}/${name}`
      // why: a file another injection already moved reads as gone.
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
 * @returns The messages this call moved, and those whose move failed while their file is still unread; one another call moved first is in neither.
 */
async function acknowledgeMail(port: EnginePort, mail: readonly Delivery[]): Promise<{ moved: Delivery[]; untaken: Untaken[] }> {
  const common = await readCommonDir(port)
  if (!common) return { moved: [], untaken: [] }
  const results = await Promise.all(mail.map(async (delivery): Promise<Delivery | Untaken | null> => {
    const unread = `${mailPath(common, delivery.address, 'new')}/${delivery.name}`
    const read = `${mailPath(common, delivery.address, 'cur')}/${delivery.name}`
    // why: one rejected move never takes the others' delivery with it; one that renamed first leaves a step to recovery and loses an inform.
    const run = await executeProcess(port.processes, ['mv', '-f', '--', unread, read]).then(output => output, (error: unknown) => formatErrorLine(error))
    if (typeof run !== 'string' && run.exitCode === 0) {
      // why: a reply deadline runs from the ack, so the file takes the ack's time; a failed touch still delivers, the deadline then running from the send.
      await executeProcess(port.processes, ['touch', '-c', '--', read]).catch(() => null)
      return delivery
    }
    // why: a file gone from new/ was taken by another injection, the ordinary race; one still there was not taken at all, and must not read as no mail.
    const isStill = await port.files.exists(unread).catch(() => true)
    return isStill ? { id: delivery.envelope.id, path: unread, error: typeof run === 'string' ? run : run.stderr.trim().split('\n')[0] || `mv exited ${run.exitCode}` } : null
  }))
  return { moved: results.filter((each): each is Delivery => each !== null && 'envelope' in each), untaken: results.filter((each): each is Untaken => each !== null && 'error' in each) }
}

/**
 * Reads the unread mail an injection would deliver, in injection order, setting aside each message whose expects no longer holds.
 * @param port - The engine calls.
 * @returns The deliverable messages.
 */
async function readDeliverableMail(port: EnginePort): Promise<Delivery[]> {
  const unread = await readUnreadMail(port)
  const stale = await Promise.all(unread.map(delivery => readStaleness(port, delivery.envelope.expects)))
  // why: a message whose expects no longer holds was written for a state that is gone, so it is never acknowledged, injected or rung for.
  for (const [index, delivery] of unread.entries()) {
    const reason = stale[index]
    if (reason) await setStaleAside(port, delivery.address, delivery.name, delivery.envelope, reason)
  }
  return unread.filter((_, index) => !stale[index])
}

/**
 * Takes and acknowledges all unread mail of this session's mailboxes, in injection order.
 * @param port - The engine calls.
 * @returns The messages this call acknowledged, and those it could not take, still unread; one another call moved first is in neither.
 */
export async function takeEnvelopes(port: EnginePort): Promise<{ envelopes: Envelope[]; untaken: Untaken[] }> {
  const { moved, untaken } = await acknowledgeMail(port, await readDeliverableMail(port))
  return { envelopes: moved.map(delivery => delivery.envelope), untaken }
}

/**
 * Reads the step messages this unit session claimed and still owes a done: in cur/ of its own unit mailbox, with no reply in their
 * sender's mailbox. A step stays there from its claim until its done, so a throw or a kill between the two leaves it here to recover.
 * @param port - The engine calls.
 * @returns The claimed steps, none outside a unit session; rejects when a mailbox it reads could not be listed, since claimed is then unknown.
 */
export async function readClaimedSteps(port: EnginePort): Promise<Envelope[]> {
  const common = await readCommonDir(port)
  const unit = (await readOwnAddresses(port)).find(address => /^\d+$/.test(address))
  if (!common || !unit) return []
  // why: a directory that could not be listed leaves claimed unknown; a file moved meanwhile by another injection's ack is an ordinary race, read as gone.
  const readListed = async (address: string): Promise<Envelope[] | null> =>
    (await Promise.all((['new', 'cur'] as const).map(box => listBox(port, common, address, box)))).includes(null) ? null : readAllMail(port, common, address)
  const owed = await collectOwed(unit, readListed)
  if (!owed) throw new Error(`the mailbox of ${unit}, or of a sender it owes a reply, could not be listed`)
  const steps = owed.filter(envelope => envelope.kind === 'step')
  const claimed = await Promise.all(steps.map(envelope => isInBox(port, common, unit, 'cur', envelope.id)))
  if (claimed.includes(null)) throw new Error(`${mailPath(common, unit, 'cur')} could not be listed`)
  return steps.filter((_, index) => claimed[index])
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
  // why: watches are set only at session start, and a session that becomes the coordinator later gets its mailbox then; the root's watch covers it, and the user's mailbox is watched by every session so whichever becomes the coordinator later already notifies.
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
 * Tells whether unread mail an injection would deliver waits in this session's mailboxes; stale mail found meanwhile is set aside.
 * @param port - The engine calls.
 * @returns Whether any deliverable message is unread.
 */
const hasUnreadMail = async (port: EnginePort): Promise<boolean> => (await readDeliverableMail(port)).length > 0

/**
 * Reads the cancels this unit session holds and owes a done, from arrival, read or not.
 * @param port - The engine calls.
 * @returns The cancels, empty outside a unit session.
 */
export async function readOwedCancels(port: EnginePort): Promise<Envelope[]> {
  const common = await readCommonDir(port)
  const unit = (await readOwnAddresses(port)).find(address => /^\d+$/.test(address))
  if (!common || !unit) return []
  return (await readOwedMail(port, common, unit)).filter(envelope => envelope.kind === 'cancel')
}

/**
 * Names the directory a cancel for this unit arrives in, which a long wait watches so a cancel reaches it within a second.
 * @param port - The engine calls.
 * @returns The unit mailbox's new/ directory, or undefined outside a delegated unit, which no cancel reaches.
 */
export async function readCancelMailbox(port: EnginePort): Promise<string | undefined> {
  const common = await readCommonDir(port)
  const unit = (await readOwnAddresses(port)).find(address => /^\d+$/.test(address))
  return common && unit ? mailPath(common, unit, 'new') : undefined
}

/**
 * Rings this session's own doorbell: submits one prompt, deferred and never awaited in the hook, when deliverable mail waits, the session
 * is not busy and no ring younger than one tick is pending. The prompt starts a turn in the idle session; the injection on its entry delivers the mail.
 * @param port - The engine calls.
 * @param state - The process state this dispatch already holds, as one that just wrote it; read here when not given.
 * @returns Once the ring is decided.
 */
export async function ringDoorbell(port: EnginePort, state?: ProcessState | null): Promise<void> {
  const now = await port.now()
  const rungAt = sessionMemory.doorbellRungAt
  // why: a busy session's Stop delivers the mail, and a prompt rung now would queue until after it, so it would enter with nothing to carry; a pending ring older than a tick is taken as lost, since the engine may hold a plugin's prompt without settling it, as after an interrupt.
  if ((rungAt !== null && now - rungAt < tickMs) || judgeNow(state === undefined ? await readProcessState(port) : state, now).kind !== 'idle' || !await hasUnreadMail(port)) return
  sessionMemory.doorbellRungAt = now
  port.defer(() => {
    void bestEffort(port, 'doorbell', () => submitDoorbell(port), undefined)
      .finally(() => { if (sessionMemory.doorbellRungAt === now) sessionMemory.doorbellRungAt = null })
  })
}

/**
 * Submits the doorbell through the common driver, which claims the idle window and writes its attempt in one compare-and-set as the
 * recorded load, so no start enters while the doorbell's prompt is entering, the ring never enters a turn that started since the
 * decision, and a ring whose answer never comes holds the session as unknown rather than ringing again.
 * @param port - The engine calls.
 * @returns Once submitted, or not rung.
 */
async function submitDoorbell(port: EnginePort): Promise<void> {
  const owner = readLoadId()
  if (!await hasUnreadMail(port)) return
  await submitAttempt(port, { owner, route: 'doorbell', subject: 'doorbell', kind: 'step', label: 'the mailbox doorbell prompt', text: doorbellText, isWanted: () => true })
}

/**
 * Removes a mailbox's staged files a crashed send left behind.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param expiry - Files older than this, in epoch ms, are removed.
 * @returns Once every mailbox's tmp/ was swept.
 */
export async function sweepMailStaging(port: EnginePort, common: string, expiry: number): Promise<void> {
  // why: the mail directory may not exist yet.
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
 * @returns `unread` in new/, `acknowledged` in cur/, `none` when neither holds it, and `unknown` when a directory of the mailbox could not be read.
 */
export async function readMailState(port: EnginePort, to: string, id: string): Promise<'unread' | 'acknowledged' | 'none' | 'unknown'> {
  const common = await readCommonDir(port)
  if (!common) return 'unknown'
  const isRead = await isInBox(port, common, to, 'cur', id)
  if (isRead) return 'acknowledged'
  const isUnread = await isInBox(port, common, to, 'new', id)
  if (isUnread) return 'unread'
  return isRead === null || isUnread === null ? 'unknown' : 'none'
}

/**
 * Tells whether a mailbox directory holds any attempt of a message.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @param box - The directory.
 * @param id - The message's id.
 * @returns Whether a file of it is there, null when the directory exists but could not be listed.
 */
async function isInBox(port: EnginePort, common: string, address: string, box: 'new' | 'cur', id: string): Promise<boolean | null> {
  const names = await listBox(port, common, address, box)
  return names && names.some(name => /^(.+)\.\d+\.json$/.exec(name)?.[1] === id)
}

/**
 * Lists a mailbox directory's file names, telling a directory not created yet from one that could not be listed.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @param box - The directory.
 * @returns The names, none for a directory confirmed missing, or null when the directory may exist but could not be listed.
 */
async function listBox(port: EnginePort, common: string, address: string, box: 'new' | 'cur'): Promise<string[] | null> {
  const directory = mailPath(common, address, box)
  const listed = await port.files.list(directory).then(entries => entries.map(entry => entry.name), () => null)
  if (listed) return listed
  // why: the engine's rejection carries no documented missing-path code, so only an exists that says no and a stat that finds nothing confirm absence.
  const isPresent = await port.files.exists(directory).then(exists => exists || port.files.stat(directory).then(() => true, () => false), () => true)
  return isPresent ? null : []
}

/**
 * Tells whether an acknowledged message is closed: replied to, or an assign a later cancel's done closed.
 * @param port - The engine calls.
 * @param to - The address the message was sent to.
 * @param id - The message's id.
 * @returns Whether it is closed; false when no attempt of the message is in cur/; null when a mailbox it needs could not be read.
 */
export async function isMailAnswered(port: EnginePort, to: string, id: string): Promise<boolean | null> {
  const common = await readCommonDir(port)
  if (!common) return null
  const isRead = await isInBox(port, common, to, 'cur', id)
  if (!isRead) return isRead
  const owed = await collectOwed(to, address => readMailOrNull(port, common, address))
  return owed && !owed.some(envelope => envelope.id === id)
}

/**
 * Reads every message a mailbox holds, delivered or already read, one per id.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @returns The valid messages.
 */
export async function readAllMail(port: EnginePort, common: string, address: string): Promise<Envelope[]> {
  // why: a mailbox, or one of its directories, may not exist yet.
  return await readMailOrNull(port, common, address, true) ?? []
}

/**
 * Reads every message a mailbox holds, one per id, telling a directory that could not be listed from an empty one.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @param isLenient - Whether a directory that could not be listed reads as empty.
 * @returns The valid messages, or null when a directory could not be listed and the read is not lenient.
 */
async function readMailOrNull(port: EnginePort, common: string, address: string, isLenient = false): Promise<Envelope[] | null> {
  const mail = await readMailOrFault(port, common, address, isLenient)
  return isMail(mail) ? mail : null
}

/**
 * Reads every message a mailbox holds, one per id, naming what a strict read could not do.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The mailbox.
 * @param isLenient - Whether a directory that could not be listed, or a file that could not be read, reads as empty.
 * @returns The valid messages, or the first directory or file a strict read failed on.
 */
async function readMailOrFault(port: EnginePort, common: string, address: string, isLenient = false): Promise<Envelope[] | MailFault> {
  const listed = await Promise.all((['new', 'cur'] as const).map(async box => ({ directory: mailPath(common, address, box), names: await listBox(port, common, address, box) })))
  const unlisted = isLenient ? undefined : listed.find(({ names }) => names === null)
  if (unlisted) return { kind: 'list', directory: unlisted.directory }
  const texts = await Promise.all(listed.flatMap(({ directory, names }) => (names ?? []).map(async name =>
    ({ directory, name, text: await port.files.read(`${directory}/${name}`).then(text => text, () => null) }))))
  // why: a lenient read takes a file another injection moved meanwhile as gone; a strict one cannot tell that from a failed read, so it knows nothing.
  const unread = isLenient ? undefined : texts.find(({ text }) => text === null)
  if (unread) return { kind: 'read', directory: unread.directory, file: unread.name }
  const valid = texts.map(({ name, text }) => parseEnvelope(name, text ?? '', address)).filter((envelope): envelope is Envelope => envelope !== null)
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
  return await collectOwed(address, each => readAllMail(port, common, each)) ?? []
}

/**
 * Reads the messages a participant still owes a reply, as readOwedMail defines them, telling a mailbox that could not be read from an empty one.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param address - The receiver.
 * @returns The owed messages, or the first directory or file of a mailbox they depend on that could not be listed or read.
 */
export async function readOwedMailOrFault(port: EnginePort, common: string, address: string): Promise<Envelope[] | MailFault> {
  return collectOwed(address, each => readMailOrFault(port, common, each))
}

/**
 * Words a mailbox fault for a reader who checks it by hand.
 * @param fault - The fault.
 * @returns What the mod could not do, and the command that checks it.
 */
export function describeMailFault(fault: MailFault): { failure: string; check: string } {
  return fault.kind === 'list'
    ? { failure: `could not list ${fault.directory}`, check: `check with ls ${fault.directory}` }
    : { failure: `could not read ${fault.file} in ${fault.directory}`, check: `check with cat ${fault.directory}/${fault.file}` }
}

/**
 * Reads the messages a receiver still owes a reply through a mailbox reader, as readOwedMail defines them.
 * @param address - The receiver.
 * @param read - Reads a mailbox, or why it could not be read.
 * @returns The owed messages, or the first failure of a mailbox they depend on.
 */
async function collectOwed<F>(address: string, read: (address: string) => Promise<Envelope[] | F>): Promise<Envelope[] | F> {
  const received = await read(address)
  if (!isMail(received)) return received
  const opened = received.filter(envelope => ['assign', 'cancel', 'question', 'step'].includes(envelope.kind))
  const senders = [...new Set(opened.map(envelope => envelope.from))]
  const boxes = await Promise.all(senders.map(sender => read(sender)))
  const failed = boxes.find(box => !isMail(box))
  if (failed !== undefined && !isMail(failed)) return failed
  const replies = boxes.flatMap(box => isMail(box) ? box : []).filter(envelope => envelope.from === address)
  const isReplied = (envelope: Envelope): boolean => replies.some(reply => reply.in_reply_to === envelope.id)
  const closers = opened.filter(envelope => envelope.kind === 'cancel' && isReplied(envelope))
  // why: one sender's seq orders its messages even when their timestamps tie; across senders only the clock does.
  const isBefore = (assign: Envelope, cancel: Envelope): boolean => assign.from === cancel.from ? assign.seq < cancel.seq : assign.created_at <= cancel.created_at
  return opened.filter(envelope => !isReplied(envelope) && !(envelope.kind === 'assign' && closers.some(cancel => isBefore(envelope, cancel))))
}

/**
 * Tells a mailbox read's messages from its failure.
 * @param read - What a mailbox read returned.
 * @returns Whether it holds the messages.
 */
function isMail<F>(read: Envelope[] | F): read is Envelope[] {
  return Array.isArray(read)
}
