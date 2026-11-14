import type { IssueRebind, RebindOutcome } from '../domain/delegation'
import { isRecord } from '../lib/guards'
import { readJson } from '../lib/json'
import { formatErrorLine, settle, succeed } from '../lib/result'
import { findCoveringScope } from './delegation'
import type { EnginePort } from './engine-port'
import type { HeldLock } from './host-lock'
import { UnansweredRenameError } from './host-lock'
import { atomicReplace, LostFenceError, readCommonDir } from './record-store'
import { progressPath, readProgressFile, resolveSpawnedSession, withSpawnLock } from './spawn'

/**
 * Rebinds a unit's spawn records from the session a handoff cleared to the one that continues it, under the spawn lock, so no spawn,
 * escalation or retirement reads or writes a record halfway: each record that names the previous session gets the new one and records
 * the previous one as superseded, every other field kept. Only the local records decide which are rebound; the scopes, which may need
 * GitHub, are read only to tell a unit no scope covers from a delegated one when no record named the previous session.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @param previous - The session the handoff cleared.
 * @param current - The session that continues the unit.
 * @returns What was established; never throws, a failure being an unknown outcome of each issue it left unread.
 */
export async function rebindUnitSession(port: EnginePort, issues: number[], previous: string, current: string): Promise<RebindOutcome> {
  const common = await readCommonDir(port).catch(() => null)
  const unknownAll = (error: string): RebindOutcome => ({ kind: 'checked', issues: issues.map(issue => ({
    issue, path: common ? progressPath(common, issue) : `spawn/${issue}.json under working-agreement in git rev-parse --git-common-dir`, kind: 'unknown', error })) })
  if (!common) return unknownAll('the git common directory could not be read')
  const held = await withSpawnLock(port, async (_common, _root, lock) => succeed(await rebindLocked(port, common, issues, previous, current, lock)))
    .catch((error: unknown) => ({ isOk: false as const, error: formatErrorLine(error) }))
  return held.isOk ? held.value : unknownAll(held.error)
}

/**
 * Runs the rebind while this process holds the spawn lock.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issues - The unit's issues.
 * @param previous - The session the handoff cleared.
 * @param current - The session that continues the unit.
 * @param lock - The held spawn lock, whose rename lands each write only while the lock is held.
 * @returns What was established.
 */
async function rebindLocked(port: EnginePort, common: string, issues: number[], previous: string, current: string, lock: HeldLock): Promise<RebindOutcome> {
  const outcomes: IssueRebind[] = []
  for (const issue of issues) outcomes.push(await rebindIssue(port, common, issue, previous, current, lock))
  if (outcomes.some(entry => entry.kind !== 'unrelated')) return { kind: 'checked', issues: outcomes }
  const covered = await settle(findCoveringScope(port, issues, true))
  if (!covered.isOk) return { kind: 'checked', issues: outcomes, scopeError: covered.error }
  return covered.value ? { kind: 'checked', issues: outcomes } : { kind: 'undelegated' }
}

/**
 * Rebinds one issue's spawn record.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue.
 * @param previous - The session the handoff cleared.
 * @param current - The session that continues the unit.
 * @param lock - The held spawn lock.
 * @returns What was established for the issue.
 */
async function rebindIssue(port: EnginePort, common: string, issue: number, previous: string, current: string, lock: HeldLock): Promise<IssueRebind> {
  const path = progressPath(common, issue)
  // why: the raw record is rewritten, so a field this load does not know survives the rebind.
  const raw = await settle(readJson(port.files, path))
  if (!raw.isOk) return { issue, path, kind: 'unknown', error: raw.error }
  if (raw.value === undefined) return { issue, path, kind: 'unrelated', reason: 'the file does not exist' }
  const read = await settle(readProgressFile(port, common, issue, true).then(async progress => ({ progress, session: await resolveSpawnedSession(common, issue, progress) })))
  if (!read.isOk) return { issue, path, kind: 'unknown', error: read.error }
  const { progress, session } = read.value
  if (session === current) return { issue, path, kind: 'rebound' }
  if (session !== previous || !isRecord(raw.value)) return { issue, path, kind: 'unrelated', reason: session ? `it names session ${session}` : 'it names no session' }
  const predecessors = [...new Set([...progress.predecessors ?? [], previous])]
  // why: the fenced rename lands only while this process holds the lock, so a rebind that lost it never renames a stale copy over a newer owner's record.
  const written = await atomicReplace(port, path, JSON.stringify({ ...raw.value, sessionId: current, predecessors }), undefined, lock).then(() => null, (error: unknown) => error)
  if (written === null) return { issue, path, kind: 'rebound' }
  if (written instanceof LostFenceError) return { issue, path, kind: 'unchanged', reason: 'this process lost the spawn lock before the write' }
  if (written instanceof UnansweredRenameError) return { issue, path, kind: 'unknown', error: written.message }
  // why: the holder answered the rename as failed, so the record was not replaced; it is read back to say what it names now.
  const after = await settle(readProgressFile(port, common, issue, true).then(each => resolveSpawnedSession(common, issue, each)))
  if (!after.isOk) return { issue, path, kind: 'unknown', error: `its write failed (${formatErrorLine(written)}), and reading it back failed: ${after.error}` }
  if (after.value === current) return { issue, path, kind: 'rebound' }
  return { issue, path, kind: 'unchanged', reason: `its write failed: ${formatErrorLine(written)}${after.value === previous ? '' : `, and it now names ${after.value ? `session ${after.value}` : 'no session'}`}` }
}
