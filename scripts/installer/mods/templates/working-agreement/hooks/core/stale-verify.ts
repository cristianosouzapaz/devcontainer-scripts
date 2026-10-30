import { facts } from '../domain/facts'
import type { EnginePort } from './engine-port'
import { locatePosition } from './position'
import { readSession } from './record-store'
import { changedPaths } from './verify-config'

/**
 * Words why the unit's turn must not end yet: Code is current again because the tree or base moved past the unit's
 * latest passing Verify. Only the checkout and the run records are read, never GitHub.
 * @param port - The engine calls.
 * @returns The stop's block reason, or null when no passing Verify has gone stale.
 */
export async function describeStaleVerify(port: EnginePort): Promise<string | null> {
  const session = await readSession(port)
  if (!session.unit || !session.flow) return null
  const position = await locatePosition(port, session, true)
  const current = position?.current
  const passed = position?.unit.verifyRuns.find(run => run.outcome.kind === 'pass')
  if (!position || !current?.step.isUnlocking || current.factCode !== 'verify-not-run' || !passed) return null
  if (current.fact === facts.verifyBaseMoved) return 'Verify is stale: the base moved after it. Run Verify before you stop.'
  const tree = position.slice?.tree
  const changed = tree ? await changedPaths(port, passed.tree, tree).catch(() => []) : []
  return `Verify is stale: the tree changed after it${changed.length ? ` (${changed.join(', ')})` : ''}. Run Verify before you stop.`
}
