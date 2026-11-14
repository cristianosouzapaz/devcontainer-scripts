import type { Result } from '../lib/result'

/**
 * A call that failed after an established change: its error names what was done and what was not. A success is done, a plain failure
 * is refused (nothing changed), and {@link Unknown} is a call whose effect the mod cannot establish.
 */
export interface Stopped { isOk: false; error: string; isStopped: true }

/** A call that did not finish where the mod cannot establish what changed: its error says why, and its check what to read before retrying. */
export interface Unknown { isOk: false; error: string; check: string; isUnknown: true }

/**
 * Wraps an error as a stopped call.
 * @param error - What was done, then what was not, such as `Created <url>; <what failed>`.
 * @returns The stopped failure.
 */
export const stop = (error: string): Stopped => ({ isOk: false, error, isStopped: true })

/**
 * Wraps an error as a call that did not finish.
 * @param error - Why it did not finish.
 * @param check - What to read before retrying.
 * @returns The unknown failure.
 */
export const unknown = (error: string, check: string): Unknown => ({ isOk: false, error, check, isUnknown: true })

/**
 * Tells whether a failed call stopped after it changed something, rather than refusing before any change.
 * @param result - The call's result.
 * @returns Whether it stopped.
 */
export const isStopped = (result: Result<unknown>): boolean => 'isStopped' in result && result.isStopped === true

/**
 * Words a call that did not finish, where the mod cannot establish what changed, as a generic catch must.
 * @param name - The call's name.
 * @param error - Why it did not finish.
 * @param check - What to read before retrying, such as `git log -1`.
 * @param isMaybeRunning - Whether the work may still run, as after a budget timeout; a work that threw has settled.
 * @returns The text.
 */
export const describeUnknown = (name: string, error: string, check: string, isMaybeRunning = false): string =>
  `${name} did not finish (${error}): it may have done part of its work${isMaybeRunning ? ' or may still be running' : ''}; check ${check} before retrying`

/**
 * Words a call's outcome for the reader: the outcome when done, otherwise a refusal, a stop or an unfinished call, naming the call.
 * @param name - The call's name, such as a tool's or `/flow retire`.
 * @param outcome - What the call did, why it refused, where it stopped, or why it did not finish.
 * @returns The text.
 */
export const describeOutcome = (name: string, outcome: Result<string>): string => {
  if (outcome.isOk) return outcome.value
  if ('isUnknown' in outcome && 'check' in outcome && typeof outcome.check === 'string') return describeUnknown(name, outcome.error, outcome.check)
  return `${name} ${isStopped(outcome) ? 'stopped' : 'refused'}: ${outcome.error}`
}
