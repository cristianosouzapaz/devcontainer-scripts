import { succeed } from '../lib/result'
import { bestEffort } from './best-effort'
import { readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { clearStallRecord } from './liveness'
import { readCommonDir } from './record-store'
import { busyWaitMs, closeOpenAssign, readProgressFile, withSpawnLock, writeProgress } from './spawn'
import { readUnitHost } from './unit-host'

/** What a close did: to the session, nothing, closed, or put off until the unit's turn ends; and the open start assignment it closed, if any. */
interface Closed { session: Closing; assign: string | null }

/** What a close did to the session. */
type Closing = 'none' | 'closed' | 'deferred'

// why: a unit's turn-end notice reaches the coordinator while herdr may still report that turn as working.
const idleWaitMs = 5000

/**
 * Closes the herdr workspace of an integrated unit, once its session is idle: a unit that works is marked, and a later sweep closes it
 * when its turn ends. Only a workspace spawn opened for a unit spawn started is closed; its worktree, branch, records and transcript
 * stay, so a later spawn reopens the worktree and resumes the same session. A start assignment the unit never replied done to is closed
 * and recorded first: an integrated unit owes no more work, so a resume never reopens it.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @returns The sentences for merge_child's result, empty when there is no open assignment and no spawned session to close.
 */
export async function closeUnitSession(port: EnginePort, issue: number): Promise<string> {
  // why: an integrated unit owes no more work, so a stall reported before must not hold back the report of a later resume's stall.
  const common = await readCommonDir(port)
  if (common) await bestEffort(port, 'stall record clear', () => clearStallRecord(port, common, issue), undefined)
  const closed = await closeLocked(port, issue, busyWaitMs, true).catch((error: unknown) => error instanceof Error ? error.message : String(error))
  if (typeof closed === 'string') return ` #${issue}'s session is not closed: ${closed}`
  const assign = closed.assign ? ` #${issue}'s start assignment (message ${closed.assign}) is closed: integrated without a done.` : ''
  return assign + (closed.session === 'none' ? ''
    : closed.session === 'closed' ? ` #${issue}'s session is closed; its worktree, branch and records stay, and spawn ${issue} resumes it.`
      : ` #${issue}'s session is mid-turn, so its workspace is closed when that turn ends.`)
}

/**
 * Closes the session of every unit in this coordinator's scope that merge_child marked while it worked, once it is idle.
 * @param port - The engine calls.
 * @returns One notice per session closed.
 */
export async function closeIdleUnits(port: EnginePort): Promise<string[]> {
  const scope = await readOwnScope(port)
  const common = await readCommonDir(port)
  if (!scope || !common) return []
  const notices: string[] = []
  for (const issue of [...scope.issues].sort((a, b) => a - b)) {
    if (!(await readProgressFile(port, common, issue, false)).isClosing) continue
    if ((await closeLocked(port, issue, idleWaitMs)).session === 'closed') notices.push(`#${issue}'s turn ended, so its integrated unit's session is closed; spawn ${issue} resumes it.`)
  }
  return notices
}

/**
 * Closes a spawned unit's workspace under the spawn lock, so it never races a spawn, or marks it for closing while its agent works.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @param waitMs - How long a working agent is given to go idle.
 * @param isIntegrated - Whether merge_child just integrated the unit, so its open start assignment is closed too.
 * @returns What it did.
 * @throws When herdr or the lock fails.
 */
async function closeLocked(port: EnginePort, issue: number, waitMs: number, isIntegrated = false): Promise<Closed> {
  const host = await readUnitHost(port)
  if (!host) return { session: 'none', assign: null }
  const done = await withSpawnLock(port, async common => {
    const assign = isIntegrated ? await closeOpenAssign(port, common, issue) : null
    const { isClosing, ...progress } = await readProgressFile(port, common, issue, true)
    const own = (await host.list(port)).find(workspace => workspace.issue === issue)
    if (!progress.isStarted || !own) {
      if (isClosing) await writeProgress(port, common, issue, progress)
      return succeed<Closed>({ session: 'none', assign })
    }
    if (await host.state(port, own, waitMs) === 'working') {
      await writeProgress(port, common, issue, { ...progress, isClosing: true })
      return succeed<Closed>({ session: 'deferred', assign })
    }
    await host.close(port, own)
    if (isClosing) await writeProgress(port, common, issue, progress)
    return succeed<Closed>({ session: 'closed', assign })
  })
  if (!done.isOk) throw new Error(done.error)
  return done.value
}
