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
  url?: string
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
/** Names one reason a call's effects could not be checked: a read that failed, or commits or a push no slice could place. */
export type UncheckedReason =
  | 'refs read failed before' | 'refs read failed after'
  | 'trees read failed before' | 'trees read failed after'
  | 'PR read failed before' | 'PR read failed after'
  | 'repository read failed before' | 'repository read failed after'
  | 'commit reachability read failed' | 'commits or push could not be placed'
/** Identifies a call whose effects the guarantees could not observe, with every reason it met; records kept before reasons existed have none. */
export interface UncheckedFact { toolUseId: string; reasons?: UncheckedReason[] }
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
/** The audit could not read GitHub or the config, or could not search, so it proves nothing either way; the findings it did establish are kept. */
export interface AuditPending { state: 'pending'; reason: string; findings?: AuditFinding[] }
/** Where the latest audit of the session's issues stands. */
export type AuditResult = AuditCompliant | AuditViolations | AuditPending
/** The issues the session wrote and the latest audit of them, with the window a handoff carried from the chat before it; absent before either. */
export interface IssueAudit {
  /** When the window of the chat a handoff came from opened, as `/clear` restarts this chat's own start; absent in a chat no handoff started. */
  since?: number
  issues: number[]
  result?: AuditResult
  /** Names a window before `since` that no audit searched, as a handoff that could read neither the start nor the declaration leaves; it holds nothing back. */
  unsearched?: string
}
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
  /** The cancels whose tool gate the user's `/flow lift` lifted in this unit, by message id; each is still owed its `done`. */
  liftedCancels?: string[]
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
  /** The herdr pane the coordinator ran `/flow delegate` in; absent outside herdr. */
  paneId?: string
  /** The coordinator's process, which tells a unit whether the coordinator still runs; absent where the host does not expose it. */
  host?: ProcessHost
}
/** Holds a session's process identity: a pid means nothing outside its pid namespace and boot, and its start time tells a reused pid. */
export interface ProcessHost { pidns: string; pid: number; pidStart: string; bootId: string }
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
  /** Where the run verified: a unit's own Verify, or the merge_child gate's; absent on a record written before stages existed. */
  stage?: VerifyStage
}
/** Names where a Verify runs: a unit's own Verify, or the merge_child gate's on the merged tree. */
export type VerifyStage = 'unit' | 'gate'
/** Holds the latest Verify run on one content key (tree, config blob, commands, stage), repository-wide, and the unit it ran in. */
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
  /** The unit's own Verify calls that failed or timed out since its last pass; absent before the first one. */
  redVerifies?: number
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
/** A labelled line of the Flow pane, such as the branch or a blocked-write count: its tone colours the key, and its value and suffix stay plain. */
export interface FlowRow { key: string; value: string; tone: FlowTone; suffix?: string }
/**
 * One step of the declared flow with its inline status and symbol styling; `detail` is the pane's fact, at most `maxFactLength` characters; `fullDetail` is its full wording for `/flow status`, when that is longer.
 */
export interface FlowStep { id: string; symbol: string; label: string; state: FlowStepState; detail?: string; fullDetail?: string; isError: boolean; isMerged: boolean; isRewritten: boolean }
/** An issue the session's unit of work resolves; `url` is empty until GitHub has answered with it. */
export interface FlowIssue { number: number; title: string; url: string }
/** Names whether the footer starts a fresh session or continues in a new one. */
export type FooterAction = 'start' | 'continue'
/** What pressing the `Merge` note's copy button answered, shown on its row until the next refresh. */
export type MergeCopy = { isCopied: true } | { isCopied: false; reason: string }
/** Why opening an issue in the browser failed, shown under its row with its web address until the next refresh. */
export interface OpenFailure { issue: number; reason: string; url: string }
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
export type RunStatus = 'running' | 'cancelled' | 'tree changed' | 'ended' | RecordedRunStatus
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
/** A run that ended with no record known to be written for a reason other than a cancel or a changed tree, labelled with that reason. */
export interface EndedRunView extends RunViewFields { status: 'ended'; label: string }
/** A run in any status other than a changed tree or an ended run's own label. */
export interface SettledRunView extends RunViewFields { status: Exclude<RunStatus, 'tree changed' | 'ended'> }
/** A live run, a terminal display, or a completed record summary. */
export type RunView = SettledRunView | ChangedRunView | EndedRunView
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
  mergeCopy?: MergeCopy
  openFailure?: OpenFailure
  hasRunLog?: boolean
  selectedRunId?: string
  /** The notices this view shows, each by its id and revision, which a completed render that shows it acknowledges. */
  notices?: string[]
}

/** A published view: the number of the load that painted it, kept beside the view so a view of none carries it too, and the view. */
export interface ViewEnvelope { seq: number; view: FlowView | null }

/** The main loop's running turn, from its `turn.start` to the `turn.complete` that names its id; an empty id is a turn carried over from a module that recorded none. */
export interface ProcessTurn { id: string; hasSent: boolean; isInformOnly: boolean; isEmptyDoorbell: boolean }
/** A prompt that entered (its UserPromptSubmit) and has not started its turn yet, with what its turn inherits; `isClaim` marks the idle window a start delivery took before its prompt entered. */
export interface EnteredPrompt { enteredAt: number; isInformOnly: boolean; isEmptyDoorbell: boolean; isClaim?: boolean }
/** A start kept for the current step, whose prompt is composed when it is taken. */
export interface StepStart { kind: 'step'; lead: string }
/** A start kept for a new coordinator, with the user's words. */
export interface CoordinateStart { kind: 'coordinate'; text: string }
/** A start kept for a delegation, with its issues and the user's instructions. */
export interface DelegateStart { kind: 'delegate'; issues: number[]; instructions: string }
/** A start prompt kept while the session was busy, as data, since the host holds only JSON. */
export type PendingStart = StepStart | CoordinateStart | DelegateStart
/** A start in the session's keeping, with the id its command delivers it by; it stays kept until an attempt to submit it is known to have entered, or ends with a notice. */
export interface KeptStart { id: string; start: PendingStart }
/** Which of the mod's own prompts an attempt submits: a kept start, the Verify approval wake, or the mailbox doorbell. */
export type AttemptRoute = 'start' | 'wake' | 'doorbell'
/**
 * What is known of an attempt's submit: still pending in the load that made it, unknown with why, entered, or dropped by the engine with
 * why; entered and dropped are established and never change again, and unknown changes only to one of them.
 */
export type AttemptStatus = { kind: 'pending' } | { kind: 'unknown'; cause: string } | { kind: 'entered' } | { kind: 'dropped'; cause: string }
/**
 * One submit of one of the mod's own prompts, written before the engine is called, owned by the load that made it: its id, the load,
 * the route and what it submits (the kept start's id, the wake's config blob, or the doorbell), how to name it, when its claim took the
 * idle window, at which turn epoch, and what is known of it. Any load may record a receipt on it by id; only the recorded load settles it
 * or releases it.
 */
export interface Attempt {
  id: string; owner: string; route: AttemptRoute; subject: string; kind: PendingStart['kind']; label: string; at: number; epoch: number; status: AttemptStatus
  /** A digest of the prompt it submits, by which the prompt's own entry is told from a prompt the user typed; absent from an attempt an earlier version wrote. */
  digest?: string
}
/**
 * An obligation the mod ended without knowing it entered, or with nothing to start, which the pane shows until a completed render of
 * its Flow view drew it: its id (the attempt's, the start's, or an overflow's, new at each fold), what it was for (the kept start's id,
 * the wake's config blob, or the doorbell), its route, kind and name, and why it ended and what to do.
 */
export interface Notice {
  id: string; subject: string; route: AttemptRoute; kind: PendingStart['kind']; label: string; cause: string
  /** The outcome its submit's answer established after the notice was written, which the pane then shows in place of an unknown one. */
  outcome?: 'entered' | 'dropped'
  /** Names this content of the notice, new at each change, so a render acknowledges only the content it drew; absent from a notice an earlier version wrote. */
  rev?: string
  /** For an overflow notice, how many of the notices it folded had their outcome established as entered or dropped. */
  established?: { entered: number; dropped: number }
}
/** An established answer for an attempt that had already ended: its id and what it was for, and the outcome the engine answered. */
export interface Receipt { id: string; subject: string; route: AttemptRoute; kind: PendingStart['kind']; label: string; outcome: 'entered' | 'dropped' }
/**
 * What the records an earlier version of the mod left said when this process state was seeded, each kept once read so a later write over
 * the record never replaces it: the process the host record named (null for none), and whether the activity record held a turn and at
 * which epoch; a field still `unread` could not be read yet, and while any is, whether a turn runs is unknown.
 */
export interface LegacyEvidence { host: ProcessHost | null | 'unread'; activity: { isTurn: boolean; epoch: number } | 'unread' }
/**
 * What this process knows of its session's turn and its waits, held by the host so it outlives a reload of the mod and starts empty in
 * a new process; `shape` names this version, and a value of another shape reads as none.
 */
export interface ProcessState {
  shape: 'v2'
  /** Names this process, so a session mirror written by a module of another process is never judged older than one of this. */
  generation: string
  /** Counts the turn starts and ends this session's processes saw, rising across processes; the activity record carries the value it was written from, so an older observation never replaces a newer one. */
  epoch: number
  turn: ProcessTurn | null
  prompt: EnteredPrompt | null
  /** The single start a state written before the queue kept; it is taken first, and every write leaves it null. */
  pendingStart: PendingStart | null
  /** The starts kept while the session was busy, oldest first; absent from a state written before the queue. */
  pendingStarts?: KeptStart[]
  /** Every submit of the mod's own prompts not settled yet, oldest first; absent from a state written before attempts were kept. */
  attempts?: Attempt[]
  /** What an earlier version's records said, kept while whether a turn runs is not settled from them; absent once settled. */
  legacy?: LegacyEvidence
  /** The obligations the mod ended without knowing they entered, or with nothing to start, until a render showed them; absent while none. */
  notices?: Notice[]
  /** Established answers whose attempt had ended, which any load leaves here and the recorded load turns into notices; absent while none. */
  receipts?: Receipt[]
  /** The turns whose end was written, newest last, so a start heard after its own end never sets its turn running again; absent while none. */
  endedTurns?: string[]
  /** The mod load that last started in this process, so a delivery a reload interrupted submits nothing; absent from a state written before it was kept. */
  loadId?: string
  /** A heartbeat an earlier version of the mod wrote for the recorded load; read as nothing, and dropped by the next load that records itself. */
  loadBeat?: number
  /** The config blob this session's Verify call was last refused for, unapproved: the unit then waits for its approval. */
  verifyAskedBlob: string | null
  /** The unapproved config blob this session's unit last waited on, until its approval is followed up. */
  approvalWait: string | null
  /** The approved config blobs this delegated session was prompted to verify, each once. */
  wokenBlobs: string[]
  /** The approved config blob whose wake is claimed and not yet known to have entered, so a reload that cancels the deferred submit does not lose it. */
  pendingWake: string | null
  /** The latest states a delegated unit's turn end asked a message for, so each asks once even across a reload. */
  turnEndKeys: string[]
  /** Why the last turn-end audit's result was not written to each chat's session record, by session id, until a later audit writes one; absent while none failed. */
  auditUnrecorded?: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    // why: the validator reads this shape in place, so it stays inline.
    'working-agreement': { view: ViewEnvelope | null; liveRun: RunView | null; paneView: 'flow' | 'run-log'; session: SessionRecord; process: ProcessState; loadSeq: number }
  }
}
