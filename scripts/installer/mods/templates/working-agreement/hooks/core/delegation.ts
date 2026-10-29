import { coversIssues, describeScope, parseScope, widenScope } from '../domain/delegation'
import type { DelegateRequest, DelegationScope } from '../domain/delegation'
import { removeFile } from '../lib/files'
import { readJson } from '../lib/json'
import { hasExitedZero } from '../lib/process'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { mergeUnique } from '../domain/records'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { atomicReplace, readCommonDir, readSession, recordsPath, updateUnits } from './record-store'
import { withRecordLock } from './session-memory'
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
 * Finds the scope that delegates a unit, in any coordinator of the repository.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @param strict - Whether an unreadable bucket or scope throws, for a caller to which not delegating is the unsafe direction.
 * @returns The covering scope, or null; unless strict, an unlistable bucket or an unreadable scope counts as not delegating.
 */
export async function findDelegation(port: EnginePort, issues: number[], strict = false): Promise<DelegationScope | null> {
  const common = await readCommonDir(port)
  if (!common || !issues.length) return null
  const directory = recordsPath(common, bucket)
  const entries = await port.files.list(directory).catch(async (error: unknown) => {
    // The bucket is created by the first /flow delegate.
    if (strict && await port.files.stat(directory).then(() => true, () => false)) throw error
    return []
  })
  for (const { name } of entries.filter(entry => entry.name.endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name))) {
    const scope = parseScope(await readJson(port.files, recordsPath(common, bucket, name)).catch((error: unknown) => { if (strict) throw error; return undefined }))
    if (scope && name === `${scope.sessionId}.json` && coversIssues(scope, issues)) return scope
  }
  return null
}

/**
 * Runs the user's `/flow delegate`: widens this coordinator's scope, or revokes it.
 * @param port - The engine calls.
 * @param request - The parsed command.
 * @param isPushGuarded - Whether a GitHub ruleset requires signed commits; the scope shows `push unguarded` otherwise.
 * @returns The reply, or the refusal outside a coordinator session.
 */
export function runDelegate(port: EnginePort, request: DelegateRequest, isPushGuarded = true): Promise<Result<string>> {
  return withRecordLock(async () => {
    if (!isCoordinatorSession(await readSession(port))) return fail('/flow delegate needs a coordinator session — run /flow coordinate first, in a session with no flow.')
    const sessionId = await port.readSessionId()
    const path = await scopePath(port, sessionId)
    const scope = await readOwnScope(port)
    if (request.kind === 'stop') {
      if (!scope) return succeed('No delegation to stop.')
      const removed = hasExitedZero(await removeFile(port.processes, path))
      return removed.isOk ? succeed(`Delegation stopped (was ${describeScope(scope)}): those issues are the user's again.`) : fail(`Delegation not stopped: ${removed.error}`)
    }
    const widened = widenScope(scope, sessionId, request.issues, !isPushGuarded)
    await atomicReplace(port, path, JSON.stringify(widened))
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
 * Records one of the user's steps as delegated when it was taken in a delegated unit.
 * The mod cannot tell the coordinator's typing, through herdr, from the user's own, so a step taken while the unit is delegated
 * is the coordinator's by the scope, and one taken outside it stays the user's.
 * @param port - The engine calls.
 * @param command - The step's command, as the records and the pane show it.
 * @returns Whether the step was recorded as delegated.
 */
export function recordDelegatedStep(port: EnginePort, command: string): Promise<boolean> {
  return withRecordLock(async () => {
    const session = await readSession(port)
    if (!session.unit || !await findDelegation(port, session.issues)) return false
    await updateUnits(port, session, unit => ({ ...unit, delegated: mergeUnique(unit.delegated ?? [], [command]) }))
    logEvent(port, session, 'delegated', { command })
    return true
  })
}
