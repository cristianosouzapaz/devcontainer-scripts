import type { ProcessState } from '../../types'
import { coordinatorAddress } from '../domain/mail'
import type { Envelope } from '../domain/mail'
import { markForAgent } from '../domain/messages'
import { findLiveDelegation } from './delegation'
import type { EnginePort } from './engine-port'
import { readDeadLetter } from './mail-retry'
import { describeMailFault, readAllMail, readOwedMailOrFault, readOwnAddresses } from './mailbox'
import type { MailFault } from './mailbox'
import { locatePosition } from './position'
import { readCommonDir, readSession } from './record-store'
import { transactProcess } from './process-state'
import { readTurnFlags } from './turn-evidence'
import { readLatestRetirement } from './retire'

/** A unit's open conversations: the ones it opened and waits on, and the ones it owes a reply, or why a mailbox they need could not be read. */
interface Conversations { awaited: Envelope[]; owed: Envelope[] | MailFault }

/** How many asked states the process state keeps: a state seen again after that many others asks once more. */
const turnEndKeyLimit = 20

/**
 * Reads a unit's open conversations with its coordinator from both mailboxes: a question or blocked it sent stays open until an answer
 * names it or a dead letter ends it, and an assign, cancel or question it received until it replied, an assign also until a later cancel's done; a blocked never closes an assign.
 * A message from before the unit's latest retirement belongs to the retired session, whose mailbox the retirement archived, so it is
 * neither awaited nor owed.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param unit - The unit's address.
 * @param coordinator - The coordinator's address.
 * @returns The open conversations; owed is the fault when a mailbox it depends on could not be listed or read, so what is owed is unknown.
 */
async function readConversations(port: EnginePort, common: string, unit: string, coordinator: string): Promise<Conversations> {
  const retiredAt = (await readLatestRetirement(port, Number(unit)))?.at ?? 0
  const isCurrent = (envelope: Envelope): boolean => Date.parse(envelope.created_at) >= retiredAt
  const received = (await readAllMail(port, common, unit)).filter(isCurrent)
  const sent = (await readAllMail(port, common, coordinator)).filter(envelope => envelope.from === unit && isCurrent(envelope))
  const opened = sent.filter(envelope => (envelope.kind === 'question' || envelope.kind === 'blocked') && !received.some(reply => reply.in_reply_to === envelope.id))
  // why: a dead letter ends its conversation, so the unit no longer waits on it.
  const isDead = await Promise.all(opened.map(envelope => readDeadLetter(port, common, envelope.id)))
  const owed = await readOwedMailOrFault(port, common, unit)
  return { awaited: opened.filter((_, index) => !isDead[index]), owed: Array.isArray(owed) ? owed.filter(isCurrent) : owed }
}

/**
 * Judges a delegated unit's turn end: when the agent sent no message this turn, the turn did not only read informs, the unit waits on no
 * conversation it opened and its step is not the user's, the turn end is blocked once per state, keyed on records only, to ask for a message:
 * done naming each open assign or cancel, or an inform when none is open.
 * @param port - The engine calls.
 * @param state - The process state the Stop holds; null when unknown, which asks for nothing.
 * @returns The block's text, or null when the turn ends.
 */
export async function judgeTurnEnd(port: EnginePort, state: ProcessState | null): Promise<string | null> {
  const flags = readTurnFlags(state)
  // why: a turn this load cannot vouch sent no message, as one a reload carried over, is never told it sent none.
  if (!flags || flags.hasSent !== false || flags.isInformOnly || flags.isEmptyDoorbell) return null
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
  const key = [step.id, position.slice?.tree ?? '', ...Array.isArray(owed) ? owed.map(envelope => envelope.id) : [`owed-unknown:${JSON.stringify(owed)}`]].join(':')
  if (!state || state.turnEndKeys.includes(key)) return null
  // why: claimed inside the compare-and-set, as two dispatches or two modules after a reload may judge one state, which asks once; the turn, its sent facts and the holds are judged again there, so a send that finished during the reads above, or a hold since, is never told it sent nothing.
  const isNew = await transactProcess(port, held => held.turnEndKeys.includes(key) || readTurnFlags(held)?.hasSent !== false || held.turn?.id !== state.turn?.id ? { state: held, result: false }
    : { state: { ...held, turnEndKeys: [...held.turnEndKeys, key].slice(-turnEndKeyLimit) }, result: true })
  if (!isNew) return null
  const lead = `This unit's turn ends at ${step.label} with no message to its coordinator, which does not read this pane.`
  const rest = 'question for a decision (its options and your proposal), or blocked for a stop only the coordinator or the user '
    + 'can lift. If the work goes on instead, go on. This is asked once for this state.'
  // why: whether done or inform is legal turns on the owed mail, so with it unknown only the kinds legal in every state are offered.
  if (!Array.isArray(owed)) {
    const { failure, check } = describeMailFault(owed)
    return markForAgent(`${lead} The mod ${failure}, which this unit's owed mail is read from, so whether an assign or cancel `
      + `waits on its done is unknown, and so is whether done or inform is legal now; ${check}. Report with send before you end it: ${rest}`)
  }
  // why: a step's done is its mod's to write, and an inform is refused while an assign or cancel waits on its done, so only the kinds legal now are offered.
  const open = owed.filter(envelope => envelope.kind === 'assign' || envelope.kind === 'cancel')
  const report = open.length ? `done in reply to ${open.map(envelope => `${envelope.kind} ${envelope.id}`).join(' and to ')} once it is finished` : 'inform for a report'
  return markForAgent(`${lead} Report with send before you end it: ${report}, ${rest}`)
}
