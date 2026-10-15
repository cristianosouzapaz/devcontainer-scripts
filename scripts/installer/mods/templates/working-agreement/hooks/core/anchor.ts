import { flowDefinitions } from '../domain/flow-definitions'
import { mergeUnits } from '../domain/records'
import type { Session, Unit } from '../domain/records'
import { isOnBase } from '../domain/step-states'
import type { GitState } from '../lib/git'
import type { EnginePort } from './engine-port'
import { listUnitKeys, readUnit, updateUnits, writeSession } from './record-store'
import { countCommitsAhead, isCommitAncestor, readGit } from './repository'

/**
 * Finds the unit's anchor while it holds: recorded, reachable from HEAD, and not written after by this session.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @param unit - The unit.
 * @param git - The checkout, or null outside a repository.
 * @returns The anchor commit, or null when the unit is judged on the live checkout.
 */
export async function findHoldingAnchor(port: EnginePort, session: Session, unit: Unit, git: GitState | null): Promise<string | null> {
  const { anchor } = unit
  if (!anchor || !git || session.wroteAfter === anchor) return null
  return (await isCommitAncestor(port, anchor, 'HEAD')) ? anchor : null
}

/**
 * Records HEAD as the unit's anchor when the live checkout shows its Commit step done and the current anchor does not hold,
 * and clears the session's write marker. The caller holds the lock.
 *
 * @param port - The engine calls.
 * @param session - The session.
 */
export async function recordAnchor(port: EnginePort, session: Session): Promise<void> {
  const definition = session.flow ? flowDefinitions.flows[session.flow] : undefined
  if (!definition?.steps.some(step => step.observe === 'commit')) return
  const git = await readGit(port)
  if (!git || git.isDirty || isOnBase(git) || !git.head) return
  const unit = mergeUnits(await Promise.all((await listUnitKeys(port, session)).map(key => readUnit(port, key))))
  // Another branch's commits are not the unit's to anchor.
  if ((unit.branch && unit.branch !== git.branch && unit.branch !== git.base) || await findHoldingAnchor(port, session, unit, git)) return
  const ownCommits = unit.start ? await countCommitsAhead(port, unit.start) : git.ahead
  if (ownCommits <= 0) return
  await updateUnits(port, session, stored => ({ ...stored, anchor: git.head }))
  if (session.wroteAfter !== undefined) {
    const { wroteAfter: _cleared, ...rest } = session
    await writeSession(port, rest)
  }
}
