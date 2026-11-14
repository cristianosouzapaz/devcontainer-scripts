/** Whether an attempt's result stands, or is worth one more attempt. */
export type RetryVerdict = 'done' | 'retry'

/** How many attempts an operation gets, which with each attempt's own timeout bounds its time, and the wait between them. */
export interface RetryPolicy { maxAttempts: number; delaySeconds: number }

/** What a retry is built from: its policy, its classifier, and the wait it runs on. */
export interface RetryOptions<T> {
  policy: RetryPolicy
  classify: (result: T) => RetryVerdict
  /** Waits between attempts; a host `sleep` keeps the wait off the hook's budget clock, which a `$.clock` wait runs down. */
  sleep: (seconds: number) => Promise<void>
  onRetry?: (attempt: number, result: T) => void
}

/** The result that stood, and how many attempts it took. */
export interface Retried<T> { result: T; attempts: number }

/**
 * Runs an operation until its classifier lets the result stand or the attempts run out, waiting the policy's delay
 * between attempts. It has no jitter: one client retries two or three times.
 * @param operation - The attempt.
 * @param options - The policy, classifier, wait and retry report.
 * @returns The last attempt's result and the number of attempts made.
 */
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions<T>): Promise<Retried<T>> {
  return attemptFrom(1, operation, options)
}

/**
 * Makes one attempt, then the rest the policy allows.
 * @param attempt - This attempt's number, from 1.
 * @param operation - The attempt.
 * @param options - The policy, classifier, wait and retry report.
 * @returns The last attempt's result and the number of attempts made.
 */
async function attemptFrom<T>(attempt: number, operation: () => Promise<T>, options: RetryOptions<T>): Promise<Retried<T>> {
  const result = await operation()
  if (options.classify(result) === 'done' || attempt >= options.policy.maxAttempts) return { result, attempts: attempt }
  options.onRetry?.(attempt, result)
  await options.sleep(options.policy.delaySeconds)
  return attemptFrom(attempt + 1, operation, options)
}
