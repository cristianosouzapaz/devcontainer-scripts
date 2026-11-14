import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { noticePermission, noticeTurnEnd } from '../core/coordinator-notice'
import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { runIssueAudit } from '../core/issue-audit'
import { recordActivity } from '../core/liveness'
import { ringDoorbell } from '../core/mailbox'
import { reread } from '../core/pane-view'
import type { ProcessState } from '../../types'
import { isReplacedIn, readProcessState } from '../core/process-state'
import { beginTurnChange, nextEpoch, settleLegacy, writeTurnTransition } from '../core/turn-evidence'
import { isStartDue, scheduleStart } from '../core/user-steps'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { endedTurnLimit } from '../core/timing'
import { armPendingHandoff, endHandoffTurn, trackSessionLength } from '../features/handoff'

/**
 * Starts the main agent's turn: arms a handoff waiting for its /handoff turn; while it runs, the unit still works, so no wait is shown yet;
 * the pane and the sidebar are redrawn at once.
 * @param port - The engine calls.
 * @param event - The starting turn.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleTurnStart(port: EnginePort, event: Frozen<Args<'turn.start'>>, next: Next<'turn.start'>): Promise<EventResult<'turn.start'>> {
  if (event.agentId) return next(event)
  // why: the time is read after the change opens; a write the tick makes for a handler that ended before reading it takes none.
  const time = { at: 0 }
  const order = { seq: Number.MAX_SAFE_INTEGER }
  // why: only the main loop's start and end write the turn, since a tool event carries no turn id and also comes from subagents and from hooks an interrupt left running; a start whose write lands after its own end was written is stale, and changes nothing; so is one this load heard before another start, or one a replaced load writes over another running turn, as the host starts a turn only once the one before it ended.
  // why: a failed end of an earlier turn this start supersedes leaves its turn among the ended ones, so a start of that turn written late never sets it running again.
  const startTurn = (held: ProcessState): ProcessState => {
    const isObsolete = held.endedTurns?.includes(event.turnId) || sessionMemory.lastStartSeq > order.seq || !!held.turn && held.turn.id !== event.turnId && isReplacedIn(held)
    if (isObsolete) return held
    const superseded = sessionMemory.pendingTurnChanges.filter(pending => pending.kind === 'complete' && pending.failure && pending.seq < order.seq && pending.turnId).map(pending => pending.turnId ?? '')
    const endedTurns = superseded.length ? { endedTurns: [...(held.endedTurns ?? []).filter(id => !superseded.includes(id)), ...superseded].slice(-endedTurnLimit) } : {}
    return { ...settleLegacy(held), ...endedTurns, epoch: nextEpoch(held, time.at), prompt: null,
      turn: { id: event.turnId, hasSent: false, isInformOnly: held.prompt?.isInformOnly ?? false, isEmptyDoorbell: held.prompt?.isEmptyDoorbell ?? false } }
  }
  // why: the change is opened before any await, with its write, so the session is held from this moment, a write about another turn never clears it, and a handler that ends before writing it leaves the write to the tick.
  const turnChange = beginTurnChange('start', event.turnId, 0, startTurn)
  order.seq = turnChange.seq
  sessionMemory.ownTurnId = event.turnId
  sessionMemory.isSentUnbound = false
  armPendingHandoff()
  time.at = await port.now()
  const before = await readProcessState(port)
  const state = await writeTurnTransition(port, turnChange, startTurn)
  // why: a start the process state could not take is still recorded as activity from the state it would have reached, so the tick, or a new module after a reload, adopts it from there; a stale start records nothing.
  const reached = state ?? (before && startTurn(before))
  if (!reached || reached.turn?.id === event.turnId) await bestEffort(port, 'activity', () => recordActivity(port, 'turn.start', reached, event.turnId), undefined)
  await bestEffort(port, 'turn start reread', () => reread(port, false), undefined)
  return next(event)
}

/**
 * Ends the main agent's turn: reports the end of a /handoff turn to the handoff,
 * and otherwise checks whether the session has grown long; then audits the issues the session wrote and, in a delegated unit, notifies its coordinator;
 * last submits the start prompt first in line and rings the doorbell for mail that arrived after the turn's Stop delivered the rest.
 *
 * @param port - The engine calls.
 * @param event - The completed turn.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleTurnComplete(port: EnginePort, event: Frozen<Args<'turn.complete'>>, next: Next<'turn.complete'>): Promise<EventResult<'turn.complete'>> {
  if (event.agentId) return next(event)
  const time = { at: 0 }
  // why: an end that names another turn is a stale one, as a module a reload replaced may hear after the new module's start, so it leaves the running turn; a turn carried over with no id ends at any end, and so does one an unreadable earlier record left unknown. The ended turn is kept, so its start, written late, never sets it running again.
  const endTurn = (held: ProcessState): ProcessState => {
    const isOwn = !!held.turn && (held.turn.id === event.turnId || held.turn.id === '') || !!held.legacy
    const endedTurns = [...(held.endedTurns ?? []).filter(id => id !== event.turnId), event.turnId].slice(-endedTurnLimit)
    return isOwn ? { ...settleLegacy(held), epoch: nextEpoch(held, time.at), turn: null, prompt: null, endedTurns } : { ...held, endedTurns }
  }
  // why: the change is opened with its write before any await, so a handler that ends before writing it leaves the write to the tick.
  const turnChange = beginTurnChange('complete', event.turnId, 0, endTurn)
  const done = await next(event)
  time.at = await port.now()
  const before = await readProcessState(port)
  const state = await writeTurnTransition(port, turnChange, endTurn)
  // why: an end the process state could not take is still recorded as activity from the state it would have reached, as a start is.
  await bestEffort(port, 'activity', () => recordActivity(port, 'turn.complete', state ?? (before && endTurn(before)), event.turnId), undefined)
  // why: the audit starts before a handoff's end runs, so the handoff waits for it and carries this turn's result; it says on the record or the pane when its result is not recorded, so it never throws here.
  const audited = runIssueAudit(port)
  if (!endHandoffTurn(event.reason)) await withRecordLock(() => trackSessionLength(createFeaturePort(port)))
  await audited
  await bestEffort(port, 'coordinator notice', () => noticeTurnEnd(port, { reason: event.reason }), undefined)
  await reread(port, true)
  // why: a kept start waits for an idle window, which the turn's end opens; no ring is made while a turn is live, so mail that came after its Stop would otherwise wait for the idle tick; a start just submitted delivers that mail at its entry, and a doorbell beside it would enter empty.
  // why: the kept start stays in the host's keeping until a dispatch of its own takes it, so a reload that cancels that dispatch loses nothing.
  if (isStartDue(state, await port.now())) scheduleStart(port)
  else await bestEffort(port, 'doorbell', () => ringDoorbell(port, state), undefined)
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
    const state = await readProcessState(port)
    await bestEffort(port, 'activity', () => recordActivity(port, 'dialog', state), undefined)
    await bestEffort(port, 'coordinator notice', () => noticePermission(port, event.message), undefined)
  }
  return done
}
