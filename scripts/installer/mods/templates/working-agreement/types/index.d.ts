/** Holds the state and labels of a sub-issue that a flow follows. */
export interface SubIssueInfo {
  state: string
  labels: string[]
}
/** Holds a diagnosis comment's identity and creation time from GitHub. */
export interface IssueComment { url: string; createdAt: string }
/** Holds an issue's title, labels and required facts as last read from GitHub. */
export interface IssueRead {
  state?: string
  title: string
  labels: string[]
  subIssues?: SubIssueInfo[] | ReadFailure
  comments?: IssueComment[] | ReadFailure
}
/** Holds the error when GitHub could not read an issue. */
export interface ReadFailure { error: string }
/** Holds why the latest GitHub read failed, and when the issue facts still shown were read, null when unknown. */
export interface GithubFailure { reason: string; readAt: number | null }
/** Holds either the facts GitHub read for an issue or its read error. */
export type IssueInfo = IssueRead | ReadFailure
/** Counts the writes the session's checks refused, by kind. */
export interface Blocked {
  edits: number
}
/** Marks a handoff still under way. */
export interface HandoffRunning {
  state: 'running'
}
/** Marks a handoff that stopped before /clear, and says why. */
export interface HandoffFailed {
  state: 'failed'
  reason: string
}
/** Names where the session's handoff stands. */
export type HandoffState = HandoffRunning | HandoffFailed
/** Names whether the gh CLI can reach GitHub as a signed-in user. */
export type GithubStatus = 'connected' | 'unreachable' | 'unauth' | 'unknown'
/** Identifies a unit within a repository independently of its chat and flow. */
export interface Identity { branch: string; issues: number[] }
/** Holds a chat's contribution to a repository unit. */
export interface UnitEntry extends Unit { identity: Identity }
/** Identifies the GitHub account behind a PR action. */
export interface GithubActor { login: string }
/** Counts a PR's reviews without carrying their contents. */
export interface ReviewCount { totalCount: number }
/** Names a PR's lifecycle state as GitHub reports it. */
export type PrState = 'OPEN' | 'CLOSED' | 'MERGED'

/** Holds the scalar auto-merge request fields and the requesting actor. */
export interface AutoMergeFields {
  authorEmail: string | null
  commitBody: string | null
  commitHeadline: string | null
  enabledAt: string | null
  enabledBy: GithubActor | null
  mergeMethod: string
}
/** Holds the PR fields protected by the guarantee window. */
export interface PrFields {
  state: PrState
  closedAt: string | null
  autoMergeRequest: AutoMergeFields | null
  isInMergeQueue: boolean
  reviews: ReviewCount
}
/** Keeps the last fresh PR read in authoritative session state. */
export interface PrSnapshot { unit: Identity; number: number; fields: PrFields }
/** Holds the commits a call created outside the user's hands. */
export interface CommitFact { shas: string[] }
/** Holds the remote ref a call moved and its tips before and after. */
export interface PushFact { ref: string; before: string | null; after: string }
/** Holds a PR's protected fields before and after a call changed them. */
export interface PrFact { number: number; before: PrFields; after: PrFields }
/** Holds the default-branch checkout whose tree a call changed. */
export interface DefaultTreeFact { root: string; before: string; after: string }
/** Identifies a call whose effects the guarantees could not observe. */
export interface UncheckedFact { toolUseId: string }
/** Holds a checkout's branch as it stood when a commit was observed. */
export interface CommitCheckout { root: string; branch: string | null }
/** Reports commits a call created. */
export interface CommitViolation {
  kind: 'commit'
  fact: CommitFact
  /** Preserves checkouts at observation time without changing the shared fact identity. */
  checkouts?: CommitCheckout[]
}
/** Reports a remote ref a call moved. */
export interface PushViolation { kind: 'push'; fact: PushFact }
/** Reports PR fields a call changed. */
export interface PrViolation { kind: 'pr'; fact: PrFact }
/** Reports a default-branch checkout a call changed. */
export interface DefaultTreeViolation { kind: 'default-tree'; fact: DefaultTreeFact }
/** Reports a call the guarantees could not check. */
export interface UncheckedViolation { kind: 'unchecked'; fact: UncheckedFact }
/** Identifies an observed guarantee fact independently of its call and session. */
export type ViolationFact = CommitViolation | PushViolation | PrViolation | DefaultTreeViolation | UncheckedViolation
/** Attributes one fact to every observing call in this session. */
export interface ViolationAttribution {
  factId: string
  /** Counts unchecked calls since the previous dismissal; an absent count means one. */
  count?: number
  toolUseIds: string[]
  agentIds?: string[]
  start: number
  end: number
  sessionId: string
}
/** An observed guarantee fact together with its attribution to the session's observing calls. */
export type Violation = ViolationFact & ViolationAttribution
/** Names how strongly the pane shows a violation note. */
export type ViolationTone = 'error' | 'warn'
/** Supplies a persistent pane note and its shared dismissal identity. */
export interface ViolationNote { factId: string; text: string; tone: ViolationTone }
/** One field of an audited issue that the `issues` config does not accept. */
export interface AuditFinding { issue: number; field: string; expected: string; actual: string }
/** Every audited issue read back and met the `issues` config. */
export interface AuditCompliant { state: 'compliant' }
/** At least one audited issue misses a required field. */
export interface AuditViolations { state: 'violations'; findings: AuditFinding[] }
/** The audit could not read GitHub or the config, so it proves nothing either way. */
export interface AuditPending { state: 'pending'; reason: string }
/** Where the latest audit of the session's issues stands. */
export type AuditResult = AuditCompliant | AuditViolations | AuditPending
/** The issues the session wrote, from when its window opened, and the latest audit of them; absent before either. */
export interface IssueAudit { since: number; issues: number[]; result?: AuditResult }
/** Holds the versioned, authoritative chat record and its disk mirror. */
export interface SessionRecord {
  v: 1
  sessionId: string
  unit: Identity | null
  units: UnitEntry[]
  info: Record<string, IssueInfo>
  blocked: Blocked
  gh: GithubStatus
  isLong: boolean
  handoff?: HandoffState
  skills?: string[]
  violations?: Violation[]
  prSnapshot?: PrSnapshot
  /** Set only by the user's `/flow coordinate`: the session never writes in the repository. */
  role?: 'coordinator'
  audit?: IssueAudit
}
/**
 * Holds one coordinator's delegation scope, shared with every worktree's sessions: only the coordinator that owns it writes it,
 * and only a `/flow delegate stop` removes it: the coordinator's own, or one from any session once the coordinator is gone.
 */
export interface DelegationScope {
  v: 1
  /** The coordinator session that holds the scope; the file is named after it. */
  sessionId: string
  /** The delegated issues, ascending: the ones the user named and, while `coversCreated`, the ones the coordinator created. */
  issues: number[]
  /** Set by a `/flow delegate` without numbers: each issue the coordinator creates joins `issues`. */
  coversCreated: boolean
  /** Set when `/flow delegate` found no GitHub ruleset requiring signed commits, so an unsigned push would not be refused. */
  isPushUnguarded?: true
  /** The issues whose triage `/flow delegate triage` handed over, ascending; absent while none is. */
  triage?: number[]
  /** The free text each `/flow delegate` carried after its numbers, verbatim, in the order given; absent while none did. */
  instructions?: string[]
  /** The herdr pane the coordinator ran `/flow delegate` in, which a delegated unit's notices are sent to; absent outside herdr. */
  paneId?: string
  /** The coordinator's process, which tells a unit whether the coordinator still runs; absent where the host does not expose it. */
  host?: ScopeHost
}
/** Holds a coordinator process's identity: a pid means nothing outside its pid namespace and boot, and its start time tells a reused pid. */
export interface ScopeHost { pidns: string; pid: number; pidStart: string; bootId: string }
/** Holds the declaration shared by chats with the same identity. */
export interface UnitRecord { v: 1; identity: Identity; flow: string; generation?: string }
/** Holds the slice end of one lifetime of a child unit that one session last observed while its branch was readable. */
export interface ObservedEndRecord { v: 1; identity: Identity; generation: string; end: string }
/** Holds the pull request of a unit's branch as GitHub reports it. */
export interface PullRequest {
  number: number
  state: string
  /** The branch the PR merges into, when read from GitHub. */
  baseRefName?: string
}
/** Records an irrevocable user skip of a whole step. */
export interface StepSkip { step: string; reason: string }
/** A tool run is bound to immutable content and the commands selected for its base. */
export interface VerifyRecord {
  tree: string
  base: string | null
  configBlob: string
  commands: string[][]
  outcome: VerifyOutcome
  runId: string
  at: number
}
/** Holds the latest Verify run on one content key (tree, config blob, commands), repository-wide, and the unit it ran in. */
export interface VerifyEvidence { v: 1; run: VerifyRecord; origin: Identity }
/** Names how a recorded command run ended. */
export type VerifyOutcome = VerifyPass | VerifyFailure | VerifyTimeout
/** Marks a run whose every command exited zero. */
export interface VerifyPass { kind: 'pass' }
/** Holds the exit code or signal of the command that failed a run. */
export interface VerifyFailure { kind: 'fail'; code: number | null; signal: string | null }
/** Holds the time limit a run exceeded. */
export interface VerifyTimeout { kind: 'timeout'; minutes: number }
/** Records a Diagnose command against the branch worktree's content. */
export interface RunRecord {
  argv: string[]
  tree: string
  outcome: VerifyRecord['outcome']
  runId: string
  at: number
}
/** Identifies the failing run an approval refers to. */
export type ApprovedRed = Pick<RunRecord, 'argv' | 'tree' | 'at' | 'runId'>
/** Holds evidence contributed by a chat to a unit. */
export interface Unit {
  base?: string
  /** The branch whose merge-base gave `base`; absent when the base is a declaration tip or no base branch is recorded. */
  baseBranch?: string
  skips?: StepSkip[]
  skills: string[]
  /** The user's steps taken while the unit was delegated, as their commands (`/to-spec`, `/flow skip pr`); the user's own steps are never listed. */
  delegated?: string[]
  verifyRuns: VerifyRecord[]
  runs: RunRecord[]
  approval?: string
  /** The red the approval was granted on, judged instead of the retained runs; absent when the approval pinned no red. */
  approvedRed?: ApprovedRed
  /** The slice whose Verify waited on the config when the user approved it: Code stays ended on it, as after a verify run. */
  verifyApproved?: Pick<VerifyRecord, 'tree' | 'base'>
  /** Separates a new lifetime from earlier chats sharing the same identity. */
  generation?: string
}

/** The color role of a row in the Flow pane. */
export type FlowTone = 'text' | 'warn' | 'error' | 'inactive'
/** Where a flow step stands for the current unit of work. */
export type FlowStepState = 'done' | 'current' | 'pending' | 'skipped'
/** Adds a separately toned annotation to a row. */
export interface RowSuffix { text: string; tone: FlowTone }
/** A labelled line of the Flow pane, such as the branch or a blocked-write count. */
export interface FlowRow { key: string; value: string; tone: FlowTone; suffix?: RowSuffix }
/**
 * One step of the declared flow with its inline status and symbol styling; `detail` is the pane's fact, at most `maxFactLength` characters; `fullDetail` is its full wording for `/flow status`, when that is longer.
 */
export interface FlowStep { id: string; symbol: string; label: string; state: FlowStepState; detail?: string; fullDetail?: string; isError: boolean; isMerged: boolean; isRewritten: boolean }
/** An issue the session's unit of work resolves. */
export interface FlowIssue { number: number; title: string }
/** Names whether the footer starts a fresh session or continues in a new one. */
export type FooterAction = 'start' | 'continue'
/** The pane's closing action, starting fresh or continuing in a new session. */
export interface FlowFooter { action: FooterAction; isRunning: boolean }
/** Names where one command of a run stands. */
export type RunCommandStatus ='waiting' | 'running' | 'passed' | 'failed' | 'timeout' | 'cancelled'
/** Display data only: command status never supplies step evidence. */
export interface RunCommandView {
  argv: string[]
  status: RunCommandStatus
  duration: number
  outcome: string
  output: string
}
/** Names the tool and evidence role a run was started for. */
export type RunKind = 'Verify' | 'Run' | 'red' | 'green'
/** Names the terminal statuses backed by a recorded outcome. */
export type RecordedRunStatus = 'passed' | 'failed' | 'timed out'
/** Names where a whole run stands, live or settled. */
export type RunStatus = 'running' | 'cancelled' | 'tree changed' | RecordedRunStatus
/** Holds the fields every run display shares, whatever its status. */
export interface RunViewFields {
  runId: string
  kind: RunKind
  selection: string
  /** Holds the result only on a Run-log summary rebuilt from a record; live producers omit it. */
  result?: string
  tree: string
  cwd: string
  log: string
  commands: RunCommandView[]
  duration: number
  at: number
}
/** A run stopped because the worktree changed under it, with the files that changed when known. */
export interface ChangedRunView extends RunViewFields { status: 'tree changed'; changed?: string[] }
/** A run in any status other than a changed tree. */
export interface SettledRunView extends RunViewFields { status: Exclude<RunStatus, 'tree changed'> }
/** A live run, a terminal display, or a completed record summary. */
export type RunView = SettledRunView | ChangedRunView
/** Everything the Flow pane draws; the session's state holds it, or null with no flow declared. */
export interface FlowView {
  flow: string
  progress: string
  issues: FlowIssue[]
  pending: string | null
  meta: FlowRow[]
  labels: string[]
  steps: FlowStep[]
  notes: FlowRow[]
  footer: FlowFooter | null
  violations?: ViolationNote[]
  hasRunLog?: boolean
  selectedRunId?: string
}

declare module 'claude-code' {
  interface PluginState {
    // The validator reads this shape in place: it stays inline.
    'working-agreement': { view: FlowView | null; liveRun: RunView | null; paneView: 'flow' | 'run-log'; session: SessionRecord }
  }
}
