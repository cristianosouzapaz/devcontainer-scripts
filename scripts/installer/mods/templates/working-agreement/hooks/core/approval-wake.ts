import type { KeyedRow } from '../ui/theme'
import { markForAgent } from '../domain/messages'
import { facts } from '../domain/facts'
import type { Position } from '../domain/step-states'
import { bestEffort } from './best-effort'
import type { EnginePort } from './engine-port'
import { readLoadId, readProcessState, transitOwned } from './process-state'
import { submitAttempt } from './attempts'
import { sessionMemory } from './session-memory'
import { isVerifyApproved } from './verify'
import { createQueue } from '../lib/queue'
import { moduleState } from '../lib/module-state'

// why: the wake callbacks of this module load run one at a time, from their claim to their submit's settlement.
const wakes = moduleState(() => ({ run: createQueue() }))

/** The prompt that wakes a delegated unit once the user approved, in their terminal, the config it waited on. */
export const wakePrompt = markForAgent('The user approved the Verify config this unit waited on, from their own terminal: call the verify tool.')

/**
 * Follows a Verify config approval given in the user's terminal, which no session sees: once the config the unit waited on is
 * approved, a delegated unit's idle session is prompted, once per config, to call Verify, which checks the approval again, so the
 * prompt grants nothing; outside delegation nobody's typing is interrupted, and a note says Verify is next instead.
 * @param port - Engine calls.
 * @param position - The unit's position, or null with no flow declared.
 * @param isDelegated - Whether the unit is delegated.
 * @returns The note to show outside delegation, or none.
 */
export async function followApproval(port: EnginePort, position: Position | null, isDelegated: boolean): Promise<KeyedRow[]> {
  // why: the load is read before the first await, so a follower that resumes after a reload changes nothing the load that replaced it keeps.
  const owner = readLoadId()
  const state = await readProcessState(port)
  // why: the wait is process state, so an approval given before a reload of the mod, which the old module had not followed up, still wakes the unit; unknown state wakes nobody.
  if (!state) return []
  if (state.pendingWake) {
    const blob = state.pendingWake
    // why: an attempt of the wake is shown on the hold row while unresolved; with none, the wake waits for its window, and is tried again.
    if (!state.attempts?.some(attempt => attempt.route === 'wake' && attempt.subject === blob)) scheduleWake(port, owner, blob)
    const attempt = state.attempts?.find(each => each.route === 'wake' && each.subject === blob)
    return [{ key: 'Approve', value: describePendingWake(attempt ? attempt.status.kind : null), tone: 'warn' }]
  }
  const waiting = position?.verify.isWaitingApproval ? position.verify.approvalBlob : undefined
  if (waiting && waiting !== state.approvalWait) await transitOwned(port, owner, held => ({ kind: 'won', value: null, state: { ...held, approvalWait: waiting } }))
  const blob = waiting ?? state.approvalWait
  if (!blob || !position || position.verify.approval || !await isVerifyApproved(port, blob)) return []
  if (!isDelegated) return [{ key: 'Approve', value: facts.verifyConfigApproved, tone: 'text' }]
  // why: a wake before the mod's tools registered would start a turn without verify; the approval stays awaited, so a later reread wakes it.
  if (!sessionMemory.isSurfaceRegistered || state.wokenBlobs.includes(blob)) return []
  // why: claimed inside the compare-and-set as the recorded load, so of two dispatches following one approval at once only one wakes the unit, and a wake already pending is never replaced; the claim stays pending until submitted, so a reload that cancels the deferred submit leaves it for the next follow-up.
  const claimed = await transitOwned(port, owner, held => !held.wokenBlobs.includes(blob) && !held.pendingWake
    ? { kind: 'won', value: null, state: { ...held, approvalWait: null, wokenBlobs: [...held.wokenBlobs, blob], pendingWake: blob } } : { kind: 'gone' })
  if (claimed.kind === 'won') scheduleWake(port, owner, blob)
  return []
}

/**
 * Words a claimed wake not yet known to have entered, as the pane shows it: being submitted or settled, held for an unknown outcome,
 * which the hold row names with how to check it, or waiting for its window.
 * @param status - What its attempt holds, or null with no attempt yet.
 * @returns The words.
 */
function describePendingWake(status: 'pending' | 'unknown' | 'entered' | 'dropped' | null): string {
  if (status === 'unknown') return 'config approved · whether the wake prompt entered is unknown, so it is not submitted again; the Process row says how to check it'
  if (status === 'pending') return 'config approved · the wake prompt is claimed and its outcome is not recorded yet; it is not submitted again'
  if (status === 'entered') return 'config approved · the wake prompt entered, and its wait ends at the next refresh'
  const why = status === 'dropped' ? 'the engine dropped its last submit, so it did not enter' : 'it waits for the session to be idle, with the mod\'s tools registered and nothing held'
  return `config approved · the wake prompt is not delivered yet: ${why}; it is tried again at each refresh`
}

/**
 * Submits a claimed wake from a dispatch of its own through the common driver, which claims the idle window and writes its attempt in
 * one compare-and-set as the recorded load, only while the wake is still claimed and no attempt of it is unsettled; so two callbacks, or
 * two loads, never both submit it, and an attempt whose outcome is unknown is never submitted again.
 * @param port - Engine calls.
 * @param owner - The load that follows the approval, read before its first await.
 * @param blob - The approved config blob the wake is for.
 */
function scheduleWake(port: EnginePort, owner: string, blob: string): void {
  // why: one callback at a time in this load, so a second never reads the first's submit, still in flight, as one to make.
  port.defer(() => void wakes.run(() => bestEffort(port, 'approval wake', async () => {
    await submitAttempt(port, { owner, route: 'wake', subject: blob, kind: 'step', label: 'the Verify approval wake prompt', text: wakePrompt,
      isWanted: state => state.pendingWake === blob && !state.attempts?.some(attempt => attempt.route === 'wake' && attempt.subject === blob) })
  }, undefined)))
}
