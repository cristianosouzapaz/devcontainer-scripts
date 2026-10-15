import type { GitState } from '../lib/git'
import type { CiState } from './ci-blocker'
import type { FlowDefinition, Step } from './flow-definitions'
import type { PullRequest, Session, Unit } from './records'

/** Names where a step stands for the session's unit. */
type StepStatus = 'done' | 'current' | 'pending' | 'skipped' | 'override'

/** Holds a sub-step of a step and where it stands, judged as a step is. */
export interface SubStepState {
  label: string
  state: StepStatus
  /** The user's command that completes the sub-step, if it is theirs. */
  hint?: string
  isStale: boolean
}

/** Holds a step of the declared flow and where it stands. */
export interface StepState {
  step: Step
  state: StepStatus
  /** Whether the step's stored evidence exists but no longer holds: a verify run, a commit or a PR head that the tree has moved past. */
  isStale: boolean
  /** The step's sub-steps, in order; only a worktree step (Diagnose) has any. */
  subSteps?: SubStepState[]
  /** Set on the current Code step when the unit's worktree is the only thing holding it back. */
  isHeldByWorktree?: boolean
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

/** Names a verify run, or a run in the worktree, in flight on the current tree. */
export type RunInFlight = DirectRunInFlight | BackgroundRunInFlight | HerdrRunInFlight

/** Names where a red file stands in the main checkout: identical to its fingerprint, not yet there, or changed since. */
export type RedFileState = 'transferred' | 'pending' | 'stale'

/**
 * Holds the worktree the unit recorded: its name, the commit its HEAD is at (null when it cannot be read), whether the
 * session works in it and whether it still exists, as a listed worktree or a branch that is left.
 */
export interface WorktreeState {
  name: string
  head: string | null
  isEntered: boolean
  isPresent: boolean
}

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
  /** Whether the unit changed a file since its start, in its commits or in the working tree, or up to its anchor while that holds. */
  isCodeChanged: boolean
  /** The verify command and whether a run of it passed on the current tree. */
  verify: VerifyState
  /** Set while the unit's anchor holds: Commit and the PR are then judged on the anchor, not on the live checkout. */
  anchored: AnchoredEvidence | null
  /** The CI state of the unit's PR; the PR step is done only when it is passing or off. */
  checks: CiState
  /** The worktree the unit recorded, or null when it recorded none. */
  worktree: WorktreeState | null
  /** Where each red file stands in the main checkout, or in the subject commit off the unit's branch; empty while the unit has no red. */
  redFiles: Record<string, RedFileState>
  /** The unit's branch while the checkout is elsewhere and the unit is judged on that branch's commit; null otherwise. */
  judgedOn: string | null
  /** Whether, off the unit's branch, that branch is gone and no confirmed PR head or anchor of it is here, so its state cannot be read. */
  isSubjectUnknown: boolean
}

/** Holds where the session's unit stands in its flow, with the checkout, the Verify state and the CI state of its PR it was judged on. */
export interface Position extends Evidence {
  flow: FlowDefinition
  unit: Unit
  states: StepState[]
  current: StepState | null
  /** A run in the worktree in flight before the green, if any. */
  worktreeRun: RunInFlight | null
}

/** The user's command that approves the diagnosis comment. */
const approvalHint = 'run /flow approve diagnose'

/**
 * Tells whether the user approved the unit's latest diagnosis comment: the approval is bound to a comment id, so a newer comment leaves it behind.
 *
 * @param unit - The unit.
 * @returns True when a diagnosis comment is on record and the approval names it.
 */
export const isApproved = (unit: Unit): boolean => !!unit.diagnosis && unit.approval === unit.diagnosis

/**
 * Tells whether Diagnose's Red and Green are settled: the red's command passed in the worktree, or the user overrode the step,
 * which skips them alone. The diagnosis comment counts only from here on.
 *
 * @param step - The worktree step.
 * @param unit - The unit.
 * @returns True once the green is on record or the step is overridden.
 */
export const isRedGreenSettled = (step: Step, unit: Unit): boolean =>
  (!!unit.red && unit.green === unit.red.command) || unit.overrides.some(override => override.step === step.id)

/**
 * Finds a flow's worktree step.
 *
 * @param flow - The flow.
 * @returns Diagnose, if the flow has it.
 */
export const findDiagnoseStep = (flow: FlowDefinition): Step | undefined => flow.steps.find(step => step.isInWorktree)

/**
 * Tells whether the checkout is on its default branch.
 *
 * @param git - The checkout, or null outside a repository.
 * @returns True on the default branch.
 */
export const isOnBase = (git: GitState | null): boolean => !!git && git.branch === git.base

/**
 * Names the checkout's branch when a unit may record it as its own: never the default branch, nor a detached HEAD, which git names `HEAD`.
 *
 * @param git - The checkout, or null outside a repository.
 * @returns The branch, or undefined when there is none to record.
 */
export const findRecordableBranch = (git: GitState | null): string | undefined =>
  git && !isOnBase(git) && git.branch !== 'HEAD' ? git.branch : undefined

/**
 * Names a step as the pane and the instruction show it: the PR step says what it does to the unit's open PR, or names the one the unit created.
 *
 * @param step - The step.
 * @param pullRequest - The unit's PR on record, if any.
 * @returns The step's label.
 */
export function formatStepLabel(step: Step, pullRequest: PullRequest | undefined): string {
  if (step.observe === 'pr.created' && pullRequest?.state === 'CLOSED') return `${step.label} #${pullRequest.number} closed`
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
 * Tells whether the session's unit has reached its end: its PR merged, or every step done and a PR on record, or, with no flow, a PR created here.
 *
 * @param session - The session.
 * @param position - The unit's position, or null with no flow declared.
 * @returns True once the unit is finished.
 */
export const isUnitFinished = (session: Session, position: Position | null): boolean =>
  position ? position.unit.pr?.state === 'MERGED' || (!position.current && (session.prCreated || !!position.unit.pr)) : session.prCreated

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
 * A worktree step (Diagnose) is done once its green (a passing run of the red's command after the red) or its override has
 * a valid diagnosis comment, and the user approved that comment; an override skips its Red and Green alone. A red file changed
 * in the main checkout since it was proved reopens the step with Red and Green stale, the diagnosis and its approval kept (a red of another command drops them).
 * Code is done on a change handed to Verify: a passing or in-flight verify run on the current tree, an overridden Verify, or a done Commit.
 * In a flow with Diagnose it also needs every red file in the main checkout as proved and the unit's worktree and its branch gone.
 * While a subject commit stands (the unit's holding anchor, or its branch's commit off that branch), Commit is done by the unit's
 * commits up to it and never stale, and the PR is done once its head contains it. A merged PR is done; a closed one never is.
 * Every state carries a stale marker when the step's stored evidence exists but no longer holds; steps that rest on GitHub alone never lapse.
 *
 * @param flow - The declared flow.
 * @param session - The session, which holds the declared issues as last read from GitHub.
 * @param unit - The unit.
 * @param evidence - What the checkout, the verify runs and CI show now.
 * @returns The flow's steps with their states; Verify is left out when the repository has no verify command.
 */
export function resolveStepStates(flow: FlowDefinition, session: Session, unit: Unit, evidence: Evidence): StepState[] {
  const { git, ownCommits, isCodeChanged, verify, checks, anchored, redFiles, worktree } = evidence
  const steps = flow.steps.filter(step => step.observe !== 'verify.passed' || verify.command)
  const isCommitted = !!git && !git.isDirty && ownCommits > 0
  const isCiGreen = checks === 'off' || checks === 'passing'
  const declared = session.issues.map(number => session.info[number])
  const isCommitDone = anchored ? ownCommits > 0 : isCommitted
  // Code ↔ Verify is a loop: a change counts as Code only once it is handed to Verify. A later PR does not count, since its head
  // can match HEAD on a dirty tree; without a verify command nothing marks the hand-off, so the change alone counts.
  const isHandedOff = !verify.command || verify.isVerified || !!verify.running || isCommitDone ||
    unit.overrides.some(override => steps.some(step => step.id === override.step && step.observe === 'verify.passed'))

  // A red file changed in the main checkout since it was proved reopens Diagnose's Red and Green, unless the step is overridden.
  const isRedStale = (step: Step): boolean => Object.values(redFiles).includes('stale') && !unit.overrides.some(override => override.step === step.id)
  // In a flow with Diagnose, Code also needs every red file in the main checkout as proved, and the worktree and its branch gone;
  // an overridden Diagnose has no red to hold Code to.
  const isRedTransferred = Object.values(redFiles).every(state => state === 'transferred')
  const isRedGate = steps.some(step => step.isInWorktree && !unit.overrides.some(override => override.step === step.id))
  const isWorkTransferred = isCodeChanged && isHandedOff && (!isRedGate || isRedTransferred)

  const isDone = (step: Step): boolean => {
    if (step.isInWorktree) return isRedGreenSettled(step, unit) && isApproved(unit) && !isRedStale(step)
    if (step.doneLabels) {
      const doneLabels = step.doneLabels
      return declared.some(info => !!info?.labels.some(label => doneLabels.includes(label)))
    }
    if (step.observe === 'sub-issues') return declared.some(info => (info?.subIssues ?? 0) > 0)
    if (step.isUnlocking) return isWorkTransferred && !worktree?.isPresent
    if (step.observe === 'verify.passed') return verify.isVerified
    if (step.observe === 'commit') return isCommitDone
    // A merged PR ends the unit; a closed one never counts, whatever its head.
    if (step.observe === 'pr.created') {
      return unit.pr?.state === 'MERGED' || (unit.pr?.state !== 'CLOSED' && isCiGreen && (anchored ? anchored.isPullRequestContained : isPullRequestDone(unit, git)))
    }
    // The mod sees a skill start, never its end: a talk step (Grill) is done once the next step's skill has started.
    const next = steps.slice(steps.indexOf(step) + 1).find(later => later.skill)
    return !!next?.skill && unit.skills.includes(next.skill)
  }
  const isLapsed = (step: Step): boolean => {
    if (step.observe === 'verify.passed') return !!unit.verify && !verify.isVerified
    if (step.observe === 'commit') return !anchored && ownCommits > 0 && !!git?.isDirty
    if (anchored && step.observe === 'pr.created') return !!unit.prHead && !anchored.isPullRequestContained
    return isPullRequestStale(step, unit, git)
  }
  // A step before the last done issue-producing step was passed over by the issue's labels, not run.
  const producedIndex = steps.findLastIndex(step => !!step.doneLabels && isDone(step))
  // Null marks a step still open: the first open one is current, the rest pending.
  const settled = steps.map((step, index): StepStatus | null => {
    // An override of the worktree step (Diagnose) skips its Red and Green only: its diagnosis and approval stay required.
    if (!step.isInWorktree && unit.overrides.some(override => override.step === step.id)) return 'override'
    // Done wins over skipped: /to-spec itself applies ready-for-agent, and its steps did run.
    if (isDone(step)) return 'done'
    if (index < producedIndex) return 'skipped'
    if (step.isOptional && (!step.skill || !unit.skills.includes(step.skill) || steps.slice(index + 1).some(isDone))) return 'skipped'
    return null
  })
  const currentIndex = settled.indexOf(null)
  return steps.map((step, index): StepState => {
    const state = settled[index] ?? (index === currentIndex ? 'current' : 'pending')
    return {
      step, state, isStale: isLapsed(step),
      ...(step.isInWorktree ? { subSteps: resolveDiagnoseSubSteps(step, unit, isRedStale(step)) } : {}),
      ...(step.isUnlocking && state === 'current' && isWorkTransferred && worktree?.isPresent ? { isHeldByWorktree: true } : {}),
    }
  })
}

/**
 * Decides where Diagnose's sub-steps stand: Red once a failing run in the worktree is on record, Green once the same
 * command passed there after it, Diagnosis once a valid diagnosis comment is on record, Approval once the user approved
 * that comment; the first one not done is current. An override of Diagnose overrides Red and Green only. While a red file is
 * stale, Red is current and Green pending, both stale, whatever is recorded; the diagnosis and the approval keep their state, which a new red of another command has already cleared.
 *
 * @param step - The worktree step.
 * @param unit - The unit.
 * @param isRedStale - Whether a red file changed in the main checkout since it was proved.
 * @returns Red, Green, Diagnosis and Approval, in order.
 */
function resolveDiagnoseSubSteps(step: Step, unit: Unit, isRedStale: boolean): SubStepState[] {
  const isOverridden = unit.overrides.some(override => override.step === step.id)
  const done = [isOverridden || !!unit.red, isRedGreenSettled(step, unit), !!unit.diagnosis, isApproved(unit)]
  const current = isRedStale ? 0 : done.indexOf(false)
  return ['Red', 'Green', 'Diagnosis', 'Approval'].map((label, index) => ({
    label,
    state: isRedStale && index < 2 ? (index === 0 ? 'current' : 'pending') : isOverridden && index < 2 ? 'override' : done[index] ? 'done' : index === current ? 'current' : 'pending',
    ...(label === 'Approval' ? { hint: approvalHint } : {}),
    isStale: isRedStale && index < 2,
  }))
}
