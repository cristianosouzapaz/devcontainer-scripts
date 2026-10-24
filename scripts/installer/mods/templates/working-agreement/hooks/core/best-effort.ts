import type { EnginePort } from './engine-port'
import { fail, formatError } from '../lib/result'
import type { Result } from '../lib/result'

/**
 * Resolves best-effort work with a debug-only failure report.
 * @param port - The engine calls.
 * @param operation - The failed operation's short name.
 * @param work - The attempted work.
 * @param fallback - The value returned on failure.
 * @returns The work's value, or the fallback after a failure.
 */
export async function bestEffort<T, F>(port: EnginePort, operation: string, work: () => Promise<T>, fallback: F): Promise<T | F> {
  try { return await work() } catch (error) {
    logFailure(port, operation, fail(formatError(error)))
    return fallback
  }
}

/**
 * Reports a failed result only to the engine debug log.
 * @param port - The engine calls.
 * @param operation - The failed operation's short name.
 * @param result - The best-effort result.
 */
export function logFailure<T>(port: EnginePort, operation: string, result: Result<T>): void {
  if (!result.isOk) port.logDebug(`working-agreement: ${operation} failed: ${result.error}`)
}
