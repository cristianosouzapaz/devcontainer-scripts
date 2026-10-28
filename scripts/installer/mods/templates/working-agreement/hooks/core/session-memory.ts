import { createQueue } from '../lib/queue'
import type { CommitCheck, Comparison, PullRequestCandidate, RequiredChecks } from '../lib/github'
import type { Result } from '../lib/result'
import type { PullRequest } from '../domain/records'
import type { GithubStatus } from '../domain/records'
import type { Identity, RunView } from '../../types'
import { sameIdentity } from '../domain/records'
import type { EnginePort } from './engine-port'

/**
 * Describes repeated failures from the first observation through the latest attempt.
 */
export interface ErrorWindow { error: string; firstSeen: number; lastSeen: number; failures: number }

/** The last GitHub reachability probe and when it ran. */
interface GithubCache { at: number; status: GithubStatus }

/** A reachability probe, in flight or settled, and when it started: a forced read within a second reuses it. */
interface GithubProbeRun { at: number; status: Promise<GithubStatus> }

/** A refreshable GitHub response, including read failures. */
interface Cached<T> { at: number; result: Result<T> }

/** Holds this chat's display for one declared unit generation. */
export interface RunDisplay {
  identity: Identity
  generation: string | undefined
  live: RunView | null
  published: RunView
  last: RunView | null
}

/** A merged PR that concluded a unit's lifetime, with the child slice end it was found on, null for any other unit. */
interface Conclusion { pullRequest: PullRequest; end: string | null }

/** The session version the Flow pane's view was built from, for the chat it belongs to. */
interface PaintedVersion { sessionId: string; version: number }

/** What the hooks share between events for the life of one module load. */
interface SessionMemory {
  herdrError: ErrorWindow | null
  /** A failed herdr worktree creation, after which Claude Code made a git worktree outside the volume. */
  worktreeError: ErrorWindow | null
  recordError: ErrorWindow | null
  logError: ErrorWindow | null
  githubCache: GithubCache | null
  githubProbe: GithubProbeRun | null
  githubLastOk: number | null
  githubError: string | null
  /** When the issues were last read, successfully or not: it throttles unforced syncs. */
  issuesCheckedAt: number
  /** Numbers each issue read as it starts: an older attempt never overwrites what a newer one stored. */
  issuesAttempt: number
  /** The attempt whose outcome the session record and the failure below hold. */
  issuesAppliedAttempt: number
  /** When every declared issue was last read in full, null before any such read since the module loaded. */
  issuesReadAt: number | null
  /** Why the latest issue sync failed; the facts it could not refresh stay as the last good read left them. */
  issuesError: string | null
  candidates: Map<string, Cached<PullRequestCandidate[]>>
  checks: Map<string, Cached<CommitCheck[]>>
  rules: Map<string, Cached<RequiredChecks>>
  /** The state of each issue of a child whose slice end is unknown, by number. */
  issueStates: Map<number, Cached<string>>
  comparisons: Map<string, Comparison>
  concluded: Map<string, Conclusion>
  runViews: Map<string, RunDisplay>
  /** An observation of an older session never repaints over a view built from a newer one. */
  painted: PaintedVersion | null
  /** The command the engine last showed as the prompt suggestion, until the step stops waiting on one. */
  shownSuggestion: string | null
}

/** The hooks' shared in-memory state; a reload evaluates the module again, so it starts over. */
export const sessionMemory: SessionMemory = {
  herdrError: null,
  worktreeError: null,
  recordError: null,
  logError: null,
  githubCache: null,
  githubProbe: null,
  githubLastOk: null,
  githubError: null,
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
}

/**
 * Runs record read-modify-writes one at a time: session and unit records are written whole, so parallel tool calls take turns here.
 *
 * @param work - The read-modify-write to run.
 * @returns What `work` resolves to; its failure reaches the caller.
 */
export const withRecordLock: <T>(work: () => Promise<T>) => Promise<T> = createQueue()

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
