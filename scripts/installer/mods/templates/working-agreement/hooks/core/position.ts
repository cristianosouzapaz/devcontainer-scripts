import type { CiState } from '../domain/ci-blocker'
import { flowDefinitions } from '../domain/flow-definitions'
import { mergeUnits } from '../domain/records'
import type { Session, Unit } from '../domain/records'
import { resolveStepStates } from '../domain/step-states'
import type { Evidence, Position, StepState, WorktreeState } from '../domain/step-states'
import { hasBranch, isWorktreeListed, readBaseRef, readCommit, readWorktreeHead } from '../lib/git'
import type { GitState } from '../lib/git'
import { unwrapOr } from '../lib/result'
import { findHoldingAnchor } from './anchor'
import type { EnginePort } from './engine-port'
import { listUnitKeys, readUnit } from './record-store'
import { readRedFiles } from './red-files'
import { countCommitsAhead, hasChanges, hasCommittedChanges, isCommitAncestor, readCommitTreeKey, readContinuousIntegration, readGit, readPullRequestChecks, readWorkingTreeKey } from './repository'
import { findRunInFlight, hasRunsInFlight, lapseBackgroundRuns } from './runs-in-flight'
import { sessionMemory } from './session-memory'
import { readVerifyCommand } from './verify-config'

/** Holds what a unit is judged on: the commit standing in for the live checkout (null for the checkout itself), and the evidence fields it sets. */
interface Subject extends Pick<Evidence, 'judgedOn' | 'isSubjectUnknown'> { commit: string | null }

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
  // While a subject commit stands, the unit's commits, Code, Verify, PR and red files are judged on it, not on the live checkout.
  const { commit: anchor, judgedOn, isSubjectUnknown } = await findSubject(port, session, unit, git)
  const isVerified = !!verifyCommand && !!tree && unit.verify === tree
  // Commits before the unit's start belong to earlier work on the branch; a unit with no start (Close out) owns them all.
  const liveCommits = !git ? 0 : unit.start ? await countCommitsAhead(port, unit.start) : git.ahead
  const baseRef = git && anchor && !unit.start && judgedOn ? await readBaseRef(port.processes) : null
  const ownCommits = !git || !anchor ? liveCommits : unit.start ? await countCommitsAhead(port, unit.start, anchor)
    : judgedOn ? (baseRef ? await countCommitsAhead(port, baseRef, anchor) : 0) : git.ahead - (await countCommitsAhead(port, anchor))
  const running = isVerified ? null : findRunInFlight(tree, 'verify')
  const worktreeRun = findRunInFlight(tree, 'worktree')
  const isAnchorVerified = !!anchor && !!verifyCommand && !!unit.verify && unit.verify === await readCommitTreeKey(port, anchor)
  const verify = { command: verifyCommand, isVerified: anchor ? isAnchorVerified : isVerified, running }
  // A unit with no start owns every commit ahead of base, which the diff against HEAD does not see.
  const hasCodeStep = definition.steps.some(step => step.isUnlocking)
  const isCodeChanged = !!git && hasCodeStep && (
    (!unit.start && ownCommits > 0) ||
    (anchor && unit.start ? await hasCommittedChanges(port, git.root, unit.start, anchor) : !anchor && await hasChanges(port, git.root, unit.start)))
  const anchored = anchor ? { isPullRequestContained: !!unit.prHead && await isCommitAncestor(port, anchor, unit.prHead) } : null
  const worktree = await readWorktreeState(port, unit)
  const redFiles = git ? await readRedFiles(port, unit, git.root, anchor && unit.branch !== git.branch ? anchor : null) : {}
  const evidence: Evidence = { git, ownCommits, isCodeChanged, verify, anchored, checks: 'off', worktree, redFiles, judgedOn, isSubjectUnknown }
  const unchecked = resolveStepStates(definition, session, unit, evidence)
  const checks = await readStepChecks(port, unchecked, unit, git)
  const states = checks === 'off' ? unchecked : resolveStepStates(definition, session, unit, { ...evidence, checks })
  return { ...evidence, checks, flow: definition, unit, states, current: states.find(state => state.state === 'current') ?? null, worktreeRun }
}

// The commit the unit is judged on instead of the live checkout, and the branch it is judged on while the checkout is elsewhere.
// A merged PR is judged on its last confirmed head; on the unit's own branch, the holding anchor; elsewhere, the branch's tip,
// or once that branch is gone, the confirmed PR head or the anchor. With none of them here the state is unknown: the unit is
// judged on its start, so nothing of another branch counts for it. A null commit leaves the unit on the live checkout.
async function findSubject(port: EnginePort, session: Session, unit: Unit, git: GitState | null): Promise<Subject> {
  const isMerged = unit.pr?.state === 'MERGED'
  if (!git || (!isMerged && (!unit.branch || unit.branch === git.branch))) {
    return { commit: await findHoldingAnchor(port, session, unit, git), judgedOn: null, isSubjectUnknown: false }
  }
  const tip = !isMerged && unit.branch ? await readCommit(port.processes, `refs/heads/${unit.branch}`) : null
  const recorded = tip ?? (unit.prHead ? await readCommit(port.processes, unit.prHead) : null) ?? (unit.anchor ? await readCommit(port.processes, unit.anchor) : null)
  if (isMerged) return { commit: recorded, judgedOn: null, isSubjectUnknown: false }
  return { commit: recorded ?? unit.start ?? null, judgedOn: unit.branch ?? null, isSubjectUnknown: !recorded }
}

// The worktree the unit recorded, with its HEAD, whether the session works in it and whether it still exists; null when it
// recorded none. It exists while git lists it or its branch is left, and a git that cannot answer counts as existing.
async function readWorktreeState(port: EnginePort, unit: Unit): Promise<WorktreeState | null> {
  if (!unit.worktree) return null
  const { name, path } = unit.worktree
  const cwd = await port.readCwd()
  const isPresent = unwrapOr(await isWorktreeListed(port.processes, path), true) || unwrapOr(await hasBranch(port.processes, `worktree-${name}`), true)
  return { name, head: unwrapOr(await readWorktreeHead(port.processes, path), null), isEntered: cwd === path || cwd.startsWith(`${path}/`), isPresent }
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
