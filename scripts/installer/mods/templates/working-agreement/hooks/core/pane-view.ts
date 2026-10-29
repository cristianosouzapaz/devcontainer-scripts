import { withStates } from '../domain/step-states'
import { auditNotes, buildView, handoffNotes } from '../ui/view-model'
import { describeScope } from '../domain/delegation'
import { bestEffort } from './best-effort'
import { findDelegation, readOwnScope } from './delegation'
import { logSteps } from './flow-log'
import type { EnginePort } from './engine-port'
import { createReadPort } from './read-port'
import { labelViolation, refreshPrSnapshot } from './guarantees'
import { readDismissals } from './violation-store'
import { clearIssuesFailure, readGithubFailure, readGithubStatus, syncIssues } from './github-sync'
import { locatePosition } from './position'
import { readVersionedSession } from './record-store'
import { readGit, readRepositoryRoot } from './repository'
import { readRepositoryConfig } from './verify-config'
import { facts } from '../domain/facts'
import { reportHerdr } from './herdr'
import { isTreeChangedRun, readRunDisplay, sessionMemory } from './session-memory'
import { isCoordinatorSession } from '../domain/coordinator'

interface RefreshRequest { port: EnginePort; full: boolean; forceGithub: boolean; generation: number; causes: string[] }
/** How one observation runs; every flag defaults to false. */
interface RefreshOptions {
  /** Fresh cached GitHub facts are preferred. */
  isQuiet?: boolean
  /** The caller has just synced the PRs and issues: both syncs, which take the lock that `declare` holds, are skipped. */
  isSynced?: boolean
  /** A signal bypasses the issue cache age. */
  isForced?: boolean
  /** The unit judgement bypasses cached GitHub facts. */
  forceGithub?: boolean
  /** The forced-read generation that may publish this observation. */
  generation?: number
  /** The signals this observation answers, for the transition log; the port's own cause when omitted. */
  causes?: string[]
}
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
        try { await refreshView(request.port, { isQuiet: !request.full, isForced: true, forceGithub: request.forceGithub, generation: request.generation, causes: request.causes }) } catch (error) { errors.push(error) }
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
 * @param options - How the observation runs.
 * @returns Once the pane and herdr reflect the observation.
 */
export async function refreshView(engine: EnginePort, options: RefreshOptions = {}): Promise<void> {
  const { isQuiet = false, isSynced = false, isForced = false, forceGithub = false, generation, causes = [engine.cause] } = options
  const port = createReadPort(engine)
  const held = await readVersionedSession(port)
  const saved = held.session
  if (!saved.flow) await readGit(port)
  const located = await locatePosition(port, saved, isQuiet || isSynced, forceGithub)
  const sync = !!saved.flow && !isQuiet && !isSynced && !located?.isConcluded
  if (!saved.flow || located?.isConcluded) clearIssuesFailure()
  // A tick alone never probes again within the minute, so an outage costs one probe a minute between explicit signals.
  const observed = sync ? await syncIssues(port, held, { isForced, isProbeForced: isForced && causes.some(cause => cause !== 'tick') }) : held
  const session = observed.session
  const position = located ? withStates(located, session) : null
  if (!isQuiet && !isSynced) await bestEffort(port, 'PR snapshot refresh', () => refreshPrSnapshot(port, located?.pullRequest?.state === 'OPEN' ? located.pullRequest.number : undefined), undefined)
  const dismissed = await readDismissals(port)
  const root = await readRepositoryRoot(port)
  const config = await readRepositoryConfig(port, root)
  const warningNotes = [...config.kind === 'invalid' ? [{ key: 'Config', value: facts.verifyConfigInvalid, tone: 'error' as const }] : [],
    ...sessionMemory.modulesAhead?.length !== 0 ? [{ key: 'Guards', value: facts.guardsOverridable, tone: 'error' as const }] : []]
  const violations = (session.violations ?? []).filter(record => !dismissed.has(record.factId)).map(record => ({
    factId: record.factId, text: labelViolation(record, root ?? undefined), tone: record.kind === 'unchecked' ? 'warn' as const : 'error' as const,
  }))
  // With no position the pane shows only notes and violations, so neither GitHub nor the run display is read.
  const github = !position ? null : !sync ? sessionMemory.githubCache?.status ?? session.gh : await readGithubStatus(port)
  const display = position ? await readRunDisplay(port, session.unit, position.unit.generation) : null
  const previous = await port.readView()
  const isTreeChanged = isTreeChangedRun(display)
  const built = position && github ? buildView(session, position, readGithubFailure(github), isTreeChanged) : null
  const notes = [...handoffNotes(session), ...auditNotes(session), ...warningNotes]
  const scope = isCoordinatorSession(session) ? await bestEffort(port, 'delegation read', () => readOwnScope(port), null) : null
  const delegation = position ? await bestEffort(port, 'delegation read', () => findDelegation(port, session.issues), null) : null
  const taken = position?.unit.delegated ?? []
  const delegationRow = delegation || taken.length
    ? [{ key: 'Delegation', value: [delegation ? 'delegated by the coordinator' : 'delegation stopped', ...taken.length ? [`took ${taken.join(', ')}`] : []].join(' · '), tone: 'text' as const }] : []
  const view = position && built ? { ...built, meta: [...built.meta, ...delegationRow], notes: [...built.notes, ...warningNotes], violations,
    hasRunLog: !!(position.unit.verifyRuns.length || position.unit.runs.length || display?.live || display?.last),
    ...(previous?.selectedRunId ? { selectedRunId: previous.selectedRunId } : {}),
  } : violations.length || notes.length || session.role ? { flow: isCoordinatorSession(session) ? 'Coordinator · writes denied' : 'No flow declared.', progress: '', issues: [], pending: null,
    meta: scope ? [{ key: 'Delegating', value: describeScope(scope), tone: 'text' as const }] : [], labels: [], steps: [], notes, footer: null, violations } : null
  if (generation !== undefined && generation !== refreshQueue.forcedGeneration) return
  if (await isOutdated(port, session.sessionId, observed.version)) return
  sessionMemory.painted = { sessionId: session.sessionId, version: observed.version }
  if (position && view) logSteps(port, session, view.steps, position.slice, causes)
  if (JSON.stringify(previous) !== JSON.stringify(view)) await port.writeView(view)
  await clearStaleRun(port, !!display?.live)
  await reportHerdr(port, session, position, dismissed, isTreeChanged, !!(delegation ?? scope))
  await suggestCommand(port, position?.current?.command)
}
