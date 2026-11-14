import { readGitOutput, runGit } from '../lib/git'
import type { ProcessPort } from '../lib/process'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { quoteWord } from '../lib/shell'

/** The unit a retirement sets aside: its issue, its branch at the tip read under the lock, the worktree holding it, and the retirement's stamp. */
export interface RetiredUnit { issue: number; branch: string; tip: string; worktree: string | null; stamp: string }

/** What a retirement kept: the ref holding the branch tip, the checkout moved aside with every file it held, and the steps done. */
export interface SetAside { ref: string; checkout: string | null; done: string[] }

/**
 * Sets a unit's work aside without deleting any of it: keeps its tip as `refs/retired/<n>/<stamp>`, moves its checkout to
 * `<worktree>.retired-<stamp>` and detaches that checkout's HEAD, then deletes the branch only while it still points at the tip; the
 * deletion comes last, since `update-ref -d` does not refuse a branch a checkout still holds.
 * @param processes - The process runner.
 * @param unit - The unit.
 * @param onMoved - Runs as soon as the checkout has moved, so a caller records where it is before any later step can stop.
 * @returns What was kept, or the step that failed with the steps done and where the checkout and branch are kept.
 */
export async function setUnitAside(processes: ProcessPort, unit: RetiredUnit, onMoved: (checkout: string) => Promise<void> = async () => {}): Promise<Result<SetAside>> {
  const ref = `refs/retired/${unit.issue}/${unit.stamp}`
  const done: string[] = []
  const checkout = unit.worktree === null ? null : `${unit.worktree}.retired-${unit.stamp}`
  const stop = (step: string, reason: string, at: string | null): Result<SetAside> => fail([...done,
    at === null ? `branch ${unit.branch} kept` : `checkout kept at ${quoteWord(at)} and branch ${unit.branch} kept`, `${step} failed: ${reason}`].join('; '))
  if (await readGitOutput(processes, ['update-ref', ref, unit.tip, '']) === null) return stop(`keeping the tip as ${ref}`, 'the ref cannot be written', unit.worktree)
  done.push(`tip of ${unit.branch} kept as ${ref}`)
  if (unit.worktree !== null && checkout !== null) {
    // why: the HEAD is read before the move, as one moved since would detach the checkout at a commit its files do not hold.
    const head = await readGitOutput(processes, ['-C', unit.worktree, 'rev-parse', 'HEAD'])
    if (head !== unit.tip) return stop('reading the checkout\'s HEAD', head ? `it is at ${head.slice(0, 7)}, not ${unit.tip.slice(0, 7)}` : 'git cannot read it', unit.worktree)
    // why: git refuses to move a worktree that holds submodules, whose unpushed commits no ref of this repository keeps.
    const moved = await runGit(processes, ['worktree', 'move', unit.worktree, checkout])
    if (moved.exitCode !== 0) return stop(`moving the checkout aside to ${quoteWord(checkout)}`, moved.stderr.trim() || `git exited ${moved.exitCode}`, unit.worktree)
    done.push(`checkout moved to ${quoteWord(checkout)}`)
    await onMoved(checkout)
    if (await readGitOutput(processes, ['-C', checkout, 'update-ref', '--no-deref', 'HEAD', unit.tip]) === null) return stop('detaching its HEAD', 'git cannot write it', checkout)
    done.push(`its HEAD detached at ${unit.tip.slice(0, 7)}`)
  }
  if (await readGitOutput(processes, ['update-ref', '-d', `refs/heads/${unit.branch}`, unit.tip]) === null) {
    return stop(`deleting branch ${unit.branch}`, `it no longer points at ${unit.tip.slice(0, 7)}`, checkout)
  }
  done.push(`branch ${unit.branch} deleted`)
  return succeed({ ref, checkout, done })
}
