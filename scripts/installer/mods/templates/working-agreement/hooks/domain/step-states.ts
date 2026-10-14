import type { GitState } from '../lib/git'
import type { CiState } from './ci-blocker'
import type { FlowDefinition, Step } from './flow-definitions'
import type { PullRequest, Session, Unit } from './records'

/** Names where a step stands for the session's unit. */
type StepStatus = 'done' | 'current' | 'pending' | 'skipped' | 'override'

/** Holds a step of the declared flow and where it stands. */
export interface StepState {
  step: Step
  state: StepStatus
  /** Whether the step's stored evidence exists but no longer holds: a verify run, a red, a commit or a PR head that the tree has moved past. */
  isStale: boolean
}

/** Holds the repository's verify command, if it has one, and whether a run of it passed on the current tree. */
interface VerifyState {
  command: string | undefined
  isVerified: boolean
  running: RunInFlight | null
}

/** Marks a run in flight in a Bash call that has not returned. */
interface DirectRunInFlight {
  kind: 'direct'
}

/** Marks a run whose Bash call moved to the background, which reports through its task notification. */
interface BackgroundRunInFlight {
  kind: 'background'
}

/** Marks a run launched in a herdr pane, which reports through that pane. */
interface HerdrRunInFlight {
  kind: 'herdr'
  pane: string
}

/** Names a verify or test run in flight on the current tree. */
export type RunInFlight = DirectRunInFlight | BackgroundRunInFlight | HerdrRunInFlight

/** Names whether the reproduction test has been seen failing on unfixed code: never, and still unchanged since, or changed since. */
export type RedState = 'none' | 'holds' | 'stale'

/** Holds what a holding anchor adds to the evidence. */
interface AnchoredEvidence {
  /** Whether the unit's confirmed PR head contains the anchor. */
  isPullRequestContained: boolean
}

/** Holds what the step states are judged on, beyond the unit's record: observed evidence, read afresh at each judgement. */
export interface Evidence {
  /** The checkout, or null outside a repository. */
  git: GitState | null
  /** How many commits the unit made since its start, or up to its anchor while that holds; every commit ahead of base for a unit with no start. */
  ownCommits: number
  /** Whether the unit changed a file since its start, in its commits or in the working tree, or up to its anchor while that holds; a non-test file in a flow with Diagnose, unless Diagnose is overridden. */
  isCodeChanged: boolean
  /** The verify command and whether a run of it passed on the current tree. */
  verify: VerifyState
  /** Set while the unit's anchor holds: Commit and the PR are then judged on the anchor, not on the live checkout. */
  anchored: AnchoredEvidence | null
  /** The CI state of the unit's PR; the PR step is done only when it is passing or off. */
  checks: CiState
  /** Whether the reproduction test has been seen failing on unfixed code and is unchanged since. */
  red: RedState
}

/** Holds where the session's unit stands in its flow, with the checkout, the Verify state and the CI state of its PR it was judged on. */
export interface Position extends Evidence {
  flow: FlowDefinition
  unit: Unit
  states: StepState[]
  current: StepState | null
  /** A run of the unit's tests in flight on the current tree, if any; a verify run is one too. */
  testRun: RunInFlight | null
}

/**
 * Tells whether the checkout is on its default branch.
 *
 * @param git - The checkout, or null outside a repository.
 * @returns True on the default branch.
 */
export const isOnBase = (git: GitState | null): boolean => !!git && git.branch === git.base

/**
 * Names a step as the pane and the instruction show it: the PR step says what it does to the unit's open PR, or names the one the unit created.
 *
 * @param step - The step.
 * @param pullRequest - The unit's PR on record, if any.
 * @returns The step's label.
 */
export function formatStepLabel(step: Step, pullRequest: PullRequest | undefined): string {
  if (step.observe !== 'pr.created' || pullRequest?.state !== 'OPEN') return step.label
  if (pullRequest.isCreated) return `PR #${pullRequest.number}`
  return step.skill ? `Update PR #${pullRequest.number}` : `Push to PR #${pullRequest.number}`
}

/**
 * Tells whether a step is a PR update gone stale: its last confirmed head is no longer the checkout's HEAD.
 *
 * @param step - The step.
 * @param unit - The unit.
 * @param git - The checkout, or null outside a repository.
 * @returns True for a confirmable PR step whose recorded head differs from HEAD.
 */
const isPullRequestStale = (step: Step, unit: Unit, git: GitState | null): boolean =>
  step.observe === 'pr.created' && !!unit.prHead && !!git?.head && unit.prHead !== git.head

/**
 * Tells whether the unit's current step is its PR step, held back only by a PR whose CI has not passed.
 *
 * @param position - The unit's position.
 * @returns True while the PR step waits on CI.
 */
export const isCiWait = (position: Position): boolean =>
  position.current?.step.observe === 'pr.created' && position.checks !== 'off' && position.checks !== 'passing'

/**
 * Tells whether the session's unit has reached its end: every step done and a PR on record, or, with no flow, a PR created here.
 *
 * @param session - The session.
 * @param position - The unit's position, or null with no flow declared.
 * @returns True once the unit is finished.
 */
export const isUnitFinished = (session: Session, position: Position | null): boolean =>
  position ? !position.current && (session.prCreated || !!position.unit.pr) : session.prCreated

/**
 * Finds a flow's PR step.
 *
 * @param flow - The flow.
 * @returns The step that observes the PR, if the flow has one.
 */
export const findPullRequestStep = (flow: FlowDefinition): Step | undefined => flow.steps.find(step => step.observe === 'pr.created')

/**
 * Lists the labels of the session's declared issues, as last read from GitHub.
 *
 * @param session - The session.
 * @returns Every declared issue's labels, in issue order.
 */
export const listDeclaredLabels = (session: Session): string[] => session.issues.flatMap(number => session.info[number]?.labels ?? [])

/**
 * Names the branch a unit's PR lives on: the branch the unit recorded, else the checkout's branch unless it is the default one
 * or the unit has a start and no commit past it, since a branch it has no work on carries other work's PR.
 *
 * @param unit - The unit.
 * @param git - The checkout, or null outside a repository.
 * @param ownCommits - The unit's commits past its start; ignored for a unit with no start.
 * @returns The branch, or undefined when there is none to look on.
 */
export const findPullRequestBranch = (unit: Unit, git: GitState | null, ownCommits: number): string | undefined =>
  unit.branch ?? (git && !isOnBase(git) && (!unit.start || ownCommits > 0) ? git.branch : undefined)

/**
 * Tells whether a PR step's own work is done, CI aside: GitHub, read back, reports a PR whose head is HEAD and whose body carries the step's required lines.
 *
 * @param unit - The unit.
 * @param git - The checkout, or null outside a repository.
 * @returns True once the confirmed PR head is HEAD.
 */
const isPullRequestDone = (unit: Unit, git: GitState | null): boolean => !!git?.head && unit.prHead === git.head

/**
 * Decides where each step of the unit's flow stands: done, skipped, overridden, the current one, or pending.
 * A step still open before the last done issue-producing step (Spec, Triage, Map) is skipped: the issue's labels show it was passed.
 * An optional step (Tickets) that is not done is skipped until its skill starts, and again once a later step is done.
 * A step is done only on evidence that still holds, so it falls back when that evidence lapses; a skill starting never
 * completes its own step. Grill is the one exception, since a conversation leaves no artefact: the next step's skill starting ends it.
 * Code is done on a change handed to Verify: a passing or in-flight verify run on the current tree, an overridden Verify, or a done Commit.
 * While the unit's anchor holds, Commit is done by the unit's commits up to it and never stale, and the PR is done once its head contains the anchor.
 * Every state carries a stale marker when the step's stored evidence exists but no longer holds; steps that rest on GitHub alone never lapse.
 *
 * @param flow - The declared flow.
 * @param session - The session, which holds the declared issues as last read from GitHub.
 * @param unit - The unit.
 * @param evidence - What the checkout, the verify runs and CI show now.
 * @returns The flow's steps with their states; Verify is left out when the repository has no verify command.
 */
export function resolveStepStates(flow: FlowDefinition, session: Session, unit: Unit, evidence: Evidence): StepState[] {
  const { git, ownCommits, isCodeChanged, verify, checks, red, anchored } = evidence
  const steps = flow.steps.filter(step => step.observe !== 'verify.passed' || verify.command)
  const isCommitted = !!git && !git.isDirty && ownCommits > 0
  const isGreen = checks === 'off' || checks === 'passing'
  const declared = session.issues.map(number => session.info[number])
  const isCommitDone = anchored ? ownCommits > 0 : isCommitted
  // Code ↔ Verify is a loop: a change counts as Code only once it is handed to Verify. A later PR does not count, since its head
  // can match HEAD on a dirty tree; without a verify command nothing marks the hand-off, so the change alone counts.
  const isHandedOff = !verify.command || verify.isVerified || !!verify.running || isCommitDone ||
    unit.overrides.some(override => steps.some(step => step.id === override.step && step.observe === 'verify.passed'))

  const isDone = (step: Step): boolean => {
    if (step.isTestExempt) return red === 'holds'
    if (step.doneLabels) {
      const doneLabels = step.doneLabels
      return declared.some(info => !!info?.labels.some(label => doneLabels.includes(label)))
    }
    if (step.observe === 'sub-issues') return declared.some(info => (info?.subIssues ?? 0) > 0)
    if (step.isUnlocking) return isCodeChanged && isHandedOff
    if (step.observe === 'verify.passed') return verify.isVerified
    if (step.observe === 'commit') return isCommitDone
    if (step.observe === 'pr.created') return isGreen && (anchored ? anchored.isPullRequestContained : isPullRequestDone(unit, git))
    // The mod sees a skill start, never its end: a talk step (Grill) is done once the next step's skill has started.
    const next = steps.slice(steps.indexOf(step) + 1).find(later => later.skill)
    return !!next?.skill && unit.skills.includes(next.skill)
  }
  const isLapsed = (step: Step): boolean => {
    if (step.isTestExempt) return red === 'stale'
    if (step.observe === 'verify.passed') return !!unit.verify && !verify.isVerified
    if (step.observe === 'commit') return !anchored && ownCommits > 0 && !!git?.isDirty
    if (anchored && step.observe === 'pr.created') return !!unit.prHead && !anchored.isPullRequestContained
    return isPullRequestStale(step, unit, git)
  }
  // A step before the last done issue-producing step was passed over by the issue's labels, not run.
  const producedIndex = steps.findLastIndex(step => !!step.doneLabels && isDone(step))
  // Null marks a step still open: the first open one is current, the rest pending.
  const settled = steps.map((step, index): StepStatus | null => {
    if (unit.overrides.some(override => override.step === step.id)) return 'override'
    // Done wins over skipped: /to-spec itself applies ready-for-agent, and its steps did run.
    if (isDone(step)) return 'done'
    if (index < producedIndex) return 'skipped'
    if (step.isOptional && (!step.skill || !unit.skills.includes(step.skill) || steps.slice(index + 1).some(isDone))) return 'skipped'
    return null
  })
  const currentIndex = settled.indexOf(null)
  return steps.map((step, index): StepState => ({
    step, state: settled[index] ?? (index === currentIndex ? 'current' : 'pending'), isStale: isLapsed(step),
  }))
}
