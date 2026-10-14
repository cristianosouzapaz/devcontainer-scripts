import type { CiState } from '../domain/ci-blocker'
import { flowDefinitions } from '../domain/flow-definitions'
import { mergeUnits } from '../domain/records'
import type { Session, Unit } from '../domain/records'
import { resolveStepStates } from '../domain/step-states'
import type { Evidence, Position, StepState } from '../domain/step-states'
import type { GitState } from '../lib/git'
import { findHoldingAnchor } from './anchor'
import type { EnginePort } from './engine-port'
import { listUnitKeys, readUnit } from './record-store'
import { readRedState } from './red-state'
import { countCommitsAhead, hasChanges, hasCommittedChanges, isCommitAncestor, readCommitTreeKey, readContinuousIntegration, readGit, readPullRequestChecks, readWorkingTreeKey } from './repository'
import { findRunInFlight, hasRunsInFlight, lapseBackgroundRuns } from './runs-in-flight'
import { sessionMemory } from './session-memory'
import { readVerifyCommand } from './verify-config'

/**
 * Locates the session's unit in its flow: every step's state, read from the unit's record, git, the verify runs and CI.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @returns The position, or null with no flow declared.
 */
export async function locatePosition(port: EnginePort, session: Session): Promise<Position | null> {
  const definition = session.flow ? flowDefinitions.flows[session.flow] : undefined
  if (!definition) return null
  const saved = mergeUnits(await Promise.all((await listUnitKeys(port, session)).map(key => readUnit(port, key))))
  const git = await readGit(port)
  // The default branch is never an issue's branch, so a unit that recorded it is treated as having no branch.
  const unit = git && saved.branch === git.base ? { ...saved, branch: undefined } : saved
  const verifyCommand = await readVerifyCommand(port)
  const tree = verifyCommand || hasRunsInFlight() ? await readWorkingTreeKey(port) : null
  lapseBackgroundRuns(tree)
  // While the unit's anchor holds, its commits, Code, Verify and PR are judged on the anchor, not on the live checkout.
  const anchor = await findHoldingAnchor(port, session, unit, git)
  const isVerified = !!verifyCommand && !!tree && unit.verify === tree
  // Commits before the unit's start belong to earlier work on the branch; a unit with no start (Close out) owns them all.
  const liveCommits = !git ? 0 : unit.start ? await countCommitsAhead(port, unit.start) : git.ahead
  const ownCommits = !git || !anchor ? liveCommits : unit.start ? await countCommitsAhead(port, unit.start, anchor) : git.ahead - (await countCommitsAhead(port, anchor))
  const running = isVerified ? null : findRunInFlight(tree, 'verify')
  const testRun = findRunInFlight(tree, 'test')
  const isAnchorVerified = !!anchor && !!verifyCommand && !!unit.verify && unit.verify === await readCommitTreeKey(port, anchor)
  const verify = { command: verifyCommand, isVerified: anchor ? isAnchorVerified : isVerified, running }
  const red = await readRedState(port, unit, git)
  // A unit with no start owns every commit ahead of base, which the diff against HEAD does not see. In a flow with a
  // test-exempt step (Diagnose) the reproduction test is that step's work, so only a non-test change counts as Code;
  // an overridden Diagnose lifts that, since a bug in the test harness is fixed in the test files themselves.
  const isTestExcluded = definition.steps.some(step => step.isTestExempt && !unit.overrides.some(override => override.step === step.id))
  const hasCodeStep = definition.steps.some(step => step.isUnlocking)
  const isCodeChanged = !!git && hasCodeStep && (
    (!unit.start && ownCommits > 0) ||
    (anchor && unit.start ? await hasCommittedChanges(port, git.root, unit.start, anchor, isTestExcluded) : !anchor && await hasChanges(port, git.root, unit.start, isTestExcluded)))
  const anchored = anchor ? { isPullRequestContained: !!unit.prHead && await isCommitAncestor(port, anchor, unit.prHead) } : null
  const evidence: Evidence = { git, ownCommits, isCodeChanged, verify, anchored, checks: 'off', red }
  const unchecked = resolveStepStates(definition, session, unit, evidence)
  const checks = await readStepChecks(port, unchecked, unit, git)
  const states = checks === 'off' ? unchecked : resolveStepStates(definition, session, unit, { ...evidence, checks })
  return { ...evidence, checks, flow: definition, unit, states, current: states.find(state => state.state === 'current') ?? null, testRun }
}

/**
 * Tells whether a skill counts: it started this turn, or started earlier for the unit while its step is still open,
 * since an interactive skill asks first, so its write lands in a later turn.
 *
 * @param position - The unit's position, or null with no flow declared.
 * @param skill - The skill's name.
 * @returns True when the skill counts now.
 */
export const isSkillCounted = (position: Position | null, skill: string): boolean =>
  sessionMemory.turnSkills.includes(skill) ||
  (!!position && position.unit.skills.includes(skill) && position.states.some(state => state.step.skill === skill && state.state === 'current'))

/**
 * Tells whether an issue-writing skill counts now.
 *
 * @param position - The unit's position, or null with no flow declared.
 * @returns True when one does.
 */
export const hasIssueSkill = (position: Position | null): boolean => flowDefinitions.issueSkills.some(skill => isSkillCounted(position, skill))

// The CI state that holds back a PR step whose own work is done, or off when nothing does; cached briefly, since every refresh asks.
async function readStepChecks(port: EnginePort, states: StepState[], unit: Unit, git: GitState | null): Promise<CiState> {
  const pullRequest = states.find(state => state.step.observe === 'pr.created')
  if (pullRequest?.state !== 'done' || unit.pr?.state !== 'OPEN') return 'off'
  const continuousIntegration = await readContinuousIntegration(port)
  if (!continuousIntegration.isOk) return 'unknown'
  if (!continuousIntegration.value) return 'off'
  const key = `${unit.pr.number}@${git?.head ?? ''}`
  const now = await port.now()
  const cached = sessionMemory.checksCache
  if (cached && cached.key === key && now - cached.at < 30000) return cached.checks
  const checks = await readPullRequestChecks(port, String(unit.pr.number))
  // An unreadable report is not cached, so the next refresh asks again.
  if (checks !== 'unknown') sessionMemory.checksCache = { key, at: now, checks }
  return checks
}
