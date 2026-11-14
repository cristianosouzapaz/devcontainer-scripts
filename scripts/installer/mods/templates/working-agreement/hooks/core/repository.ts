import { captureContentTree, readGitState, readRoot } from '../lib/git'
import type { GitState } from '../lib/git'
import { fail, unwrapOr } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { readCommonDir, temporaryPath, recordsPath } from './record-store'

/**
 * Reads the repository root.
 *
 * @param port - The engine calls.
 * @returns The root, or null outside a repository.
 */
export async function readRepositoryRoot(port: EnginePort): Promise<string | null> {
  const root = await readRoot(port.processes)
  return unwrapOr(root, null)
}

/**
 * Reads the working tree's git state.
 *
 * @param port - The engine calls.
 * @returns The state, or null outside a repository or when git cannot tell.
 */
export const readGit = async (port: EnginePort): Promise<GitState | null> => unwrapOr(await readGitState(port.processes), null)

/**
 * Reads the key that identifies the working tree's content.
 *
 * @param port - The engine calls.
 * @param root - The worktree root; the chat checkout when omitted.
 * @returns The key, or null when git cannot tell.
 */
export async function readWorkingTreeKey(port: EnginePort, root?: string): Promise<string | null> {
  return unwrapOr(await readWorkingTree(port, root), null)
}

/**
 * Reads the key that identifies the working tree's content, naming why it could not be read.
 *
 * @param port - The engine calls.
 * @param root - The worktree root; the chat checkout when omitted.
 * @returns The key, or the error of the step that failed.
 */
export async function readWorkingTree(port: EnginePort, root?: string): Promise<Result<string>> {
  const common = await readCommonDir(port)
  if (!common) return fail('the repository metadata cannot be located')
  return captureContentTree(port.processes, root ?? await port.readCwd(), await temporaryPath(port, recordsPath(common, 's')))
}
