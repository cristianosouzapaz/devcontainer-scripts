import { coversIssues, describeScope, parseScope, widenScope } from '../domain/delegation'
import type { DelegateRequest, DelegationScope } from '../domain/delegation'
import type { SessionLiveness } from '../domain/process-host'
import { removeFile } from '../lib/files'
import { readJson, readJsonUnlessStrict } from '../lib/json'
import { hasExitedZero } from '../lib/process'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { mergeUnique } from '../domain/records'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { judgeSession, stampHost } from './host'
import { atomicReplace, listRecordNames, readCommonDir, readSession, readSessionMirrors, recordsPath, updateUnits } from './record-store'
import { readSessionLiveness } from './session-host'
import { withRecordLock } from './session-memory'
import { readSpawnedSession, unitAgent } from './spawn'
import { isCoordinatorSession } from '../domain/coordinator'

// why: The scopes live beside the session mirrors, under the common directory every worktree shares, so a unit session
// in any worktree reads them; each file has one writer, its coordinator, so no cross-process write can lose an issue.
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
  return findCovering(port, issues, strict, async () => (await listScopes(port, strict)).find(scope => coversIssues(scope, issues)) ?? null)
}

/**
 * Finds the scope that delegates this session's unit and whose coordinator still runs, for the actions only delegation allows.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @param strict - Whether an unreadable bucket, scope or spawn record throws.
 * @returns The covering live scope, or null; an orphaned scope delegates nothing, and a session spawn did not start is never delegated.
 */
export async function findLiveDelegation(port: EnginePort, issues: number[], strict = false): Promise<DelegationScope | null> {
  return findCovering(port, issues, strict, () => findLiveScope(port, issues, strict))
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
 * Finds the scope covering issues whose coordinator still runs, whichever session asks.
 * @param port - The engine calls.
 * @param issues - The issues.
 * @param strict - Whether an unreadable bucket or scope throws.
 * @returns The covering live scope, or null.
 */
async function findLiveScope(port: EnginePort, issues: number[], strict: boolean): Promise<DelegationScope | null> {
  for (const scope of (await listScopes(port, strict)).filter(scope => coversIssues(scope, issues))) {
    if (await readLiveness(port, scope) === 'live') return scope
  }
  return null
}

/**
 * Finds the first issue a declaration would take from a delegated unit that runs in another session.
 * @param port - The engine calls.
 * @param issues - The issues to declare.
 * @returns The refusal naming the unit's session, or null when no running unit of a live scope holds any of them.
 */
export async function findHeldIssue(port: EnginePort, issues: number[]): Promise<string | null> {
  const sessionId = await port.readSessionId()
  for (const issue of issues) {
    const holder = await readSpawnedSession(port, issue, false)
    if (!holder || holder === sessionId || !await findLiveScope(port, [issue], false) || await readSessionLiveness(port, holder) !== 'live') continue
    return `#${issue} is delegated: its unit runs in session ${holder} (herdr agent ${unitAgent(issue)}). Work on it there, or ask the coordinator to retire it first.`
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
 * Records this process in a scope, or drops a stale record where the host exposes no full identity.
 * @param port - The engine calls.
 * @param scope - The scope.
 * @returns The scope with the current process.
 */
async function stampScope(port: EnginePort, scope: DelegationScope): Promise<DelegationScope> {
  const { host: _host, ...rest } = scope
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
  // An unreadable mirror loses only its unit's log line, never the stop.
  const mirrors = await readSessionMirrors(port).catch(() => [])
  const lines: string[] = []
  for (const scope of ended) {
    const removed = hasExitedZero(await removeFile(port.processes, await scopePath(port, scope.sessionId)))
    if (!removed.isOk) return fail(`Delegation not stopped: ${removed.error}`)
    const units = new Map(mirrors.flatMap(({ session }) => session.unit && coversIssues(scope, session.unit.issues) ? [[JSON.stringify(session.unit), session]] : []))
    for (const session of units.values()) logEvent(port, { ...session, flow: null, issues: session.unit?.issues ?? [] }, 'delegation-ended', { coordinator: scope.sessionId, by: sessionId })
    lines.push(scope === own ? `Delegation stopped (was ${describeScope(scope)}): those issues are the user's again.`
      : `Orphaned delegation of coordinator ${scope.sessionId} stopped (was ${describeScope(scope)}): those issues are the user's again.`)
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
 * The mod cannot tell the coordinator's typing, through herdr, from the user's own, so a step taken while the unit is delegated
 * is the coordinator's by the scope, and one taken outside it stays the user's.
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
