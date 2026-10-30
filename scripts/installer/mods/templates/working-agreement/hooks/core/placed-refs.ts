import type { EnginePort } from './engine-port'
import { atomicReplace, readCommonDir, recordsPath } from './record-store'

// why: spawn and merge_child move refs for another unit while any session's call may be open, so every session reads these records;
// one file per branch and tip means two writers never share a file.
const bucket = 'placed'

/**
 * Names the record of a branch tip.
 * @param common - The git common directory.
 * @param branch - The short branch name.
 * @param sha - The tip.
 * @returns The record's path.
 */
const placedPath = (common: string, branch: string, sha: string): string => recordsPath(common, bucket, `${encodeURIComponent(branch)}@${sha}.json`)

/**
 * Records that the mod itself set a branch to a tip for another unit, so no session's window judges that move.
 * @param port - The engine calls.
 * @param branch - The short branch name.
 * @param sha - The tip the mod set it to.
 */
export async function recordPlaced(port: EnginePort, branch: string, sha: string): Promise<void> {
  const common = await readCommonDir(port)
  if (common) await atomicReplace(port, placedPath(common, branch, sha), JSON.stringify({ v: 1, branch, sha }))
}

/**
 * Tells whether the mod itself set a branch to a tip.
 * @param port - The engine calls.
 * @param branch - The short branch name.
 * @param sha - The tip.
 * @returns Whether a record names that branch at that tip; a missing or unreadable one reads as no.
 */
export async function isPlaced(port: EnginePort, branch: string, sha: string): Promise<boolean> {
  const common = await readCommonDir(port)
  return !!common && await port.files.stat(placedPath(common, branch, sha)).then(() => true, () => false)
}
