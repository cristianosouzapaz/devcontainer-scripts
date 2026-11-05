import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { noticePermission, noticeTurnEnd } from '../core/coordinator-notice'
import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { runIssueAudit } from '../core/issue-audit'
import { recordActivity } from '../core/liveness'
import { ringDoorbell } from '../core/mailbox'
import { reread } from '../core/pane-view'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { endHandoffTurn, trackSessionLength } from '../features/handoff'

/**
 * Starts the main agent's turn: while it runs, the unit still works, so no wait is shown yet; the pane and the sidebar are redrawn at once.
 * @param port - The engine calls.
 * @param event - The starting turn.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleTurnStart(port: EnginePort, event: Frozen<Args<'turn.start'>>, next: Next<'turn.start'>): Promise<EventResult<'turn.start'>> {
  if (event.agentId) return next(event)
  sessionMemory.isTurnLive = true
  sessionMemory.hasSentThisTurn = false
  await bestEffort(port, 'activity', () => recordActivity(port, 'turn.start'), undefined)
  await bestEffort(port, 'turn start reread', () => reread(port, false), undefined)
  return next(event)
}

/**
 * Ends the main agent's turn: reports the end of a /handoff turn to the handoff,
 * and otherwise checks whether the session has grown long; then audits the issues the session wrote and, in a delegated unit, notifies its coordinator;
 * last rings the doorbell for mail that arrived after the turn's Stop delivered the rest.
 *
 * @param port - The engine calls.
 * @param event - The completed turn.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleTurnComplete(port: EnginePort, event: Frozen<Args<'turn.complete'>>, next: Next<'turn.complete'>): Promise<EventResult<'turn.complete'>> {
  const done = await next(event)
  if (event.agentId) return done
  sessionMemory.isTurnLive = false
  await bestEffort(port, 'activity', () => recordActivity(port, 'turn.complete'), undefined)
  if (!endHandoffTurn(event.reason)) await withRecordLock(() => trackSessionLength(createFeaturePort(port)))
  await bestEffort(port, 'issue audit', () => runIssueAudit(port), undefined)
  await bestEffort(port, 'coordinator notice', () => noticeTurnEnd(port, { reason: event.reason }), undefined)
  await reread(port, true)
  // why: no ring is made while a turn is live, so mail that came after its Stop would otherwise wait for the idle tick.
  await bestEffort(port, 'doorbell', () => ringDoorbell(port), undefined)
  return done
}

/**
 * Notifies a delegated unit's coordinator of a permission dialog, which holds the unit mid-turn.
 * @param port - The engine calls.
 * @param event - The notification.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleNotification(port: EnginePort, event: Frozen<Args<'classic.Notification'>>, next: Next<'classic.Notification'>): Promise<EventResult<'classic.Notification'>> {
  const done = await next(event)
  if (event.notification_type === 'permission_prompt') {
    await bestEffort(port, 'activity', () => recordActivity(port, 'dialog'), undefined)
    await bestEffort(port, 'coordinator notice', () => noticePermission(port, event.message), undefined)
  }
  return done
}
