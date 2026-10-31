import type { ApprovedRed, FlowStepState, IssueComment, IssueRead, RunRecord } from '../../types'
import type { GitState } from '../lib/git'
import type { CiState } from './ci-blocker'
import { describeAuditBlocker } from './issue-audit'
import type { AuditBlocker } from './issue-audit'
import { hasDiagnoseStep, isDeliveryStep } from './flow-definitions'
import type { FlowDefinition, Step } from './flow-definitions'
import { findEarliestRed } from './records'
import type { Identity, IssueInfo, PullRequest, Session, Unit } from './records'
import { facts } from './facts'

/** Selects an action independently of the displayed fact's wording. */
type FactCode = 'verify-config-missing' | 'verify-not-run' | 'github-unreachable' | 'ci-unreadable' | 'push-required' | 'pr-ambiguous' | 'base-mismatch'
  | 'child-end-unknown' | 'child-unmerged' | AuditBlocker['factCode']

/** Holds a step of the declared flow and where it stands. */
interface StepStateFields {
  step: Step
  /** The pane's wording, at most `maxFactLength` characters. */
  fact?: string
  /** The full wording, for `/flow status` and the agent, when the fact names its subject briefly. */
  detail?: string
  factCode?: FactCode
  need?: DiagnoseNeed
  /** The user-only `/flow` command the current step waits on, offered as the prompt suggestion. */
  command?: string
  isError: boolean
  isWaitingApproval: boolean
}

interface SkippedStepState extends StepStateFields { state: 'skipped'; reason: string | undefined }
interface ActiveStepState extends StepStateFields { state: Exclude<FlowStepState, 'skipped'> }
/** Holds a step and the facts permitted by its resolved state. */
export type StepState = SkippedStepState | ActiveStepState

/** Holds the Verify fact and whether selected commands passed on the current slice. */
interface VerifyState {
  fact?: string
  detail?: string
  factCode?: FactCode
  command?: string
  isError?: boolean
  isWaitingApproval?: boolean
  isVerified: boolean
  /** Whether the change has reached Verify, which ends Code: a run of any outcome exists on the current tree and base, or the config keeps Verify from running. */
  isReached: boolean
  /** This session's place in the repository's Verify queue, such as `queued, 2nd of 3`, while it waits for another session's Verify. */
  queued?: string
  /** The run that decides Verify, as `<run id> in <unit>`, named by /flow status. */
  run?: string
}

/** Holds whether a GitHub-judged step is done and the first fact that prevents it. */
type IssueJudgement = IssueDone | IssuePending
interface IssueJudgementFlags { isError?: boolean; isWaitingApproval?: boolean }
interface IssueDone extends IssueJudgementFlags { done: true; fact?: never; detail?: never }
interface IssuePending extends IssueJudgementFlags { done: false; fact?: string; detail?: string }

interface DiagnosePending extends IssuePending {
  need: DiagnoseNeed
  command?: string
}

/** Names the first unmet Diagnose requirement independently of its wording. */
export type DiagnoseNeed = 'red' | 'issue' | 'comments' | 'comment' | 'approval'

/** Holds a done Diagnose with the creation time of its approved comment; a concluded unit has none. */
interface DiagnoseDone extends IssueDone { approvedAt?: number }

/** Keeps agent requirements separate from the pane's short facts. */
type DiagnoseJudgement = DiagnoseDone | DiagnosePending

/** Names the steps whose state comes entirely from declared issue facts. */
type IssueStepId = 'grill' | 'spec' | 'triage' | 'map' | 'tickets'
interface IssueStepIdentity { id: IssueStepId }
type IssueStep = Step & IssueStepIdentity

/** Holds why an issue step is not complete, with a fact only off the normal path. */
type IssueProblem = Omit<IssuePending, 'done' | 'isWaitingApproval'>

/** The branch slice and content used to judge Code and Commit. */
export interface UnitSlice {
  base: string | null
  end: string
  tree: string | null
  baseTree: string | null
  commits: number
  isClean: boolean
  isFrozen: boolean
  isRewritten: boolean
  isShared: boolean
}

interface CodeSlice extends UnitSlice { tree: string }

/** Holds whether Integrate is done and the fact it shows off the normal path. */
interface IntegrateJudgement { done: boolean; fact?: string; detail?: string }

/** Holds the parent branch every Integrate fact is judged against: the unit's cached base branch. */
interface IntegrationParent { parent: string }

/** Holds an integrated child: its slice has a commit and its end is reachable from the parent's local tip or fetched origin copy. */
interface Integrated extends IntegrationParent {
  state: 'integrated'
  /** An open PR from the parent into the default branch whose head contains the slice end. */
  parentPullRequest?: number
}

/** Holds a child not integrated yet, as its judgement finds it. */
interface Pending extends IntegrationParent {
  state: 'pending'
  /** An open PR from the child into the parent, which only enriches the merge guidance. */
  childPullRequest?: number
}

/** Holds a child not integrated yet, with the merge that integrates it. */
interface NotIntegrated extends Pending {
  /** The user's merge of the child into its parent, resolved from where the parent is checked out. */
  command: string
}

/** Holds a child whose local branch is gone with no single observed slice end, so it is never integrated, stranded or concluded. */
interface EndUnknown extends IntegrationParent { state: 'unknown-end'; branch: string; end: UnknownEndKind }

/** Holds a child whose local branch is gone at an observed slice end the parent does not reach: no merge can name the branch until it is restored. */
interface DeletedUnmerged extends IntegrationParent {
  state: 'deleted-unmerged'
  branch: string
  end: string
  /** The user's `git branch` command that restores the branch at its observed end. */
  command: string
}

/** Holds an integrated child whose parent was delivered to the default branch without its slice end, while no open parent PR carries it. */
interface Stranded extends IntegrationParent {
  state: 'stranded'
  /** The latest merged parent PR, cut after the child, whose head lacks the slice end. */
  pullRequest: number
}

/** Holds an integrated child that a merged parent PR into the default branch carries, while its own conclusion could not be read. */
interface Delivered extends IntegrationParent {
  state: 'delivered'
  /** The merged parent PR whose head contains the slice end. */
  pullRequest: number
}

/** Holds the facts that judge a child unit's Integrate step, read afresh at each judgement. */
export type Integration = Integrated | NotIntegrated | EndUnknown | DeletedUnmerged | Stranded | Delivered

/** Holds a child unit's integration as judged, before any merge guidance is written for it. */
export type ChildIntegration = Integrated | Pending | EndUnknown | DeletedUnmerged | Stranded | Delivered

/** Holds where a child unit stands with its parent branch: its Integrate state, or concluded. */
type ChildState = Exclude<ChildIntegration['state'], 'delivered'> | 'concluded'

/** Holds why a child's slice end is unknown: no session observed it, or the observations diverge. */
export type UnknownEndKind = 'never-observed' | 'ambiguous'

/** Holds a child unit of the unit's branch whose slice end is known, and where it stands. */
interface KnownEndChild { identity: Identity; state: Exclude<ChildState, 'unknown-end' | 'deleted-unmerged'> }

/** Holds a child unit of the unit's branch whose slice end is unknown, with its issues still open. */
interface UnknownEndChild { identity: Identity; state: 'unknown-end'; end: UnknownEndKind; openIssues: number[] }

/** Holds a child unit of the unit's branch deleted at an observed end the branch does not reach, with its issues still open. */
interface DeletedUnmergedChild { identity: Identity; state: 'deleted-unmerged'; command: string; openIssues: number[] }

/** Holds a child unit of the unit's branch and where it stands. */
export type ChildUnit = KnownEndChild | UnknownEndChild | DeletedUnmergedChild

/** Holds what the step states are judged on, beyond the unit's record: observed evidence, read afresh at each judgement. */
export interface Evidence {
  /** The checkout, or null outside a repository. */
  git: GitState | null
  /** The declared unit's slice, independent of the checkout. */
  slice: UnitSlice | null
  /** The Verify fact and result recomputed for the current slice. */
  verify: VerifyState
  /** The CI state read on the slice end SHA. */
  checks: CiState
  pullRequest?: PullRequest
  prFact?: string
  /** The PR fact's full wording, when the fact names its subject briefly. */
  prDetail?: string
  prFactCode?: FactCode
  /** The Integrate facts, present only for a child unit. */
  integration?: Integration
  /**
   * The child units of the unit's branch, absent when they could not be read or the unit is a child itself; a unit
   * other than a Close out reads them only up to the first integrated one.
   */
  children?: ChildUnit[]
  isConcluded: boolean
}

/** Holds where the session's unit stands in its flow, with the checkout, the Verify state and the CI state of its PR it was judged on. */
export interface Position extends Evidence {
  flow: FlowDefinition
  unit: Unit
  states: StepState[]
  current: StepState | null
}

/** Holds a PR step fact and the code that selects its action. */
export type DeliveryFact = Pick<Evidence, 'prFact' | 'prDetail' | 'prFactCode'>

/** The legend entry a step is drawn with. */
export type StepMarkKind = FlowStepState | 'failed' | 'rewritten' | 'waitingApproval'

/** How a step reads on every surface: its legend entry, and the marks that decide its color and fact. */
interface StepMark {
  mark: StepMarkKind
  isMerged: boolean
  isFailed: boolean
  isRunUnrecorded: boolean
  isRewritten: boolean
}

/**
 * Tells whether the checkout is on its default branch.
 *
 * @param git - The checkout, or null outside a repository.
 * @returns True on the default branch.
 */
export const isOnBase = (git: GitState | null): boolean => !!git && git.branch === git.base

/**
 * Tells whether the declared unit belongs to the default branch, regardless of the checkout.
 * @param identity - The declared unit, if any.
 * @param git - The checkout's repository and default branch.
 * @returns True when the unit's branch is the default branch.
 */
export const isUnitOnBase = (identity: Identity | null | undefined, git: GitState | null): boolean => !!git && identity?.branch === git.base

/**
 * Tells whether a unit is a child unit: its cached base branch is a parent branch other than the default branch, and it
 * is no Close out, whose own PR delivers its branch whatever that PR's base.
 * @param unit - The unit's record.
 * @param defaultBranch - The default branch, unknown outside a repository.
 * @param isCloseOut - Whether the unit is declared as a Close out.
 * @returns True for a child unit.
 */
export const isChildUnit = (unit: Pick<Unit, 'baseBranch'>, defaultBranch: string | undefined, isCloseOut: boolean): boolean =>
  !isCloseOut && !!defaultBranch && !!unit.baseBranch && unit.baseBranch !== defaultBranch

/**
 * Names why a child's own Integrate cannot be judged: no retry changes a never-observed end, while an ambiguous one is
 * decided once the parent branch reaches one of the observed ends.
 * @param end - Why the slice end is unknown.
 * @returns The fact.
 */
export const describeUnknownEnd = (end: UnknownEndKind): string => end === 'ambiguous' ? facts.endAmbiguous : facts.endNeverObserved

/**
 * Judges a child unit's Integrate step: done once the unit is integrated into its parent branch, by SHA ancestry, and not stranded.
 * @param integration - The Integrate facts, absent when they could not be read.
 * @returns Completion and the step's fact: where the integrated slice is delivered from, or why it is not integrated.
 */
function judgeIntegrate(integration: Integration | undefined): IntegrateJudgement {
  if (!integration) return { done: false, fact: facts.integrationUnreadable }
  const { parent } = integration
  if (integration.state === 'integrated') {
    return integration.parentPullRequest ? { done: true, fact: facts.inParentPr(integration.parentPullRequest) } : { done: true, fact: facts.awaitingParentPr, detail: `awaiting ${parent}'s PR` }
  }
  if (integration.state === 'delivered') return { done: true, fact: facts.mergedPr(integration.pullRequest) }
  if (integration.state === 'unknown-end') return { done: false, fact: describeUnknownEnd(integration.end) }
  if (integration.state === 'deleted-unmerged') {
    return { done: false, fact: facts.restoreBranch, detail: `branch ${integration.branch} deleted unmerged at ${integration.end} — restore it with ${integration.command}` }
  }
  if (integration.state === 'stranded') {
    return { done: false, fact: facts.strandedPr(integration.pullRequest), detail: `parent PR #${integration.pullRequest} merged without this unit's commits — deliver it with another PR` }
  }
  // Not yet in the parent is Integrate's normal state: the Merge note carries the command.
  return { done: false }
}

/**
 * Recomputes a position after its session facts change.
 * @param position - The unit and evidence to judge.
 * @param session - The current session facts.
 * @returns The position with freshly resolved states and current step.
 */
export function withStates(position: Omit<Position, 'states' | 'current'>, session: Session): Position {
  const states = resolveStepStates(position.flow, session, position.unit, position)
  return { ...position, states, current: states.find(state => state.state === 'current') ?? null }
}

/**
 * Names a step as the pane and the instruction show it: the PR step names its open or merged PR.
 *
 * @param step - The step.
 * @param pullRequest - The unit's PR read from GitHub, if any.
 * @returns The step's label.
 */
export function formatStepLabel(step: Step, pullRequest: PullRequest | undefined): string {
  return step.observe !== 'pr.created' || !pullRequest || pullRequest.state === 'CLOSED' ? step.label : `PR #${pullRequest.number}`
}

/**
 * Tells whether the unit's current step is its PR step, held back only by a PR whose CI has not passed.
 *
 * @param position - The unit's position.
 * @returns True while the PR step waits on CI.
 */
export const isCiWait = (position: Position): boolean =>
  position.current?.step.observe === 'pr.created' && position.checks !== 'off' && position.checks !== 'passing'

/**
 * Tells whether the unit concluded, or has no current step and either an open PR or, for a child unit, an integrated slice that is not stranded.
 *
 * @param position - The unit's position, or null with no flow declared.
 * @returns True once the unit is finished.
 */
export const isUnitFinished = (position: Position | null): boolean =>
  !!position && (position.isConcluded || (!position.current && (position.pullRequest?.state === 'OPEN' || isIntegrateDone(position.integration))))

/**
 * Tells whether a step's error is a failure: only a Verify run or a delivery fails, while any other step's error is
 * an unreadable fact it still waits on.
 * @param entry - The step's resolved state.
 * @returns Whether the current step failed.
 */
const isStepFailed = (entry: StepState): boolean =>
  entry.isError && entry.state === 'current' && (entry.step.observe === 'verify.passed' || isDeliveryStep(entry.step))

/**
 * Marks a step for every surface that draws one. Rewritten history wins over everything, then a merged delivery,
 * then a failure, then a wait on the user's approval, then the step's state; a Verify run that changed the tree
 * is no failure of the current tree, so it leaves the step in progress.
 * @param entry - The step's displayed state.
 * @param position - The unit's position.
 * @param isTreeChanged - Whether the last Verify run changed the tree and so left no record.
 * @returns The step's legend entry and marks.
 */
export function markStep(entry: StepState, position: Position, isTreeChanged: boolean): StepMark {
  const isRewritten = !!position.slice?.isRewritten
  const isCurrent = entry.state === 'current'
  // The unrecorded run explains Code only while Code waits on a Verify run; any other Code blocker, an approval included, stays shown.
  const isRunUnrecorded = isTreeChanged && !isRewritten && isCurrent && !entry.isWaitingApproval && (entry.step.id === 'verify' || entry.factCode === 'verify-not-run')
  const isMerged = !isRewritten && position.isConcluded && isDeliveryStep(entry.step) && !!position.pullRequest
  const isFailed = !isRewritten && !isRunUnrecorded && isStepFailed(entry)
  return {
    mark: isRewritten ? 'rewritten' : isMerged ? 'done' : isFailed ? 'failed' : isCurrent && entry.isWaitingApproval ? 'waitingApproval' : entry.state,
    isMerged, isFailed, isRunUnrecorded, isRewritten,
  }
}

/**
 * Tells whether a child's Integrate facts show it integrated: awaiting or in its parent's PR, or carried by a merged one.
 * @param integration - The Integrate facts, absent for a unit that is no child or when they could not be read.
 * @returns True for an integrated child that is not stranded.
 */
const isIntegrateDone = (integration: Integration | undefined): boolean => integration?.state === 'integrated' || integration?.state === 'delivered'

/**
 * Projects the states for display: a done step after the current step shows as pending, because no later step has been reached
 * and its fact may describe an earlier slice. Guidance and judgements read the real states, never this projection.
 *
 * @param states - The unit's resolved step states.
 * @returns The states to render, with skipped steps and every step up to the current one unchanged.
 */
export function projectDisplayStates(states: StepState[]): StepState[] {
  const currentIndex = states.findIndex(entry => entry.state === 'current')
  return states.map((entry, index): StepState => {
    if (currentIndex < 0 || index <= currentIndex || entry.state !== 'done') return entry
    const { fact: _fact, factCode: _factCode, ...rest } = entry
    return { ...rest, state: 'pending' }
  })
}

/**
 * Lists the labels of the session's first declared issue, the one the pane shows, as last read from GitHub.
 *
 * @param session - The session.
 * @returns The first issue's labels, or none.
 */
export const listDeclaredLabels = (session: Session): string[] => {
  const info = session.issues[0] === undefined ? undefined : session.info[session.issues[0]]
  return info && 'labels' in info ? info.labels : []
}

/**
 * Judges every declared issue, stopping at its first unmet condition.
 * @param declared - The declared issues as last read from GitHub.
 * @param judge - The condition each readable issue must satisfy.
 * @returns Completion or the first missing fact or unmet condition.
 */
const judgeIssues = (declared: (IssueInfo | undefined)[], judge: (info: IssueRead) => IssueProblem | undefined): IssueJudgement => {
  if (!declared.length) return { done: false }
  for (const info of declared) {
    if (!info) return { done: false, fact: facts.issueFactsUnavailable, isError: true }
    if ('error' in info) return { done: false, fact: facts.issueUnreadable, detail: info.error, isError: true }
    const problem = judge(info)
    if (problem) return { done: false, ...problem }
  }
  return { done: true }
}

/**
 * Tells whether a step's id is judged from declared issue facts.
 * @param step - The flow step to classify.
 * @returns Whether the step depends on declared issue facts.
 */
const isIssueStep = (step: Step): step is IssueStep => ['grill', 'spec', 'triage', 'map', 'tickets'].includes(step.id)

/**
 * Judges an issue-driven step from the facts already read from GitHub.
 * @param id - The issue-driven step to judge.
 * @param declared - The declared issues as last read from GitHub.
 * @returns Completion or the first fact preventing the step from completing.
 */
const judgeIssueStep = (id: IssueStepId, declared: (IssueInfo | undefined)[]): IssueJudgement => {
  // Spec and Grill both wait on the readiness label.
  const spec = (): IssueJudgement => judgeIssues(declared, info => info.labels.includes('ready-for-agent') ? undefined : {})
  if (id === 'grill' || id === 'spec') return spec()
  if (id === 'triage') return judgeIssues(declared, info => {
    if (info.labels.includes('ready-for-agent') || info.labels.includes('ready-for-human')) return undefined
    return info.labels.includes('needs-info') ? { fact: facts.needsInfo } : info.labels.includes('wontfix') ? { fact: facts.wontfix } : {}
  })
  if (id === 'map') return judgeIssues(declared, info => {
    if (!info.labels.includes('wayfinder:map')) return {}
    if (info.subIssues && !Array.isArray(info.subIssues)) return { fact: facts.subIssuesUnreadable, detail: info.subIssues.error, isError: true }
    const mapped = (info.subIssues ?? []).filter(subIssue => subIssue.labels.some(label => label.startsWith('wayfinder:')))
    return mapped.length && mapped.every(subIssue => subIssue.state === 'closed') ? undefined : {}
  })
  return judgeIssues(declared, info => {
    if (info.subIssues && !Array.isArray(info.subIssues)) return { fact: facts.subIssuesUnreadable, detail: info.subIssues.error, isError: true }
    return info.subIssues?.some(subIssue => subIssue.labels.includes('ready-for-agent')) ? undefined : {}
  })
}

/**
 * Decides where each step stands from its stored evidence, issue labels and the live checkout.
 * Done wins over explicit skips; optional steps are skipped whenever they are not done.
 *
 * @param flow - The declared flow.
 * @param session - The session, which holds the declared issues as last read from GitHub.
 * @param unit - The unit.
 * @param evidence - What the checkout, the verify runs and CI show now.
 * @returns The flow's steps with their states; Verify is always present.
 */
export function resolveStepStates(flow: FlowDefinition, session: Session, unit: Unit, evidence: Evidence): StepState[] {
  const { git, slice, verify, checks } = evidence
  const steps = flow.steps
  const hasSlice = !!slice && !slice.isRewritten
  const isOnDefault = isUnitOnBase(session.unit, git)
  const isCodeChanged = hasCodeChange(slice)
  const isCommitDone = hasSlice && slice.commits > 0 && slice.isClean
  const isCiGreen = checks === 'passing'
  const diagnose: DiagnoseJudgement = evidence.isConcluded ? { done: true } : judgeDiagnose(unit, session.issues, session.info)
  const isFixJudged = isCodeJudgedByFix(flow, unit)
  const hasFixGreen = diagnose.done && diagnose.approvedAt !== undefined && !!findFixGreen(unit.runs, diagnose.approvedAt, unit.approvedRed)
  const isCodeWritten = isCodeChanged && (!isFixJudged || hasFixGreen)
  const declared = session.issues.map(number => session.info[number])
  const issueJudgements: Map<Step, IssueJudgement> = new Map(steps.filter(isIssueStep).map(step => [step, judgeIssueStep(step.id, declared)]))
  const integrate = judgeIntegrate(evidence.integration)
  // why: Integrate facts with no slice come from a deleted child branch: an observed end stands for the work before
  // Integrate, while an unknown end proves none of it, so those steps are set aside rather than done.
  const isBranchGone = !slice && !!evidence.integration
  const isEndUnknown = isBranchGone && evidence.integration?.state === 'unknown-end'
  // A session's non-compliant issues hold its delivery back, since nothing else catches a write that bypassed the issue tools.
  const auditBlocker = describeAuditBlocker(session.audit?.result)

  const isDone = (step: Step): boolean => {
    if (evidence.isConcluded) return true
    if (isBranchGone && !isEndUnknown && step.observe !== 'integrated') return true
    if (step.isInWorktree) return diagnose.done
    if (isIssueStep(step)) return issueJudgements.get(step)?.done ?? false
    if (step.isUnlocking) return isCodeWritten && verify.isReached
    if (step.observe === 'verify.passed') return isCodeChanged && verify.isVerified
    if (step.observe === 'commit') return isCommitDone
    // Only a qualifying open PR can complete delivery before conclusion.
    if (step.observe === 'pr.created') {
      return evidence.pullRequest?.state === 'OPEN' && isCiGreen && !auditBlocker
    }
    if (step.observe === 'integrated') return integrate.done
    return false
  }
  const settled = steps.map((step): FlowStepState | null => {
    if (isDone(step)) return 'done'
    if (unit.skips?.some(skip => skip.step === step.id) || step.isOptional || (isEndUnknown && step.observe !== 'integrated')) return 'skipped'
    return null
  })
  const currentIndex = settled.indexOf(null)
  const mergedFact = evidence.pullRequest ? facts.mergedPr(evidence.pullRequest.number) : facts.merged
  return steps.map((step, index): StepState => {
    const state = settled[index] ?? (index === currentIndex ? 'current' : 'pending')
    const judgement = isIssueStep(step) ? issueJudgements.get(step) : undefined
    const shared = {
      step,
      isError: !!(isIssueStep(step) ? judgement?.isError : step.isInWorktree ? diagnose.isError
        : step.observe === 'verify.passed' ? verify.isError : step.observe === 'pr.created' ? checks === 'failing' || !!auditBlocker : step.observe === 'integrated' && evidence.integration?.state === 'stranded'),
      isWaitingApproval: step.observe === 'verify.passed' ? verify.isWaitingApproval === true : !!step.isInWorktree && diagnose.isWaitingApproval === true,
      ...(state === 'current' && isIssueStep(step) ? { fact: judgement?.fact, detail: judgement?.detail } : {}),
      ...((step.isUnlocking || step.observe === 'commit') && !isBranchGone ? { fact: isOnDefault ? facts.redeclareOnBranch
        : !slice ? facts.redeclareSliceUnavailable
        : step.isUnlocking ? (isCodeWritten ? describeMissingVerify(unit, slice) : undefined)
        : slice.commits === 0 ? undefined : facts.uncommitted } : {}),
      ...(step.isUnlocking && !isOnDefault && isCodeWritten && !verify.isReached ? { factCode: 'verify-not-run' as const } : {}),
      ...(step.observe === 'verify.passed' ? { fact: verify.fact, detail: verify.detail, factCode: verify.factCode } : {}),
      ...(state === 'current' && step.observe === 'verify.passed' && verify.command ? { command: verify.command } : {}),
      ...(step.observe === 'pr.created' ? evidence.isConcluded ? { fact: mergedFact, factCode: evidence.prFactCode }
        : auditBlocker ?? { fact: evidence.prFact, detail: evidence.prDetail, factCode: evidence.prFactCode } : {}),
      ...(step.observe === 'integrated' ? evidence.isConcluded ? { fact: mergedFact } : { fact: integrate.fact, detail: integrate.detail } : {}),
      ...(step.isInWorktree ? { fact: diagnose.fact, detail: diagnose.detail, ...(!diagnose.done ? { need: diagnose.need } : {}) } : {}),
      ...(state === 'current' && step.isInWorktree && !diagnose.done && diagnose.command ? { command: diagnose.command } : {}),
    }
    if (state === 'skipped') {
      const unread = step.isOptional && judgement?.isError ? judgement : undefined
      const chosen = unit.skips?.find(skip => skip.step === step.id)?.reason ?? (isEndUnknown && step.observe !== 'integrated' ? facts.branchDeleted : undefined)
      // A skipped step's detail words its reason, never the step's own fact.
      const { detail: _detail, ...rest } = shared
      return { ...rest, state, reason: chosen ?? unread?.fact, ...(!chosen && unread?.detail ? { detail: unread.detail } : {}) }
    }
    return { ...shared, state }
  })
}

/**
 * Tells whether Code waits for the approved fix to pass: the flow has a Diagnose step and the unit has not skipped it.
 * @param flow - The declared flow.
 * @param unit - The unit and its skips.
 * @returns True when Code needs a fix green besides a change.
 */
export const isCodeJudgedByFix = (flow: FlowDefinition, unit: Pick<Unit, 'skips'>): boolean =>
  hasDiagnoseStep(flow) && !unit.skips?.some(skip => skip.step === 'diagnose')

/**
 * Finds the latest pass after a time of a red's argv on different content: the approval's pinned red when given, otherwise
 * any earlier failing run, for an approval with no pinned red.
 * @param runs - The unit's command history.
 * @param after - The time the pass must come strictly after.
 * @param pinned - The red the approval was granted on, if recorded.
 * @returns The matching pass, if any.
 */
export function findFixGreen(runs: RunRecord[], after: number, pinned?: ApprovedRed): RunRecord | undefined {
  const reds = pinned ? [pinned] : runs.filter(run => run.outcome.kind !== 'pass')
  return [...runs].sort((a, b) => b.at - a.at).find(green => green.outcome.kind === 'pass' && green.at > after && reds.some(red =>
    red.at < green.at && red.tree !== green.tree && JSON.stringify(red.argv) === JSON.stringify(green.argv)))
}

/**
 * Judges Diagnose from the approval's pinned red, or else the command history, against live issue comments and the user's approval.
 * @param unit - The unit's runs, approval and pinned red.
 * @param issues - The declared issues.
 * @param info - Their current GitHub facts.
 * @returns Completion, with the approved comment's creation time, or the first unmet condition; a wait for approval carries the command that approves the newest comment.
 */
export function judgeDiagnose(unit: Pick<Unit, 'runs' | 'approval' | 'approvedRed'>, issues: number[], info: Record<string, IssueInfo>): DiagnoseJudgement {
  const red = (unit.approval && unit.approvedRed) || findEarliestRed(unit.runs)
  if (!red) return { done: false, need: 'red' }
  if (!issues.length) return { done: false, need: 'issue' }
  const comments: IssueComment[] = []
  for (const number of issues) {
    const issue = info[number]
    if (!issue || 'error' in issue) return { done: false, need: 'comments', fact: issue ? facts.issueUnreadable : facts.issueFactsUnavailable, ...(issue ? { detail: issue.error } : {}) }
    if (!issue.comments || !Array.isArray(issue.comments)) return { done: false, need: 'comments', fact: facts.issueCommentsUnavailable, ...(issue.comments ? { detail: issue.comments.error } : {}) }
    comments.push(...issue.comments)
  }
  if (unit.approval && !comments.some(comment => comment.url === unit.approval)) return { done: false, need: 'comment', fact: facts.approvedCommentDeleted }
  const after = comments.filter(comment => Date.parse(comment.createdAt) > red.at)
  if (!after.length) return { done: false, need: 'comment' }
  const approved = after.find(comment => comment.url === unit.approval)
  if (!approved) {
    const newest = after.reduce((latest, comment) => Date.parse(comment.createdAt) >= Date.parse(latest.createdAt) ? comment : latest)
    return { done: false, need: 'approval', fact: facts.waitingForApproval, isWaitingApproval: true, command: `/flow approve ${newest.url}` }
  }
  return { done: true, approvedAt: Date.parse(approved.createdAt) }
}

/**
 * Identifies an available, unrevised slice with content different from its base.
 * @param slice - The current unit slice, or null when unavailable.
 * @returns Whether the slice has a code change and a usable tree.
 */
export const hasCodeChange = (slice: UnitSlice | null): slice is CodeSlice => !!slice && !slice.isRewritten && !!slice.tree && (slice.base === null || (!!slice.baseTree && slice.tree !== slice.baseTree))

/**
 * Names why a written change still lacks a Verify run on its tree and base, from the unit's newest Verify record.
 * @param unit - The unit, whose Verify records are newest first.
 * @param slice - The current unit slice.
 * @returns The Code fact naming what the change went back from, none before its first Verify run; shown only while no record matches the slice's tree and base.
 */
function describeMissingVerify(unit: Pick<Unit, 'verifyRuns'>, slice: UnitSlice): string | undefined {
  const latest = unit.verifyRuns[0]
  if (!latest) return undefined
  return latest.tree === slice.tree ? facts.verifyBaseMoved : latest.outcome.kind === 'pass' ? facts.verifyChangedAfterPass : facts.verifyTreeChanged
}
