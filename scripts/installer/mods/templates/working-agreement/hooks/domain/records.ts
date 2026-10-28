import type { ApprovedRed, GithubStatus, IssueInfo, Identity, ObservedEndRecord, SessionRecord, Unit, UnitEntry, UnitRecord, VerifyRecord, RunRecord, Violation } from '../../types'
import { hasOnlyKeys, isStringArray, isFiniteNumber, isNonEmptyString, isSafeInteger, isRecord } from '../lib/guards'
import { isPrFields } from '../lib/github-rows'
import { flowDefinitions } from './flow-definitions'

export type { GithubStatus, Identity, IssueInfo, ObservedEndRecord, PullRequest, SessionRecord, Unit, UnitEntry, UnitRecord } from '../../types'

/** Adds the current unit's derived flow and issues for the existing flow logic. */
export interface Session extends SessionRecord { flow: string | null; issues: number[] }

const githubStatuses: GithubStatus[] = ['connected', 'unreachable', 'unauth', 'unknown']
// why: Every run of a unit is written into its record on each write; the bounds keep that record small
// while a red-to-green loop and the regression tests beside it still fit.
const runsPerArgv = 10
const totalRuns = 50

/**
 * Identifies issue facts or their read failure.
 * @param value - The decoded value.
 * @returns Whether the issue record is valid.
 */
function isIssueInfo(value: unknown): value is IssueInfo {
  return isRecord(value) && ((hasOnlyKeys(value, ['error']) && typeof value.error === 'string')
  || (hasOnlyKeys(value, ['state', 'title', 'labels', 'subIssues', 'comments']) && (value.state === undefined || typeof value.state === 'string') && typeof value.title === 'string' && isStringArray(value.labels)
      && (value.comments === undefined || (isRecord(value.comments) && hasOnlyKeys(value.comments, ['error']) && typeof value.comments.error === 'string')
        || (Array.isArray(value.comments) && value.comments.every(comment => isRecord(comment) && hasOnlyKeys(comment, ['url', 'createdAt'])
          && isNonEmptyString(comment.url) && typeof comment.createdAt === 'string' && Number.isFinite(Date.parse(comment.createdAt)))))
      && (value.subIssues === undefined || (isRecord(value.subIssues) && hasOnlyKeys(value.subIssues, ['error']) && typeof value.subIssues.error === 'string')
        || (Array.isArray(value.subIssues) && value.subIssues.every(subIssue => isRecord(subIssue)
          && hasOnlyKeys(subIssue, ['state', 'labels']) && typeof subIssue.state === 'string' && isStringArray(subIssue.labels))))))
}

/**
 * Identifies a branch and its ordered issue numbers.
 * @param value - The decoded value.
 * @returns Whether the identity is valid.
 */
function isIdentity(value: unknown): value is Identity {
  return isRecord(value) && hasOnlyKeys(value, ['branch', 'issues']) && isNonEmptyString(value.branch) && Array.isArray(value.issues)
    && value.issues.every((issue, index, issues) => isSafeInteger(issue) && issue > 0 && (index === 0 || issues[index - 1] < issue))
}

/**
 * Identifies complete verification evidence.
 * @param value - The decoded value.
 * @returns Whether the verification record is valid.
 */
function isVerifyRecord(value: unknown): value is VerifyRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, ['tree', 'base', 'configBlob', 'commands', 'outcome', 'runId', 'at'])
    || typeof value.tree !== 'string' || !value.tree || !(value.base === null || (typeof value.base === 'string' && !!value.base))
    || typeof value.configBlob !== 'string' || !value.configBlob || typeof value.runId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(value.runId)
    || !isFiniteNumber(value.at) || !Array.isArray(value.commands)
    || !value.commands.every(command => isStringArray(command) && command.length > 0 && command.every(arg => !!arg.length)) || !isRecord(value.outcome)) return false
  return isOutcome(value.outcome)
}

/**
 * Identifies a recorded process outcome.
 * @param outcome - The decoded value.
 * @returns Whether the outcome is valid.
 */
function isOutcome(outcome: unknown): outcome is VerifyRecord['outcome'] {
  return isRecord(outcome) && ((outcome.kind === 'pass' && hasOnlyKeys(outcome, ['kind']))
    || (outcome.kind === 'fail' && hasOnlyKeys(outcome, ['kind', 'code', 'signal']) && (outcome.code === null || Number.isInteger(outcome.code))
      && (outcome.signal === null || typeof outcome.signal === 'string'))
    || (outcome.kind === 'timeout' && hasOnlyKeys(outcome, ['kind', 'minutes']) && isFiniteNumber(outcome.minutes) && outcome.minutes > 0))
}

/**
 * Identifies complete Diagnose evidence.
 * @param value - The decoded value.
 * @returns Whether the command record is valid.
 */
function isRunRecord(value: unknown): value is RunRecord {
  return isRecord(value) && hasOnlyKeys(value, ['argv', 'tree', 'outcome', 'runId', 'at']) && hasRunIdentity(value)
    && isRecord(value.outcome) && isOutcome(value.outcome)
}

/**
 * Identifies the red an approval pins.
 * @param value - The decoded value.
 * @returns Whether the pinned red is valid.
 */
function isApprovedRed(value: unknown): value is ApprovedRed {
  return isRecord(value) && hasOnlyKeys(value, ['argv', 'tree', 'runId', 'at']) && hasRunIdentity(value)
}

/**
 * Checks the fields that identify a run: its command, content and time.
 * @param value - The decoded record.
 * @returns Whether every identifying field is valid.
 */
function hasRunIdentity(value: Record<string, unknown>): boolean {
  return isStringArray(value.argv) && value.argv.length > 0 && value.argv.every(arg => !!arg.length)
    && typeof value.tree === 'string' && !!value.tree && typeof value.runId === 'string' && /^[a-zA-Z0-9-]+$/.test(value.runId)
    && isFiniteNumber(value.at)
}

/**
 * Identifies a chat contribution and its evidence.
 * @param value - The decoded value.
 * @returns Whether the unit entry is valid.
 */
function isUnit(value: unknown): value is UnitEntry {
  return isRecord(value) && hasOnlyKeys(value, ['identity', 'skills', 'verifyRuns', 'runs', 'approval', 'approvedRed', 'generation', 'base', 'baseBranch', 'skips']) && isIdentity(value.identity) && isStringArray(value.skills)
    && Array.isArray(value.verifyRuns) && value.verifyRuns.every(isVerifyRecord)
    && Array.isArray(value.runs) && value.runs.every(isRunRecord)
    && ['approval', 'generation', 'base', 'baseBranch'].every(key => value[key] === undefined || typeof value[key] === 'string')
    && (value.approvedRed === undefined || (value.approval !== undefined && isApprovedRed(value.approvedRed)))
    && (value.base === undefined || !!value.base) && (value.baseBranch === undefined || (!!value.base && !!value.baseBranch))
    && (value.skips === undefined || (Array.isArray(value.skips) && value.skips.every(skip => isRecord(skip) && hasOnlyKeys(skip, ['step', 'reason'])
      && typeof skip.step === 'string' && !!skip.step.trim() && typeof skip.reason === 'string' && !!skip.reason.trim())))
}

/**
 * Identifies a guarantee fact and its attribution.
 * @param value - The decoded value.
 * @returns Whether the violation is valid.
 */
function isViolation(value: unknown): value is Violation {
  if (!isRecord(value) || !hasOnlyKeys(value, ['kind', 'fact', 'factId', 'toolUseIds', 'agentIds', 'start', 'end', 'sessionId', 'count', 'checkouts'])
    || typeof value.factId !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.factId) || !isStringArray(value.toolUseIds) || !value.toolUseIds.length || value.toolUseIds.some(id => !id)
    || (value.count !== undefined && (value.kind !== 'unchecked' || !isSafeInteger(value.count) || Number(value.count) < 1))
    || (value.checkouts !== undefined && (value.kind !== 'commit' || !Array.isArray(value.checkouts) || !value.checkouts.every(checkout =>
      isRecord(checkout) && hasOnlyKeys(checkout, ['root', 'branch']) && isNonEmptyString(checkout.root)
      && (checkout.branch === null || typeof checkout.branch === 'string'))))
    || (value.agentIds !== undefined && !isStringArray(value.agentIds)) || !isFiniteNumber(value.start) || !isFiniteNumber(value.end)
    || value.end < value.start || typeof value.sessionId !== 'string' || !value.sessionId || !isRecord(value.fact)) return false
  const fact = value.fact
  if (value.kind === 'commit') return hasOnlyKeys(fact, ['shas']) && isStringArray(fact.shas) && fact.shas.length > 0 && fact.shas.every(sha => !!sha)
  if (value.kind === 'push') return hasOnlyKeys(fact, ['ref', 'before', 'after']) && typeof fact.ref === 'string' && fact.ref.startsWith('refs/remotes/')
    && (fact.before === null || typeof fact.before === 'string') && typeof fact.after === 'string' && !!fact.after
  if (value.kind === 'pr') return hasOnlyKeys(fact, ['number', 'before', 'after']) && isSafeInteger(fact.number) && Number(fact.number) > 0 && isPrFields(fact.before) && isPrFields(fact.after)
  if (value.kind === 'default-tree') return hasOnlyKeys(fact, ['root', 'before', 'after']) && ['root', 'before', 'after'].every(key => typeof fact[key] === 'string' && !!fact[key])
  return value.kind === 'unchecked' && hasOnlyKeys(fact, ['toolUseId']) && typeof fact.toolUseId === 'string' && value.toolUseIds.includes(fact.toolUseId)
}

/**
 * Identifies a complete disk session without filling missing fields.
 * @param value - The decoded JSON.
 * @returns Whether the complete session is valid.
 */
function isSessionRecord(value: unknown): value is SessionRecord {
  if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'sessionId', 'unit', 'units', 'info', 'blocked', 'gh', 'isLong', 'handoff', 'skills', 'violations', 'prSnapshot']) || value.v !== 1 || typeof value.sessionId !== 'string' || !value.sessionId
    || !(value.unit === null || isIdentity(value.unit)) || !Array.isArray(value.units) || !value.units.every(isUnit)
    || !isRecord(value.info) || !Object.values(value.info).every(isIssueInfo)
    || !isRecord(value.blocked) || !hasOnlyKeys(value.blocked, ['edits']) || !isSafeInteger(value.blocked.edits) || Number(value.blocked.edits) < 0
    || !isGithubStatus(value.gh) || typeof value.isLong !== 'boolean'
    || (value.violations !== undefined && (!Array.isArray(value.violations) || !value.violations.every(item => isViolation(item) && item.sessionId === value.sessionId)))
    || (value.prSnapshot !== undefined && (!isRecord(value.prSnapshot) || !hasOnlyKeys(value.prSnapshot, ['unit', 'number', 'fields']) || !isIdentity(value.prSnapshot.unit)
      || !isSafeInteger(value.prSnapshot.number) || Number(value.prSnapshot.number) <= 0 || !isPrFields(value.prSnapshot.fields)))
    || (value.skills !== undefined && !isStringArray(value.skills))
    || (value.handoff !== undefined && (!isRecord(value.handoff) || !(
      (value.handoff.state === 'running' && hasOnlyKeys(value.handoff, ['state'])) || (value.handoff.state === 'failed' && hasOnlyKeys(value.handoff, ['state', 'reason']) && typeof value.handoff.reason === 'string'))))) return false
  return true
}

/**
 * Identifies a shared declaration without accepting retired flows.
 * @param value - The decoded JSON.
 * @returns Whether the declaration is valid.
 */
function isUnitRecord(value: unknown): value is UnitRecord {
  return isRecord(value) && hasOnlyKeys(value, ['v', 'identity', 'flow', 'generation']) && value.v === 1 && isIdentity(value.identity) && typeof value.flow === 'string'
    && (value.generation === undefined || typeof value.generation === 'string') && Object.hasOwn(flowDefinitions.flows, value.flow)
}

/**
 * Identifies a recognized GitHub reachability state.
 * @param value - The decoded status.
 * @returns Whether the status is recognized.
 */
function isGithubStatus(value: unknown): value is GithubStatus {
  return githubStatuses.some(status => status === value)
}

/**
 * Validates a complete disk session without filling missing fields.
 * @param value - The decoded JSON.
 * @returns The valid record, or null.
 */
export function parseSession(value: unknown): SessionRecord | null {
  return isSessionRecord(value) ? value : null
}

/**
 * Validates a shared declaration without accepting retired flows.
 * @param value - The decoded JSON.
 * @returns The valid declaration, or null.
 */
export function parseUnitRecord(value: unknown): UnitRecord | null {
  return isUnitRecord(value) ? value : null
}

/**
 * Validates an observed slice end record with exactly its keys.
 * @param value - The decoded JSON.
 * @returns The valid record, or null.
 */
export function parseObservedEnd(value: unknown): ObservedEndRecord | null {
  return isRecord(value) && hasOnlyKeys(value, ['v', 'identity', 'generation', 'end']) && value.v === 1 && isIdentity(value.identity)
    && isNonEmptyString(value.generation) && isNonEmptyString(value.end) ? { v: 1, identity: value.identity, generation: value.generation, end: value.end } : null
}

/**
 * Builds a chat record before its first declaration.
 * @param sessionId - The engine session id.
 * @returns An empty session with derived flow fields.
 */
export const createEmptySession = (sessionId: string): Session => ({
  v: 1, sessionId, unit: null, units: [], flow: null, issues: [], info: {},
  blocked: { edits: 0 }, gh: 'unknown', isLong: false,
})

/**
 * Builds a unit with no evidence yet.
 * @returns The empty evidence.
 */
export const createEmptyUnit = (): Unit => ({ skills: [], verifyRuns: [], runs: [] })

/**
 * Joins two skill lists, each skill once, in first-seen order.
 *
 * @param recorded - The skills already on record.
 * @param added - The skills to add.
 * @returns The union of both lists.
 */
export const mergeSkills = (recorded: string[], added: string[]): string[] => [...new Set([...recorded, ...added])]

/**
 * Orders runs newest first, breaking time ties by run id so the order never depends on input order.
 * @param a - One run.
 * @param b - The other run.
 * @returns The sort comparison.
 */
const newestFirst = (a: RunRecord, b: RunRecord): number => b.at - a.at || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0)

/**
 * Finds the earliest failing run, the reference Diagnose measures its comment against.
 * @param runs - The unit's command history.
 * @returns The earliest failing run, if any.
 */
export const findEarliestRed = (runs: RunRecord[]): RunRecord | undefined =>
  runs.filter(run => run.outcome.kind !== 'pass').sort(newestFirst).at(-1)

/**
 * Keeps, newest first across chat contributions, each argv's newest runs and its earliest red, newest argvs first up to a
 * total cap; the unit's earliest red survives the cap, so a red no approval pins yet stays the Diagnose reference.
 * @param runs - The contributed runs.
 * @returns The bounded command history.
 */
export function retainRuns(runs: RunRecord[]): RunRecord[] {
  const ordered = [...new Map(runs.map(run => [run.runId, run])).values()].sort(newestFirst)
  const argvs = [...new Set(ordered.map(run => JSON.stringify(run.argv)))]
  const kept = argvs.flatMap(argv => {
    const history = ordered.filter(run => JSON.stringify(run.argv) === argv)
    const red = findEarliestRed(history)
    const newest = history.slice(0, runsPerArgv)
    return red && !newest.includes(red) ? [...newest.slice(0, -1), red] : newest
  })
  const red = findEarliestRed(ordered)
  const capped = kept.slice(0, totalRuns)
  return (red && !capped.includes(red) ? [...capped.slice(0, -1), red] : capped).sort(newestFirst)
}

/**
 * Serializes a unit identity so equivalent identities read the same.
 * @param identity - The identity.
 * @returns Its branch and issues as one string.
 */
export function canonicalIdentity(identity: Identity): string {
  return JSON.stringify({ branch: identity.branch, issues: identity.issues })
}

/**
 * Compares canonical unit identities.
 * @param left - One identity.
 * @param right - The other identity.
 * @returns Whether both name the same branch and exact issue set.
 */
export const sameIdentity = (left: Identity, right: Identity): boolean => canonicalIdentity(left) === canonicalIdentity(right)
