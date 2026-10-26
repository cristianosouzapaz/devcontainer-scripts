import { withStates } from '../domain/step-states'
import { buildView, handoffNotes } from '../ui/view-model'
import { bestEffort } from './best-effort'
import { logSteps } from './flow-log'
import type { EnginePort } from './engine-port'
import { createReadPort } from './read-port'
import { describeViolation, refreshPrSnapshot } from './guarantees'
import { readDismissals } from './violation-store'
import { readGithubStatus, syncIssues } from './github-sync'
import { locatePosition } from './position'
import { selectRunDisplay, readVersionedSession } from './record-store'
import { readGit, readRepositoryRoot } from './repository'
import { reportHerdr } from './herdr'
import { sessionMemory } from './session-memory'

interface RefreshRequest { port: EnginePort; full: boolean; forceGithub: boolean; generation: number; causes: string[] }
interface RefreshQueue { running: Promise<void> | null; queued: RefreshRequest | null; forcedGeneration: number }
const refreshQueue: RefreshQueue = { running: null, queued: null, forcedGeneration: 0 }

/**
 * Coalesces signals into one active read and at most one queued read, upgrading local reads to full reads.
 * @param port - The engine calls.
 * @param full - Whether GitHub may also be refreshed.
 * @param forceGithub - Whether a fresh GitHub read must run after any active observation.
 * @returns Once the active and coalesced reads finish.
 */
export function reread(port: EnginePort, full: boolean, forceGithub = false): Promise<void> {
  if (forceGithub) refreshQueue.forcedGeneration += 1
  refreshQueue.queued = {
    port,
    full: full || (refreshQueue.queued?.full ?? false),
    forceGithub: forceGithub || (refreshQueue.queued?.forceGithub ?? false),
    generation: refreshQueue.forcedGeneration,
    causes: [...new Set([...refreshQueue.queued?.causes ?? [], port.cause])],
  }
  if (refreshQueue.running) return refreshQueue.running
  const drain = async (): Promise<void> => {
    const errors: unknown[] = []
    try {
      while (refreshQueue.queued) {
        const request = refreshQueue.queued
        refreshQueue.queued = null
        try { await refreshView(request.port, !request.full, false, true, request.forceGithub, request.generation, request.causes) } catch (error) { errors.push(error) }
      }
      if (errors.length) throw errors[0]
    } finally { refreshQueue.running = null }
  }
  const running = drain()
  refreshQueue.running = running
  return running
}

/**
 * Offers the command the current step waits on as the prompt box's suggestion, once per state change; a failure never breaks the refresh.
 * @param port - The engine calls.
 * @param command - The command the current step waits on, if any.
 * @returns Once the suggestion is offered or skipped.
 */
async function suggestCommand(port: EnginePort, command: string | undefined): Promise<void> {
  if (!command) {
    sessionMemory.shownSuggestion = null
    return
  }
  if (command === sessionMemory.shownSuggestion) return
  const isShown = await bestEffort(port, 'prompt suggestion', () => port.suggestPrompt(command), false)
  if (isShown) sessionMemory.shownSuggestion = command
}

/**
 * Tells whether the pane already shows a newer state than this observation read: a newer version of
 * the same chat's session, or any state of the chat a `/clear` started after the read.
 * @param port - The engine calls.
 * @param sessionId - The chat whose session was read.
 * @param version - The session version the observation was built from.
 * @returns Whether painting the observation would put an older state back on screen.
 */
async function isOutdated(port: EnginePort, sessionId: string, version: number): Promise<boolean> {
  const painted = sessionMemory.painted
  return await port.readSessionId() !== sessionId || (painted?.sessionId === sessionId && painted.version > version)
}

/**
 * Drops a live run that no run of this module still paints, such as one a reload interrupted.
 * @param port - The engine calls.
 * @param isLive - Whether this chat's unit has a run in flight.
 * @returns Once the stale run is cleared or kept.
 */
async function clearStaleRun(port: EnginePort, isLive: boolean): Promise<void> {
  if (!isLive && await port.readLiveRun()) await port.writeLiveRun(null)
}

/**
 * Rebuilds the Flow pane's view from the stored session, writing it only when it changed.
 *
 * @param engine - The engine calls.
 * @param isQuiet - Whether fresh cached GitHub facts are preferred.
 * @param isSynced - Whether the caller has just synced the PRs and issues: it skips both syncs, which take the lock that `declare` holds.
 * @param isForced - Whether a signal bypasses the issue cache age.
 * @param forceGithub - Whether the unit judgement bypasses cached GitHub facts.
 * @param generation - The forced-read generation that may publish this observation.
 * @param causes - The signals this observation answers, for the transition log.
 * @returns Once the pane and herdr reflect the observation.
 */
export async function refreshView(engine: EnginePort, isQuiet = false, isSynced = false, isForced = false, forceGithub = false, generation?: number, causes = [engine.cause]): Promise<void> {
  const port = createReadPort(engine)
  const held = await readVersionedSession(port)
  const saved = held.session
  if (!saved.flow) await readGit(port)
  const located = await locatePosition(port, saved, isQuiet || isSynced, forceGithub)
  const sync = !!saved.flow && !isQuiet && !isSynced && !located?.isConcluded
  const observed = sync ? await syncIssues(port, held, isForced) : held
  const session = observed.session
  const position = located ? withStates(located, session) : null
  if (!isQuiet && !isSynced) await bestEffort(port, 'PR snapshot refresh', () => refreshPrSnapshot(port, located?.pullRequest?.state === 'OPEN' ? located.pullRequest.number : undefined), undefined)
  const dismissed = await readDismissals(port)
  const root = await readRepositoryRoot(port)
  const violations = (session.violations ?? []).filter(record => !dismissed.has(record.factId)).map(record => ({
    factId: record.factId, text: describeViolation(record, 'user', root ?? undefined), tone: record.kind === 'unchecked' ? 'warn' as const : 'error' as const,
  }))
  // With no position the pane shows only notes and violations, so neither GitHub nor the run display is read.
  const github = !position ? null : !sync ? sessionMemory.githubCache?.status ?? session.gh : await readGithubStatus(port)
  const display = position ? selectRunDisplay(await port.readSessionId(), session.unit, position.unit.generation) : null
  const previous = await port.readView()
  const built = position && github ? buildView(session, position, github) : null
  const isTreeChanged = display?.last?.kind === 'Verify' && display.last.status === 'tree changed'
  const notes = handoffNotes(session)
  const view = position && built ? { ...built, violations,
    ...(isTreeChanged ? { steps: built.steps.map(step => step.id === 'verify' && step.state === 'current' && step.symbol !== '?' ? { ...step, symbol: '▸', detail: 'tree changed during run', isError: false } : step) } : {}),
    hasRunLog: !!(position.unit.verifyRuns.length || position.unit.runs.length || display?.live || display?.last),
    ...(previous?.selectedRunId ? { selectedRunId: previous.selectedRunId } : {}),
  } : violations.length || notes.length ? { flow: 'No flow declared.', progress: '', issues: [], pending: null, meta: [], labels: [], steps: [], notes, footer: null, violations } : null
  if (generation !== undefined && generation !== refreshQueue.forcedGeneration) return
  if (await isOutdated(port, session.sessionId, observed.version)) return
  sessionMemory.painted = { sessionId: session.sessionId, version: observed.version }
  if (position && view) logSteps(port, session, view.steps, causes)
  if (JSON.stringify(previous) !== JSON.stringify(view)) await port.writeView(view)
  await clearStaleRun(port, !!display?.live)
  await reportHerdr(port, session, position, dismissed)
  await suggestCommand(port, position?.current?.command)
}
