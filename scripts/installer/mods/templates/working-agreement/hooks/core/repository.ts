import { readContentTree, readGitState, readRoot } from '../lib/git'
import type { GitState } from '../lib/git'
import { unwrapOr } from '../lib/result'
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
  const common = await readCommonDir(port)
  if (!common) return null
  return readContentTree(port.processes, root ?? await port.readCwd(), await temporaryPath(port, recordsPath(common, 's')))
}
