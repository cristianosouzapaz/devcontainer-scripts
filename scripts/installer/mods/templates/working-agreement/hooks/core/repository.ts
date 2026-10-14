import type { CiState } from '../domain/ci-blocker'
import { flowDefinitions } from '../domain/flow-definitions'
import type { DirtyFiles } from '../domain/tree-changes'
import { countCommitsSince, hasPullRequestWorkflow, isAncestor, listChangedFiles, listCommittedFiles, readCommitTree, readDirtyFiles, readGitState, readHead, readRoot, readTreeKey } from '../lib/git'
import type { GitState } from '../lib/git'
import { readChecks } from '../lib/github'
import { isPathMatched } from '../lib/paths'
import { unwrapOr } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'

/**
 * Reads the repository root.
 *
 * @param port - The engine calls.
 * @param isStrict - Whether a git that cannot run rejects, so a gate fails closed, rather than reading as outside a repository.
 * @returns The root, or null outside a repository.
 */
export async function readRepositoryRoot(port: EnginePort, isStrict = false): Promise<string | null> {
  const root = await readRoot(port.processes)
  if (!root.isOk && isStrict) throw new Error(root.error)
  return unwrapOr(root, null)
}

/**
 * Counts the commits on a commit since a ref.
 *
 * @param port - The engine calls.
 * @param ref - The ref.
 * @param to - The commit counted to; HEAD when omitted.
 * @returns The count, 0 when git cannot tell.
 */
export const countCommitsAhead = async (port: EnginePort, ref: string, to = 'HEAD'): Promise<number> => unwrapOr(await countCommitsSince(port.processes, ref, to), 0)

/**
 * Tells whether a commit is an ancestor of another, or the same commit.
 *
 * @param port - The engine calls.
 * @param ancestor - The commit expected behind.
 * @param descendant - The commit expected ahead.
 * @returns True when it is; false when it is not or git cannot tell.
 */
export const isCommitAncestor = async (port: EnginePort, ancestor: string, descendant: string): Promise<boolean> =>
  unwrapOr(await isAncestor(port.processes, ancestor, descendant), false)

/**
 * Reads the tree a commit holds.
 *
 * @param port - The engine calls.
 * @param commit - The commit.
 * @returns The tree id, or null when git cannot tell.
 */
export const readCommitTreeKey = async (port: EnginePort, commit: string): Promise<string | null> => unwrapOr(await readCommitTree(port.processes, commit), null)

/**
 * Tells whether any file changed between two commits.
 *
 * @param port - The engine calls.
 * @param root - The repository root.
 * @param from - The commit compared against.
 * @param to - The commit compared.
 * @param isTestExcluded - Whether a change under the test paths does not count.
 * @returns True when a counted file changed; false when git cannot tell.
 */
export async function hasCommittedChanges(port: EnginePort, root: string, from: string, to: string, isTestExcluded: boolean): Promise<boolean> {
  const changed = await listCommittedFiles(port.processes, root, from, to)
  return changed.isOk && changed.value.some(file => !isTestExcluded || !isTestPath(file))
}

/**
 * Reads the HEAD commit.
 *
 * @param port - The engine calls.
 * @returns The commit, or undefined when git cannot tell.
 */
export const readHeadCommit = async (port: EnginePort): Promise<string | undefined> => unwrapOr(await readHead(port.processes), undefined)

/**
 * Reads the working tree's git state.
 *
 * @param port - The engine calls.
 * @returns The state, or null outside a repository or when git cannot tell.
 */
export const readGit = async (port: EnginePort): Promise<GitState | null> => unwrapOr(await readGitState(port.processes), null)

/**
 * Tells whether a PR has CI to wait for; without a pull-request workflow the CI gate is off.
 *
 * @param port - The engine calls.
 * @returns Whether the repository has a pull-request workflow, or a failure when that could not be read, so the gate fails closed.
 */
export const readContinuousIntegration = (port: EnginePort): Promise<Result<boolean>> => hasPullRequestWorkflow(port.processes)

/**
 * Reads what a PR's checks report.
 *
 * @param port - The engine calls.
 * @param pullRequest - A number, a URL, or none for the current branch's PR.
 * @returns The report, or unknown when gh cannot give one, so the PR step keeps waiting.
 */
export const readPullRequestChecks = async (port: EnginePort, pullRequest?: string): Promise<CiState> => unwrapOr(await readChecks(port.processes, pullRequest), 'unknown' as const)

/**
 * Reads the key that identifies the working tree's content.
 *
 * @param port - The engine calls.
 * @returns The key, or null when git cannot tell.
 */
export const readWorkingTreeKey = async (port: EnginePort): Promise<string | null> => unwrapOr(await readTreeKey(port.processes), null)

/**
 * Reads the files that differ from HEAD, with their content hashes.
 *
 * @param port - The engine calls.
 * @param root - The repository root.
 * @returns The files, or null when git cannot read them.
 */
export const readDirtyTree = async (port: EnginePort, root: string): Promise<DirtyFiles | null> => unwrapOr(await readDirtyFiles(port.processes, root), null)

/**
 * Tells whether every change since the unit's start, staged or not and untracked files included, is under the test paths.
 *
 * @param port - The engine calls.
 * @param root - The repository root.
 * @param start - The unit's starting commit; HEAD when it has none.
 * @returns True when only test files changed.
 */
export async function isTestOnly(port: EnginePort, root: string, start: string | undefined): Promise<boolean> {
  const changed = await listChangedFiles(port.processes, root, start ?? 'HEAD')
  return changed.isOk && changed.value.every(isTestPath)
}

/**
 * Tells whether any file changed since the unit's start, staged or not and untracked files included.
 *
 * @param port - The engine calls.
 * @param root - The repository root.
 * @param start - The unit's starting commit; HEAD when it has none, so only the working tree counts.
 * @param isTestExcluded - Whether a change under the test paths does not count.
 * @returns True when a counted file changed; false when git cannot tell.
 */
export async function hasChanges(port: EnginePort, root: string, start: string | undefined, isTestExcluded: boolean): Promise<boolean> {
  const changed = await listChangedFiles(port.processes, root, start ?? 'HEAD')
  return changed.isOk && changed.value.some(file => !isTestExcluded || !isTestPath(file))
}

// Whether a repo-relative file is under the test paths.
function isTestPath(file: string): boolean {
  return isPathMatched(flowDefinitions.testPaths, file)
}
