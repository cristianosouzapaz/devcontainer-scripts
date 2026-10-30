import { coversIssues } from '../domain/delegation'
import { isUnitFinished } from '../domain/step-states'
import { findWorktreeRoot, readFirstParentFork, readGitOutput, readLocalBranchTips, readMergeConflicts, readParentBranch, readWorktreeStatus, runGit } from '../lib/git'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { recordDelegated } from './delegated-commits'
import { readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { composeMergeCommand } from './integration'
import { recordPlaced } from './placed-refs'
import { locatePosition } from './position'
import { readBranchUnits, readDeclaration, readSession, readSessionMirrors, readUnit } from './record-store'
import { readGit } from './repository'
import { isCoordinatorSession } from '../domain/coordinator'

/**
 * Runs the coordinator's merge of a finished child unit into its parent branch, under delegation, for a pair the mod knows:
 * the parent is the branch the child's reflog was cut from, both units are in this coordinator's scope, and the child's unit
 * record names that parent. A fast-forward when the parent's tip is on the child's first-parent chain, else a `--no-ff` merge that applies cleanly;
 * a conflict, named by its paths before anything moves, is handed back. The merge is recorded as delegated only when the parent is the sole moved
 * branch and its new tip is the child's tip or a merge whose second parent is that tip.
 * @param port - The engine calls.
 * @param child - The child branch.
 * @returns What was merged, or the refusal; a merge into the default branch is always refused.
 */
export async function mergeChild(port: EnginePort, child: string): Promise<Result<string>> {
  if (!isCoordinatorSession(await readSession(port))) return fail('only a coordinator merges a child into its parent.')
  const git = await readGit(port)
  if (!git) return fail('the repository is unreadable.')
  const scope = await readOwnScope(port)
  if (!scope) return fail('this coordinator delegates nothing; merging is the user\'s.')
  const parent = await readParentBranch(port.processes, child, git.base)
  const unknown = `${child} has no parent branch the mod knows (a merge into ${git.base} is always the user's).`
  if (!parent) return fail(unknown)
  const record = (await readSessionMirrors(port)).map(mirror => mirror.session).find(session => session.unit?.branch === child && coversIssues(scope, session.unit.issues))
  const declaration = record?.unit ? await readDeclaration(port, record.unit) : null
  const parentUnits = await readBranchUnits(port, parent)
  if (!record?.unit || !declaration || (await readUnit(port, record.unit)).baseBranch !== parent
    || !parentUnits.some(entry => coversIssues(scope, entry.identity.issues))) return fail(`${child} → ${parent} is no delegated child/parent pair the mod knows.`)
  const session = { ...record, flow: declaration.flow, issues: record.unit.issues }
  const position = await locatePosition(port, session, true)
  if (isUnitFinished(position) && !position?.current) return succeed(`${child} is already integrated into ${parent}.`)
  if (position?.current?.step.observe !== 'integrated' || position.slice?.isRewritten) {
    return fail(`${child} is not finished: its unit is at ${position?.current?.step.label ?? 'an unreadable step'}, and only a finished child is merged.`)
  }
  const root = await findWorktreeRoot(port.processes, parent)
  const handOver = `merging it is the user's: ${await composeMergeCommand(port, parent, child)}`
  if (!root) return fail(`no worktree holds ${parent}; ${handOver}`)
  if (await readWorktreeStatus(port.processes, root) !== '') return fail(`${root} has uncommitted changes; ${handOver}`)
  const before = await readLocalBranchTips(port.processes)
  const [parentTip, childTip] = [before?.get(parent), before?.get(child)]
  if (!before || !parentTip || !childTip) return fail('the branch tips are unreadable.')
  // why: Fork points of earlier children are read on the parent's first-parent chain, which a fast-forward replaces with the
  // child's; only a child whose own chain passes through the parent's tip keeps those earlier integrations on it.
  const isFastForward = await readFirstParentFork(port.processes, `refs/heads/${child}`, parentTip) === parentTip
  const conflicts = isFastForward ? [] : await readMergeConflicts(port.processes, parentTip, childTip)
  if (conflicts?.length) return fail(`${child} conflicts with ${parent}'s tip (conflicts in ${conflicts.join(', ')}), so nothing was merged: `
    + `the unit can bring the tip in with merge_parent, or ${handOver}`)
  // why: a fast-forward's tip is known before it moves, so a window closing mid-merge already finds the record; a merge commit's is not.
  if (isFastForward) await recordPlaced(port, parent, childTip)
  // why: A delegated commit is unsigned by design; the user's signing rebase signs it on their return.
  const merge = await runGit(port.processes, ['-C', root, 'merge', '--no-gpg-sign', '--no-edit', isFastForward ? '--ff-only' : '--no-ff', child])
  if (merge.exitCode !== 0) {
    if (!isFastForward) await runGit(port.processes, ['-C', root, 'merge', '--abort'])
    return fail(`${child} does not merge cleanly into ${parent}, so the merge was aborted; ${handOver}`)
  }
  const after = await readLocalBranchTips(port.processes)
  const tip = after?.get(parent)
  const moved = after ? [...new Set([...before.keys(), ...after.keys()])].filter(ref => before.get(ref) !== after.get(ref)) : []
  const parents = tip ? await readGitOutput(port.processes, ['log', '-1', '--format=%P', tip]) : null
  const isKnownMerge = !!tip && (isFastForward ? tip === childTip : parents === `${parentTip} ${childTip}`)
  if (tip && isKnownMerge && !isFastForward) await recordPlaced(port, parent, tip)
  const isRecorded = tip && moved.length === 1 && moved[0] === parent && isKnownMerge && (isFastForward || await recordDelegated(port, [tip], parent))
  if (!tip || !isRecorded) return fail(`${child} was merged into ${parent}, but other refs moved or the merge is not the expected one, so it is not recorded as delegated — tell the user.`)
  logEvent(port, session, 'delegated-merge', { parent, sha: tip, kind: isFastForward ? 'fast-forward' : 'merge' })
  return succeed(`Merged ${child} into ${parent} (${isFastForward ? 'fast-forward' : `merge ${tip}`}), recorded as delegated.`)
}
