import type { DelegationScope } from '../domain/delegation'
import { coordinatorAddress, unitAddress, userAddress } from '../domain/mail'
import type { Envelope, MailKind } from '../domain/mail'
import { deriveReplyId, isReplyKind, judgeReply, sendKinds, withArticle } from '../domain/mail-reply'
import { isIssueNumber, isStringArray } from '../lib/guards'
import { fail, formatErrorLine, settle, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { findDelegation, findLiveDelegation, readLiveness } from './delegation'
import type { EnginePort } from './engine-port'
import { recordLateReply } from './mail-retry'
import { describeMailFault, findMessage, readOwedMailOrFault, readOwnAddresses, sendMail } from './mailbox'
import { readCommonDir } from './record-store'
import { keepLateReply, readLatestRetirement } from './retire'
import { readProcessState } from './process-state'
import { recordTurnFact } from './turn-evidence'
import { sessionMemory } from './session-memory'
import { askUser, forwardToUser, readForward } from './user-inbox'

/**
 * Runs an agent's `send`: a reply goes to the sender of the message it answers, from the mailbox that message reached, under the
 * legal-reply map and a derived id; a unit's question or blocked opens a conversation with the coordinator that delegates it, and its
 * inform, a report that takes no reply, goes there too unless an assign or cancel waits on its done; a coordinator's question to the
 * user forwards a unit's question unchanged, or opens its own, and needs options either way.
 * @param port - The engine calls.
 * @param args - The call's arguments.
 * @returns The sent message's id and receiver, or why nothing was sent.
 */
export async function sendTyped(port: EnginePort, args: Record<string, unknown>): Promise<Result<string>> {
  const { kind, body, in_reply_to: inReplyTo, refs = [], to, forward, options = [], issue: about } = args
  const known = sendKinds.find(each => each === kind)
  if (!known) return fail(`kind must be one of ${sendKinds.join(', ')}`)
  if (typeof body !== 'string' || !body.trim()) return fail('body must be the message\'s text')
  if (!isStringArray(refs)) return fail('refs must be a list of URLs or repository paths')
  if (!isStringArray(options) || options.some(option => !option.trim())) return fail('options must be a list of non-empty choices')
  if (options.length && known !== 'question') return fail('only a question carries options')
  if (to !== undefined && to !== userAddress) return fail(`to is ${userAddress} or left out, for the coordinator`)
  if (forward !== undefined && to !== userAddress) return fail(`forward names a question forwarded to the user: send it with to ${userAddress}`)
  const common = await readCommonDir(port)
  if (!common) return fail('this session is not inside a git repository, which holds the mailboxes')
  const read = await settle(readOwnAddresses(port))
  if (!read.isOk) return fail(`this session's mailbox addresses could not be read (${read.error}), so nothing was sent; retry the send`)
  const own = read.value
  // why: the turn a send belongs to is named before the send, so a send that succeeds is kept for its turn even when its start's write or a later read failed.
  const turnId = await bindSend(port)
  if (to === userAddress) {
    const coordinator = own.find(address => address.startsWith('coordinator-'))
    if (!coordinator) return fail('a unit asks its coordinator only: send the question with options to it, and it forwards a question only the user can answer')
    if (known !== 'question' || inReplyTo !== undefined) return fail('only a question is sent to the user, and it opens a conversation')
    const sent = typeof forward === 'string' && /^[\w-]+$/.test(forward) ? await forwardToUser(port, coordinator, forward, body)
      : forward !== undefined ? fail('forward must be the id of a unit\'s question in this mailbox')
        : isIssueNumber(about) ? await askUser(port, about, body, options, refs) : fail('a question of the coordinator\'s own to the user names its issue')
    if (sent.isOk) await markSent(port, turnId)
    return sent
  }
  if (!isReplyKind(known)) {
    if (inReplyTo !== undefined) {
      return fail(known === 'inform' ? 'an inform opens no conversation and is never a reply: send it without in_reply_to'
        : `a ${known} opens a conversation and is never a reply: send it without in_reply_to`)
    }
    const issue = Number(own.find(address => /^\d+$/.test(address)))
    if (!issue) return fail(`only a unit session spawn started sends ${withArticle(known)} with send; a coordinator messages a unit with unit_prompt`)
    const scope = await findUnitCoordinator(port, issue, known)
    if (!scope.isOk) return scope
    if (!scope.value) return fail(`no running coordinator delegates #${issue}, so no session would read ${withArticle(known)}`)
    if (known === 'inform') {
      const open = await findOpenWork(port, common, issue)
      if (!open.isOk) return open
      // why: the coordinator waits on that assign's or cancel's done, so a report sent beside it would leave the done owed.
      if (open.value) return fail(`${open.value.kind} ${open.value.id} is open: put this in its done, sent with in_reply_to ${open.value.id}; nothing was sent`)
    }
    const coordinator = coordinatorAddress(scope.value.sessionId)
    const sent = await sendMail(port, { kind: known, to: coordinator, issue, body, refs, options })
    if (!sent.isOk) return sent
    await markSent(port, turnId)
    return succeed(known === 'inform' ? `Sent inform ${sent.value} to the coordinator (${coordinator}); it takes no reply.`
      : `Sent ${known} ${sent.value} to the coordinator (${coordinator}); its answer arrives in this session's mailbox.`)
  }
  if (typeof inReplyTo !== 'string' || !/^[\w-]+$/.test(inReplyTo)) return fail(`${withArticle(known)} is a reply: in_reply_to must be the id of the message it answers`)
  for (const address of own) {
    const original = await findMessage(port, common, address, inReplyTo)
    if (!original) continue
    const refusal = judgeReply(original.kind, known)
    if (refusal) return fail(`${refusal}: message ${inReplyTo} is ${withArticle(original.kind)}`)
    // why: a step's outcome is the mod's to report, from the checks it ran, so no agent closes one.
    if (original.kind === 'step') return fail(`step ${inReplyTo} is closed by this session's mod once it applied or refused the step, never with send`)
    // why: a forwarded question is the user's to answer, and its asker takes one answer only.
    if (await readForward(port, common, inReplyTo)) return fail(`question ${inReplyTo} was forwarded to the user, whose answer goes to the unit`)
    const kept = await keepLateReply(port, common, original, { kind: known, from: address, body, refs })
    if (kept) return succeed(kept)
    const sent = await sendMail(port, { kind: known, to: original.from, issue: original.issue, body, refs,
      reply: { inReplyTo, id: deriveReplyId(inReplyTo, address), from: address } })
    if (!sent.isOk) return sent
    await markSent(port, turnId)
    const late = await recordLateReply(port, common, inReplyTo, sent.value) ? ' It came after the message\'s dead letter, so it is recorded on that dead letter too.' : ''
    return succeed(`Sent ${known} ${sent.value} to ${original.from}, in reply to ${inReplyTo}.${late}`)
  }
  return fail(`no message ${inReplyTo} reached this session's mailbox, so there is nothing to reply to`)
}

/**
 * Finds the coordinator whose live scope delegates a unit, telling a coordinator that is gone from one whose liveness could not be established.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @param kind - The kind being sent, named in the refusal.
 * @returns The live scope, null when no scope delegates the unit or its coordinator is gone, or why that is unknown, with nothing sent.
 */
async function findUnitCoordinator(port: EnginePort, issue: number, kind: MailKind): Promise<Result<DelegationScope | null>> {
  const unknown = (why: string, check: string): Result<never> =>
    fail(`whether a running coordinator delegates #${issue} is unknown: ${why}. Nothing was sent, never to a recorded address; ${check}, then send the ${kind} again`)
  try {
    const live = await findLiveDelegation(port, [issue], true)
    if (live) return succeed(live)
    const covering = await findDelegation(port, [issue], true)
    if (covering && await readLiveness(port, covering) === 'unknown') {
      return unknown(`the process of coordinator-${covering.sessionId}, which delegates #${issue}, could not be judged running or ended`,
        `check that session ${covering.sessionId} still runs in its herdr pane`)
    }
    return succeed(null)
  } catch (error) {
    return unknown(`the delegation records could not be read (${formatErrorLine(error)})`, 'check that the records named there can be read')
  }
}

/**
 * Finds an assign or cancel the unit still owes its done, of its current session only: a message from before its latest retirement
 * belongs to the retired session. A step's done is its mod's to write, so a step is never one.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @returns The open cancel, else the first open assign, null when none is open, or why that is unknown, with nothing sent.
 */
async function findOpenWork(port: EnginePort, common: string, issue: number): Promise<Result<Envelope | null>> {
  const owed = await readOwedMailOrFault(port, common, unitAddress(issue))
  if (!Array.isArray(owed)) {
    const { failure, check } = describeMailFault(owed)
    return fail(`whether an assign or cancel is open is unknown: the mod ${failure}, which this unit's owed mail is read from. Nothing was sent; ${check}, then send the inform again`)
  }
  const retiredAt = (await readLatestRetirement(port, issue))?.at ?? 0
  const current = owed.filter(envelope => Date.parse(envelope.created_at) >= retiredAt)
  // why: a cancel's done also closes the assign it stopped, so an open cancel is the one to name.
  return succeed(current.find(envelope => envelope.kind === 'cancel') ?? current.find(envelope => envelope.kind === 'assign') ?? null)
}

/**
 * Names the turn a send about to be made belongs to: the turn this load saw start, written or not, else the state's turn.
 * @param port - The engine calls.
 * @returns The turn, or null when none can be named.
 */
export async function bindSend(port: EnginePort): Promise<string | null> {
  return sessionMemory.ownTurnId ?? (await readProcessState(port))?.turn?.id ?? null
}

/**
 * Records that a turn sent a message, which its Stop then asks for no more; the host keeps it, so a reload of the mod does not lose it,
 * and this load keeps it until it is written into its turn. A send whose turn could not be named leaves no turn of this load to be said
 * to have sent none, until the next turn starts.
 * @param port - The engine calls.
 * @param turnId - The turn named before the send, or null when none could be.
 * @returns Once recorded or kept.
 */
export async function markSent(port: EnginePort, turnId: string | null): Promise<void> {
  if (turnId === null) {
    sessionMemory.isSentUnbound = true
    return
  }
  await recordTurnFact(port, 'sent', turnId, state => state.turn ? { ...state, turn: { ...state.turn, hasSent: true } } : state)
}
