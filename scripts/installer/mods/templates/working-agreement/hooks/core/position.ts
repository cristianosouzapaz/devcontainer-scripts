import { findFlow, resolveUnitFlow } from '../domain/flow-definitions'
import type { FlowDefinition } from '../domain/flow-definitions'
import { createEmptyUnit } from '../domain/records'
import type { Session, Unit } from '../domain/records'
import { describeMissingIssue, listRequiredIssues } from '../domain/requirements'
import { isChildUnit, withStates } from '../domain/step-states'
import type { Evidence, Position } from '../domain/step-states'
import type { GitState } from '../lib/git'
import { deliverableEnd } from './child-end'
import type { EnginePort } from './engine-port'
import { guideMerge, judgeChild, readBranchChildren } from './integration'
import { readUnit } from './record-store'
import { readGit } from './repository'
import { sessionMemory } from './session-memory'
import { readUnitSlice } from './unit-slice'
import { readCandidates, readConclusion, readDelivery, unitMemoryKey } from './unit-github'
import { readVerifyState } from './verify'

/** Holds the flow a unit runs, with the record and checkout it was chosen from and whether that made it a child unit. */
interface UnitFlow { flow: FlowDefinition; unit: Unit; git: GitState | null; isChild: boolean }

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
  const located = await readUnitFlow(port, session)
  if (!located) return null
  const { flow: definition, unit, git } = located
  // A child's remembered conclusion is checked against its slice end, which only its slice read gives.
  const held = session.unit && !located.isChild ? sessionMemory.concluded.get(unitMemoryKey(session.unit, unit))?.pullRequest : undefined
  /**
   * Completes the located evidence with the declared unit's step states.
   * @param evidence - The observed unit evidence.
   * @returns The fully resolved position.
   */
  const finish = (evidence: Evidence): Position => withStates({ ...evidence, flow: definition, unit }, session)
  const empty: Evidence = { git: null, slice: null, verify: { fact: '', isVerified: false, isReached: false }, checks: 'off', isConcluded: true }
  if (held) return finish({ ...empty, pullRequest: held })
  const slice = git && session.unit ? await readUnitSlice(port, session.unit, unit, git, session.flow === 'close-out') : null
  const judged = located.isChild && git && session.unit && unit.baseBranch
    ? await judgeChild(port, session.unit, unit, unit.baseBranch, git, slice, isLocal, isForced) : null
  const candidates = judged ? judged.candidates : git && session.unit ? await readCandidates(port, session.unit.branch, isLocal, isForced) : null
  const conclusion = judged ? judged.conclusion : candidates && session.unit && git
    ? candidates.isOk ? await readConclusion(port, session.unit, unit, candidates.value, git.base, false, deliverableEnd(slice)) : candidates : null
  if (conclusion?.isOk && conclusion.value) return finish({ ...empty, pullRequest: conclusion.value })
  const verify = await readVerifyState(port, slice, unit)
  // why: Only a Close out's PR closes the children's issues; any other unit needs no more than whether the branch is an integration branch.
  const children = git && session.unit && !located.isChild
    ? await readBranchChildren(port, session.unit.branch, git, { isLocal, isForced, isUntilIntegrated: session.flow !== 'close-out' }) : null
  const childUnits = children?.isOk ? children.value.map(({ entry: _entry, ...child }) => child) : undefined
  const issues = session.flow === 'trivial' ? [] : listRequiredIssues(session.flow, session.issues, childUnits ?? [])
  const delivery = !candidates || !git ? { checks: 'off' as const, isConcluded: false, prFact: 'GitHub unreachable', prFactCode: 'github-unreachable' as const }
    // why: A Close out whose children cannot be read could require fewer issues than its round delivers, so its PR step waits for the read.
    : session.flow === 'close-out' && children && !children.isOk
      ? { checks: 'off' as const, isConcluded: false, prFact: `children unreadable: ${children.error}`, prFactCode: 'github-unreachable' as const }
      : await readDelivery(port, slice, issues, issue => describeMissingIssue(session.flow, session.issues, issue, childUnits ?? []), unit,
        conclusion && !conclusion.isOk ? conclusion : candidates, isLocal, isForced)
  const integration = judged?.integration && session.unit ? await guideMerge(port, judged.integration, session.unit.branch) : undefined
  return finish({ git, slice, verify, ...delivery, ...(integration ? { integration } : {}), ...(childUnits ? { children: childUnits } : {}) })
}

/**
 * Reads the steps the session's unit runs: its declared flow, with Integrate in place of PR for a child unit.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @returns The unit's flow, its record and the checkout, or null with no flow declared.
 */
export async function readUnitFlow(port: EnginePort, session: Session): Promise<UnitFlow | null> {
  const definition = findFlow(session.flow)
  if (!definition) return null
  const unit = session.unit ? await readUnit(port, session.unit) : createEmptyUnit()
  const git = await readGit(port)
  const isChild = isChildUnit(unit, git?.base, session.flow === 'close-out')
  return { flow: resolveUnitFlow(definition, isChild), unit, git, isChild }
}
