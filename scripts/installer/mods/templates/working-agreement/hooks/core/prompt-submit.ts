import { DroppedPromptError } from './engine-port'
import type { EnginePort } from './engine-port'
import { tickMs } from './timing'

/** How a mod prompt's submit settled: the engine confirmed it, answered that it dropped it, or it failed otherwise, its entry unknown. */
export type SubmitOutcome = { kind: 'submitted' } | { kind: 'dropped'; error: unknown } | { kind: 'failed'; error: unknown }

/** A submit's outcome within one tick, unsettled past it, and the outcome it settles to whenever it does. */
export interface BoundedSubmit { outcome: SubmitOutcome | { kind: 'unsettled' }; late: Promise<SubmitOutcome> }

/**
 * Submits a mod prompt bounded by one tick, as the doorbell's ring is: the engine may hold a plugin's prompt without settling it, as after
 * an interrupt, so whatever waits on the submit gets an unsettled outcome past the tick and its late answer apart, never a wait without end.
 * @param port - The engine calls.
 * @param text - The prompt.
 * @returns The outcome within the tick, and the late one.
 */
export async function submitWithinTick(port: EnginePort, text: string): Promise<BoundedSubmit> {
  const late = port.submitPrompt(text).then((): SubmitOutcome => ({ kind: 'submitted' }),
    (error: unknown): SubmitOutcome => error instanceof DroppedPromptError ? { kind: 'dropped', error } : { kind: 'failed', error })
  const bound = new AbortController()
  const expired = port.clock.sleep(tickMs, bound.signal).then(() => ({ kind: 'unsettled' as const }), () => new Promise<never>(() => {}))
  const outcome = await Promise.race([late, expired])
  bound.abort()
  return { outcome, late }
}
