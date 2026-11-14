import type { Args, EventResult, Frozen, Next } from 'claude-code'
import type { ProcessState } from '../../types'
import { readHolds } from '../core/gate'
import { loadSuperseded } from '../domain/instruction'

import { bestEffort } from '../core/best-effort'
import { refreshScopeHost } from '../core/delegation'
import { refreshSessionHost } from '../core/session-host'
import type { EnginePort } from '../core/engine-port'
import { escalateIdleUnitsOnTick } from '../core/escalation'
import { resendOwedDones } from '../core/owed-done'
import { createFeaturePort } from '../core/feature-port'
import { closeIdleUnits } from '../core/unit-close'
import { claimLoadSeq, reread } from '../core/pane-view'
import { sweepHerdrWorktrees } from '../core/herdr-worktrees'
import { initializeSession, mirrorSession, readCommonDir, readSession } from '../core/record-store'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { registrationBoundMs, tickMs } from '../core/timing'
import { readWorkingTreeConfig } from '../core/verify-config'
import { pruneRecords } from '../core/pruning'
import { readLegacyReading, reconcileProcessState, recordToolsOutcome, reportStalledUnits, resetActivity } from '../core/liveness'
import { takeMailBlock } from '../core/mail-delivery'
import { isMailArrival, openOwnMailboxes, ringDoorbell } from '../core/mailbox'
import { isProcessStarted, openAdoption, readKeptStarts, readLoadId, startProcessState } from '../core/process-state'
import { describeHoldRow, pruneStartFaults } from '../core/start-notices'
import { isStartDue, recordLoad, recoverStarts, scheduleStart } from '../core/user-steps'
import { retryOwnMail } from '../core/mail-retry'
import { recoverHandoff, trackSessionLength } from '../features/handoff'
import { isCoordinatorSession } from '../domain/coordinator'
import { describeToolsFailure } from '../domain/liveness'
import { formatError } from '../lib/result'
import { clearFault, listFaults, raiseFault, readFault } from '../core/fault-registry'
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
  // why: the adoption is open before the tick or any command is registered, so neither takes an absent process state for an empty one before the adoption settled it.
  openAdoption()
  // why: mail can land and ring while the steps below wait on the host, and the turn it starts gets the tools only if they are registered already; until they are, the mod holds its own prompts. The registration starts first and is awaited last, so a slow one holds back neither the tick nor the host refresh.
  sessionMemory.isSurfaceRegistered = false
  clearFault('tools')
  const registration = registerSurfaceWithin(port)
  // why: this load's views carry its number, so a load this reload replaced, finishing a paint late, never paints over them.
  await claimLoadSeq(port)
  // why: Registered before the seed, so a startup whose mirror read failed still retries it on every tick.
  port.repeat(tickMs, async () => {
    sessionMemory.tickSeq += 1
    // why: atomicReplace already holds the error in sessionMemory.recordError, so it is swallowed here.
    try { await mirrorSession(port) } catch {}
    await bestEffort(port, 'scope host', () => refreshScopeHost(port), undefined)
    await bestEffort(port, 'session host', () => refreshSessionHost(port), undefined)
    // why: a start whose first read of the process state failed adopted nothing, and holds every prompt of the mod until this adopts it.
    if (!isProcessStarted()) await bestEffort(port, 'process state', () => adoptProcessState(port), undefined)
    // why: mail waiting since before the start, a ring lost before the watch existed, or one a dialog held off, is rung here once the session is idle; the first tick comes a full period after the start, so after the host has seen the session ready for input. A start kept for a prompt that never started its turn is submitted once the session is idle, and its entry delivers the mail.
    const state = await reconcileProcessState(port)
    // why: turn changes and receipts whose write failed are written again, a load record that did not land is written, and established outcomes are settled, before the paint, so this tick shows them.
    const recovered = await bestEffort(port, 'start recovery', () => recoverStarts(port), null)
    if (state) pruneStartFaults(state)
    await reread({ ...port, cause: 'tick' }, true)
    // why: a publish of the activity record that wrote nothing, as one that waited past its deadline for the session's publish lock, is published again from the process state.
    if (listFaults('publish:').some(key => key.includes('/activity/'))) await bestEffort(port, 'activity retry', () => resetActivity(port, state), undefined)
    // why: a hold is announced of the state recovery left, so nothing it settled or recorded is told as still holding.
    if (recovered) await bestEffort(port, 'hold notice', () => announceHolds(port, recovered), undefined)
    const isStarted = isStartDue(state, await port.now())
    if (isStarted) scheduleStart(port)
    else await bestEffort(port, 'doorbell recovery', () => ringDoorbell(port, state), undefined)
    await bestEffort(port, 'mail retry', () => retryOwnMail(port), undefined)
    await bestEffort(port, 'owed dones', () => resendOwedDones(port), undefined)
    // why: a question or answer is never held back by GitHub, so the comment that records it is owed until a coordinator's tick posts it.
    if (isCoordinatorSession((await port.readSessionState()).value ?? {})) {
      await bestEffort(port, 'owed comments', () => retryOwedComments(port), undefined)
      await bestEffort(port, 'stall reports', () => reportStalledUnits(port), undefined)
      // why: the mod's own prompts skip its prompt hook, and a prompt runs that hook when submitted, maybe before a unit's turn ended, so a coordinator that gets only mail would never sweep; a closed unit's pane shows the close, so its notice is dropped here.
      await bestEffort(port, 'escalation', () => escalateIdleUnitsOnTick(port), undefined)
      await bestEffort(port, 'unit close', () => closeIdleUnits(port), [])
    }
  })
  // why: A seed whose mirror read failed must not stop the chain; every later read retries it.
  await bestEffort(port, 'session seed', () => initializeSession(port), undefined)
  // why: a process that crashed mid-turn left its record running, which would hide the session's unread mail from its coordinator's stall check, while a reload in the middle of a turn keeps it running; the host-held process state tells them apart, and is read before the host refresh below records this process, which the fallback for a module that kept none compares against.
  await bestEffort(port, 'process state', () => adoptProcessState(port), undefined)
  const origin = sessionMemory.processOrigin
  // why: a start or resume runs in a new process; until the first tick, a full period later, the records would name the ended one, and a unit's send in that window would find its coordinator gone.
  await bestEffort(port, 'scope host', () => refreshScopeHost(port), undefined)
  await bestEffort(port, 'session host', () => refreshSessionHost(port), undefined)
  await bestEffort(port, 'session length', () => withRecordLock(() => trackSessionLength(createFeaturePort(port))), undefined)
  await bestEffort(port, 'handoff recovery', () => recoverHandoff(createFeaturePort(port), origin), undefined)
  await bestEffort(port, 'startup pruning', () => withRecordLock(() => pruneRecords(port)), undefined)
  port.defer(() => { void bestEffort(port, 'worktree sweep', () => sweepHerdrWorktrees(port), undefined) })
  await registration
  const session = await bestEffort(port, 'session read', () => readSession(port), null)
  // why: a failed registration shows at start, since no mod prompt will start a turn; an invalid config shows at start, before any unit reaches Verify; so does a hooks module ahead, before any guard is relied on.
  const config = await readWorkingTreeConfig(port)
  if (readFault('tools') || (session && (session.flow || session.violations?.length || config?.kind === 'invalid' || sessionMemory.modulesAhead?.length !== 0))) {
    await reread(port, true)
    void port.openPane()
  }
  return next(event)
}

/**
 * Tells the user once, through a notification that needs no open pane, of each hold no fault caused that keeps work waiting: a load a
 * reload started that has not heard a turn start or end itself, or a prompt that entered and started no turn; an unattended session may
 * never hear one. The hold itself stays; a fault's hold is shown on the pane and in /flow status. A load that stood down, which publishes
 * no view, says so here too.
 * @param port - The engine calls.
 * @param state - The process state as the tick's recovery left it.
 * @returns Once told, or at once when nothing waits or each hold was told already.
 */
async function announceHolds(port: EnginePort, state: ProcessState): Promise<void> {
  const isSuperseded = !!state.loadId && state.loadId !== readLoadId()
  const holds = readHolds(state).filter(reason => reason.kind === 'activity' || reason.kind === 'turn-change' && reason.change.kind === 'prompt')
  const keyOf = (reason: typeof holds[number]): string => reason.kind === 'activity' ? 'activity' : `prompt:${reason.kind === 'turn-change' ? reason.change.seq : ''}`
  // why: a hold that ended is forgotten, so the record stays bounded and a later hold of the same kind is told again.
  sessionMemory.announcedHolds = new Set([...sessionMemory.announcedHolds].filter(key => key === 'superseded' ? isSuperseded : holds.some(reason => keyOf(reason) === key)))
  // why: a load the state does not record publishes no view, so why reaches the user here; it counts as told only once the notification went through.
  if (isSuperseded && !sessionMemory.announcedHolds.has('superseded')) {
    await port.notify(sessionMemory.isLoadSuperseded ? loadSuperseded : `this mod load stands down from the Flow pane, as the session's process state records another load: ${readFault('load-id') ?? 'it is still recording itself'}`)
    sessionMemory.announcedHolds.add('superseded')
  }
  const waiting = readKeptStarts(state).length
  if (!waiting && !state.pendingWake) return
  const fresh = holds.filter(reason => !sessionMemory.announcedHolds.has(keyOf(reason)))
  if (!fresh.length) return
  const what = [...waiting ? [`${waiting} start prompt${waiting === 1 ? '' : 's'}`] : [], ...state.pendingWake ? ['the Verify approval wake'] : []].join(' and ')
  await port.notify(`this session's mod holds ${what}: ${describeHoldRow(fresh) ?? ''}`)
  for (const reason of fresh) sessionMemory.announcedHolds.add(keyOf(reason))
}

/**
 * Adopts or seeds the process state, records this load in it, adopts a turn change only the activity record holds, and sets the record
 * from the state; the session start runs it, and so does each tick until the state was adopted, since a first read that fails adopts nothing.
 * @param port - The engine calls.
 * @returns Once done.
 */
async function adoptProcessState(port: EnginePort): Promise<void> {
  const start = await startProcessState(port, () => readLegacyReading(port))
  sessionMemory.processOrigin = start.origin
  // why: the load a reload replaced may have heard a turn start or end that reached neither channel, which no read here can find, so this load holds its own prompts until it hears one itself, a turn start or end or a prompt the chain accepted, never one it rejected; a new process runs no turn yet, and a start whose origin is unknown is held by the read or the earlier records that left it so.
  sessionMemory.isActivityUnchecked = start.origin === 'reload' && !sessionMemory.isBoundaryHeard
  // why: a delivery of the load this one replaced reads this id before it submits, and submits nothing once it is not its own.
  if (start.state) await recordLoad(port)
  // why: a session write before the state held a generation left its mirror for now, which this publishes.
  if (start.state && sessionMemory.isMirrorDeferred) {
    sessionMemory.isMirrorDeferred = false
    await mirrorSession(port).catch(() => null)
  }
  // why: a turn change only the activity record holds, as one whose write failed before the reload, is adopted before the record is set from the state.
  const state = start.state ? await reconcileProcessState(port) : null
  await bestEffort(port, 'activity', () => resetActivity(port, state), undefined)
}

/**
 * Registers `/flow` and the mod's tools, and settles how it went once it answers or its bound passes: a success opens the gate on the
 * mod's own prompts, a failure or no answer is shown with its cause; a registration that answers after its bound still applies. A bound
 * wait the host cancelled, as a reload cancels the replaced load's waits, decides nothing: the registration's own answer does.
 * @param port - The engine calls.
 * @returns Once the outcome is applied; never rejects.
 */
async function registerSurfaceWithin(port: EnginePort): Promise<void> {
  const bound = new AbortController()
  const registered = port.registerSurface().then(() => null, (error: unknown) => formatError(error))
  const late = `no answer within ${registrationBoundMs / 1000} s`
  // why: the engine never meters a $ call, so a registration that hangs would otherwise hold the start, and hide its failure, forever.
  const expired = port.clock.sleep(registrationBoundMs, bound.signal).then(() => late, () => registered)
  const outcome = await Promise.race([registered, expired])
  bound.abort()
  await applyRegistration(port, outcome)
  if (outcome === late) void registered.then(error => applyRegistration(port, error))
}

/**
 * Applies a registration's outcome to the gate, the failure shown and the activity the coordinator reads.
 * @param port - The engine calls.
 * @param error - Why it failed, or null once registered.
 * @returns Once the activity is recorded.
 */
async function applyRegistration(port: EnginePort, error: string | null): Promise<void> {
  sessionMemory.isSurfaceRegistered = error === null
  if (error === null) clearFault('tools')
  else raiseFault('tools', { row: 'Tools', text: describeToolsFailure(error), cause: error })
  if (error !== null) {
    const text = describeToolsFailure(error)
    port.logDebug(`working-agreement: ${text}`)
    port.toast(text)
  }
  await bestEffort(port, 'activity', () => recordToolsOutcome(port), undefined)
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
  // why: a forced GitHub read can outlast the hook's budget, so it runs on a timer's dispatch.
  if (relative === 'HEAD' || relative === 'packed-refs' || relative.startsWith('refs/') || /^worktrees\/[^/]+\/HEAD$/.test(relative)) {
    port.defer(() => { void bestEffort(port, 'ref change reread', () => reread(port, true, true), undefined) })
  }
  return result
}
