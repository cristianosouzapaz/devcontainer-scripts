import { pluralize } from './messages'

/**
 * Every fact a step shows after its dot, in one vocabulary: lowercase, no trailing period, the state only: the step's
 * label names the subject and its mark says whose turn it is. A template takes only bounded values, such as a PR or issue number; a branch, path, command or GitHub error
 * goes in the step's `detail`, which `/flow status` and the agent read. A step whose next move is the unit's own on the normal
 * path has no fact; every fact here names a move that belongs to someone else or a unit off that path, as the step-states
 * wiki page's table lists.
 */
export const facts = {
  // Grill, Spec, Triage, Map, Tickets
  issueFactsUnavailable: 'issue facts unavailable',
  issueUnreadable: 'issue unreadable',
  subIssuesUnreadable: 'sub-issues unreadable',
  needsInfo: 'needs-info',
  wontfix: 'wontfix',
  // Diagnose
  issueCommentsUnavailable: 'issue comments unavailable',
  approvedCommentDeleted: 'approved comment deleted',
  waitingForApproval: 'waiting for /flow approve',
  // Code and Commit
  redeclareOnBranch: "re-declare on the unit's branch",
  redeclareSliceUnavailable: 're-declare: slice unavailable',
  verifyBaseMoved: 'parent branch moved',
  verifyTreeChanged: 'changed after Verify failed',
  verifyChangedAfterPass: 'changed after Verify',
  verifyTreeChangedInRun: 'code changed during Verify',
  uncommitted: 'uncommitted changes',
  // Verify
  verifyConfigMissing: 'no verify command configured',
  verifyConfigInvalid: 'config invalid — see /flow status',
  guardsOverridable: 'guards overridable — see /flow status',
  verifyConfigApproval: '/flow approve verify',
  verifyNotRun: 'not run',
  verifyPassed: 'passed',
  verifyPassedElsewhere: 'passed in another unit',
  verifyPassedIn: (issue: number): string => `passed in #${issue}`,
  leftToCi: 'no local check selected — left to CI',
  verifyTimedOut: (minutes: number): string => `timed out after ${minutes} min`,
  verifyFailedExit: (code: number): string => `failed, exit ${code}`,
  verifyFailedSignal: 'failed, killed by a signal',
  verifyFailed: 'failed',
  // PR
  merged: 'merged',
  mergedPr: (pr: number): string => `merged #${pr}`,
  githubUnreachable: 'GitHub unreachable',
  closeExtraPrs: 'close all open PRs but one',
  pushRequired: 'last commit not pushed',
  retargetPr: 'wrong base',
  addCloses: (issue: number): string => `missing Closes #${issue}`,
  settleChildDeleted: (issue: number): string => `settle child #${issue}: branch deleted`,
  settleChildEndUnknown: (issue: number): string => `settle child #${issue}: end unknown`,
  childUnitsUnreadable: 'child units unreadable',
  ciUnreadable: 'CI unreadable',
  ciFailing: 'CI failing',
  ciPending: 'CI pending',
  ciRequiredMissing: 'CI pending: required check missing',
  ciNoChecks: 'CI: no checks reported',
  fixIssues: (count: number): string => `fix ${pluralize(count, 'issue')} with issue_edit`,
  auditPending: 'issue audit pending',
  // Integrate
  integrationUnreadable: 'integration unreadable',
  inParentPr: (pr: number): string => `in PR #${pr}`,
  awaitingParentPr: "awaiting the parent's PR",
  endAmbiguous: 'branch deleted, end ambiguous',
  endNeverObserved: 'branch deleted, end never observed',
  restoreBranch: 'restore the branch: deleted unmerged',
  strandedPr: (pr: number): string => `open a PR: #${pr} merged without it`,
  // Delegation
  coordinatorGone: 'coordinator session gone',
  coordinatorUnknown: 'coordinator liveness unknown',
  // Skipped
  branchDeleted: 'branch deleted',
} as const
