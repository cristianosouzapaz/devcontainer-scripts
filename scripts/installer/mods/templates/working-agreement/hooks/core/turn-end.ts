import { coordinatorAddress } from '../domain/mail'
import type { Envelope } from '../domain/mail'
import { markForAgent } from '../domain/messages'
import { findLiveDelegation } from './delegation'
import type { EnginePort } from './engine-port'
import { readDeadLetter } from './mail-retry'
import { readAllMail, readOwedMail, readOwnAddresses } from './mailbox'
import { locatePosition } from './position'
import { readCommonDir, readSession } from './record-store'
import { readLatestRetirement } from './retire'
import { sessionMemory } from './session-memory'

/** A unit's open conversations: the ones it opened and waits on, and the ones it owes a reply. */
interface Conversations { awaited: Envelope[]; owed: Envelope[] }

/**
 * Reads a unit's open conversations with its coordinator from both mailboxes: a question or blocked it sent stays open until an answer
 * names it or a dead letter ends it, and an assign, cancel or question it received until it replied, an assign also until a later cancel's done; a blocked never closes an assign.
 * A message from before the unit's latest retirement belongs to the retired session, whose mailbox the retirement archived, so it is
 * neither awaited nor owed.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param unit - The unit's address.
 * @param coordinator - The coordinator's address.
 * @returns The open conversations.
 */
async function readConversations(port: EnginePort, common: string, unit: string, coordinator: string): Promise<Conversations> {
  const retiredAt = (await readLatestRetirement(port, Number(unit)))?.at ?? 0
  const isCurrent = (envelope: Envelope): boolean => Date.parse(envelope.created_at) >= retiredAt
  const received = (await readAllMail(port, common, unit)).filter(isCurrent)
  const sent = (await readAllMail(port, common, coordinator)).filter(envelope => envelope.from === unit && isCurrent(envelope))
  const opened = sent.filter(envelope => (envelope.kind === 'question' || envelope.kind === 'blocked') && !received.some(reply => reply.in_reply_to === envelope.id))
  // why: a dead letter ends its conversation, so the unit no longer waits on it.
  const isDead = await Promise.all(opened.map(envelope => readDeadLetter(port, common, envelope.id)))
  return {
    awaited: opened.filter((_, index) => !isDead[index]),
    owed: (await readOwedMail(port, common, unit)).filter(isCurrent),
  }
}

/**
 * Judges a delegated unit's turn end: when the agent sent no message this turn, the turn did not only read informs, the unit waits on no
 * conversation it opened and its step is not the user's, the turn end is blocked once per state, keyed on records only, to ask for a message.
 * @param port - The engine calls.
 * @returns The block's text, or null when the turn ends.
 */
export async function judgeTurnEnd(port: EnginePort): Promise<string | null> {
  if (sessionMemory.hasSentThisTurn || sessionMemory.isInformOnlyTurn) return null
  const common = await readCommonDir(port)
  const session = await readSession(port)
  const unit = (await readOwnAddresses(port)).find(address => /^\d+$/.test(address))
  const scope = common && unit && session.flow ? await findLiveDelegation(port, session.issues) : null
  if (!common || !unit || !scope) return null
  const position = await locatePosition(port, session)
  const step = position?.current?.step
  // why: a user's step is not the coordinator's to lift, so the unit has nothing to send it.
  if (!step || step.isHuman) return null
  const { awaited, owed } = await readConversations(port, common, unit, coordinatorAddress(scope.sessionId))
  if (awaited.length) return null
  const key = [step.id, position.slice?.tree ?? '', ...owed.map(envelope => envelope.id)].join(':')
  if (sessionMemory.turnEndKeys.has(key)) return null
  sessionMemory.turnEndKeys.add(key)
  const open = owed.length ? ` Open and owed a reply: ${owed.map(envelope => `${envelope.kind} ${envelope.id}`).join(', ')}.` : ''
  return markForAgent(`This unit's turn ends at ${step.label} with no message to its coordinator, which does not read this pane. Report with send before you end it: `
    + 'done in reply to the assign you finished, question for a decision (its options and your proposal), or blocked for a stop only the coordinator or the user '
    + `can lift. If the work goes on instead, go on.${open} This is asked once for this state.`)
}
