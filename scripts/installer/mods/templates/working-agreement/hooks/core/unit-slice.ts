import type { Identity, Unit } from '../domain/records'
import { isUnitOnBase } from '../domain/step-states'
import type { UnitSlice } from '../domain/step-states'
import { isAncestor, readGitOutput, readDefaultRef, readWorktrees } from '../lib/git'
import type { GitState } from '../lib/git'
import type { EnginePort } from './engine-port'
import { readBranchUnits, readDeclaration, sameIdentity } from './record-store'
import { readWorkingTreeKey } from './repository'

/**
 * Reads a unit's boundaries and content independently of the chat's checkout.
 * @param port - The engine calls.
 * @param identity - The declared branch and issues.
 * @param unit - The merged unit entry.
 * @param git - The checkout's repository and default branch.
 * @param isCloseOut - Whether the slice always spans the live merge-base through tip.
 * @returns The slice, or null for the default branch or an unreadable branch.
 */
export async function readUnitSlice(port: EnginePort, identity: Identity, unit: Unit, git: GitState, isCloseOut?: boolean): Promise<UnitSlice | null> {
  if (isUnitOnBase(identity, git)) return null
  const wholeBranch = isCloseOut ?? (await readDeclaration(port, identity))?.flow === 'close-out'
  const read = (args: string[]) => readGitOutput(port.processes, args)
  const tip = await read(['rev-parse', '--verify', '--quiet', `refs/heads/${identity.branch}`])
  if (!tip) return null
  const defaultRef = await readDefaultRef(port.processes, git.base)
  const base = (wholeBranch ? undefined : unit.base) ?? await read(['merge-base', defaultRef, tip])
  const isRewritten = !wholeBranch && !!unit.base && !await isAncestor(port.processes, unit.base, tip)
  const entries = await readBranchUnits(port, identity.branch)
  const later = await Promise.all((wholeBranch ? [] : entries).filter(entry => !sameIdentity(entry.identity, identity) && entry.base && (entry.base !== base || !unit.base))
    .map(async entry => (await readDeclaration(port, entry.identity))?.flow === 'close-out' ? null
      : base && entry.base && await isAncestor(port.processes, base, entry.base) ? entry.base : null))
  const candidates = later.filter((value): value is string => !!value)
  // The nearest descendant base ends this slice; timestamps never order units.
  const end = await candidates.slice(1).reduce(async (pending, candidate) => {
    const closest = await pending
    return await isAncestor(port.processes, candidate, closest) ? candidate : closest
  }, Promise.resolve(candidates[0] ?? tip))
  const isFrozen = end !== tip || candidates.length > 0
  const worktrees = await readWorktrees(port.processes)
  if (worktrees === null) return null
  const root = worktrees.find(worktree => worktree.branch === `refs/heads/${identity.branch}`)?.root
  const status = !isFrozen && root ? await read(['-C', root, 'status', '--porcelain=v2', '-z', '--untracked-files=all']) : ''
  const tree = isFrozen || !root ? await read(['rev-parse', `${end}^{tree}`]) : await readWorkingTreeKey(port, root)
  const count = await read(['rev-list', '--count', base ? `${base}..${end}` : end])
  return {
    base, end, tree, baseTree: base ? await read(['rev-parse', `${base}^{tree}`]) : null, commits: count === null ? 0 : Number(count),
    isClean: status === '', isFrozen, isRewritten, isShared: entries.some(entry => !sameIdentity(entry.identity, identity)),
  }
}
