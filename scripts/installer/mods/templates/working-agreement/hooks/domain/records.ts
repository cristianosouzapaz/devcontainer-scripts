import type { GithubAccess } from '../lib/github'
import { filterRecords, isRecord, toStringOrEmpty } from '../lib/json'
import { flowDefinitions } from './flow-definitions'

// The record fields are the keys the store holds, which outlive the mod's versions: they keep their stored names.

/** Holds an issue's title and labels as last read from GitHub, and its sub-issue count when the flow follows sub-issues and GitHub answered. */
export interface IssueInfo {
  title: string
  labels: string[]
  subIssues?: number
}
/** Counts the writes the session's checks refused, by kind. */
export interface Blocked {
  edits: number
  shell: number
}
/** Marks a handoff still under way. */
interface HandoffRunning {
  state: 'running'
}
/** Marks a handoff that stopped before /clear, and says why. */
interface HandoffFailed {
  state: 'failed'
  reason: string
}
/** Names where the session's handoff stands. */
type HandoffState = HandoffRunning | HandoffFailed
/** Names whether the gh CLI can reach GitHub as a signed-in user. */
export type GithubStatus = GithubAccess | 'unknown'
/** Holds the stored record of one session: its declared flow, issues and what it has produced. */
export interface Session {
  flow: string | null
  issues: number[]
  info: Record<string, IssueInfo>
  prCreated: boolean
  output: boolean
  reclassifyOk: boolean
  blocked: Blocked
  gh: GithubStatus
  followUp?: number
  isLong: boolean
  isToasted: boolean
  handoff?: HandoffState
  skills?: string[]
  /** The unit anchor this session wrote a repository file after, which reopens the unit's finished steps. */
  wroteAfter?: string
}
/** Holds a step the user let through, and the reason they gave. */
interface Override {
  step: string
  reason: string
}
/** Holds the pull request a unit's branch opened; `isCreated` marks one the unit created, as opposed to one already open when it started. */
export interface PullRequest {
  number: number
  state: string
  isCreated?: boolean
}
/**
 * Holds the red: the failing command run in the worktree, and the content hash of each red file, the worktree's changes
 * against the unit's start when it failed, '' for a file the change deleted.
 */
interface Red {
  command: string
  fingerprints: Record<string, string>
}
/** Holds the worktree Diagnose runs in: its name under `.claude/worktrees/`, and its absolute path. */
export interface Worktree {
  name: string
  path: string
}
/**
 * Holds the repository files changed outside Edit or Write, during a Bash call or between calls, while a step held writes
 * back, with no allowed write to explain them: each file's content hash before the change, `clean` for a file that matched
 * HEAD, '' for one that was absent; `isUnchecked` when the working tree could not be read at a boundary, so what changed is unknown.
 */
export interface UnexplainedWrites {
  files: Record<string, string>
  isUnchecked?: true
}
/**
 * Holds the stored record of one unit of work, shared by every session that works on its issue;
 * `start` is the HEAD when it was first declared, so only commits after it count as the unit's;
 * `prHead` is the PR head SHA at the last confirmed update, absent when none was confirmed;
 * `anchor` is the commit that completed the unit's Commit step, absent until a session sees the step done;
 * `worktree` is the worktree Diagnose entered; `red` is the last failing command there before the green, and `green` the red's
 * command text once a run of it passed there; `diagnosis` is the URL of the latest valid diagnosis comment posted on the issue after
 * the green, and `approval` the diagnosis comment URL the user approved, so a newer comment leaves the approval behind; a failing run of another command than the red's replaces the red and drops the green, the diagnosis and the approval;
 * `unexplained` holds back every repository write until its files are restored or the user overrides it.
 */
export interface Unit {
  skills: string[]
  verify: string | null
  overrides: Override[]
  start?: string
  branch?: string
  pr?: PullRequest
  worktree?: Worktree
  red?: Red
  green?: string
  diagnosis?: string
  approval?: string
  prHead?: string
  anchor?: string
  unexplained?: UnexplainedWrites
}

// Store records outlive the mod's versions: a field of the wrong type falls back to its default,
// and an absent optional field stays absent so a merge with another record keeps that record's value.
const githubStatuses: GithubStatus[] = ['connected', 'unreachable', 'unauth', 'unknown']

const asStrings = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
const asNumbers = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [])
const asCount = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function parseIssueInfo(value: unknown): Record<string, IssueInfo> {
  const info = isRecord(value) ? value : {}
  return Object.fromEntries(Object.entries(info).flatMap(([number, issue]) =>
    isRecord(issue) ? [[number, {
      title: toStringOrEmpty(issue.title), labels: asStrings(issue.labels), ...(typeof issue.subIssues === 'number' ? { subIssues: issue.subIssues } : {}),
    }]] : []))
}

// A red stored before reds carried their command (a reproduction test's) reads as none: no green could match it.
function parseRed(value: unknown): Pick<Unit, 'red'> {
  if (!isRecord(value) || !isRecord(value.fingerprints) || typeof value.command !== 'string' || !value.command) return {}
  const entries = Object.entries(value.fingerprints).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return { red: { command: value.command, fingerprints: Object.fromEntries(entries) } }
}

function parseWorktree(value: unknown): Pick<Unit, 'worktree'> {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.path !== 'string' || !value.path) return {}
  return { worktree: { name: value.name, path: value.path } }
}

function parseUnexplained(value: unknown): Pick<Unit, 'unexplained'> {
  if (!isRecord(value) || !isRecord(value.files)) return {}
  const files = Object.fromEntries(Object.entries(value.files).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  return { unexplained: { files, ...(value.isUnchecked === true ? { isUnchecked: true } : {}) } }
}

function parseHandoff(value: unknown): Pick<Session, 'handoff'> {
  if (!isRecord(value)) return {}
  if (value.state === 'running') return { handoff: { state: 'running' } }
  return value.state === 'failed' ? { handoff: { state: 'failed', reason: toStringOrEmpty(value.reason) } } : {}
}

function parsePullRequest(value: unknown): Pick<Unit, 'pr'> {
  if (!isRecord(value) || typeof value.number !== 'number') return {}
  return { pr: { number: value.number, state: toStringOrEmpty(value.state), ...(value.isCreated === true ? { isCreated: true } : {}) } }
}

/**
 * Reads a stored session record.
 *
 * @param value - The record as the store holds it.
 * @returns The session, with defaults for every missing or malformed field.
 */
export function parseSession(value: unknown): Session {
  const record = isRecord(value) ? value : {}
  const blocked = isRecord(record.blocked) ? record.blocked : {}
  return {
    // A flow this version no longer defines reads as none declared.
    flow: typeof record.flow === 'string' && record.flow in flowDefinitions.flows ? record.flow : null,
    issues: asNumbers(record.issues),
    info: parseIssueInfo(record.info),
    prCreated: record.prCreated === true,
    output: record.output === true,
    reclassifyOk: record.reclassifyOk === true,
    blocked: { edits: asCount(blocked.edits), shell: asCount(blocked.shell) },
    gh: githubStatuses.find(status => status === record.gh) ?? 'unknown',
    ...(typeof record.followUp === 'number' ? { followUp: record.followUp } : {}),
    isLong: record.isLong === true,
    isToasted: record.isToasted === true,
    ...parseHandoff(record.handoff),
    ...(Array.isArray(record.skills) ? { skills: asStrings(record.skills) } : {}),
    ...(typeof record.wroteAfter === 'string' && record.wroteAfter ? { wroteAfter: record.wroteAfter } : {}),
  }
}

/**
 * Reads a stored unit record.
 *
 * @param value - The record as the store holds it.
 * @returns The unit, with defaults for every missing or malformed field.
 */
export function parseUnit(value: unknown): Unit {
  const record = isRecord(value) ? value : {}
  return {
    skills: asStrings(record.skills),
    verify: typeof record.verify === 'string' ? record.verify : null,
    // A stored override on `change` reads as one on `code`, the Trivial change's writing step.
    overrides: filterRecords(record.overrides).map(override => {
      const step = toStringOrEmpty(override.step)
      return { step: step === 'change' ? 'code' : step, reason: toStringOrEmpty(override.reason) }
    }),
    ...(typeof record.start === 'string' ? { start: record.start } : {}),
    ...(typeof record.branch === 'string' ? { branch: record.branch } : {}),
    ...parseWorktree(record.worktree),
    ...parseRed(record.red),
    ...(typeof record.green === 'string' && record.green ? { green: record.green } : {}),
    ...(typeof record.diagnosis === 'string' && record.diagnosis ? { diagnosis: record.diagnosis } : {}),
    ...(typeof record.approval === 'string' && record.approval ? { approval: record.approval } : {}),
    ...parsePullRequest(record.pr),
    ...(typeof record.prHead === 'string' && record.prHead ? { prHead: record.prHead } : {}),
    ...(typeof record.anchor === 'string' && record.anchor ? { anchor: record.anchor } : {}),
    ...parseUnexplained(record.unexplained),
  }
}

/**
 * Builds the record of a session with no flow declared.
 *
 * @returns An empty session.
 */
export const createEmptySession = (): Session => ({
  flow: null, issues: [], info: {}, prCreated: false, output: false,
  reclassifyOk: false, blocked: { edits: 0, shell: 0 }, gh: 'unknown', isLong: false, isToasted: false,
})

/**
 * Builds the record of a unit nothing has happened in yet.
 *
 * @returns An empty unit.
 */
export const createEmptyUnit = (): Unit => ({ skills: [], verify: null, overrides: [] })

/**
 * Joins two skill lists, each skill once, in first-seen order.
 *
 * @param recorded - The skills already on record.
 * @param added - The skills to add.
 * @returns The union of both lists.
 */
export const mergeSkills = (recorded: string[], added: string[]): string[] => [...new Set([...recorded, ...added])]

/**
 * Records an override on a unit, replacing any earlier one on the same step.
 *
 * @param unit - The unit.
 * @param step - The overridden step's id.
 * @param reason - The user's reason.
 * @returns The unit with the override recorded last.
 */
export const recordOverride = (unit: Unit, step: string, reason: string): Unit =>
  ({ ...unit, overrides: [...unit.overrides.filter(override => override.step !== step), { step, reason }] })

/**
 * Merges the units of a session declared on several issues into the one the gates read: the first unit, whose overrides
 * keep only the steps every unit overrides, since a step holds only once every declared issue lets it through.
 *
 * @param units - The session's units, one per declared issue.
 * @returns The first unit with the shared overrides, or an empty unit when the list is empty.
 */
export const mergeUnits = (units: Unit[]): Unit => {
  const [first = createEmptyUnit()] = units
  return { ...first, overrides: first.overrides.filter(({ step }) => units.every(unit => unit.overrides.some(override => override.step === step))) }
}
