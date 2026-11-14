import { createQueue } from '../lib/queue'
import type { CommitCheck, Comparison, PullRequestCandidate, RequiredChecks } from '../lib/github'
import type { Result } from '../lib/result'
import type { PullRequest } from '../domain/records'
import type { GithubStatus } from '../domain/records'
import type { Attempt, AttemptStatus, Identity, ProcessState, RunView } from '../../types'
import { sameIdentity } from '../domain/records'
import type { EnginePort } from './engine-port'
import type { HeldLock } from './host-lock'
import { moduleState } from '../lib/module-state'
import type { StartFault } from '../domain/instruction'
import type { FaultEntry } from './fault-registry'
import type { TurnChange } from './turn-evidence'

/**
 * Describes repeated failures from the first observation through the latest attempt.
 */
export interface ErrorWindow { error: string; firstSeen: number; lastSeen: number; failures: number }

/** One guard's checks this session: how many ran, the most of the hook budget one used, and how many timed out or were recovered by the retry. */
export interface GuardStat { runs: number; maxUsedMs: number; timeouts: number; recovered: number }

/** The last GitHub reachability probe and when it ran. */
interface GithubCache { at: number; status: GithubStatus }

/** A reachability probe, in flight or settled, and when it started: a forced read within a second reuses it. */
interface GithubProbeRun { at: number; status: Promise<GithubStatus> }

/** A refreshable GitHub response, including read failures. */
interface Cached<T> { at: number; result: Result<T> }

/** Holds this chat's display for one declared unit generation. */
interface RunDisplay {
  identity: Identity
  generation: string | undefined
  live: RunView | null
  published: RunView
  last: RunView | null
  /** The slice base a Verify run started on, which only judges whether the run still holds the slice; null for any other run. */
  base: string | null
}

/** A merged PR that concluded a unit's lifetime, with the child slice end it was found on, null for any other unit. */
interface Conclusion { pullRequest: PullRequest; end: string | null }

/** The session version the Flow pane's view was built from, for the chat it belongs to. */
interface PaintedVersion { sessionId: string; version: number }

/**
 * What the hooks share between events for the life of one module load, which a reload of the mod starts over. Every field is a cache,
 * safe to lose on a reload, and says why; a fact a reload must keep is process state and lives in the host-held atom (process-state.ts).
 */
interface SessionMemory {
  /** Cache: a herdr failure seen again after a reload opens a new window. */
  herdrError: ErrorWindow | null
  /** Cache: a failed herdr worktree creation, after which Claude Code made a git worktree outside the volume; the next creation reports it again. */
  worktreeError: ErrorWindow | null
  /** Cache: a record write failure seen again after a reload opens a new window. */
  recordError: ErrorWindow | null
  /** Cache: a transition log failure seen again after a reload opens a new window. */
  logError: ErrorWindow | null
  /** Cache: the next status read probes GitHub again. */
  githubCache: GithubCache | null
  /** Cache: a probe in flight belongs to the module that started it. */
  githubProbe: GithubProbeRun | null
  /** Cache: the next successful GitHub read sets it again. */
  githubLastOk: number | null
  /** Cache: the next failing GitHub read sets it again. */
  githubError: string | null
  /** Cache: how many failed GitHub calls this module repeated, a diagnostic count. */
  githubRetries: number
  /** Cache: when the issues were last read, which throttles unforced syncs; a reload syncs once more. */
  issuesCheckedAt: number
  /** Cache: numbers each issue read as it starts, so an older attempt never overwrites a newer one; attempts belong to the module that made them. */
  issuesAttempt: number
  /** Cache: the attempt whose outcome the session record and the failure below hold. */
  issuesAppliedAttempt: number
  /** Cache: when every declared issue was last read in full, null before any such read since the module loaded. */
  issuesReadAt: number | null
  /** Cache: why the latest issue sync failed; the next sync sets it again. */
  issuesError: string | null
  /** Cache: GitHub answers, read again on a miss. */
  candidates: Map<string, Cached<PullRequestCandidate[]>>
  /** Cache: GitHub answers, read again on a miss. */
  checks: Map<string, Cached<CommitCheck[]>>
  /** Cache: GitHub answers, read again on a miss. */
  rules: Map<string, Cached<RequiredChecks>>
  /** Cache: the state of each issue of a child whose slice end is unknown, read again on a miss. */
  issueStates: Map<number, Cached<string>>
  /** Cache: git comparisons, computed again on a miss. */
  comparisons: Map<string, Comparison>
  /** Cache: concluded lifetimes, found again on a miss. */
  concluded: Map<string, Conclusion>
  /** Cache: the run display, rebuilt from the run records; a run in flight at a reload is the old module's, since a reload never lands inside a tool call. */
  runViews: Map<string, RunDisplay>
  /** Cache: an observation of an older session never repaints over a view built from a newer one; the next paint sets it again. */
  painted: PaintedVersion | null
  /** Cache: the command the engine last showed as the prompt suggestion; at worst it is suggested once more. */
  shownSuggestion: string | null
  /** Cache: the hooks modules the engine nests outside this one, outermost first; every load refreshes it. Null after a refresh that did not list
   * this mod, which leaves the order unknown. */
  modulesAhead: readonly string[] | null
  /** Cache: the permission mode the engine last reported, which it reports again with its next event; null before any report. */
  permissionMode: string | null
  /** Cache: whether this module registered the mod's tools and `/flow`; every load registers them again, and a mod prompt waits for it. */
  isSurfaceRegistered: boolean
  /** Cache: the faults this load holds, by key, each cleared once the operation it is about succeeds again; fault-registry.ts owns them, and a new module learns them again. */
  faults: Map<string, FaultEntry>
  /** Cache: why each start prompt was not delivered, by its id, shown until that start is delivered; a new module learns it again at its next try. */
  startFaults: Map<string, StartFault>
  /** Whether a newer mod load recorded itself in the process state after this one replaced its predecessor, so this load changes nothing in the keeping, for good. */
  isLoadSuperseded: boolean
  /**
   * The turn starts, ends and entering prompts this load saw and has not seen written yet, in the order this load saw them, each from its
   * handler's start, with the cause and the change of one whose write failed, which the tick writes again: each holds the session until a
   * write of it lands or a write of a change that supersedes it does; a write about another turn clears none of them. A new module adopts
   * them from the activity record at its start.
   */
  pendingTurnChanges: TurnChange[]
  /** The order this load numbers turn changes in, as each handler begins. */
  turnSeq: number
  /** Whether this load heard a turn start or end, or a prompt the chain accepted, itself: evidence newer than the load a reload replaced. */
  isBoundaryHeard: boolean
  /** The epoch and the last ended turn of the latest turn change this load wrote, so a dispatch whose reads stand at an earlier moment knows it is older. */
  turnMark: { epoch: number; ended: string | null }
  /** How many ticks this load ran, so a turn change still unwritten a full tick after it began is known stranded. */
  tickSeq: number
  /** The turn whose start this load saw, the only one whose facts it can vouch for; null before any. */
  ownTurnId: string | null
  /** When the prompt this load saw entering entered, whose flags it can vouch for before its turn starts; null before any. */
  ownPromptAt: number | null
  /** Whether this load saw a message sent while the turn it belongs to could not be named, so no turn of this load may be said to have sent none. */
  isSentUnbound: boolean
  /**
   * The turn facts this load saw and has not seen written into their turn, by name and turn, so one turn's fact never replaces another's:
   * each change, and the turn it belongs to, or null for a fact of no one turn; decisions read the state with them applied, and the tick
   * writes them again until one is written into its turn, or its turn is over.
   */
  turnFacts: Map<string, { name: string; turnId: string | null; change: (state: ProcessState) => ProcessState }>
  /** The attempts this load made whose submit has not answered within its tick yet, which hold the session busy rather than unknown. */
  liveAttempts: Set<string>
  /** The receipts this load holds whose write failed, by attempt, which its continuation writes again in a tick; the hold row names them. */
  unwrittenReceipts: Map<string, AttemptStatus>
  /** The notices of the process state a completed paint of this load showed, which the tick then dismisses. */
  shownNotices: Set<string>
  /** The attempts whose submit this load saw answer unknown, newest last, so a prompt the user types hands them over even when the state cannot be read. */
  unknownAttempts: string[]
  /** The digests of the attempts this load settled as entered, newest last, so their prompts' entry is never taken for the user's. */
  settledDigests: string[]
  /** The attempts this load ended while whether they entered was unknown, newest last, so their prompt seen entering later is still recorded as their outcome. */
  endedUnknown: Attempt[]
  /** The last prompt that entered, when, its digest and the attempts this load knew unknown then, until it is applied as evidence about the attempts; null when none waits. */
  enteringPrompt: { at: number; digest: string; unknown: string[] } | null
  /** The answers this load's submits received whose record is not written yet, by attempt, so a decision reads what this load knows. */
  answers: Map<string, AttemptStatus>
  /** The claims this load wrote whose write answered with a failure, so it never submitted them, which it withdraws, at the tick until it can. */
  unsubmittedClaims: Set<string>
  /** How this load's process state began: kept across a reload, new with its process, or not known, as when its first read failed. */
  processOrigin: 'reload' | 'process' | 'unknown'
  /**
   * Whether this load, started by a reload, has not yet heard a turn start, a turn end or a prompt entering itself: the load it replaced
   * may have heard one it never recorded in either channel, so until then a turn may run, or have ended, that no record shows.
   */
  isActivityUnchecked: boolean
  /** Whether a mirror publish waited for the process state to hold a generation, which the adoption then publishes. */
  isMirrorDeferred: boolean
  /** The holds no fault caused, by kind, that this load told the user of by a notification while they kept work waiting. */
  announcedHolds: Set<string>
  /**
   * What this load knows of each chat's last audit that the process state could not keep, by session id: why its result is not on the
   * record, or null once a result is while the state still holds a note it could not clear. A reload starts it over.
   */
  auditUnrecorded: Map<string, string | null>
  /** The order, among this load's turn changes, of the last turn start it heard, so a start it heard before another is known obsolete. */
  lastStartSeq: number
  /** This load's number among the session's loads, which its views are published under so no older load paints over them; null until taken. */
  loadSeq: number | null
  /** Whether this load took its number after its start, as one whose first try failed, which may rank it above a newer load. */
  isLoadSeqLate: boolean
  /** Whether this load's last view was published, false when a newer load's stood, so the next paint publishes again. */
  isViewPublished: boolean
  /** Cache: the Edit, Write and NotebookEdit calls running now, which the view reads as already changed; a reload never lands inside a tool call, so it is 0 there. */
  pendingWrites: number
  /** Cache: when this session's doorbell last rang, until its prompt enters, so a burst rings once; a ring lost with it enters as the empty doorbell. */
  doorbellRungAt: number | null
  /** Cache: the activity this module last recorded and when, so a burst of tool calls writes it once a tick. */
  activity: { key: string; at: number }
  /** Cache: the stall this coordinator last reported per unit; the stall records on disk outlive a reload. */
  stallReports: Map<number, string>
  /**
   * The escalation failure notice this coordinator last kept per unit issue: whether it is on the unit's record, sent, and whether the
   * user was told its record write failed, so a failed write is retried and still sent, and a failed clear never sends it again.
   */
  escalationNotices: Map<number, { notice: string; isRecorded: boolean; isSent: boolean; isWarned: boolean }>
  /** The lost signal of the spawn lock this process holds now, null while it holds none, so a starting check knows a hold its process lost. */
  spawnLockLost: AbortSignal | null
  /** The spawn lock this process holds now, null while it holds none, whose rename lands each spawn record write only while it is held. */
  spawnLockHeld: HeldLock | null
  /** Cache: the unit issues herdr showed blocked at this coordinator's last tick; a reload waits one tick more before counting one. */
  blockedUnits: Set<number>
  /** Cache: each issue's native parent as GitHub last answered, null for none, read again on a miss. */
  parentIssues: Map<number, number | null>
  /** Cache: each guard's check measurements, a diagnostic count. */
  guards: Map<string, GuardStat>
  /** Cache: the decisions whose step outcome this module returned to the agent with a pending mark, by URL with the step's id, until a later injection point clears the mark; a reload leaves the mark on disk, so the new module shows that outcome again. */
  shownMarks: Map<string, string>
  /** Cache: whether this module read every decision record once for pending marks it did not write, so a later injection point reads none again; a reload scans once more. */
  isPendingScanned: boolean
  /** Cache: the state each note about pending marks was last shown in, by what it is about, so a failure that persists is named once; a reload names it once more. */
  pendingNotes: Map<string, string>
  /** Cache: the kind of terms each step's entry last showed, by step id, so a Choice or a note on it is shown once per state, at prompts too; a reload shows it once more. */
  shownTerms: Map<string, string>
  /** Cache: the marked decisions whose Choice this module has not shown yet, by URL with the step's id: read again at each injection point until it is; a reload finds them again in its scan. */
  unshownMarks: Map<string, string>
}

/** The key of an audit note kept for a chat whose id could not be read, which every chat this load shows reads. */
export const unknownChat = ''

/** The hooks' shared in-memory state; a reload evaluates the module again, so it starts over. */
export const sessionMemory: SessionMemory = moduleState(createSessionMemory)

/** The queue record read-modify-writes take turns in; each module load has its own. */
const recordLock = moduleState(() => ({ run: createQueue() }))

/**
 * Runs record read-modify-writes one at a time: session and unit records are written whole, so parallel tool calls take turns here.
 *
 * @param work - The read-modify-write to run.
 * @returns What `work` resolves to; its failure reaches the caller.
 */
export function withRecordLock<T>(work: () => Promise<T>): Promise<T> {
  return recordLock.run(work)
}

/**
 * Builds the memory a fresh evaluation of the module starts with.
 * @returns The memory.
 */
function createSessionMemory(): SessionMemory {
  return {
    herdrError: null,
    worktreeError: null,
    recordError: null,
    logError: null,
    githubCache: null,
    githubProbe: null,
    githubLastOk: null,
    githubError: null,
    githubRetries: 0,
    issuesCheckedAt: 0,
    issuesAttempt: 0,
    issuesAppliedAttempt: 0,
    issuesReadAt: null,
    issuesError: null,
    candidates: new Map(),
    checks: new Map(),
    rules: new Map(),
    issueStates: new Map(),
    comparisons: new Map(),
    concluded: new Map(),
    runViews: new Map(),
    painted: null,
    shownSuggestion: null,
    modulesAhead: [],
    permissionMode: null,
    isSurfaceRegistered: false,
    faults: new Map(),
    startFaults: new Map(),
    isLoadSuperseded: false,
    pendingTurnChanges: [],
    turnSeq: 0,
    isBoundaryHeard: false,
    turnMark: { epoch: 0, ended: null },
    tickSeq: 0,
    ownTurnId: null,
    ownPromptAt: null,
    isSentUnbound: false,
    turnFacts: new Map(),
    liveAttempts: new Set(),
    unwrittenReceipts: new Map(),
    shownNotices: new Set(),
    unsubmittedClaims: new Set(),
    answers: new Map(),
    enteringPrompt: null,
    settledDigests: [],
    endedUnknown: [],
    unknownAttempts: [],
    processOrigin: 'unknown',
    isActivityUnchecked: false,
    isMirrorDeferred: false,
    announcedHolds: new Set(),
    auditUnrecorded: new Map(),
    lastStartSeq: 0,
    loadSeq: null,
    isViewPublished: false,
    isLoadSeqLate: false,
    pendingWrites: 0,
    doorbellRungAt: null,
    activity: { key: '', at: 0 },
    stallReports: new Map(),
    escalationNotices: new Map(),
    spawnLockLost: null,
    spawnLockHeld: null,
    blockedUnits: new Set(),
    parentIssues: new Map(),
    guards: new Map(),
    shownMarks: new Map(),
    isPendingScanned: false,
    pendingNotes: new Map(),
    shownTerms: new Map(),
    unshownMarks: new Map(),
  }
}

/**
 * Retains the first failure time while recording the latest failure and attempt count.
 * @param previous - The current error window, if any.
 * @param error - The latest failure message.
 * @param now - The failure time.
 * @returns The replacement error window.
 */
export function holdError(previous: ErrorWindow | null, error: string, now: number): ErrorWindow {
  return { error, firstSeen: previous?.firstSeen ?? now, lastSeen: now, failures: (previous?.failures ?? 0) + 1 }
}

/**
 * Reads this chat's run display only for the declared unit and generation.
 * @param port - The engine calls.
 * @param identity - The declared unit, if any.
 * @param generation - The unit's declared lifetime.
 * @returns The matching display, or null when it belongs to another unit or lifetime.
 */
export async function readRunDisplay(port: EnginePort, identity: Identity | null | undefined, generation: string | undefined): Promise<RunDisplay | null> {
  const memory = sessionMemory.runViews.get(await port.readSessionId())
  return memory && identity && sameIdentity(memory.identity, identity) && memory.generation === generation ? memory : null
}

/**
 * Tells whether a run display's last run is a Verify run that changed the tree and so left no record.
 * @param display - The chat's run display for the unit, if any.
 * @returns Whether the last Verify run changed the tree.
 */
export const isTreeChangedRun = (display: RunDisplay | null): boolean => display?.last?.kind === 'Verify' && display.last.status === 'tree changed'

/**
 * Tells whether this chat's last Verify run of the unit changed the tree and so left no record.
 * @param port - The engine calls.
 * @param identity - The declared unit, if any.
 * @param generation - The unit's declared lifetime.
 * @returns Whether the last Verify run changed the tree.
 */
export async function readIsTreeChanged(port: EnginePort, identity: Identity | null | undefined, generation: string | undefined): Promise<boolean> {
  return isTreeChangedRun(await readRunDisplay(port, identity, generation))
}
