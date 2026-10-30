import type { Identity, Unit } from '../domain/records'
import { isUnitOnBase } from '../domain/step-states'
import type { UnitSlice } from '../domain/step-states'
import { isAncestor, readForkPoint, readGitOutput, readDefaultRef, readWorktrees } from '../lib/git'
import type { GitState } from '../lib/git'
import { recordObservedEnd } from './child-end'
import { remapDelegatedBase } from './delegated-commits'
import type { EnginePort } from './engine-port'
import { readBranchUnits, readDeclaration } from './record-store'
import { sameIdentity } from '../domain/records'
import { readWorkingTreeKey } from './repository'

/**
 * Reads a unit's boundaries and content independently of the chat's checkout.
 * @param port - The engine calls.
 * @param identity - The declared branch and issues.
 * @param unit - The merged unit entry.
 * @param git - The checkout's repository and default branch.
 * @param isCloseOut - Whether the slice always spans the live merge-base, with the unit's base branch or else the default branch, through tip.
 * @returns The slice, or null for the default branch or an unreadable branch.
 */
export async function readUnitSlice(port: EnginePort, identity: Identity, unit: Unit, git: GitState, isCloseOut?: boolean): Promise<UnitSlice | null> {
  if (isUnitOnBase(identity, git)) return null
  const wholeBranch = isCloseOut ?? (await readDeclaration(port, identity))?.flow === 'close-out'
  const read = (args: string[]) => readGitOutput(port.processes, args)
  const tip = await read(['rev-parse', '--verify', '--quiet', `refs/heads/${identity.branch}`])
  if (!tip) return null
  // The recorded base orders the branch's units and detects rewritten history; it moves only on re-declaration,
  // or follows the user's signing rebase when it names a delegated commit.
  const isBaseGone = !wholeBranch && !!unit.base && !await isAncestor(port.processes, unit.base, tip)
  const recorded = isBaseGone && unit.base ? await remapDelegatedBase(port, unit.base, tip) ?? unit.base : unit.base
  const anchor = (wholeBranch ? undefined : recorded) ?? await read(['merge-base', await readDefaultRef(port.processes, unit.baseBranch ?? git.base), tip])
  const isRewritten = isBaseGone && recorded === unit.base
  const entries = await readBranchUnits(port, identity.branch)
  const later = await Promise.all((wholeBranch ? [] : entries).filter(entry => !sameIdentity(entry.identity, identity) && entry.base && (entry.base !== anchor || !unit.base))
    .map(async entry => (await readDeclaration(port, entry.identity))?.flow === 'close-out' ? null
      : anchor && entry.base && await isAncestor(port.processes, anchor, entry.base) ? entry.base : null))
  const candidates = later.filter((value): value is string => !!value)
  // The nearest descendant base ends this slice; timestamps never order units.
  const end = await candidates.slice(1).reduce(async (pending, candidate) => {
    const closest = await pending
    return await isAncestor(port.processes, candidate, closest) ? candidate : closest
  }, Promise.resolve(candidates[0] ?? tip))
  const isFrozen = end !== tip || candidates.length > 0
  // A base taken from a branch follows that branch's fork point; once neither copy of the branch is readable, the recorded base stands.
  const forkPoint = !wholeBranch && unit.baseBranch ? await readForkPoint(port.processes, unit.baseBranch, end) : null
  // why: Below the recorded base lie commits the base branch already delivered from another branch, which are never the unit's.
  const isBelow = !!forkPoint && !!recorded && forkPoint !== recorded && await isAncestor(port.processes, forkPoint, recorded)
  // why: A base branch fast-forwarded onto the unit puts its end on that branch's first-parent chain, so the fork point
  // is the end itself: the branch already contains the whole slice, which the recorded base still bounds.
  const isContained = !!recorded && forkPoint === end
  const base = forkPoint && !isBelow && !isContained ? forkPoint : anchor
  const worktrees = await readWorktrees(port.processes)
  if (worktrees === null) return null
  const root = worktrees.find(worktree => worktree.branch === `refs/heads/${identity.branch}`)?.root
  const status = !isFrozen && root ? await read(['-C', root, 'status', '--porcelain=v2', '-z', '--untracked-files=all']) : ''
  const tree = isFrozen || !root ? await read(['rev-parse', `${end}^{tree}`]) : await readWorkingTreeKey(port, root)
  const count = await read(['rev-list', '--count', base ? `${base}..${end}` : end])
  const slice: UnitSlice = {
    base, end, tree, baseTree: base ? await read(['rev-parse', `${base}^{tree}`]) : null, commits: count === null ? 0 : Number(count),
    isClean: status === '', isFrozen, isRewritten, isShared: entries.some(entry => !sameIdentity(entry.identity, identity)),
  }
  // why: A child's branch is often deleted right after its merge, so every reader caches the end it sees while it can,
  // after the read and never holding up the judgement.
  void recordObservedEnd(port, identity, unit, git, slice, wholeBranch)
  return slice
}
