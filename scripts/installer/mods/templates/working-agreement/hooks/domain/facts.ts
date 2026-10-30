import { pluralize } from './messages'

/**
 * Every fact a step shows after its dot, in one vocabulary: lowercase, no trailing period, the state only: the step's
 * label names the subject and its mark says whose turn it is. A template takes only bounded values, such as a PR or issue number; a branch, path, command or GitHub error
 * goes in the step's `detail`, which `/flow status` and the agent read.
 */
export const facts = {
  // Grill, Spec, Triage, Map, Tickets
  issueNotCreated: 'issue not yet created',
  issueFactsUnavailable: 'issue facts unavailable',
  issueUnreadable: 'issue unreadable',
  subIssuesUnreadable: 'sub-issues unreadable',
  noReadyLabel: 'no ready-for-agent label',
  noTriageLabel: 'no triage label',
  needsInfo: 'needs-info',
  wontfix: 'wontfix',
  noMapLabel: 'no wayfinder:map label',
  noMappedSubIssue: 'no wayfinder:* sub-issue',
  openMappedSubIssues: (count: number): string => `${pluralize(count, 'wayfinder:* sub-issue')} open`,
  noReadySubIssue: 'no ready-for-agent sub-issue',
  // Diagnose
  noRedRun: 'no red run yet',
  issueCommentsUnavailable: 'issue comments unavailable',
  approvedCommentDeleted: 'approved comment deleted',
  noCommentAfterRed: 'no comment after the red',
  waitingForApproval: 'waiting for /flow approve',
  // Code and Commit
  redeclareOnBranch: "re-declare on the unit's branch",
  redeclareSliceUnavailable: 're-declare: slice unavailable',
  noChange: 'no change from the base',
  noFixGreen: 'run the fix: no green since approval',
  verifyNoRun: 'no run yet',
  verifyBaseMoved: 'base moved',
  verifyTreeChanged: 'tree changed',
  verifyChangedAfterPass: 'changed after Verify',
  verifyTreeChangedInRun: 'tree changed in the run',
  nothingCommitted: 'nothing yet',
  uncommitted: 'uncommitted changes',
  // Verify
  verifyConfigMissing: 'no verify command configured',
  verifyConfigInvalid: 'config invalid — see /flow status',
  guardsOverridable: 'guards overridable — see /flow status',
  verifyConfigApproval: '/flow approve verify',
  verifyNotRun: 'not run on this tree',
  verifyPassed: 'passed',
  verifyPassedElsewhere: 'passed (run in another unit)',
  verifyPassedIn: (issue: number): string => `passed (run in #${issue})`,
  leftToCi: 'no local check selected — left to CI',
  verifyTimedOut: (minutes: number): string => `timed out after ${minutes} min`,
  verifyFailedExit: (code: number): string => `failed, exit ${code}`,
  verifyFailedSignal: 'failed, killed by a signal',
  verifyFailed: 'failed',
  // PR
  noPr: 'no PR',
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
  mergeChildPr: (pr: number): string => `merge PR #${pr} into the parent`,
  mergeIntoParent: 'merge into the parent branch',
  // Delegation
  coordinatorGone: 'coordinator session gone',
  coordinatorUnknown: 'coordinator liveness unknown',
  // Skipped
  optional: 'optional',
  branchDeleted: 'branch deleted',
} as const
