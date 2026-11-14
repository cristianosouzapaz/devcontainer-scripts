import type { Attempt, ProcessState } from '../../types'
import { isProcessStarted } from './process-state'
import { sessionMemory } from './session-memory'
import { tickMs } from './timing'
import { isPromptPending, isTurnChangePending, readFailedTurnChanges } from './turn-evidence'
import type { TurnChange } from './turn-evidence'

/**
 * An obligation that holds the session: evidence not yet resolved, under which the mod submits none of its own prompts on any route and
 * asserts nothing it cannot vouch for. Each is released only by evidence that resolves it, never by a read that merely succeeds.
 */
export type HoldReason =
  | { kind: 'unstarted' }
  | { kind: 'unreadable' }
  | { kind: 'legacy'; missing: 'host record' | 'activity record' | 'host and activity records' | 'own identity' }
  | { kind: 'turn-change'; change: TurnChange }
  | { kind: 'activity' }
  | { kind: 'attempt'; attempt: Attempt }

/** Why the session is busy: the mod's tools are not registered, a turn runs or is being written, a prompt is entering, or a submit of this load is in flight or settling. */
type BusyReason = 'tools' | 'turn' | 'prompt' | 'submitting'

/** A fact an idle judgment discharged. */
type IdleFact = 'process state adopted' | 'earlier records settled' | 'turn changes written' | 'no submission unsettled' | 'tools registered' | 'no turn running' | 'no prompt entering'

/** What an idle judgment rests on: the turn epoch it was made at, and every fact it discharged, so idle is never a bare timestamp or a read that succeeded. */
interface IdleProof { epoch: number; facts: readonly IdleFact[] }

/** The one judgment every automatic submit rests on, made again in the compare-and-set that claims the window, right before the submit. */
export type Gate = { kind: 'held'; reasons: readonly HoldReason[] } | { kind: 'busy'; reason: BusyReason } | { kind: 'idle'; proof: IdleProof }

/** What this load holds besides the process state: when, whether it adopted the state, its turn changes not written yet and its submits in flight. */
export interface Evidence {
  now: number; isStarted: boolean; isSurfaceRegistered: boolean; failedTurnChanges: readonly TurnChange[]; isTurnChanging: boolean; isPromptEntering: boolean
  isActivityUnchecked: boolean; liveAttempts: ReadonlySet<string>
}

/** Every fact an idle judgment discharges. */
const idleFacts: readonly IdleFact[] = ['process state adopted', 'earlier records settled', 'turn changes written', 'no submission unsettled', 'tools registered', 'no turn running', 'no prompt entering']

/**
 * Reads the evidence this load holds now.
 * @param now - The time, in epoch ms.
 * @returns The evidence.
 */
export function readEvidence(now: number): Evidence {
  return { now, isStarted: isProcessStarted(), isSurfaceRegistered: sessionMemory.isSurfaceRegistered, failedTurnChanges: readFailedTurnChanges(),
    isTurnChanging: isTurnChangePending(), isPromptEntering: isPromptPending(), isActivityUnchecked: sessionMemory.isActivityUnchecked,
    liveAttempts: new Set(sessionMemory.liveAttempts) }
}

/**
 * Names what an earlier version's records left unknown.
 * @param state - The process state.
 * @returns What is missing, or null once settled.
 */
const readLegacyMissing = (state: ProcessState): Extract<HoldReason, { kind: 'legacy' }>['missing'] | null => {
  const legacy = state.legacy
  if (!legacy) return null
  if (legacy.host === 'unread') return legacy.activity === 'unread' ? 'host and activity records' : 'host record'
  return legacy.activity === 'unread' ? 'activity record' : 'own identity'
}

/**
 * Tells whether an attempt holds the session: one whose outcome is unknown, or one still pending that no submit of this load awaits, as
 * an earlier load's, whose answer may still arrive.
 * @param attempt - The attempt.
 * @param live - The attempts this load awaits.
 * @returns Whether it holds.
 */
const isUnresolved = (attempt: Attempt, live: ReadonlySet<string>): boolean => attempt.status.kind === 'unknown' || attempt.status.kind === 'pending' && !live.has(attempt.id)
  && !sessionMemory.unsubmittedClaims.has(attempt.id)

/**
 * Judges whether the mod may submit one of its own prompts now: held while any evidence is unresolved, listing every such obligation;
 * busy while a turn runs or may be starting, a prompt is entering, the tools are not registered, or a submit is in flight or settling;
 * idle only with every fact discharged.
 * @param state - The process state, null when it cannot be read or is of an unknown shape.
 * @param evidence - What this load holds.
 * @returns The judgment.
 */
export function judge(state: ProcessState | null, evidence: Evidence): Gate {
  const legacy = state ? readLegacyMissing(state) : null
  const reasons: HoldReason[] = [...evidence.isStarted ? [] : [{ kind: 'unstarted' as const }], ...state ? [] : [{ kind: 'unreadable' as const }],
    ...legacy ? [{ kind: 'legacy' as const, missing: legacy }] : [], ...evidence.failedTurnChanges.map(change => ({ kind: 'turn-change' as const, change })),
    ...evidence.isActivityUnchecked ? [{ kind: 'activity' as const }] : [],
    ...(state?.attempts ?? []).filter(attempt => isUnresolved(attempt, evidence.liveAttempts)).map(attempt => ({ kind: 'attempt' as const, attempt }))]
  if (reasons.length || !state) return { kind: 'held', reasons }
  if (!evidence.isSurfaceRegistered) return { kind: 'busy', reason: 'tools' }
  if (state.turn || evidence.isTurnChanging) return { kind: 'busy', reason: 'turn' }
  if (evidence.isPromptEntering || state.prompt !== null && evidence.now - state.prompt.enteredAt < tickMs) return { kind: 'busy', reason: 'prompt' }
  if (state.attempts?.length) return { kind: 'busy', reason: 'submitting' }
  return { kind: 'idle', proof: { epoch: state.epoch, facts: idleFacts } }
}

/**
 * Lists the obligations holding the session now, as the pane and `/flow status` show them; no hold depends on the time.
 * @param state - The process state, null when unknown.
 * @returns The obligations, empty when nothing holds.
 */
export function readHolds(state: ProcessState | null): readonly HoldReason[] {
  const gate = judge(state, readEvidence(0))
  return gate.kind === 'held' ? gate.reasons : []
}
