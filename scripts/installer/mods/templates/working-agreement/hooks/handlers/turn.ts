import type { Args, EventResult, Frozen, Next } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { reread } from '../core/pane-view'
import { withRecordLock } from '../core/session-memory'
import { endHandoffTurn, trackSessionLength } from '../features/handoff'

/**
 * Ends the main agent's turn: reports the end of a /handoff turn to the handoff,
 * and otherwise checks whether the session has grown long.
 *
 * @param port - The engine calls.
 * @param event - The completed turn.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleTurnComplete(port: EnginePort, event: Frozen<Args<'turn.complete'>>, next: Next<'turn.complete'>): Promise<EventResult<'turn.complete'>> {
  const done = await next(event)
  if (event.agentId) return done
  if (!endHandoffTurn(event.reason)) await withRecordLock(() => trackSessionLength(createFeaturePort(port)))
  await reread(port, true)
  return done
}
