import { isAncestor, readMergeConflicts, readParentBranch, readWorktreeStatus, runGit } from '../lib/git'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { readDelegatedUnit, recordHead, refuseOtherCheckout } from './delegated-commits'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { readSession } from './record-store'
import { readGit } from './repository'

/** A delegated unit's branch and the parent branch its reflog was cut from, the pair merge_child integrates. */
interface ParentPair { branch: string; parent: string }

/**
 * Reads the delegated unit of this session and the parent branch it was cut from.
 * @param port - The engine calls.
 * @returns The pair, or the refusal for a session that is no delegated unit or a unit cut from the default branch.
 */
async function readParentPair(port: EnginePort): Promise<Result<ParentPair>> {
  const unit = await readDelegatedUnit(port).catch(() => null)
  if (!unit) return fail('only a delegated unit brings its parent\'s tip in through this tool; elsewhere merges are the user\'s.')
  const git = await readGit(port)
  if (!git) return fail('the repository is unreadable.')
  const parent = await readParentBranch(port.processes, unit.branch, git.base)
  return parent ? succeed({ branch: unit.branch, parent }) : fail(`${unit.branch} has no parent branch the mod knows (a merge from ${git.base} is always the user's).`)
}

/**
 * Names, for a delegated unit, the paths its branch no longer merges cleanly on into its parent's current tip.
 * @param port - The engine calls.
 * @returns The refusal that stops a run on a branch merge_child could not integrate, or null when it merges cleanly or is no delegated child.
 */
export async function describeParentConflicts(port: EnginePort): Promise<string | null> {
  const pair = await readParentPair(port)
  if (!pair.isOk) return null
  const { branch, parent } = pair.value
  const conflicts = await readMergeConflicts(port.processes, branch, parent)
  return conflicts?.length ? `${branch} no longer merges cleanly into ${parent}'s tip (conflicts in ${conflicts.join(', ')}), so this run would be wasted at merge_child: `
    + 'ask the coordinator, then bring the tip in with merge_parent, resolve, conclude it with the commit tool, and run again.' : null
}

/**
 * Brings the parent branch's tip into a delegated unit's own branch, checked out clean in this session's worktree, with an unsigned
 * merge commit recorded as delegated, so merge_child then merges the child into the parent cleanly. A conflict leaves the merge in progress for the
 * unit to resolve and conclude with the commit tool; nothing is rebased, so the unit's recorded commits keep their ids.
 * It runs in the hook process, so the Bash word guard that refuses a merge does not apply.
 * @param port - The engine calls.
 * @returns What was merged or where it stopped, or the refusal.
 */
export async function mergeParent(port: EnginePort): Promise<Result<string>> {
  const pair = await readParentPair(port)
  if (!pair.isOk) return fail(pair.error)
  const { branch, parent } = pair.value
  const elsewhere = await refuseOtherCheckout(port, branch)
  if (elsewhere) return fail(elsewhere)
  if (await readWorktreeStatus(port.processes) !== '') {
    return fail('this worktree has uncommitted changes (or a merge in progress): commit them with the commit tool first.')
  }
  if (await isAncestor(port.processes, parent, branch)) return succeed(`${branch} already holds ${parent}'s tip; merge_child merges it into ${parent}.`)
  const conflicts = await readMergeConflicts(port.processes, branch, parent)
  if (conflicts === null) return fail(`git cannot tell whether ${parent} merges into ${branch}.`)
  // why: A delegated commit stays unsigned whatever commit.gpgsign says; the user's signing step signs it on their return.
  const merge = await runGit(port.processes, ['merge', '--no-gpg-sign', '--no-edit', '--no-ff', parent])
  const session = await readSession(port)
  if (merge.exitCode !== 0) {
    if (conflicts.length) return succeed(`Merging ${parent} into ${branch} stopped on conflicts in ${conflicts.join(', ')}: resolve them, stage them with git add, `
      + 'then conclude the merge with the commit tool, and run Verify on the merged tree.')
    await runGit(port.processes, ['merge', '--abort'])
    return fail(`git merge failed, so it was aborted: ${`${merge.stdout}\n${merge.stderr}`.trim()}`)
  }
  const sha = await recordHead(port, branch, 'a merge commit')
  if (!sha.isOk) return sha
  logEvent(port, session, 'delegated-merge', { parent, sha: sha.value, kind: 'parent' })
  return succeed(`Merged ${parent} into ${branch} (merge ${sha.value}), unsigned and recorded as delegated; run Verify on the merged tree, then merge_child merges it into ${parent}.`)
}
