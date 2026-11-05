import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { refreshScopeHost } from '../core/delegation'
import { refreshSessionHost } from '../core/session-host'
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
import { reportStalledUnits } from '../core/liveness'
import { takeMailBlock } from '../core/mail-delivery'
import { isMailArrival, openOwnMailboxes, ringDoorbell } from '../core/mailbox'
import { retryOwnMail } from '../core/mail-retry'
import { recoverHandoff, trackSessionLength } from '../features/handoff'
import { isCoordinatorSession } from '../domain/coordinator'
import { notifyUserMail, remindUnwatchedQuestions, retryOwedComments } from '../core/user-inbox'

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
    await bestEffort(port, 'scope host', () => refreshScopeHost(port), undefined)
    await bestEffort(port, 'session host', () => refreshSessionHost(port), undefined)
    await reread({ ...port, cause: 'tick' }, true)
    // why: mail waiting since before the start, a ring lost before the watch existed, or one a dialog held off, is rung here once the
    // session is idle; the first tick comes a full period after the start, so after the host has seen the session ready for input.
    if (!sessionMemory.isTurnLive) await bestEffort(port, 'doorbell recovery', () => ringDoorbell(port), undefined)
    await bestEffort(port, 'mail retry', () => retryOwnMail(port), undefined)
    // why: a question or answer is never held back by GitHub, so the comment that records it is owed until a coordinator's tick posts it.
    if (isCoordinatorSession((await port.readSessionState()).value ?? {})) {
      await bestEffort(port, 'owed comments', () => retryOwedComments(port), undefined)
      await bestEffort(port, 'stall reports', () => reportStalledUnits(port), undefined)
    }
  })
  // why: A seed whose mirror read failed must not stop the chain before the surface registers; every later read retries it.
  await bestEffort(port, 'session seed', () => initializeSession(port), undefined)
  // why: a start or resume runs in a new process; until the first tick, a full period later, the records would name the
  // ended one, and a unit's send in that window would find its coordinator gone.
  await bestEffort(port, 'scope host', () => refreshScopeHost(port), undefined)
  await bestEffort(port, 'session host', () => refreshSessionHost(port), undefined)
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
 * Watches shared and linked-worktree refs for changes outside the session, and the session's own mailboxes for its doorbell; on a
 * compaction delivers the mail still unread into the turn that goes on. A start or resume never rings: a turn begun before the host saw the
 * session idle at its prompt makes the host's start wait fail, so mail already waiting is left to the idle tick.
 *
 * @param port - The engine calls.
 * @param event - The classic session start.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handleClassicSessionStart(port: EnginePort, event: Frozen<Args<'classic.SessionStart'>>, next: Next<'classic.SessionStart'>): Promise<EventResult<'classic.SessionStart'>> {
  const result = await next(event)
  const common = await readCommonDir(port)
  if (!common) return result
  const mailboxes = await bestEffort(port, 'mailbox watch', () => openOwnMailboxes(port), [])
  // why: a toast reaches the user and starts no turn, so it never disturbs the host's start wait the way a ring would.
  if (['startup', 'resume'].includes(event.source)) await bestEffort(port, 'inbox reminder', () => remindUnwatchedQuestions(port), undefined)
  // why: a compaction happens inside a turn, which goes on by itself and carries the mail without a ring.
  const mail = event.source === 'compact' ? await bestEffort(port, 'mail delivery', () => takeMailBlock(port), null) : null
  return { ...result, watchPaths: [...new Set([...(result.watchPaths ?? []), `${common}/HEAD`, `${common}/packed-refs`, `${common}/refs`, `${common}/worktrees`, ...mailboxes])],
    ...mail ? { additionalContext: [...result.additionalContext ?? [], mail] } : {} }
}

/**
 * Rings the doorbell when mail arrives, notifies a coordinator of mail for the user, and queues a refresh of repository and GitHub facts after watched ref changes.
 * @param port - The engine calls.
 * @param event - The watched file event.
 * @param next - The rest of the chain.
 * @returns The chain's answer.
 */
export async function handleFileChanged(port: EnginePort, event: Frozen<Args<'classic.FileChanged'>>, next: Next<'classic.FileChanged'>): Promise<EventResult<'classic.FileChanged'>> {
  const result = await next(event)
  const common = await readCommonDir(port)
  if (!common) return result
  if (event.event === 'add' && await bestEffort(port, 'user mail notice', () => notifyUserMail(port, event.file_path), false)) {
    port.defer(() => { void bestEffort(port, 'inbox reread', () => reread(port, true), undefined) })
    return result
  }
  if (await bestEffort(port, 'mail arrival', () => isMailArrival(port, event.file_path, event.event), false)) {
    await bestEffort(port, 'doorbell', () => ringDoorbell(port), undefined)
    return result
  }
  const path = event.file_path
  const relative = path.startsWith(`${common}/`) ? path.slice(common.length + 1) : ''
  // A forced GitHub read can outlast the hook's budget, so it runs on a timer's dispatch.
  if (relative === 'HEAD' || relative === 'packed-refs' || relative.startsWith('refs/') || /^worktrees\/[^/]+\/HEAD$/.test(relative)) {
    port.defer(() => { void bestEffort(port, 'ref change reread', () => reread(port, true, true), undefined) })
  }
  return result
}
