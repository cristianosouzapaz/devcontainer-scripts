import type { CiState } from '../domain/ci-blocker'
import type { GithubStatus } from '../domain/records'

/** The last GitHub reachability probe and when it ran. */
interface GithubCache { at: number; status: GithubStatus }

/** The last CI state read for a PR at a given head, keyed `<pr>@<head>`, and when it was read. */
interface ChecksCache { key: string; at: number; checks: CiState }

/** What the hooks share between events for the life of one module load. */
interface SessionMemory {
  /** Every skill started in the current turn: a nested skill (generate-pr inside create-pr) does not end the one that started it. */
  turnSkills: string[]
  githubCache: GithubCache | null
  permissionMode: string | null
  pullRequestsCheckedAt: number
  issuesCheckedAt: number
  checksCache: ChecksCache | null
  lock: Promise<unknown>
}

/** The hooks' shared in-memory state; a reload evaluates the module again, so it starts over. */
export const sessionMemory: SessionMemory = {
  turnSkills: [],
  githubCache: null,
  permissionMode: null,
  pullRequestsCheckedAt: 0,
  issuesCheckedAt: 0,
  checksCache: null,
  lock: Promise.resolve(),
}

/**
 * Runs record read-modify-writes one at a time: session and unit records are written whole, so parallel tool calls take turns here.
 *
 * @param work - The read-modify-write to run.
 * @returns What `work` resolves to; its failure reaches the caller.
 */
export function withRecordLock<T>(work: () => Promise<T>): Promise<T> {
  const queued = sessionMemory.lock.then(work)
  // The caller receives the failure; the queue only needs to know the work ended, so the next one still runs.
  sessionMemory.lock = queued.then(() => undefined, () => undefined)
  return queued
}
