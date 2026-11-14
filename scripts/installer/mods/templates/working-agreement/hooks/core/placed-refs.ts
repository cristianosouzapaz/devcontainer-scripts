import { removeFile } from '../lib/files'
import { hasExitedZero } from '../lib/process'
import type { EnginePort } from './engine-port'
import { atomicReplace, readCommonDir, recordsPath } from './record-store'

/** A placed-ref record left behind, and why it could not be removed. */
export interface PlacedLeft { path: string; error: string }

// why: spawn and merge_child move refs, and merge_child checks commits out, for another unit while any session's call may be open, so every session reads these records; one file per place and tip means two writers never share a file.
const bucket = 'placed'

/**
 * Names the record of a tip.
 * @param common - The git common directory.
 * @param place - The short branch name, or the root of a worktree with a detached HEAD; a root starts with `/`, which no branch name can.
 * @param sha - The tip.
 * @returns The record's path.
 */
const placedPath = (common: string, place: string, sha: string): string => recordsPath(common, bucket, `${encodeURIComponent(place)}@${sha}.json`)

/**
 * Records that the mod itself set a branch, or a worktree's detached HEAD, to a tip for another unit, so no session's window judges that move.
 * @param port - The engine calls.
 * @param place - The short branch name, or the worktree's root.
 * @param sha - The tip the mod set it to.
 */
export async function recordPlaced(port: EnginePort, place: string, sha: string): Promise<void> {
  const common = await readCommonDir(port)
  if (common) await atomicReplace(port, placedPath(common, place, sha), JSON.stringify({ v: 1, place, sha }))
}

/**
 * Tells whether the mod itself set a branch, or a worktree's detached HEAD, to a tip.
 * @param port - The engine calls.
 * @param place - The short branch name, or the worktree's root.
 * @param sha - The tip.
 * @returns Whether a record names that place at that tip; a missing or unreadable one reads as no.
 */
export async function isPlaced(port: EnginePort, place: string, sha: string): Promise<boolean> {
  const common = await readCommonDir(port)
  return !!common && await port.files.stat(placedPath(common, place, sha)).then(() => true, () => false)
}

/**
 * Removes the record of a tip the mod was about to set, once the move it was written for did not happen, so no record claims it.
 * @param port - The engine calls.
 * @param place - The short branch name, or the worktree's root.
 * @param sha - The tip the record names.
 * @returns Null once no record names that place at that tip, or the record left behind with why.
 */
export async function removePlaced(port: EnginePort, place: string, sha: string): Promise<PlacedLeft | null> {
  const common = await readCommonDir(port)
  if (!common) return { path: `the placed record of ${place} at ${sha}`, error: 'the git common directory could not be read' }
  const path = placedPath(common, place, sha)
  const removed = hasExitedZero(await removeFile(port.processes, path), 'rm exited non-zero')
  return removed.isOk ? null : { path, error: removed.error }
}
