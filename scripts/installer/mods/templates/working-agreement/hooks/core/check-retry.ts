import type { HookFailure } from 'claude-code'

import { describeHookError, markForAgent } from '../domain/messages'
import { sessionMemory } from './session-memory'
import type { GuardStat } from './session-memory'

/** A hook's budget as `next.budget` reads it, live. */
interface Budget { readonly ms: number; readonly remainingMs: number }

/** A guard's `next`: the chain beneath, and the budget the guard runs under. */
interface GuardNext<E, R> {
  (event: E): Promise<R>
  readonly budget: Budget
}

/** A guard's `next` as its `.catch` reads it: also why the guard failed, and whether it had passed the call on. */
export interface CaughtNext<E, R> extends GuardNext<E, R> {
  readonly error: HookFailure
  readonly called: boolean
}

/**
 * A guard's check of one call: it judges the call and runs the chain beneath through `proceed` once the call passes. It is
 * built over the hook's `$` in the hook itself, since the engine lets `$` be spelled only at its call site, never passed on.
 */
export type GuardCheck<E, R> = (proceed: (event: E) => Promise<R>) => Promise<R>

/** A guard hook, past its `$`. */
export type GuardHook<E, R> = (event: E, next: GuardNext<E, R>) => Promise<R>

/** A guard's `.catch` handler, past its `$`. */
export type GuardCatch<E, R> = (event: E, next: CaughtNext<E, R>) => Promise<R>

/** A check that ran past the hook budget, and whether its retry recovered it. */
export interface GuardTimeout { guard: string; isRecovered: boolean }

/** A check that used most of its hook budget. */
export interface GuardUsage { guard: string; usedMs: number; budgetMs: number }

/** What a guard's `.catch` is built from. */
export interface GuardCatchSpec<E, R> {
  /** Names the guard in its measurements. */
  guard: string
  check: GuardCheck<E, R>
  /** The guard's deny in its event's shape. */
  deny: (reason: string) => R
  /** The handler's `$.clock.sleep`, which the deadline waits on. */
  sleep: (delayMs: number, signal: AbortSignal) => Promise<void>
  /** Hears each timeout once the answer is known; it must not wait, since it runs inside the grace. */
  onTimeout?: (timeout: GuardTimeout) => void
}

/** The race between a retried check and its deadline: neither has won yet, the check passed the call on, or the deadline expired. */
interface Race { state: 'pending' | 'passed' | 'expired' }

/** The error a failed guard check denies with. */
export const checkFailed = markForAgent('The check failed, so the call is denied — retry; if it keeps failing, stop and tell the user.')

/**
 * Reads a guard's measurements, created empty on first use.
 * @param guard - The guard's name.
 * @returns Its measurements, live.
 */
function readStat(guard: string): GuardStat {
  const known = sessionMemory.guards.get(guard)
  if (known) return known
  const created: GuardStat = { runs: 0, maxUsedMs: 0, timeouts: 0, recovered: 0 }
  sessionMemory.guards.set(guard, created)
  return created
}

/**
 * Wraps a guard's check so each run records how much of the hook budget the check used before it passed the call on or answered.
 * @param guard - The guard's name.
 * @param check - The guard's check.
 * @param onUsage - Hears each run's usage; it must not wait.
 * @returns The guard hook.
 */
export function measureGuard<E, R>(guard: string, check: GuardCheck<E, R>, onUsage?: (usage: GuardUsage) => void): GuardHook<E, R> {
  return async (_event, next) => {
    const run = { isMeasured: false }
    const measure = (): void => {
      if (run.isMeasured) return
      run.isMeasured = true
      const stat = readStat(guard)
      const usedMs = next.budget.ms - next.budget.remainingMs
      stat.runs += 1
      stat.maxUsedMs = Math.max(stat.maxUsedMs, usedMs)
      onUsage?.({ guard, usedMs, budgetMs: next.budget.ms })
    }
    const answer = await check(passed => { measure(); return next(passed) })
    measure()
    return answer
  }
}

/**
 * Builds a guard's `.catch` handler. A call already passed on is replayed; a failure other than a timeout is denied. A timeout
 * runs the check once more against a deadline of half the grace left: the deny lands before the engine drops the handler,
 * which would let the call run unchecked. A retry that passed the call on before the deadline stands; anything else is denied,
 * and a pass arriving after the deadline gets the deny instead of the chain, so the call never runs unchecked.
 * @param spec - The guard, its check, its deny, and who hears a timeout.
 * @returns The handler.
 */
export function guardCatch<E, R>(spec: GuardCatchSpec<E, R>): GuardCatch<E, R> {
  return async (event, next) => {
    if (next.called) return next(event)
    const denial = spec.deny(`${checkFailed} ${describeHookError(next.error)}`)
    if (next.error.kind !== 'timeout') return denial
    const outcome = await retryCheck(event, next, spec, denial)
    const stat = readStat(spec.guard)
    stat.timeouts += 1
    if (outcome.isRecovered) stat.recovered += 1
    spec.onTimeout?.({ guard: spec.guard, isRecovered: outcome.isRecovered })
    return outcome.answer
  }
}

/**
 * Runs the check once more, raced against a deadline of half the grace left.
 * @param event - The call.
 * @param next - The handler's chain and grace.
 * @param spec - The guard's check and the clock its deadline waits on.
 * @param denial - The deny when the retry does not answer in time.
 * @returns The answer, and whether the retry's own verdict stands.
 */
async function retryCheck<E, R>(event: E, next: CaughtNext<E, R>, spec: GuardCatchSpec<E, R>, denial: R): Promise<{ answer: R; isRecovered: boolean }> {
  const control = new AbortController()
  const race: Race = { state: 'pending' }
  const proceed = (passed: E): Promise<R> => {
    if (race.state === 'expired') return Promise.resolve(denial)
    race.state = 'passed'
    control.abort()
    return next(passed)
  }
  const expire = (): boolean => {
    if (race.state === 'pending') race.state = 'expired'
    return race.state === 'expired'
  }
  // Only the pass disarms the deadline: a wait that fails for any other reason expires it, so the call is still denied in time.
  const deadline = spec.sleep(next.budget.remainingMs / 2, control.signal).then(expire, expire)
  const retried = spec.check(proceed).then(answer => ({ answer }), () => null)
  const first = await Promise.race([retried, deadline.then(expired => expired ? 'expired' as const : 'disarmed' as const)])
  if (first === 'expired') return { answer: denial, isRecovered: false }
  const settled = first === 'disarmed' ? await retried : first
  control.abort()
  if (settled) return { answer: settled.answer, isRecovered: true }
  // A retry that failed after it passed the call on: the chain already ran, so its settled result is replayed.
  return race.state === 'passed' ? { answer: await next(event), isRecovered: true } : { answer: denial, isRecovered: false }
}

/**
 * Describes this session's guard checks for `/flow status`: per guard, how many ran, the most of the hook budget one used,
 * and how many timed out and were recovered by the retry.
 * @returns The row's text.
 */
export function describeGuardChecks(): string {
  const guards = [...sessionMemory.guards.entries()]
  if (!guards.length) return 'none measured yet'
  return guards.map(([guard, stat]) => `${guard} ${stat.runs} run, max ${Math.round(stat.maxUsedMs)} ms of the budget`
    + (stat.timeouts ? `, ${stat.timeouts} timed out (${stat.recovered} recovered by the retry)` : ', none timed out')).join(' · ')
}
