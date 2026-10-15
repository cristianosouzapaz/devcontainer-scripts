import type { Unit } from '../domain/records'
import type { RedFileState } from '../domain/step-states'
import { hashFile, readBlobAt } from '../lib/git'
import { unwrapOr } from '../lib/result'
import type { EnginePort } from './engine-port'
import { readRepositoryRoot } from './repository'

/**
 * Reads where each red file stands in the main checkout, against the content hash it was proved with: transferred when it is
 * identical, pending when it is absent or still as at the unit's start (not yet moved there), stale when it holds other content.
 * A hash git cannot read counts as absent, so it never reads stale.
 *
 * @param port - The engine calls.
 * @param unit - The unit.
 * @param root - The main checkout's root.
 * @param subject - The commit the unit is judged on instead of the main checkout, or null to read the main checkout.
 * @returns Each red file's state; empty while the unit has no red.
 */
export async function readRedFiles(port: EnginePort, unit: Unit, root: string, subject: string | null = null): Promise<Record<string, RedFileState>> {
  const prints = Object.entries(unit.red?.fingerprints ?? {})
  const states = await Promise.all(prints.map(async ([file, print]): Promise<[string, RedFileState]> => {
    const content = unwrapOr(subject ? await readBlobAt(port.processes, subject, file) : await hashFile(port.processes, `${root}/${file}`), '')
    if (content === print) return [file, 'transferred']
    if (!content) return [file, 'pending']
    const original = unit.start ? unwrapOr(await readBlobAt(port.processes, unit.start, file), '') : ''
    return [file, content === original ? 'pending' : 'stale']
  }))
  return Object.fromEntries(states)
}

/**
 * Tells whether a red file changed in the main checkout since it was proved, so the red and the green need proving again.
 *
 * @param port - The engine calls.
 * @param unit - The unit.
 * @returns True when a red file is stale.
 */
export async function hasStaleRedFile(port: EnginePort, unit: Unit): Promise<boolean> {
  const root = unit.red ? await readRepositoryRoot(port) : null
  return !!root && Object.values(await readRedFiles(port, unit, root)).includes('stale')
}
