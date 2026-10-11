import { formatError } from '../lib/result'
import type { EnginePort } from './engine-port'

/**
 * Builds the handler for a failure the hooks recover from: the work goes on without it, and the user sees why.
 * The mod has no silent catch: a failure is either surfaced here or turned into a deny by a gate.
 *
 * @param port - The engine calls.
 * @param action - What could not be done, as it completes "The working agreement could not …".
 * @returns The handler, which toasts the failure.
 */
export function toastFailure(port: EnginePort, action: string): (error: unknown) => void {
  return error => port.toast(`The working agreement could not ${action} (${formatError(error)}).`)
}
