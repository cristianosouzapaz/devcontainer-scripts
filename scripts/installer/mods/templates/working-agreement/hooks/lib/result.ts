/** A call that succeeded, and the value it produced. */
interface Success<T> { isOk: true; value: T }

/** A call that failed, and why. */
interface Failure { isOk: false; error: string }

/** What a call outside the mod produced: success with a value, or failure with an error. */
export type Result<T> = Success<T> | Failure

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
 * Settles a pending call as a result.
 *
 * @param work - The pending call.
 * @returns Its value as a success, or its rejection's message as a failure.
 */
export const settle = <T>(work: Promise<T>): Promise<Result<T>> => work.then(succeed, (error: unknown) => fail(formatError(error)))

/**
 * Words a thrown value as an error message.
 *
 * @param error - What was thrown.
 * @returns Its message, or its text when it is not an Error.
 */
export const formatError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Words a thrown value as the first line of its error message, for a reply that must stay on one line.
 *
 * @param error - What was thrown.
 * @returns The message's first line.
 */
export const formatErrorLine = (error: unknown): string => formatError(error).split(/\r?\n/)[0] ?? ''
