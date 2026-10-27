import { parseObservedEnd } from '../domain/records'
import type { Identity, Unit } from '../domain/records'
import { isChildUnit } from '../domain/step-states'
import type { UnitSlice, UnknownEndKind } from '../domain/step-states'
import { readJson } from '../lib/json'
import { isAncestor, readLocalBranchTips, readLocalBranches } from '../lib/git'
import type { GitState } from '../lib/git'
import { createQueue } from '../lib/queue'
import { bestEffort } from './best-effort'
import type { EnginePort } from './engine-port'
import { observedEndPath, readObservedEnds, writeObservedEnd } from './record-store'

/** Holds a child's slice end as its readable branch shows it; null when no end is deliverable. */
interface LiveEnd { state: 'live'; end: string | null }

/** Holds a child's slice end as the sessions observed it before its branch was deleted. */
interface ObservedEnd { state: 'observed'; end: string }

/** Holds a child whose branch is gone and whose observed slice end is missing or contradictory. */
interface UnknownEnd { state: UnknownEndKind }

/** Holds where the slice end a child unit is judged on comes from. */
export type ChildEnd = LiveEnd | ObservedEnd | UnknownEnd

// why: Each observation reads this session's file, compares and replaces it, so two judgements of one session take turns.
const queueObservedEnd = createQueue()

/**
 * Selects the slice end a child unit's integration and conclusion are judged on: only an unrewritten slice with a commit has one.
 * @param slice - The unit's slice, null when it could not be read.
 * @returns The slice end, or null.
 */
export const deliverableEnd = (slice: UnitSlice | null): string | null => slice && !slice.isRewritten && slice.commits > 0 ? slice.end : null

/**
 * Selects the slice end a child's judgement can use.
 * @param end - The child's end, undefined when it could not be read.
 * @returns The live or observed end, or null when there is none.
 */
export const knownEnd = (end: ChildEnd | undefined): string | null => end && 'end' in end ? end.end : null

/**
 * Tells whether a commit is reachable from a parent branch's local tip or its origin copy.
 * @param port - The engine calls.
 * @param parent - The parent branch.
 * @param sha - The commit.
 * @returns True when either copy reaches it.
 */
export async function isReachableFromParent(port: EnginePort, parent: string, sha: string): Promise<boolean> {
  // why: The mod never fetches, so the origin copy counts only as far as the user's own fetch moved it.
  for (const ref of [`refs/heads/${parent}`, `refs/remotes/origin/${parent}`]) if (await isAncestor(port.processes, sha, ref)) return true
  return false
}

/**
 * Caches a child unit's deliverable slice end in this session's own file, best-effort and one write at a time, once the
 * slice read that saw it is over. The stored end moves only forward: it is replaced when the new end does not precede
 * it, when the branch's live tip no longer reaches it after a rewrite, or when the unit's lifetime changed.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @param unit - The unit's merged evidence, which holds its lifetime.
 * @param git - The checkout's repository and default branch.
 * @param slice - The slice just read.
 * @param isCloseOut - Whether the unit is declared as a Close out, which is never a child unit.
 * @returns Once the write is settled; a judgement never waits for it.
 */
export function recordObservedEnd(port: EnginePort, identity: Identity, unit: Unit, git: GitState, slice: UnitSlice, isCloseOut: boolean): Promise<void> {
  const end = deliverableEnd(slice)
  const { generation } = unit
  if (!end || !generation || !isChildUnit(unit, git.base, isCloseOut)) return Promise.resolve()
  return bestEffort(port, 'observed end write', () => queueObservedEnd(async () => {
    // why: The file is this session's own, so one it cannot read is replaced rather than left to block every later write.
    const stored = parseObservedEnd(await readJson(port.files, await observedEndPath(port, identity)).catch(() => undefined))
    if (stored?.generation === generation && (stored.end === end || await isStoredEndKept(port, identity.branch, end, stored.end))) return
    await writeObservedEnd(port, { v: 1, identity, generation, end })
  }), undefined)
}

/**
 * Reads the slice end a child unit is judged on: the live one while its branch is readable, else the one the sessions
 * observed for its lifetime, merged by ancestry alone: the end every other one precedes, else the one that every other
 * end the parent branch reaches precedes. Time never breaks a tie.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @param unit - The unit's merged evidence, which holds its lifetime and parent branch.
 * @param slice - The unit's slice, null when it could not be read.
 * @param branches - The local branches, read once for every child a caller judges; read here when omitted, null when the listing failed.
 * @returns The end, or undefined when a read failed or the branch is readable but its slice is not, so a retry may succeed.
 */
export async function readChildEnd(port: EnginePort, identity: Identity, unit: Unit, slice: UnitSlice | null,
  branches?: Set<string> | null): Promise<ChildEnd | undefined> {
  if (slice) return { state: 'live', end: deliverableEnd(slice) }
  // why: Only a listing that succeeded and lacks the branch is definite; a failed listing may succeed on the next judgement.
  const local = branches === undefined ? await readLocalBranches(port.processes) : branches
  if (!local || local.has(identity.branch)) return undefined
  const read = await readObservedEnds(port, identity).catch(() => null)
  if (!read?.isOk) return undefined
  const ends = [...new Set(read.value.filter(record => record.generation === unit.generation).map(record => record.end))]
  if (!ends.length) return { state: 'never-observed' }
  const parent = unit.baseBranch
  const reached = parent ? (await Promise.all(ends.map(async end => await isReachableFromParent(port, parent, end) ? end : null))).filter(end => end !== null) : []
  const newest = await findNewest(port, ends) ?? (reached.length ? await findNewest(port, reached) : null)
  return newest ? { state: 'observed', end: newest } : { state: 'ambiguous' }
}

/**
 * Tells whether a stored end stands against a different new one: the new end precedes it and the branch's live tip
 * still reaches it. The tip is read at write time, since the branch may have moved since the slice was read.
 * @param port - The engine calls.
 * @param branch - The child's branch.
 * @param end - The newly observed end.
 * @param stored - The end this session's file holds for the same lifetime.
 * @returns True when the stored end is kept, including when the live tip cannot be read.
 */
async function isStoredEndKept(port: EnginePort, branch: string, end: string, stored: string): Promise<boolean> {
  // why: A read port caches `rev-parse` for its whole observation, while the ref listing is always read as it is now.
  const tip = (await readLocalBranchTips(port.processes))?.get(branch)
  // why: Without the live tip, no rewrite can be told from a slower observation, so the stored end stands.
  if (!tip) return true
  return await isAncestor(port.processes, end, stored) && await isAncestor(port.processes, stored, tip)
}

/**
 * Finds the end that every other end precedes.
 * @param port - The engine calls.
 * @param ends - Distinct commits.
 * @returns That end, or null when the ends diverge.
 */
async function findNewest(port: EnginePort, ends: string[]): Promise<string | null> {
  for (const end of ends) {
    const preceding = await Promise.all(ends.filter(other => other !== end).map(other => isAncestor(port.processes, other, end)))
    if (preceding.every(Boolean)) return end
  }
  return null
}
