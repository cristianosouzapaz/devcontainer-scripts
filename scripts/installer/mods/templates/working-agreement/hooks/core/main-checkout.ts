import { readMainCheckout } from '../lib/git'
import type { ProcessPort } from '../lib/process'
import { unwrapOr } from '../lib/result'

/** Where Claude Code places the worktrees it creates, under the main checkout; a worktree's name begins below it. */
export const worktreesFolder = '/.claude/worktrees/'

/**
 * Tells whether a directory lies in one of the worktrees Claude Code creates.
 *
 * @param path - The directory, absolute.
 * @returns True under `.claude/worktrees/` of a checkout.
 */
export const isInWorktree = (path: string): boolean => path.includes(worktreesFolder)

/**
 * Pins every process the mod runs to the main checkout while the session works in one of its worktrees, so the branch,
 * the base, the unit-branch gate and the unit's own commits are judged where the unit lives, not on the worktree's branch.
 * Outside a worktree the processes run as given, with no extra git call.
 *
 * @param processes - The engine's process runner.
 * @param readCwd - Reads the session's working directory, which follows the session into a worktree.
 * @returns The pinned runner.
 */
export function pinToMainCheckout(processes: ProcessPort, readCwd: () => Promise<string>): ProcessPort {
  return {
    run: async (commandLine, options) => {
      const cwd = await readCwd()
      // A main checkout that cannot be read leaves the process in the worktree, as before worktrees were known.
      const main = isInWorktree(cwd) ? unwrapOr(await readMainCheckout(processes, cwd), null) : null
      return processes.run(commandLine, main ? { ...options, cwd: main } : options)
    },
  }
}
