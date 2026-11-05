import { coordinatorAddress, userAddress } from '../domain/mail'
import { deriveReplyId, isReplyKind, judgeReply, sendKinds, withArticle } from '../domain/mail-reply'
import { isIssueNumber, isStringArray } from '../lib/guards'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { findLiveDelegation } from './delegation'
import type { EnginePort } from './engine-port'
import { recordLateReply } from './mail-retry'
import { findMessage, readOwnAddresses, sendMail } from './mailbox'
import { readCommonDir } from './record-store'
import { keepLateReply } from './retire'
import { sessionMemory } from './session-memory'
import { askUser, forwardToUser, readForward } from './user-inbox'

/**
 * Runs an agent's `send`: a reply goes to the sender of the message it answers, from the mailbox that message reached, under the
 * legal-reply map and a derived id; a unit's question or blocked opens a conversation with the coordinator that delegates it; a
 * coordinator's question to the user forwards a unit's question unchanged, or opens its own, and needs options either way.
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
  const own = await readOwnAddresses(port)
  if (to === userAddress) {
    const coordinator = own.find(address => address.startsWith('coordinator-'))
    if (!coordinator) return fail('a unit asks its coordinator only: send the question with options to it, and it forwards a question only the user can answer')
    if (known !== 'question' || inReplyTo !== undefined) return fail('only a question is sent to the user, and it opens a conversation')
    const sent = typeof forward === 'string' && /^[\w-]+$/.test(forward) ? await forwardToUser(port, coordinator, forward, body)
      : forward !== undefined ? fail('forward must be the id of a unit\'s question in this mailbox')
        : isIssueNumber(about) ? await askUser(port, about, body, options, refs) : fail('a question of the coordinator\'s own to the user names its issue')
    if (sent.isOk) sessionMemory.hasSentThisTurn = true
    return sent
  }
  if (!isReplyKind(known)) {
    if (inReplyTo !== undefined) return fail(`a ${known} opens a conversation and is never a reply: send it without in_reply_to`)
    const issue = Number(own.find(address => /^\d+$/.test(address)))
    if (!issue) return fail(`only a unit session spawn started opens a ${known} with send; a coordinator messages a unit with unit_prompt`)
    const scope = await findLiveDelegation(port, [issue])
    if (!scope) return fail(`no running coordinator delegates #${issue}, so no session would read a ${known}`)
    const coordinator = coordinatorAddress(scope.sessionId)
    const sent = await sendMail(port, { kind: known, to: coordinator, issue, body, refs, options })
    if (sent.isOk) sessionMemory.hasSentThisTurn = true
    return sent.isOk ? succeed(`Sent ${known} ${sent.value} to the coordinator (${coordinator}); its answer arrives in this session's mailbox.`) : sent
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
    sessionMemory.hasSentThisTurn = true
    const late = await recordLateReply(port, common, inReplyTo, sent.value) ? ' It came after the message\'s dead letter, so it is recorded on that dead letter too.' : ''
    return succeed(`Sent ${known} ${sent.value} to ${original.from}, in reply to ${inReplyTo}.${late}`)
  }
  return fail(`no message ${inReplyTo} reached this session's mailbox, so there is nothing to reply to`)
}
