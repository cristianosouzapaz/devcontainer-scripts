import { stop, unknown } from '../domain/outcome'
import { fail } from '../lib/result'
import type { Result } from '../lib/result'

/** What kind of change a spawn made, so a failure's own text can name it and the escalation can read how its session stands. */
export type EffectKind = 'placement' | 'cut' | 'close' | 'session' | 'record' | 'marker' | 'start' | 'opened' | 'checkout' | 'message' | 'name' | 'assign' | 'ack'
  | 'workspace' | 'escalation' | 'level'

/**
 * A change one spawn call established: its kind, how its answer words it after "this spawn", what to read to check it, what to do next
 * while it is the last change named, and whether the caller's own answer names it already, as an escalation's notice names its close.
 */
export interface Effect { kind: EffectKind; clause: string; check?: string; next?: string; isNamed?: boolean }

/** A change one spawn call began without an established result: its kind, what was under way, and what to read before retrying. */
interface Pending { kind: EffectKind; what: string; check: string }

/**
 * Why a spawn step failed, and how its answer words it: the step's own next move, a clause that follows the changes named, the
 * changes its own text already names, and its wording as a refusal.
 */
export interface Failure { error: string; next?: string; after?: string; covers?: EffectKind[]; refusal?: string }

/**
 * One spawn call's effect state: the changes it established, in order, and those it began whose result is not established; one
 * classifier turns a failure into a refusal, a stop or a call that did not finish from it alone.
 */
export interface SpawnEffects {
  /** Records a change whose result came back. */
  establish: (effect: Effect) => void
  /** Replaces the established change of a kind, as a cut takes the place of the placement record it rests on. */
  supersede: (kind: EffectKind, effect: Effect) => void
  /** Drops the established change of a kind once it is undone, as a start marker removed. */
  retract: (kind: EffectKind) => void
  /** Opens a change; the returned call closes it once its result is established, recording the change when one is given. */
  begin: (pending: Pending) => (effect?: Effect) => void
  /** Tells whether a change of this kind is still unresolved. */
  isPending: (kind: EffectKind) => boolean
  /** Tells whether a change of this kind is established. */
  has: (kind: EffectKind) => boolean
  /** Words a failure from the effect state: did not finish while a change is unresolved, stopped after an established one, else refused. */
  classify: (failure: Failure) => Result<never>
}

/**
 * Creates the effect state of one spawn call, or of an escalation's resume.
 * @param issue - The unit's issue, named by the default next move.
 * @returns The empty state.
 */
export function createSpawnEffects(issue: number): SpawnEffects {
  const state: { established: Effect[]; pending: { id: number; value: Pending }[]; next: number } = { established: [], pending: [], next: 0 }
  const establish = (effect: Effect): void => { state.established = [...state.established, effect] }
  return {
    establish,
    supersede: (kind, effect) => {
      const index = state.established.findIndex(each => each.kind === kind)
      state.established = index < 0 ? [...state.established, effect] : state.established.map((each, at) => at === index ? effect : each)
    },
    retract: kind => { state.established = state.established.filter(each => each.kind !== kind) },
    begin: pending => {
      const id = state.next
      state.next += 1
      state.pending = [...state.pending, { id, value: pending }]
      return effect => {
        state.pending = state.pending.filter(each => each.id !== id)
        if (effect) establish(effect)
      }
    },
    isPending: kind => state.pending.some(each => each.value.kind === kind),
    has: kind => state.established.some(each => each.kind === kind),
    classify: failure => {
      const covers = failure.covers ?? []
      const named = state.established.filter(effect => !effect.isNamed && !covers.includes(effect.kind))
      const clauses = named.map(effect => effect.clause).join(', then ')
      const latest = state.pending.at(-1)?.value
      if (latest) {
        const checks = [...state.pending.map(each => each.value.check), ...named.flatMap(effect => effect.check ? [effect.check] : [])]
        return unknown(`${latest.what} when it failed: ${failure.error}${clauses ? `; this spawn already ${clauses}` : ''}`, [...new Set(checks)].join(', and '))
      }
      if (!state.established.length) return fail(failure.refusal ?? failure.error)
      if (!named.length) return stop(failure.error)
      const next = failure.next ?? named.findLast(effect => effect.next)?.next ?? `check unit_read ${issue} and plan before spawning again`
      return stop(`${failure.error}; before that, this spawn ${clauses}${failure.after ?? ''}; ${next}`)
    },
  }
}
