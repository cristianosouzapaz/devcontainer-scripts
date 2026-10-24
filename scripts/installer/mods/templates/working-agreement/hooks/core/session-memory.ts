import { createQueue } from '../lib/queue'
import type { CommitCheck, Comparison, PullRequestCandidate, RequiredChecks } from '../lib/github'
import type { Result } from '../lib/result'
import type { PullRequest } from '../domain/records'
import type { GithubStatus } from '../domain/records'
import type { Identity, RunView } from '../../types'

/**
 * Describes repeated failures from the first observation through the latest attempt.
 */
export interface ErrorWindow { error: string; firstSeen: number; lastSeen: number; failures: number }

/** The last GitHub reachability probe and when it ran. */
interface GithubCache { at: number; status: GithubStatus }

/** A refreshable GitHub response, including read failures. */
interface Cached<T> { at: number; result: Result<T> }

/** Holds this chat's display for one declared unit generation. */
export interface RunDisplay {
  identity: Identity
  generation?: string
  live: RunView | null
  published: RunView
  last: RunView | null
}

/** What the hooks share between events for the life of one module load. */
interface SessionMemory {
  herdrError: ErrorWindow | null
  recordError: ErrorWindow | null
  githubCache: GithubCache | null
  githubLastOk: number | null
  githubError: string | null
  issuesCheckedAt: number
  candidates: Map<string, Cached<PullRequestCandidate[]>>
  checks: Map<string, Cached<CommitCheck[]>>
  rules: Map<string, Cached<RequiredChecks>>
  comparisons: Map<string, Comparison>
  concluded: Map<string, PullRequest>
  runViews: Map<string, RunDisplay>
  /** The command the engine last showed as the prompt suggestion, until the step stops waiting on one. */
  shownSuggestion: string | null
}

/** The hooks' shared in-memory state; a reload evaluates the module again, so it starts over. */
export const sessionMemory: SessionMemory = {
  herdrError: null,
  recordError: null,
  githubCache: null,
  githubLastOk: null,
  githubError: null,
  issuesCheckedAt: 0,
  candidates: new Map(),
  checks: new Map(),
  rules: new Map(),
  comparisons: new Map(),
  concluded: new Map(),
  runViews: new Map(),
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
