import type { Session } from '../domain/records'
import { applyTreeChange, listTreeChanges } from '../domain/tree-changes'
import { isWriteAllowed } from './call-judgement'
import type { EnginePort } from './engine-port'
import { updateUnits } from './record-store'
import { readDirtyTree, readRepositoryRoot } from './repository'
import { sessionMemory } from './session-memory'

/**
 * Compares the working tree with the one last recorded and records on the unit what changed in between, whoever changed
 * it: every changed file the agreement would have held a write to back. A tree git
 * cannot read counts as an unexplained write while a step holds writes back, and leaves the record as it was, so the
 * next read still sees the change. The first read of a declared flow only starts the record.
 *
 * @param port - The engine calls.
 * @param session - The session the boundary falls in.
 * @param isApproved - Whether the user approved the call whose window this closes, which then records no unexplained write.
 */
export async function compareTree(port: EnginePort, session: Session, isApproved = false): Promise<void> {
  if (!session.flow) {
    sessionMemory.tree = null
    return
  }
  const root = await readRepositoryRoot(port)
  if (!root) return
  const recorded = sessionMemory.tree?.root === root ? sessionMemory.tree.files : null
  const after = await readDirtyTree(port, root)
  if (after) sessionMemory.tree = { root, files: after }
  if (after && !recorded) return
  // A write a call names was judged before it ran, and one held back never ran, so the judgement alone tells them apart.
  const changed = recorded && after ? listTreeChanges(recorded, after) : []
  const strays: string[] = []
  for (const path of isApproved ? [] : changed) {
    if (!(await isWriteAllowed(port, session, `${root}/${path}`))) strays.push(path)
  }
  const isUnchecked = !isApproved && !after && !(await isWriteAllowed(port, session, null))
  // A file made clean again is no change but may restore a record, so only a tree equal to the recorded one is skipped.
  const isSame = !!recorded && !!after && !changed.length && !listTreeChanges(after, recorded).length
  if (isSame || (!after && !isUnchecked)) return
  await updateUnits(port, session, unit => applyTreeChange(unit, { before: recorded, after, strays, isUnchecked }))
}

/**
 * Takes the working tree as it is into the record without judging it: what changed since the last read is the user's.
 *
 * @param port - The engine calls.
 * @param session - The session the prompt is submitted in.
 */
export async function absorbTree(port: EnginePort, session: Session): Promise<void> {
  const root = session.flow ? await readRepositoryRoot(port) : null
  const files = root ? await readDirtyTree(port, root) : null
  if (root && files) sessionMemory.tree = { root, files }
}
