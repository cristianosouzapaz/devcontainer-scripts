import { flowDefs } from './flows'
import { asRecords, asString, isRecord } from './json'

/** An issue's title and labels as last read from GitHub. */
export interface IssueInfo { title: string; labels: string[] }
/** How many writes the session's checks refused, by kind. */
export interface Blocked { edits: number; shell: number }
/** A handoff still under way. */
export interface HandoffRunning { state: 'running' }
/** A handoff that stopped before /clear, and why. */
export interface HandoffFailed { state: 'failed'; reason: string }
/** Where the session's handoff stands. */
export type HandoffState = HandoffRunning | HandoffFailed
/** The stored record of one session: its declared flow, issues and what it has produced. */
export interface Session {
  flow: string | null; issues: number[]; hadIssue: boolean; info: Record<string, IssueInfo>
  prCreated: boolean; output: boolean; reclassifyOk: boolean
  blocked: Blocked; gh: Gh; followUp?: number
  isLong: boolean; isToasted: boolean; handoff?: HandoffState
  skills?: string[]
}
/** A step the user let through, and the reason they gave. */
export interface Override { step: string; reason: string }
/** The pull request a unit's branch opened; `isCreated` marks one the unit created, as opposed to one already open when it started. */
export interface Pr { number: number; state: string; isCreated?: boolean }
/**
 * The stored record of one unit of work, shared by every session that works on its issue;
 * `start` is the HEAD when it was first declared, so only commits after it count as the unit's;
 * `prHead` is the PR head SHA at the last confirmed update, absent when none was confirmed.
 */
export interface Unit {
  skills: string[]; verify: string | null; overrides: Override[]
  start?: string; branch?: string; committed?: boolean; pushed?: boolean; pr?: Pr
  tested?: boolean; produced?: string[]; prHead?: string
}
/** Whether the gh CLI can reach GitHub as a signed-in user. */
export type Gh = 'connected' | 'unreachable' | 'unauth' | 'unknown'

// Store records outlive the mod's versions: a field of the wrong type falls back to its default,
// and an absent optional field stays absent so a merge with another record keeps that record's value.
const ghStates: Gh[] = ['connected', 'unreachable', 'unauth', 'unknown']

const asStrings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const asNumbers = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [])
const asCount = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function toIssueInfo(v: unknown): Record<string, IssueInfo> {
  const info = isRecord(v) ? v : {}
  return Object.fromEntries(Object.entries(info).flatMap(([n, i]) =>
    isRecord(i) ? [[n, { title: asString(i.title), labels: asStrings(i.labels) }]] : []))
}

function toHandoff(v: unknown): Pick<Session, 'handoff'> {
  if (!isRecord(v)) return {}
  if (v.state === 'running') return { handoff: { state: 'running' } }
  return v.state === 'failed' ? { handoff: { state: 'failed', reason: asString(v.reason) } } : {}
}

/**
 * Reads a stored session record.
 *
 * @param v - The record as the store holds it.
 * @returns The session, with defaults for every missing or malformed field.
 */
export function toSession(v: unknown): Session {
  const r = isRecord(v) ? v : {}
  const blocked = isRecord(r.blocked) ? r.blocked : {}
  return {
    // A flow this version no longer defines reads as none declared.
    flow: typeof r.flow === 'string' && r.flow in flowDefs.flows ? r.flow : null,
    issues: asNumbers(r.issues),
    hadIssue: r.hadIssue === true,
    info: toIssueInfo(r.info),
    prCreated: r.prCreated === true,
    output: r.output === true,
    reclassifyOk: r.reclassifyOk === true,
    blocked: { edits: asCount(blocked.edits), shell: asCount(blocked.shell) },
    gh: ghStates.find(g => g === r.gh) ?? 'unknown',
    ...(typeof r.followUp === 'number' ? { followUp: r.followUp } : {}),
    isLong: r.isLong === true,
    isToasted: r.isToasted === true,
    ...toHandoff(r.handoff),
    ...(Array.isArray(r.skills) ? { skills: asStrings(r.skills) } : {}),
  }
}

/**
 * Reads a stored unit record.
 *
 * @param v - The record as the store holds it.
 * @returns The unit, with defaults for every missing or malformed field.
 */
export function toUnit(v: unknown): Unit {
  const r = isRecord(v) ? v : {}
  return {
    skills: asStrings(r.skills),
    verify: typeof r.verify === 'string' ? r.verify : null,
    overrides: asRecords(r.overrides).map(o => ({ step: asString(o.step), reason: asString(o.reason) })),
    ...(typeof r.start === 'string' ? { start: r.start } : {}),
    ...(typeof r.branch === 'string' ? { branch: r.branch } : {}),
    ...(typeof r.committed === 'boolean' ? { committed: r.committed } : {}),
    ...(typeof r.pushed === 'boolean' ? { pushed: r.pushed } : {}),
    ...(typeof r.tested === 'boolean' ? { tested: r.tested } : {}),
    ...(isRecord(r.pr) && typeof r.pr.number === 'number' ? { pr: { number: r.pr.number, state: asString(r.pr.state), ...(r.pr.isCreated === true ? { isCreated: true } : {}) } } : {}),
    ...(typeof r.prHead === 'string' && r.prHead ? { prHead: r.prHead } : {}),
    ...(Array.isArray(r.produced) ? { produced: asStrings(r.produced) } : {}),
  }
}

/**
 * Builds the record of a session with no flow declared.
 *
 * @returns An empty session.
 */
export const emptySession = (): Session => ({
  flow: null, issues: [], hadIssue: false, info: {}, prCreated: false, output: false,
  reclassifyOk: false, blocked: { edits: 0, shell: 0 }, gh: 'unknown', isLong: false, isToasted: false,
})

/**
 * Builds the record of a unit nothing has happened in yet.
 *
 * @returns An empty unit.
 */
export const emptyUnit = (): Unit => ({ skills: [], verify: null, overrides: [] })

/**
 * Joins two skill lists, each skill once, in first-seen order.
 *
 * @param a - The skills already on record.
 * @param b - The skills to add.
 * @returns The union of both lists.
 */
export const mergeSkills = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])]

/**
 * Records an override on a unit, replacing any earlier one on the same step.
 *
 * @param u - The unit.
 * @param step - The overridden step's id.
 * @param reason - The user's reason.
 * @returns The unit with the override recorded last.
 */
export const withOverride = (u: Unit, step: string, reason: string): Unit =>
  ({ ...u, overrides: [...u.overrides.filter(o => o.step !== step), { step, reason }] })
