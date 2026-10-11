import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { recordAnchor } from '../core/anchor'
import type { EnginePort } from '../core/engine-port'
import { toastFailure } from '../core/failure-toast'
import { createFeaturePort } from '../core/feature-port'
import { syncIssues } from '../core/github-sync'
import { refreshView } from '../core/pane-view'
import { readSession } from '../core/record-store'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { recoverHandoff } from '../features/handoff'

const tickMs = 15000

/**
 * Starts the session: recovers an interrupted handoff, registers `/flow` and `declare_flow`, redraws the pane of a flow
 * already declared, and keeps the pane in step with GitHub and the tree.
 *
 * @param port - The engine calls.
 * @param event - The session start.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleSessionStart(port: EnginePort, event: Frozen<Args<'session.start'>>, next: Next<'session.start'>): Promise<EventResult<'session.start'>> {
  await recoverHandoff(createFeaturePort(port))
  await port.registerSurface()
  if ((await readSession(port)).flow) {
    await refreshView(port)
    void port.openPane()
  }
  port.repeat(tickMs, async () => {
    const session = await readSession(port)
    if (!session.flow) return
    await syncIssues(port, session)
    await withRecordLock(() => recordAnchor(port, session)).catch(toastFailure(port, "record the unit's commit"))
    await refreshView(port, true)
  })
  return next(event)
}

/**
 * Records the permission mode the classic session start reports.
 *
 * @param event - The classic session start.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export function handleClassicSessionStart(event: Frozen<Args<'classic.SessionStart'>>, next: Next<'classic.SessionStart'>): Promise<EventResult<'classic.SessionStart'>> {
  sessionMemory.permissionMode = event.permission_mode ?? sessionMemory.permissionMode
  return next(event)
}
