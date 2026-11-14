import type { ProcessState } from '../../types'
import { formatError } from '../lib/result'
import type { EnginePort } from './engine-port'
import { isProcessStarted, updateProcessState } from './process-state'
import { sessionMemory } from './session-memory'

/**
 * A turn change this load saw: its order among the changes of this load, which turn it is about (null for an entering prompt), when, and,
 * once its write failed, why and the change itself, which the tick writes again.
 */
export interface TurnChange {
  seq: number; kind: 'start' | 'complete' | 'prompt'; turnId: string | null; at: number; failure: { cause: string; apply: (state: ProcessState) => ProcessState } | null
  /** When an entering prompt's write landed or failed, after which a prompt whose turn has not started yet holds the session as a hold the row explains. */
  heldFrom?: number
  /** The write the change makes, known from its handler's first step, which the tick makes itself once a full tick passed with the change still unwritten, as when its handler ended before writing it. */
  intent?: (state: ProcessState) => ProcessState
  /** The tick of this load the change began in. */
  tick: number
}

/** What a turn owes its Stop: whether it sent a message, null when this load cannot vouch for it, only read informs, or entered as an empty doorbell. */
export interface TurnFlags { hasSent: boolean | null; isInformOnly: boolean; isEmptyDoorbell: boolean }

/**
 * Opens a turn change as its handler begins, before any await: from then until a write of it lands, or a write that supersedes it does, it
 * holds the session, so a delivery never reads the moment between a turn's start and its write as idle. Its write is known from here on,
 * so a handler that ends before making it, as one whose read of the clock or the state failed, leaves it to the tick, never stranded.
 * @param kind - A turn start or end, or an entering prompt.
 * @param turnId - The turn it is about, or null for an entering prompt.
 * @param at - When it happened.
 * @param intent - The write it makes, run on the state of whichever try lands.
 * @returns The change.
 */
export function beginTurnChange(kind: TurnChange['kind'], turnId: string | null, at: number, intent?: (state: ProcessState) => ProcessState): TurnChange {
  // why: a turn change this load heard itself is newer than any the load a reload replaced heard, so from here this change, held until written, stands for whether a turn runs; an entering prompt counts only once the chain accepted it, as a blocked one is no boundary.
  if (kind !== 'prompt') {
    sessionMemory.isActivityUnchecked = false
    sessionMemory.isBoundaryHeard = true
  }
  sessionMemory.turnSeq += 1
  if (kind === 'start') sessionMemory.lastStartSeq = sessionMemory.turnSeq
  const change: TurnChange = { seq: sessionMemory.turnSeq, kind, turnId, at, failure: null, tick: sessionMemory.tickSeq, ...intent ? { intent } : {} }
  sessionMemory.pendingTurnChanges = [...sessionMemory.pendingTurnChanges, change]
  return change
}

/**
 * Tells whether a landed change makes a pending one moot: a turn's end settles every change about that turn; a turn's start settles an
 * earlier change about it, and the failed changes of other turns this load saw before it, since a turn that started later ended those; an
 * entering prompt is settled by any later turn change or prompt. A change about another turn that began later is never settled, so a late
 * write about an earlier turn clears no newer one.
 * @param landed - The change whose write landed.
 * @param pending - A change still pending.
 * @returns Whether the pending one is settled.
 */
function isSettledBy(landed: TurnChange, pending: TurnChange): boolean {
  if (pending.kind === 'prompt') return pending.seq < landed.seq
  if (landed.kind === 'prompt') return false
  if (landed.kind === 'complete') return pending.turnId === landed.turnId
  return pending.turnId === landed.turnId ? pending.seq <= landed.seq : pending.seq < landed.seq && pending.failure !== null
}

/**
 * Tells whether a turn change is still pending, not yet settled by its own write or a later change's.
 * @param turnChange - The change.
 * @returns Whether it is.
 */
const isPending = (turnChange: TurnChange): boolean => sessionMemory.pendingTurnChanges.some(pending => pending.seq === turnChange.seq)

/**
 * Writes a turn's start, end or entering prompt. A write that lands clears the change and the changes it settles; one that fails keeps
 * the change pending with its cause, holding the session, and the tick writes it again.
 * @param port - The engine calls.
 * @param turnChange - The change, as its handler began it.
 * @param apply - Writes it into a state; it is run again on the state of a later try.
 * @returns The state written, or null when the write failed.
 */
export async function writeTurnTransition(port: EnginePort, turnChange: TurnChange, apply: (state: ProcessState) => ProcessState): Promise<ProcessState | null> {
  const written = { isChanged: true }
  return updateProcessState(port, state => {
    const next = apply(state)
    written.isChanged = next !== state
    return next
  }, true).then(async state => {
    sessionMemory.turnMark = { epoch: Math.max(sessionMemory.turnMark.epoch, state.epoch), ended: state.endedTurns?.at(-1) ?? sessionMemory.turnMark.ended }
    // why: an entering prompt holds the session until its turn starts; a write that lands after a later turn change settled the prompt brings back nothing.
    const heldFrom = turnChange.kind === 'prompt' ? await port.now() : 0
    const landed: TurnChange[] = turnChange.kind === 'prompt' && isPending(turnChange) ? [{ ...turnChange, failure: null, heldFrom }] : []
    // why: a change that changed nothing, as a start heard after its own end, settles nothing but itself, or a failed end it came after would be lost.
    sessionMemory.pendingTurnChanges = [...sessionMemory.pendingTurnChanges.filter(pending => pending.seq !== turnChange.seq && !(written.isChanged && isSettledBy(turnChange, pending))), ...landed]
      .sort((left, right) => left.seq - right.seq)
    return state
  }, async (error: unknown) => {
    const cause = formatError(error)
    const failed: TurnChange = { ...turnChange, failure: { cause, apply }, ...turnChange.kind === 'prompt' ? { heldFrom: await port.now() } : {} }
    const others = sessionMemory.pendingTurnChanges.filter(pending => pending.seq !== turnChange.seq)
    // why: a prompt a later turn change settled while its write was failing is not held again.
    if (turnChange.kind === 'prompt' && !isPending(turnChange)) return null
    sessionMemory.pendingTurnChanges = [...others, failed].sort((left, right) => left.seq - right.seq)
    port.logDebug(`working-agreement: a turn change was not written (${cause}); the session is held until it is`)
    return null
  })
}

/**
 * Writes again, oldest first, the turn changes whose write failed; each that lands clears what it settles.
 * @param port - The engine calls.
 * @returns Once each was tried.
 */
export async function retryTurnChanges(port: EnginePort): Promise<void> {
  // why: an entering prompt is not written again: it holds the session until its turn starts, which supersedes it.
  for (const pending of readFailedTurnChanges().filter(each => each.kind !== 'prompt')) {
    // why: a change an earlier retry of this pass settled is gone, and is not written again.
    const apply = pending.failure?.apply ?? pending.intent
    if (!sessionMemory.pendingTurnChanges.some(each => each.seq === pending.seq) || !apply) continue
    await writeTurnTransition(port, pending, apply)
  }
}

/**
 * Tells whether a turn change is stranded: begun a full tick ago or more and still unresolved, as a start or end whose handler ended
 * before writing it, or a prompt whose turn has not started, as one the user withdrew or a later hook blocked.
 * @param pending - The change.
 * @returns Whether it is.
 */
const isStranded = (pending: TurnChange): boolean => sessionMemory.tickSeq - pending.tick >= 2

/**
 * Lists the turn changes this load saw that hold the session until resolved and that the hold row names: a start or end whose write
 * failed or that its handler never wrote, and a prompt that entered a full tick ago or more whose turn has not started. None depends on
 * the time, so the pane and the gate judge them alike.
 * @returns The changes, oldest first.
 */
export const readFailedTurnChanges = (): TurnChange[] => sessionMemory.pendingTurnChanges.filter(pending => pending.kind === 'prompt' ? isStranded(pending)
  : !!pending.failure || isStranded(pending))

/**
 * Tells whether a turn start or end this load saw is not written yet, in flight or failed.
 * @returns Whether one is.
 */
export const isTurnChangePending = (): boolean => sessionMemory.pendingTurnChanges.some(pending => pending.kind !== 'prompt')

/**
 * Tells whether an entering prompt this load saw keeps the session busy: until its turn starts, which settles it, or until it is stranded,
 * after which it holds the session as a hold the row names.
 * @returns Whether it does.
 */
export const isPromptPending = (): boolean => sessionMemory.pendingTurnChanges.some(pending => pending.kind === 'prompt' && !isStranded(pending))

/**
 * Settles, in a turn change's write, the records an earlier version left unresolved: the change itself shows whether a turn runs now.
 * @param held - The state the change writes over.
 * @returns The state with them settled.
 */
export const settleLegacy = (held: ProcessState): ProcessState => held.legacy ? { ...held, legacy: undefined } : held

/**
 * Advances the turn epoch for a turn change. Past an earlier version's activity record that could not be read, whose epoch is unknown,
 * the epoch jumps to the time, above any count that record can hold, so a later read of it never takes its stale turn for a newer one.
 * @param held - The state the change writes over.
 * @param at - When the change happened, in epoch ms.
 * @returns The next epoch.
 */
export const nextEpoch = (held: ProcessState, at: number): number => held.legacy?.activity === 'unread' ? Math.max(held.epoch + 1, at) : held.epoch + 1

/**
 * Judges whether a turn may be running, from every piece of turn evidence: the state's turn, a turn change not written yet, an earlier
 * version's records not settled. The pane and Verify read this one judgment, as the gate does, so none of them takes a working session
 * for idle.
 * @param state - The process state.
 * @returns Whether a turn may be running.
 */
export function judgeTurnRunning(state: ProcessState): boolean {
  return !!state.turn || !!state.legacy || isTurnChangePending() || sessionMemory.isActivityUnchecked
}

/**
 * Reads what the current turn owes its Stop: the running turn's flags, or, before its `turn.start`, those of the prompt that entered for
 * it. Only a turn this load saw start, with every turn change written and no earlier record unsettled, can be said to have sent nothing.
 * @param state - The process state, null when unknown.
 * @returns The flags; null when the state is unknown.
 */
export function readTurnFlags(state: ProcessState | null): TurnFlags | null {
  if (!state) return null
  // why: a fact this load saw for the turn it belongs to still holds for it, written or not.
  const held = withTurnFacts(state)
  const flags = held.turn ?? { hasSent: false, isInformOnly: held.prompt?.isInformOnly ?? false, isEmptyDoorbell: held.prompt?.isEmptyDoorbell ?? false }
  const isSent = [...sessionMemory.turnFacts.values()].some(fact => fact.name === 'sent' && fact.turnId !== null && fact.turnId === sessionMemory.ownTurnId)
  const isOwn = held.turn ? held.turn.id === sessionMemory.ownTurnId : !held.prompt || held.prompt.enteredAt === sessionMemory.ownPromptAt
  // why: an attempt whose outcome is unresolved holds the session, and the hold row promises no missing message is asserted meanwhile.
  const isHeld = (state.attempts ?? []).some(attempt => attempt.status.kind === 'unknown' || attempt.status.kind === 'pending' && !sessionMemory.liveAttempts.has(attempt.id))
  const isSettled = isProcessStarted() && !state.legacy && !isTurnChangePending() && !sessionMemory.isSentUnbound && !sessionMemory.isActivityUnchecked && !isHeld
  return { ...flags, hasSent: flags.hasSent || isSent ? true : isOwn && isSettled ? false : null }
}

/**
 * Applies to a state the turn facts this load holds that belong to its turn, or to no one turn, so a decision reads them as written.
 * @param state - The process state.
 * @returns The state with them.
 */
export function withTurnFacts(state: ProcessState): ProcessState {
  return [...sessionMemory.turnFacts.values()].reduce((held, fact) => fact.turnId === null || held.turn?.id === fact.turnId ? fact.change(held) : held, state)
}

/**
 * Records a fact of a turn, or of no one turn, in the process state; this load keeps it until it is written into its turn, so a write
 * that fails, or a turn whose start is not written yet, never loses it, and the tick writes it again. A later fact of the same name
 * replaces an earlier one of the same turn only, so a late fact of an earlier turn never takes the place of a later turn's.
 * @param port - The engine calls.
 * @param name - The fact.
 * @param turnId - The turn it belongs to, or null for a fact of no one turn.
 * @param change - Writes it into a state.
 * @returns Once written or kept.
 */
export async function recordTurnFact(port: EnginePort, name: string, turnId: string | null, change: (state: ProcessState) => ProcessState): Promise<void> {
  sessionMemory.turnFacts.set(`${name}:${turnId ?? ''}`, { name, turnId, change })
  await writeTurnFacts(port)
}

/**
 * Writes the turn facts this load holds, each into its own turn only; a fact leaves this load once written into it, or once its turn is
 * over, neither the state's turn nor one whose start is still being written.
 * @param port - The engine calls.
 * @returns Once tried; a failure keeps the fact for the next tick.
 */
export async function writeTurnFacts(port: EnginePort): Promise<void> {
  for (const [key, fact] of [...sessionMemory.turnFacts]) {
    const isOwn = (state: ProcessState): boolean => fact.turnId === null || state.turn?.id === fact.turnId
    await updateProcessState(port, state => isOwn(state) ? fact.change(state) : state).then(state => {
      const isStarting = sessionMemory.pendingTurnChanges.some(pending => pending.kind === 'start' && pending.turnId === fact.turnId)
      if (sessionMemory.turnFacts.get(key) === fact && (isOwn(state) || !isStarting)) sessionMemory.turnFacts.delete(key)
    }, (error: unknown) => { port.logDebug(`working-agreement: a turn fact (${fact.name}) was not written (${formatError(error)}); the tick writes it again`) })
  }
}

/**
 * Closes a turn change whose handler writes nothing, as a prompt the chain blocked, so it holds the session no longer.
 * @param turnChange - The change.
 */
export function abandonTurnChange(turnChange: TurnChange): void {
  sessionMemory.pendingTurnChanges = sessionMemory.pendingTurnChanges.filter(pending => pending.seq !== turnChange.seq)
}
