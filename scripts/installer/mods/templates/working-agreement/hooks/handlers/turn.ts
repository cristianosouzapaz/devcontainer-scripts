import type { Args, EventResult, Frozen, Next } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import { toastFailure } from '../core/failure-toast'
import { createFeaturePort } from '../core/feature-port'
import { refreshView } from '../core/pane-view'
import { reconcileBackgroundRuns } from '../core/runs-in-flight'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { endHandoffTurn, trackSessionLength } from '../features/handoff'

/**
 * Ends the main agent's turn: clears the turn's skills, reports the end of a /handoff turn to the handoff,
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
  sessionMemory.turnSkills = []
  if (endHandoffTurn(event.reason)) return done
  await withRecordLock(() => trackSessionLength(createFeaturePort(port)))
  return done
}

/**
 * Drops the background runs whose task ended without a notification, from the background work the classic stop lists;
 * an engine that lists none drops nothing.
 *
 * @param port - The engine calls.
 * @param event - The classic stop.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleClassicStop(port: EnginePort, event: Frozen<Args<'classic.Stop'>>, next: Next<'classic.Stop'>): Promise<EventResult<'classic.Stop'>> {
  if (event.background_tasks && reconcileBackgroundRuns(event.background_tasks.map(task => task.id))) {
    await withRecordLock(() => refreshView(port, true)).catch(toastFailure(port, 'refresh the Flow pane'))
  }
  return next(event)
}
