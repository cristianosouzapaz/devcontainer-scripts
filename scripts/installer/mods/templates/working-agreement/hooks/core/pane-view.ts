import { withPendingWrite, withStates } from '../domain/step-states'
import { auditNotes, buildView, handoffNotes, inboxRow, scopeRows } from '../ui/view-model'
import { bestEffort } from './best-effort'
import { findDelegation, readLiveness, readOwnScope } from './delegation'
import { logSteps } from './flow-log'
import type { EnginePort } from './engine-port'
import { createReadPort } from './read-port'
import { isGithubCacheMiss } from './unit-github'
import { describeViolation, refreshPrSnapshot } from './guarantees'
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
import { countInbox } from './user-inbox'
import { countDeadLetters } from './mail-retry'
import type { KeyedRow } from '../ui/theme'
import type { Session } from '../domain/records'
import type { Position } from '../domain/step-states'
import type { FlowView } from '../../types'
import { followApproval } from './approval-wake'

/** Settles every caller coalesced into one queued read once that read has run. */
interface Settler { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void }
interface RefreshRequest { port: EnginePort; full: boolean; forceGithub: boolean; generation: number; causes: string[]; isGithubCacheOnly: boolean; settler: Settler }
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
  /** No GitHub fact is read: one the cache lacks repaints the last observation and is left to a full read off the caller's path. */
  isGithubCacheOnly?: boolean
}
interface RefreshQueue { running: Promise<void> | null; queued: RefreshRequest | null; forcedGeneration: number }
/** What one observation read, and how to draw it with the in-flight writes and turn as they stand when it paints. */
interface Observation {
  session: Session
  version: number
  /** Builds the position and view the pane and the sidebar both draw. */
  compose: (previous: FlowView | null) => { position: Position | null; view: FlowView | null }
  dismissed: Set<string>
  isTreeChanged: boolean
  /** Whether this chat's unit had a run in flight. */
  isRunLive: boolean
  /** Whether the herdr report names the delegation. */
  isDelegated: boolean
}
/** The last observation painted, which a call start repaints while a read is in flight, and the tail of the paint chain. */
interface Painter { last: Observation | null; tail: Promise<void> }
const refreshQueue: RefreshQueue = { running: null, queued: null, forcedGeneration: 0 }
const painter: Painter = { last: null, tail: Promise.resolve() }

/**
 * Coalesces signals into one active read and at most one queued read, upgrading local reads to full reads.
 * @param port - The engine calls.
 * @param full - Whether GitHub may also be refreshed.
 * @param forceGithub - Whether a fresh GitHub read must run after any active observation.
 * @returns Once the active and coalesced reads finish.
 */
export function reread(port: EnginePort, full: boolean, forceGithub = false): Promise<void> {
  const own = enqueue(port, full, forceGithub, false)
  own.catch(() => undefined)
  return refreshQueue.running ?? own
}

/**
 * Refreshes the view at a tool call's start without waiting on any read in flight and without reading GitHub: with a
 * read running, the last observation is repainted with the in-flight writes applied and a local read is queued behind it, unawaited.
 * @param port - The engine calls.
 * @returns Once the view shows the call's start.
 */
export async function rereadAtCallStart(port: EnginePort): Promise<void> {
  if (!refreshQueue.running) return enqueue(port, false, false, true)
  void reread(port, false).catch(() => undefined)
  await repaint(port, [port.cause])
}

/**
 * Queues a read, coalesced with the one already queued.
 * @param port - The engine calls.
 * @param full - Whether GitHub may also be refreshed.
 * @param forceGithub - Whether a fresh GitHub read must run after any active observation.
 * @param isGithubCacheOnly - Whether the read must answer from cached GitHub facts alone; coalesced, it stays so only if every signal asks it.
 * @returns Once the read this signal joined has run, without waiting on reads queued after it.
 */
function enqueue(port: EnginePort, full: boolean, forceGithub: boolean, isGithubCacheOnly: boolean): Promise<void> {
  if (forceGithub) refreshQueue.forcedGeneration += 1
  const queued = refreshQueue.queued
  refreshQueue.queued = {
    port,
    full: full || (queued?.full ?? false),
    forceGithub: forceGithub || (queued?.forceGithub ?? false),
    generation: refreshQueue.forcedGeneration,
    causes: [...new Set([...queued?.causes ?? [], port.cause])],
    isGithubCacheOnly: isGithubCacheOnly && !full && (queued?.isGithubCacheOnly ?? true),
    settler: queued?.settler ?? createSettler(),
  }
  const { promise } = refreshQueue.queued.settler
  if (!refreshQueue.running) {
    const running = drain()
    running.catch(() => undefined)
    refreshQueue.running = running
  }
  return promise
}

/**
 * Creates a settler.
 * @returns A pending promise with its resolve and reject.
 */
function createSettler(): Settler {
  const handlers: { resolve?: () => void; reject?: (error: unknown) => void } = {}
  const promise = new Promise<void>((resolve, reject) => Object.assign(handlers, { resolve, reject }))
  return { promise, resolve: () => handlers.resolve?.(), reject: error => handlers.reject?.(error) }
}

/**
 * Runs queued reads one at a time until none is left, settling each read's callers once it has run.
 * @returns Once the queue is empty.
 */
async function drain(): Promise<void> {
  const errors: unknown[] = []
  try {
    while (refreshQueue.queued) {
      const request = refreshQueue.queued
      refreshQueue.queued = null
      try {
        await refreshView(request.port, { isQuiet: !request.full, isForced: true, forceGithub: request.forceGithub, generation: request.generation, causes: request.causes, isGithubCacheOnly: request.isGithubCacheOnly })
        request.settler.resolve()
      } catch (error) {
        errors.push(error)
        request.settler.reject(error)
      }
    }
    if (errors.length) throw errors[0]
  } finally { refreshQueue.running = null }
}

/**
 * Repaints the last observation, with no read of git or GitHub.
 * @param engine - The engine calls.
 * @param causes - The signals the repaint answers.
 * @returns Once painted, or at once before any observation has painted.
 */
async function repaint(engine: EnginePort, causes: string[]): Promise<void> {
  const last = painter.last
  if (last) await paint(createReadPort(engine), last, causes)
}

/**
 * Paints an observation after any paint in progress, so the pane and the herdr report come from one position and reports never overlap.
 * @param port - The engine calls.
 * @param observation - The observation to draw.
 * @param causes - The signals it answers.
 * @returns Once painted, or skipped when the pane already shows a newer state.
 */
function paint(port: EnginePort, observation: Observation, causes: string[]): Promise<void> {
  const painted = painter.tail.then(async () => {
    const { session, version } = observation
    if (await isOutdated(port, session.sessionId, version)) return
    sessionMemory.painted = { sessionId: session.sessionId, version }
    painter.last = observation
    const previous = await port.readView()
    const { position, view } = observation.compose(previous)
    if (position && view) logSteps(port, session, view.steps, position.slice, causes)
    if (JSON.stringify(previous) !== JSON.stringify(view)) await port.writeView(view)
    await clearStaleRun(port, observation.isRunLive)
    await reportHerdr(port, session, position, observation.dismissed, observation.isTreeChanged, observation.isDelegated)
    await suggestCommand(port, position?.current?.command)
  })
  painter.tail = painted.catch(() => undefined)
  return painted
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
 * Rebuilds the Flow pane's view from the stored session, writing it only when it changed. A cache-only observation that
 * needs a GitHub fact its cache lacks repaints the last observation and leaves the fact to a full read off its path.
 *
 * @param engine - The engine calls.
 * @param options - How the observation runs.
 * @returns Once the pane and herdr reflect the observation.
 */
export async function refreshView(engine: EnginePort, options: RefreshOptions = {}): Promise<void> {
  const { isGithubCacheOnly = false, generation, causes = [engine.cause] } = options
  const port = createReadPort(engine, isGithubCacheOnly)
  const observation = await observe(engine, port, { ...options, causes }).catch((error: unknown) => {
    if (isGithubCacheMiss(error)) return null
    throw error
  })
  if (!observation) {
    engine.defer(() => { void bestEffort(engine, 'cache miss reread', () => reread(engine, true), undefined) })
    return repaint(engine, causes)
  }
  if (generation !== undefined && generation !== refreshQueue.forcedGeneration) return
  await paint(port, observation, causes)
}

/**
 * Reads everything the pane and the sidebar show, leaving the in-flight writes and turn to the paint.
 * @param engine - The engine calls.
 * @param port - The observation's read port.
 * @param options - How the observation runs.
 * @returns The observation.
 */
async function observe(engine: EnginePort, port: EnginePort, options: RefreshOptions): Promise<Observation> {
  const { isQuiet = false, isSynced = false, isForced = false, forceGithub = false, causes = [] } = options
  const held = await readVersionedSession(port)
  const saved = held.session
  if (!saved.flow) await readGit(port)
  const located = await locatePosition(port, saved, isQuiet || isSynced, forceGithub)
  const sync = !!saved.flow && !isQuiet && !isSynced && !located?.isConcluded
  if (!saved.flow || located?.isConcluded) clearIssuesFailure()
  // A tick alone never probes again within the minute, so an outage costs one probe a minute between explicit signals.
  const observed = sync ? await syncIssues(port, held, { isForced, isProbeForced: isForced && causes.some(cause => cause !== 'tick') }) : held
  const session = observed.session
  /**
   * Places the unit with the writes and the turn in flight when it is called, so a paint after an edit started shows it.
   * @returns The position the pane and the sidebar both draw.
   */
  const place = (): Position | null => located ? { ...withStates(sessionMemory.pendingWrites ? withPendingWrite(located) : located, session), isWorking: sessionMemory.isTurnLive } : null
  if (!isQuiet && !isSynced) await bestEffort(port, 'PR snapshot refresh', () => refreshPrSnapshot(port, located?.pullRequest?.state === 'OPEN' ? located.pullRequest.number : undefined), undefined)
  const dismissed = await readDismissals(port)
  const root = await readRepositoryRoot(port)
  const config = await readRepositoryConfig(port, root)
  const warningNotes: KeyedRow[] = [...config.kind === 'invalid' ? [{ key: 'Config' as const, value: facts.verifyConfigInvalid, tone: 'error' as const }] : [],
    ...sessionMemory.modulesAhead?.length !== 0 ? [{ key: 'Guards' as const, value: facts.guardsOverridable, tone: 'error' as const }] : []]
  const violations = (session.violations ?? []).filter(record => !dismissed.has(record.factId)).map(record => ({
    factId: record.factId, text: describeViolation(record, 'user', root ?? undefined), tone: record.kind === 'unchecked' ? 'warn' as const : 'error' as const,
  }))
  // With no position the pane shows only notes and violations, so neither GitHub nor the run display is read.
  const github = !located ? null : !sync ? sessionMemory.githubCache?.status ?? session.gh : await readGithubStatus(port)
  const display = located ? await readRunDisplay(port, session.unit, located.unit.generation) : null
  const isTreeChanged = isTreeChangedRun(display)
  const notes = [...handoffNotes(session), ...auditNotes(session), ...warningNotes]
  const scope = isCoordinatorSession(session) ? await bestEffort(port, 'delegation read', () => readOwnScope(port), null) : null
  const inbox = scope ? await bestEffort(port, 'inbox count', async () => ({ ...await countInbox(port), deadLetters: await countDeadLetters(port, scope.issues) }), null) : null
  const delegation = located ? await bestEffort(port, 'delegation read', () => findDelegation(port, session.issues), null) : null
  const liveness = delegation ? await bestEffort(port, 'coordinator liveness', () => readLiveness(port, delegation), 'unknown' as const) : null
  const taken = located?.unit.delegated ?? []
  const state = liveness === 'live' ? 'on' : liveness === 'gone' ? facts.coordinatorGone : liveness ? facts.coordinatorUnknown : 'stopped'
  const delegationRow: KeyedRow[] = delegation || taken.length
    ? [{ key: 'Delegation', value: [state, ...taken.length ? [`took ${taken.join(', ')}`] : []].join(' · '), tone: liveness && liveness !== 'live' ? 'warn' as const : 'text' as const }] : []
  const approvalNotes = await bestEffort(port, 'approval follow-up', () => followApproval(engine, place(), !!delegation), [])
  /**
   * Builds the view from this observation and the position as it stands now.
   * @param previous - The view on screen, whose run selection is kept.
   * @returns The position and the view.
   */
  const compose = (previous: FlowView | null): { position: Position | null; view: FlowView | null } => {
    const position = place()
    const built = position && github ? buildView(session, position, readGithubFailure(github), isTreeChanged) : null
    const view = position && built ? { ...built, meta: [...built.meta, ...delegationRow], notes: [...built.notes, ...approvalNotes, ...warningNotes], violations,
      hasRunLog: !!(position.unit.verifyRuns.length || position.unit.runs.length || display?.live || display?.last),
      ...(previous?.selectedRunId ? { selectedRunId: previous.selectedRunId } : {}),
    } : violations.length || notes.length || session.role ? { flow: isCoordinatorSession(session) ? 'Coordinator · writes denied' : 'No flow declared.', progress: '', issues: [], pending: null,
      meta: scope ? [...scopeRows(scope), ...inbox ? [inboxRow(inbox)] : []] : [], labels: [], steps: [], notes, footer: null, violations } : null
    return { position, view }
  }
  return { session, version: observed.version, compose, dismissed, isTreeChanged, isRunLive: !!display?.live, isDelegated: liveness === 'live' || !!scope }
}
