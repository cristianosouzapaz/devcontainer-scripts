/** A call that succeeded, and the value it produced. */
interface Success<T> { isOk: true; value: T }

/** A call that failed, and why. */
interface Failure { isOk: false; error: string }

/** What a call outside the mod produced: success with a value, or failure with an error. */
export type Result<T> = Success<T> | Failure

/** The engine clock a timeout waits on; the signal ends the wait once the call has settled. */
export interface ClockPort { sleep: (durationMs: number, signal: AbortSignal) => Promise<void> }

/**
 * Wraps a value as a success.
 *
 * @param value - What the call produced.
 * @returns The success.
 */
export const succeed = <T>(value: T): Success<T> => ({ isOk: true, value })

/**
 * Wraps an error as a failure.
 *
 * @param error - Why the call failed.
 * @returns The failure.
 */
export const fail = (error: string): Failure => ({ isOk: false, error })

/**
 * Reads a result's value, or a fallback when it failed.
 *
 * @param result - The result.
 * @param fallback - What a failure stands for.
 * @returns The value, or the fallback.
 */
export const unwrapOr = <T, F>(result: Result<T>, fallback: F): T | F => (result.isOk ? result.value : fallback)

/**
 * Words a thrown value as an error message.
 *
 * @param error - What was thrown.
 * @returns Its message, or its text when it is not an Error.
 */
export const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Runs a call that has no timeout of its own against one on the engine clock.
 *
 * @param clock - The clock the timeout waits on.
 * @param timeoutMs - How long the call may take.
 * @param label - What the call is, for the error.
 * @param work - The call.
 * @returns Its value, or a failure when it rejected or outlasted the timeout.
 */
export async function withTimeout<T>(clock: ClockPort, timeoutMs: number, label: string, work: () => Promise<T>): Promise<Result<T>> {
  const abort = new AbortController()
  const done = work().then(succeed, (error: unknown) => fail(`${label}: ${formatError(error)}`))
  // A wait the engine refuses, or the abort below, leaves the call to settle on its own.
  const timedOut = clock.sleep(timeoutMs, abort.signal).then(() => fail(`${label}: timed out after ${timeoutMs} ms`), () => done)
  try {
    return await Promise.race([done, timedOut])
  } finally {
    abort.abort()
  }
}
