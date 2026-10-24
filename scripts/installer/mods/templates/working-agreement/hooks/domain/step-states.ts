import type { FlowStepState, IssueComment, IssueRead, RunRecord } from '../../types'
import type { GitState } from '../lib/git'
import type { CiState } from './ci-blocker'
import { hasDiagnoseStep } from './flow-definitions'
import type { FlowDefinition, Step } from './flow-definitions'
import type { Identity, IssueInfo, PullRequest, Session, Unit } from './records'

/** Selects an action independently of the displayed fact's wording. */
type FactCode = 'verify-config-missing' | 'github-unreachable' | 'ci-unreadable' | 'push-required'

/** Holds a step of the declared flow and where it stands. */
interface StepStateFields {
  step: Step
  fact?: string
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
  fact: string
  factCode?: FactCode
  command?: string
  isError?: boolean
  isWaitingApproval?: boolean
  isVerified: boolean
}

/** Holds whether a GitHub-judged step is done and the first fact that prevents it. */
type IssueJudgement = IssueDone | IssuePending
interface IssueJudgementFlags { isError?: boolean; isWaitingApproval?: boolean }
interface IssueDone extends IssueJudgementFlags { done: true; fact?: never }
interface IssuePending extends IssueJudgementFlags { done: false; fact: string }

interface DiagnosePending extends IssuePending {
  need: DiagnoseNeed
  command?: string
}

/** Names the first unmet Diagnose requirement independently of its wording. */
export type DiagnoseNeed = 'red' | 'issue' | 'comments' | 'comment' | 'approval'

/** Holds a done Diagnose with the creation time of its approved comment; a concluded unit has none. */
interface DiagnoseDone extends IssueDone { approvedAt?: number }

/** Keeps agent requirements separate from the pane's short facts. */
export type DiagnoseJudgement = DiagnoseDone | DiagnosePending

/** Names the steps whose state comes entirely from declared issue facts. */
type IssueStepId = 'grill' | 'spec' | 'triage' | 'map' | 'tickets'
interface IssueStepIdentity { id: IssueStepId }
type IssueStep = Step & IssueStepIdentity

/** Holds a fact that prevents an issue step completing. */
interface IssueProblem { fact: string; isError?: boolean }

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
  prFactCode?: FactCode
  isConcluded: boolean
}

/** Holds where the session's unit stands in its flow, with the checkout, the Verify state and the CI state of its PR it was judged on. */
export interface Position extends Evidence {
  flow: FlowDefinition
  unit: Unit
  states: StepState[]
  current: StepState | null
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
 * Names a step as the pane and the instruction show it: the PR step names its PR, and says what it does to an open PR only while current.
 *
 * @param step - The step.
 * @param pullRequest - The unit's PR read from GitHub, if any.
 * @param isCurrent - Whether the step is the unit's current step.
 * @returns The step's label.
 */
export function formatStepLabel(step: Step, pullRequest: PullRequest | undefined, isCurrent: boolean): string {
  if (step.observe !== 'pr.created' || !pullRequest || pullRequest.state === 'CLOSED') return step.label
  if (!isCurrent || pullRequest.state === 'MERGED') return `PR #${pullRequest.number}`
  return step.skill ? `Update PR #${pullRequest.number}` : `Push to PR #${pullRequest.number}`
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
 * Tells whether the unit concluded or every step is done with an open PR.
 *
 * @param position - The unit's position, or null with no flow declared.
 * @returns True once the unit is finished.
 */
export const isUnitFinished = (position: Position | null): boolean =>
  !!position && (position.isConcluded || (!position.current && position.pullRequest?.state === 'OPEN'))

/**
 * Lists the labels of the session's declared issues, as last read from GitHub.
 *
 * @param session - The session.
 * @returns Every declared issue's labels, in issue order.
 */
export const listDeclaredLabels = (session: Session): string[] => session.issues.flatMap(number => {
  const info = session.info[number]
  return info && 'labels' in info ? info.labels : []
})

/**
 * Judges every declared issue, stopping at its first unmet condition.
 * @param declared - The declared issues as last read from GitHub.
 * @param judge - The condition each readable issue must satisfy.
 * @returns Completion or the first missing fact or unmet condition.
 */
const judgeIssues = (declared: (IssueInfo | undefined)[], judge: (info: IssueRead) => IssueProblem | undefined): IssueJudgement => {
  if (!declared.length) return { done: false, fact: 'issue not yet created' }
  for (const info of declared) {
    if (!info) return { done: false, fact: 'issue facts unavailable', isError: true }
    if ('error' in info) return { done: false, fact: info.error, isError: true }
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
  /** Judges readiness labels for Spec and Grill. */
  const spec = (): IssueJudgement => judgeIssues(declared, info => info.labels.includes('ready-for-agent') ? undefined : { fact: 'no ready-for-agent label' })
  if (id === 'grill' || id === 'spec') return spec()
  if (id === 'triage') return judgeIssues(declared, info => {
    if (info.labels.includes('ready-for-agent') || info.labels.includes('ready-for-human')) return undefined
    return { fact: info.labels.find(label => label === 'needs-info' || label === 'wontfix') ?? 'no triage label' }
  })
  if (id === 'map') return judgeIssues(declared, info => {
    if (!info.labels.includes('wayfinder:map')) return { fact: 'no wayfinder:map label' }
    if (info.subIssues && !Array.isArray(info.subIssues)) return { fact: info.subIssues.error, isError: true }
    const mapped = (info.subIssues ?? []).filter(subIssue => subIssue.labels.some(label => label.startsWith('wayfinder:')))
    if (!mapped.length) return { fact: 'no wayfinder:* sub-issue' }
    const open = mapped.filter(subIssue => subIssue.state !== 'closed').length
    return open ? { fact: `${open} wayfinder:* sub-issue${open === 1 ? '' : 's'} open` } : undefined
  })
  return judgeIssues(declared, info => {
    if (info.subIssues && !Array.isArray(info.subIssues)) return { fact: info.subIssues.error, isError: true }
    return info.subIssues?.some(subIssue => subIssue.labels.includes('ready-for-agent')) ? undefined : { fact: 'no ready-for-agent sub-issue' }
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
  const hasFixGreen = diagnose.done && diagnose.approvedAt !== undefined && !!findFixGreen(unit.runs, diagnose.approvedAt)
  const declared = session.issues.map(number => session.info[number])
  const issueJudgements: Map<Step, IssueJudgement> = new Map(steps.filter(isIssueStep).map(step => [step, judgeIssueStep(step.id, declared)]))

  const isDone = (step: Step): boolean => {
    if (evidence.isConcluded) return true
    if (step.isInWorktree) return diagnose.done
    if (isIssueStep(step)) return issueJudgements.get(step)?.done ?? false
    if (step.isUnlocking) return isCodeChanged && (!isFixJudged || hasFixGreen)
    if (step.observe === 'verify.passed') return isCodeChanged && verify.isVerified
    if (step.observe === 'commit') return isCommitDone
    // Only a qualifying open PR can complete delivery before conclusion.
    if (step.observe === 'pr.created') {
      return evidence.pullRequest?.state === 'OPEN' && isCiGreen
    }
    return false
  }
  const settled = steps.map((step): FlowStepState | null => {
    if (isDone(step)) return 'done'
    if (unit.skips?.some(skip => skip.step === step.id) || step.isOptional) return 'skipped'
    return null
  })
  const currentIndex = settled.indexOf(null)
  return steps.map((step, index): StepState => {
    const state = settled[index] ?? (index === currentIndex ? 'current' : 'pending')
    const shared = {
      step,
      isError: !!(isIssueStep(step) ? issueJudgements.get(step)?.isError : step.isInWorktree ? diagnose.isError
        : step.observe === 'verify.passed' ? verify.isError : step.observe === 'pr.created' && checks === 'failing'),
      isWaitingApproval: step.observe === 'verify.passed' ? verify.isWaitingApproval === true : !!step.isInWorktree && diagnose.isWaitingApproval === true,
      ...(state === 'current' && isIssueStep(step) ? { fact: issueJudgements.get(step)?.fact } : {}),
      ...(step.isUnlocking || step.observe === 'commit' ? { fact: isOnDefault ? "check out the unit's branch and re-declare"
        : !slice ? 'slice unavailable — re-declare'
        : step.isUnlocking ? (isCodeChanged ? 'no green after the approval' : 'no change from the base') : slice.commits === 0 ? 'no commit in the slice' : 'uncommitted changes' } : {}),
      ...(step.observe === 'verify.passed' ? { fact: verify.fact, factCode: verify.factCode } : {}),
      ...(state === 'current' && step.observe === 'verify.passed' && verify.command ? { command: verify.command } : {}),
      ...(step.observe === 'pr.created' ? { fact: evidence.isConcluded ? `merged #${evidence.pullRequest?.number}` : evidence.prFact ?? 'no PR', factCode: evidence.prFactCode } : {}),
      ...(step.isInWorktree ? { fact: diagnose.fact, ...(!diagnose.done ? { need: diagnose.need } : {}) } : {}),
      ...(state === 'current' && step.isInWorktree && !diagnose.done && diagnose.command ? { command: diagnose.command } : {}),
    }
    if (state === 'skipped') {
      const reason = unit.skips?.find(skip => skip.step === step.id)?.reason
        ?? (step.isOptional && isIssueStep(step) && issueJudgements.get(step)?.isError ? issueJudgements.get(step)?.fact : 'optional')
      return { ...shared, state, reason }
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
 * Finds the earliest failing run, the reference Diagnose measures its comment against.
 * @param runs - The unit's command history.
 * @returns The earliest failing run, if any.
 */
export const findEarliestRed = (runs: RunRecord[]): RunRecord | undefined =>
  runs.filter(run => run.outcome.kind !== 'pass').sort((a, b) => a.at - b.at)[0]

/**
 * Finds the latest pass after a time with an earlier failing run of the same argv on different content.
 * @param runs - The unit's command history.
 * @param after - The time the pass must come strictly after.
 * @returns The matching pass, if any.
 */
export function findFixGreen(runs: RunRecord[], after: number): RunRecord | undefined {
  return [...runs].sort((a, b) => b.at - a.at).find(green => green.outcome.kind === 'pass' && green.at > after && runs.some(red =>
    red.outcome.kind !== 'pass' && red.at < green.at && red.tree !== green.tree && JSON.stringify(red.argv) === JSON.stringify(green.argv)))
}

/**
 * Judges Diagnose from command history, live issue comments and the user's approval.
 * @param unit - The unit's runs and approval.
 * @param issues - The declared issues.
 * @param info - Their current GitHub facts.
 * @returns Completion, with the approved comment's creation time, or the first unmet condition; a wait for approval carries the command that approves the newest comment.
 */
export function judgeDiagnose(unit: Pick<Unit, 'runs' | 'approval'>, issues: number[], info: Record<string, IssueInfo>): DiagnoseJudgement {
  const red = findEarliestRed(unit.runs)
  if (!red) return { done: false, need: 'red', fact: 'no red run' }
  if (!issues.length) return { done: false, need: 'issue', fact: 'issue not yet created' }
  const comments: IssueComment[] = []
  for (const number of issues) {
    const issue = info[number]
    if (!issue || 'error' in issue) return { done: false, need: 'comments', fact: issue && 'error' in issue ? issue.error : 'issue facts unavailable' }
    if (!issue.comments || !Array.isArray(issue.comments)) return { done: false, need: 'comments', fact: issue.comments?.error ?? 'issue comments unavailable' }
    comments.push(...issue.comments)
  }
  if (unit.approval && !comments.some(comment => comment.url === unit.approval)) return { done: false, need: 'comment', fact: 'approved comment deleted' }
  const after = comments.filter(comment => Date.parse(comment.createdAt) > red.at)
  if (!after.length) return { done: false, need: 'comment', fact: 'no comment after the red' }
  const approved = after.find(comment => comment.url === unit.approval)
  if (!approved) {
    const newest = after.reduce((latest, comment) => Date.parse(comment.createdAt) >= Date.parse(latest.createdAt) ? comment : latest)
    return { done: false, need: 'approval', fact: 'waiting for /flow approve <url>', isWaitingApproval: true, command: `/flow approve ${newest.url}` }
  }
  return { done: true, approvedAt: Date.parse(approved.createdAt) }
}

/**
 * Identifies an available, unrevised slice with content different from its base.
 * @param slice - The current unit slice, or null when unavailable.
 * @returns Whether the slice has a code change and a usable tree.
 */
export const hasCodeChange = (slice: UnitSlice | null): slice is CodeSlice => !!slice && !slice.isRewritten && !!slice.tree && (slice.base === null || (!!slice.baseTree && slice.tree !== slice.baseTree))
