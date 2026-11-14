import { coversIssues, describeScope, parseScope, widenScope } from '../domain/delegation'
import { formatIssueReferences } from '../domain/messages'
import type { DelegateRequest, DelegationLookup, DelegationScope } from '../domain/delegation'
import type { SessionLiveness } from '../domain/process-host'
import { removeFile } from '../lib/files'
import { readGraphql } from '../lib/github'
import { isRecord } from '../lib/guards'
import { readJson, readJsonUnlessStrict } from '../lib/json'
import { hasExitedZero } from '../lib/process'
import { fail, settle, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { mergeUnique } from '../domain/records'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { explainSession, judgeSession, stampHost } from './host'
import type { LivenessJudgement } from './host'
import { atomicReplace, listRecordNames, readCommonDir, readSession, readSessionMirrors, recordsPath, updateUnits } from './record-store'
import { readSessionLiveness } from './session-host'
import { sessionMemory, withRecordLock } from './session-memory'
import { progressPath, readProgressFile, readSpawnedSession, resolveSpawnedSession } from './spawn'
import { unitAgent } from './unit-host'
import { isCoordinatorSession } from '../domain/coordinator'

// why: the scopes live beside the session mirrors, under the common directory every worktree shares, so a unit session in any worktree reads them; each file has one writer, its coordinator, so no cross-process write can lose an issue.
const bucket = 'delegation'

/**
 * Names a coordinator's scope file.
 * @param port - The engine calls.
 * @param sessionId - The coordinator session.
 * @returns The file path.
 */
async function scopePath(port: EnginePort, sessionId: string): Promise<string> {
  const common = await readCommonDir(port)
  if (!common) throw new Error('not in a repository')
  return recordsPath(common, bucket, `${sessionId}.json`)
}

/**
 * Reads this session's own scope; a file that is no valid scope reads as none.
 * @param port - The engine calls.
 * @returns The scope, or null when this session delegates nothing.
 * @throws When the file cannot be read: a failed read must not widen a scope from nothing.
 */
export async function readOwnScope(port: EnginePort): Promise<DelegationScope | null> {
  const sessionId = await port.readSessionId()
  const scope = parseScope(await readJson(port.files, await scopePath(port, sessionId)))
  return scope?.sessionId === sessionId ? scope : null
}

/**
 * Lists every coordinator's scope in the repository, in file-name order.
 * @param port - The engine calls.
 * @param strict - Whether an unreadable bucket or scope throws, for a caller to which not delegating is the unsafe direction.
 * @returns The valid scopes; unless strict, an unlistable bucket or an unreadable scope is left out.
 */
async function listScopes(port: EnginePort, strict: boolean): Promise<DelegationScope[]> {
  const common = await readCommonDir(port)
  if (!common) return []
  const directory = recordsPath(common, bucket)
  const names = strict ? await listRecordNames(port, directory) : await listRecordNames(port, directory).catch(() => [])
  const scopes: DelegationScope[] = []
  for (const name of names.filter(name => name.endsWith('.json')).sort((a, b) => a.localeCompare(b))) {
    const scope = parseScope(await readJsonUnlessStrict(port.files, recordsPath(common, bucket, name), strict, undefined))
    if (scope && name === `${scope.sessionId}.json`) scopes.push(scope)
  }
  return scopes
}

/**
 * Tells whether this session is the one spawn started for one of a unit's issues: a scope delegates that session only,
 * never another one that declares the same issues, even in the unit's own worktree.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @param strict - Whether an unreadable spawn record throws.
 * @returns Whether this session is the spawned unit.
 */
async function isSpawnedSession(port: EnginePort, issues: number[], strict: boolean): Promise<boolean> {
  const sessionId = await port.readSessionId()
  for (const issue of issues) {
    if (await readSpawnedSession(port, issue, strict) === sessionId) return true
  }
  return false
}

/**
 * Finds the scope that delegates this session's unit, in any coordinator of the repository, whether or not its coordinator
 * still runs: a guard that delegation adds holds until the scope is stopped.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @param strict - Whether an unreadable bucket, scope or spawn record throws, for a caller to which not delegating is the unsafe direction.
 * @returns The covering scope, or null when none covers the unit or this session is not the one spawn started for it;
 * unless strict, an unreadable record counts as not delegating.
 */
export async function findDelegation(port: EnginePort, issues: number[], strict = false): Promise<DelegationScope | null> {
  return findCovering(port, issues, strict, () => findCoveringScope(port, issues, strict))
}

/**
 * Finds the first scope that covers a unit, whichever session asks and whether or not its coordinator still runs.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @param strict - Whether an unreadable bucket, scope or parent throws.
 * @returns The covering scope, or null.
 */
export async function findCoveringScope(port: EnginePort, issues: number[], strict: boolean): Promise<DelegationScope | null> {
  for (const scope of await listScopes(port, strict)) if (await coversUnit(port, scope, issues, strict)) return scope
  return null
}

/**
 * Looks up whether this session is its unit's delegated session, as {@link findDelegation} does with strict reads, and says why not.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @returns The covering scope, or the reason none delegates this session; a failed read is unreadable, never not delegated.
 */
export async function lookUpDelegation(port: EnginePort, issues: number[]): Promise<DelegationLookup> {
  const common = await readCommonDir(port).catch(() => null)
  if (!common) return { kind: 'unreadable', error: 'the git common directory could not be read', path: 'git rev-parse --git-common-dir' }
  const current = await port.readSessionId()
  const recorded: { issue: number; path: string; session: string | null }[] = []
  for (const issue of issues) {
    const path = progressPath(common, issue)
    const read = await settle(readProgressFile(port, common, issue, true).then(progress => resolveSpawnedSession(common, issue, progress)))
    if (!read.isOk) return { kind: 'unreadable', error: read.error, path }
    recorded.push({ issue, path, session: read.value })
    if (read.value === current) return lookUpScope(port, common, issues)
  }
  const other = recorded.find(entry => entry.session)
  if (other?.session) return { kind: 'other-session', issue: other.issue, path: other.path, recorded: other.session, current }
  return { kind: 'no-record', issues, paths: recorded.map(entry => entry.path) }
}

/**
 * Finds the scope that covers this session's unit, naming the source a failed read came from: the scope files, or an issue's native
 * parent on GitHub.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issues - The unit's issues.
 * @returns The covering scope, no scope, or the failed read with where to check it.
 */
async function lookUpScope(port: EnginePort, common: string, issues: number[]): Promise<DelegationLookup> {
  const directory = recordsPath(common, bucket)
  const scopes = await settle(listScopes(port, true))
  if (!scopes.isOk) return { kind: 'unreadable', error: scopes.error, path: directory }
  for (const scope of scopes.value) {
    const covers = await settle(coversUnit(port, scope, issues, true))
    if (!covers.isOk) {
      const missed = issues.filter(issue => !scope.issues.includes(issue))
      return { kind: 'unreadable', error: covers.error, path: `the native parent of ${formatIssueReferences(missed, ', ')} on GitHub, with gh issue view ${missed[0] ?? ''}` }
    }
    if (covers.value) return { kind: 'scope', scope }
  }
  return { kind: 'no-scope', issues }
}

/**
 * Finds the scope that delegates this session's unit and whose coordinator still runs, for the actions only delegation allows.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @param strict - Whether an unreadable bucket, scope or spawn record throws.
 * @returns The covering live scope, or null; an orphaned scope delegates nothing, and a session spawn did not start is never delegated.
 */
export async function findLiveDelegation(port: EnginePort, issues: number[], strict = false): Promise<DelegationScope | null> {
  return findCovering(port, issues, strict, () => findLiveScope(port, issues, strict, true))
}

/**
 * Tells whether a scope delegates a unit: each issue the unit resolves is in the scope or is a native sub-issue of one that is, since
 * a group's unit declares the group's sub-issues beside it. The parents the scope needs are read in one GitHub call, once a process.
 * @param port - The engine calls.
 * @param scope - The scope.
 * @param issues - The unit's issues.
 * @param strict - Whether an unreadable parent throws; otherwise it counts as not covered.
 * @returns Whether the unit is delegated; a unit with no issues never is.
 * @throws When strict and the parents cannot be read.
 */
export async function coversUnit(port: EnginePort, scope: DelegationScope, issues: number[], strict: boolean): Promise<boolean> {
  const missed = issues.filter(issue => !scope.issues.includes(issue))
  if (!issues.length || !missed.length) return coversIssues(scope, issues)
  const error = await readParents(port, missed)
  if (error) {
    if (strict) throw new Error(`cannot read the native parents of ${missed.map(issue => `#${issue}`).join(', ')}: ${error}`)
    return false
  }
  return missed.every(issue => scope.issues.includes(sessionMemory.parentIssues.get(issue) ?? 0))
}

/**
 * Reads into session memory the native parent of each issue not yet there, in one GitHub call: a parent rarely changes, and the guards
 * and the pane check delegation on every call, so each is read once a process and outlasts a later GitHub outage.
 * @param port - The engine calls.
 * @param issues - The issues.
 * @returns Null once every parent is known, else why one is not.
 */
async function readParents(port: EnginePort, issues: number[]): Promise<string | null> {
  const unread = issues.filter(issue => !sessionMemory.parentIssues.has(issue))
  if (!unread.length) return null
  const query = unread.map(issue => `i${issue}:issue(number:${issue}){parent{number}}`).join(' ')
  const read = await readGraphql(port.processes, `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${query}}}`)
  if (!read.isOk) return read.error
  for (const issue of unread) {
    const fields = read.value[`i${issue}`]
    // why: an answer without the issue's field is no answer, so it is read again rather than held as no parent.
    if (isRecord(fields)) sessionMemory.parentIssues.set(issue, isRecord(fields.parent) ? Number(fields.parent.number) : null)
  }
  return unread.every(issue => sessionMemory.parentIssues.has(issue)) ? null : 'unreadable gh output'
}

/**
 * Finds a scope for this session's unit only when this session is the one spawn started for it.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @param strict - Whether an unreadable spawn record throws.
 * @param find - Finds the scope once the session is the spawned unit.
 * @returns What find returns, or null for no issues or a session spawn did not start.
 */
async function findCovering(port: EnginePort, issues: number[], strict: boolean, find: () => Promise<DelegationScope | null>): Promise<DelegationScope | null> {
  if (!issues.length || !await isSpawnedSession(port, issues, strict)) return null
  return find()
}

/**
 * Finds the scope covering issues whose coordinator still runs, whichever session asks: for what any session may know,
 * never for an action only delegation allows.
 * @param port - The engine calls.
 * @param issues - The issues.
 * @param strict - Whether an unreadable bucket or scope throws.
 * @param isUnit - Whether the issues are a unit's, which a scope also covers through their native parents.
 * @returns The covering live scope, or null.
 */
export async function findLiveScope(port: EnginePort, issues: number[], strict: boolean, isUnit = false): Promise<DelegationScope | null> {
  for (const scope of await listScopes(port, strict)) {
    if (!(isUnit || coversIssues(scope, issues)) || await readLiveness(port, scope) !== 'live') continue
    if (!isUnit || await coversUnit(port, scope, issues, strict)) return scope
  }
  return null
}

/**
 * Finds the first issue a declaration would take from a delegated unit that runs in another session: the issue's own unit, or the unit
 * of its native parent, which a group's unit declares beside the group.
 * @param port - The engine calls.
 * @param issues - The issues to declare.
 * @returns The refusal naming the unit's session, or null when no running unit of a live scope holds any of them.
 */
export async function findHeldIssue(port: EnginePort, issues: number[]): Promise<string | null> {
  const sessionId = await port.readSessionId()
  const hasScope = (await listScopes(port, false)).length > 0
  for (const issue of issues) {
    const own = await readSpawnedSession(port, issue, false)
    // why: only a delegated issue is held, so without any scope no parent is read from GitHub.
    const parent = own || !hasScope || await readParents(port, [issue]) ? undefined : sessionMemory.parentIssues.get(issue) ?? undefined
    const unit = own ? issue : parent
    const holder = own ?? (parent ? await readSpawnedSession(port, parent, false) : null)
    if (!holder || !unit || holder === sessionId || !await findLiveScope(port, [unit], false) || await readSessionLiveness(port, holder) !== 'live') continue
    return `#${issue} is delegated: its unit runs in session ${holder} (herdr agent ${unitAgent(unit)}). Work on it there, or ask the coordinator to retire it first.`
  }
  return null
}

/**
 * Judges whether a scope's coordinator session still runs, from the process the scope records.
 * @param port - The engine calls.
 * @param scope - The scope.
 * @returns `live` for this session's own scope or a running recorded process, `gone` once that process ended or its pid was
 * reused, and `unknown` without a recorded process or outside its pid namespace and boot.
 */
export async function readLiveness(port: EnginePort, scope: DelegationScope): Promise<SessionLiveness> {
  return judgeSession(port, scope.sessionId, async () => scope.host)
}

/**
 * Judges whether a coordinator can escalate an issue's unit: by the escalation sweep's own predicate, a scope whose issues hold the
 * issue itself, never through a native parent, and whose coordinator runs.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @returns `live` when such a coordinator runs, `gone` when every scope holding the issue ended or none holds it, and `unknown`, with
 * why, when the scopes cannot be read or a holding scope's coordinator cannot be judged.
 */
export async function judgeEscalator(port: EnginePort, issue: number): Promise<LivenessJudgement> {
  const listed = await listScopes(port, true).then(scopes => ({ scopes }), (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
  if ('error' in listed) return { liveness: 'unknown', why: `the delegation scopes cannot be read: ${listed.error}` }
  const whys: string[] = []
  for (const scope of listed.scopes.filter(each => coversIssues(each, [issue]))) {
    const judged = await explainSession(port, scope.sessionId, async () => scope.host)
    if (judged.liveness === 'live') return judged
    if (judged.liveness === 'unknown') whys.push(`coordinator ${scope.sessionId}: ${judged.why}`)
  }
  return whys.length ? { liveness: 'unknown', why: whys.join('; ') } : { liveness: 'gone' }
}

/**
 * Records this process in a scope, or drops a stale record where the host exposes no full identity.
 * @param port - The engine calls.
 * @param scope - The scope.
 * @returns The scope with the current process.
 */
async function stampScope(port: EnginePort, scope: DelegationScope): Promise<DelegationScope> {
  const { host: staleHost, ...rest } = scope
  const host = await stampHost(port)
  return host ? { ...rest, host } : rest
}

/**
 * Keeps this coordinator's scope naming its current process, which a resume or a reload of the session changes.
 * @param port - The engine calls.
 * @returns Once the scope names this process, or at once outside a coordinator that delegates.
 */
export function refreshScopeHost(port: EnginePort): Promise<void> {
  return withRecordLock(async () => {
    if (!isCoordinatorSession(await readSession(port))) return
    const scope = await readOwnScope(port)
    if (!scope) return
    const stamped = await stampScope(port, scope)
    if (JSON.stringify(stamped) !== JSON.stringify(scope)) await atomicReplace(port, await scopePath(port, scope.sessionId), JSON.stringify(stamped))
  })
}

/**
 * Ends this coordinator's own scope and every scope whose coordinator is gone or cannot be judged, from any session,
 * and records in each delegated unit's transition log which session ended it.
 * @param port - The engine calls.
 * @returns The reply, or the failure of a removal.
 */
async function stopDelegation(port: EnginePort): Promise<Result<string>> {
  const sessionId = await port.readSessionId()
  const own = isCoordinatorSession(await readSession(port)) ? await readOwnScope(port) : null
  const others = (await listScopes(port, false)).filter(scope => scope.sessionId !== sessionId)
  const liveness = await Promise.all(others.map(scope => readLiveness(port, scope)))
  const orphaned = others.filter((_, index) => liveness[index] !== 'live')
  const ended = [...own ? [own] : [], ...orphaned]
  if (!ended.length) return succeed(others.length ? 'No delegation to stop here: every other coordinator still runs — stop each in its own session.' : 'No delegation to stop.')
  // why: an unreadable mirror loses only its unit's log line, never the stop.
  const mirrors = await readSessionMirrors(port).catch(() => [])
  const lines: string[] = []
  for (const scope of ended) {
    const removed = hasExitedZero(await removeFile(port.processes, await scopePath(port, scope.sessionId)))
    if (!removed.isOk) return fail(`Delegation not stopped: ${removed.error}`)
    const units = new Map(mirrors.flatMap(({ session }) => session.unit && coversIssues(scope, session.unit.issues) ? [[JSON.stringify(session.unit), session]] : []))
    for (const session of units.values()) logEvent(port, { ...session, flow: null, issues: session.unit?.issues ?? [] }, 'delegation-ended', { coordinator: scope.sessionId, by: sessionId })
    lines.push(scope === own ? 'Delegation stopped' : `Orphaned delegation of coordinator ${scope.sessionId} stopped`,
      `  ${'Scope'.padEnd(13)}${describeScope(scope, false)} → yours again`,
      `  ${'Ruleset'.padEnd(13)}${scope.isPushUnguarded ? 'no signed-commit ruleset (recommended)' : 'signed commits required'}`)
  }
  return succeed(lines.join('\n'))
}

/**
 * Runs the user's `/flow delegate`: widens this coordinator's scope, or revokes it and every orphaned one.
 * @param port - The engine calls.
 * @param request - The parsed command.
 * @param isPushGuarded - Whether a GitHub ruleset requires signed commits; the scope shows `no signed-commit ruleset` otherwise.
 * @returns The reply, or the refusal of a widening outside a coordinator session.
 */
export function runDelegate(port: EnginePort, request: DelegateRequest, isPushGuarded = true): Promise<Result<string>> {
  return withRecordLock(async () => {
    if (request.kind === 'stop') return stopDelegation(port)
    if (!isCoordinatorSession(await readSession(port))) return fail('/flow delegate needs a coordinator session — run /flow coordinate first, in a session with no flow.')
    const sessionId = await port.readSessionId()
    const path = await scopePath(port, sessionId)
    const scope = await readOwnScope(port)
    const { environment, paneId } = await port.readHerdrEnv()
    const widened = widenScope(scope, sessionId, request.issues, !isPushGuarded, request.isTriage, request.instructions, environment === '1' && paneId ? paneId : scope?.paneId)
    await atomicReplace(port, path, JSON.stringify(await stampScope(port, widened)))
    return succeed(`Delegating ${describeScope(widened)} until /flow delegate stop.`)
  })
}

/**
 * Adds an issue this coordinator just created to its scope, while the scope covers created issues.
 * @param port - The engine calls.
 * @param issue - The created issue.
 * @returns Whether the issue joined the scope.
 */
export function addCreatedIssue(port: EnginePort, issue: number): Promise<boolean> {
  return withRecordLock(async () => {
    if (!isCoordinatorSession(await readSession(port))) return false
    const scope = await readOwnScope(port)
    if (!scope?.coversCreated) return false
    await atomicReplace(port, await scopePath(port, scope.sessionId), JSON.stringify(widenScope(scope, scope.sessionId, [issue])))
    return true
  })
}

/**
 * Records one of the user's steps as delegated when it was taken in a unit a running coordinator delegates.
 * A step taken while the unit is delegated is the coordinator's by the scope, whether its mod applied a relayed step or the composer
 * ran it, since text typed into a pane reads as the user's; one taken outside the scope stays the user's.
 * @param port - The engine calls.
 * @param command - The step's command, as the records and the pane show it.
 * @returns Whether the step was recorded as delegated.
 */
export function recordDelegatedStep(port: EnginePort, command: string): Promise<boolean> {
  return withRecordLock(async () => {
    const session = await readSession(port)
    if (!session.unit || !await findLiveDelegation(port, session.issues)) return false
    await updateUnits(port, session, unit => ({ ...unit, delegated: mergeUnique(unit.delegated ?? [], [command]) }))
    logEvent(port, session, 'delegated', { command })
    return true
  })
}
