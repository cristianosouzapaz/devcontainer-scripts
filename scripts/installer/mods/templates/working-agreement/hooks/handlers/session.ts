import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { reread } from '../core/pane-view'
import { sweepHerdrWorktrees } from '../core/herdr-worktrees'
import { openAuditWindow } from '../core/issue-audit'
import { initializeSession, mirrorSession, readCommonDir, readSession } from '../core/record-store'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { tickMs } from '../core/timing'
import { readWorkingTreeConfig } from '../core/verify-config'
import { pruneRecords } from '../core/pruning'
import { recoverHandoff, trackSessionLength } from '../features/handoff'

/**
 * Starts the session, registers `/flow` and the mod's tools, and keeps the pane current.
 *
 * @param port - The engine calls.
 * @param event - The session start.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleSessionStart(port: EnginePort, event: Frozen<Args<'session.start'>>, next: Next<'session.start'>): Promise<EventResult<'session.start'>> {
  // why: Registered before the seed, so a startup whose mirror read failed still retries it on every tick.
  port.repeat(tickMs, async () => {
    // atomicReplace holds the error in sessionMemory.recordError.
    try { await mirrorSession(port) } catch {}
    await reread({ ...port, cause: 'tick' }, true)
  })
  // why: A seed whose mirror read failed must not stop the chain before the surface registers; every later read retries it.
  await bestEffort(port, 'session seed', () => initializeSession(port), undefined)
  await bestEffort(port, 'audit window', () => openAuditWindow(port), undefined)
  await bestEffort(port, 'session length', () => withRecordLock(() => trackSessionLength(createFeaturePort(port))), undefined)
  await bestEffort(port, 'handoff recovery', () => recoverHandoff(createFeaturePort(port)), undefined)
  await bestEffort(port, 'startup pruning', () => withRecordLock(() => pruneRecords(port)), undefined)
  port.defer(() => { void bestEffort(port, 'worktree sweep', () => sweepHerdrWorktrees(port), undefined) })
  await port.registerSurface()
  const session = await bestEffort(port, 'session read', () => readSession(port), null)
  // An invalid config shows at start, before any unit reaches Verify; so does a hooks module ahead, before any guard is relied on.
  const config = await readWorkingTreeConfig(port)
  if (session && (session.flow || session.violations?.length || config?.kind === 'invalid' || sessionMemory.modulesAhead?.length !== 0)) {
    await reread(port, true)
    void port.openPane()
  }
  return next(event)
}

/**
 * Watches shared and linked-worktree refs for changes outside the session.
 *
 * @param port - The engine calls.
 * @param event - The classic session start.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleClassicSessionStart(port: EnginePort, event: Frozen<Args<'classic.SessionStart'>>, next: Next<'classic.SessionStart'>): Promise<EventResult<'classic.SessionStart'>> {
  const result = await next(event)
  const common = await readCommonDir(port)
  return common ? { ...result, watchPaths: [...new Set([...(result.watchPaths ?? []), `${common}/HEAD`, `${common}/packed-refs`, `${common}/refs`, `${common}/worktrees`])] } : result
}

/**
 * Queues a refresh of repository and GitHub facts after watched ref changes.
 * @param port - The engine calls.
 * @param event - The watched file event.
 * @param next - The rest of the chain.
 * @returns The chain's answer.
 */
export async function handleFileChanged(port: EnginePort, event: Frozen<Args<'classic.FileChanged'>>, next: Next<'classic.FileChanged'>): Promise<EventResult<'classic.FileChanged'>> {
  const result = await next(event)
  const common = await readCommonDir(port)
  if (!common) return result
  const path = event.file_path
  const relative = path.startsWith(`${common}/`) ? path.slice(common.length + 1) : ''
  // A forced GitHub read can outlast the hook's budget, so it runs on a timer's dispatch.
  if (relative === 'HEAD' || relative === 'packed-refs' || relative.startsWith('refs/') || /^worktrees\/[^/]+\/HEAD$/.test(relative)) {
    port.defer(() => { void bestEffort(port, 'ref change reread', () => reread(port, true, true), undefined) })
  }
  return result
}
