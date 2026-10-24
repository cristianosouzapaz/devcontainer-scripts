import { findFlow } from '../domain/flow-definitions'
import { createEmptyUnit } from '../domain/records'
import type { Session } from '../domain/records'
import { withStates } from '../domain/step-states'
import type { Evidence, Position } from '../domain/step-states'
import type { EnginePort } from './engine-port'
import { readUnit } from './record-store'
import { readGit } from './repository'
import { sessionMemory } from './session-memory'
import { readUnitSlice } from './unit-slice'
import { readCandidates, readConclusion, readDelivery, unitMemoryKey } from './unit-github'
import { readVerifyState } from './verify'

/**
 * Locates the session's unit in its flow: every step's state, read from the unit's record, git, the verify runs and CI.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @param isLocal - Whether cached GitHub facts are preferred.
 * @param isForced - Whether the unit's GitHub facts must be refreshed.
 * @returns The position, or null with no flow declared.
 */
export async function locatePosition(port: EnginePort, session: Session, isLocal = false, isForced = false): Promise<Position | null> {
  const definition = findFlow(session.flow)
  if (!definition) return null
  const unit = session.unit ? await readUnit(port, session.unit) : createEmptyUnit()
  const held = session.unit ? sessionMemory.concluded.get(unitMemoryKey(session.unit, unit)) : undefined
  /**
   * Completes the located evidence with the declared unit's step states.
   * @param evidence - The observed unit evidence.
   * @returns The fully resolved position.
   */
  const finish = (evidence: Evidence): Position => withStates({ ...evidence, flow: definition, unit }, session)
  const empty: Evidence = { git: null, slice: null, verify: { fact: '', isVerified: false }, checks: 'off', isConcluded: true }
  if (held) return finish({ ...empty, pullRequest: held })
  const git = await readGit(port)
  const slice = git && session.unit ? await readUnitSlice(port, session.unit, unit, git, session.flow === 'close-out') : null
  const candidates = git && session.unit ? await readCandidates(port, session.unit.branch, git.base, isLocal, isForced) : null
  const conclusion = candidates?.isOk && session.unit ? await readConclusion(port, session.unit, unit, candidates.value) : null
  if (conclusion?.isOk && conclusion.value) return finish({ ...empty, pullRequest: conclusion.value })
  const verify = await readVerifyState(port, slice, unit)
  const delivery = candidates && git ? await readDelivery(port, slice, session.flow === 'trivial' ? [] : session.issues, git.base,
    conclusion && !conclusion.isOk ? conclusion : candidates, isLocal, isForced) : { checks: 'off' as const, isConcluded: false, prFact: 'GitHub unreachable', prFactCode: 'github-unreachable' as const }
  return finish({ git, slice, verify, ...delivery })
}
