import type { PublishFault } from '../domain/liveness'
import { moduleState } from '../lib/module-state'
import { formatError } from '../lib/result'
import type { EnginePort } from './engine-port'
import { UnansweredRenameError, hostLockPath, withHostLock } from './host-lock'
import type { HeldLock } from './host-lock'
import { LostFenceError, readCommonDir } from './record-store'
import { clearFault, raiseFault } from './fault-registry'
import { describePublishFault } from '../domain/liveness'

/** How a fenced publish ended: written, written or not as its holder ended before answering the rename, or refused with nothing written. */
export type PublishOutcome = 'confirmed' | 'unknown' | 'refused'

/** How long a publish waits for its publish lock before it writes nothing and leaves the record to the next tick. */
const publishWaitMs = 5000
// why: a hold names its module load, so a reader of the queue tells two loads of one session apart.
const holds = moduleState(() => ({ nonce: crypto.randomUUID().replaceAll('-', '').slice(0, 12), sequence: 0 }))

/** How many fixed publish locks the sessions share. */
const publishStripes = 16

/**
 * Names the host lock every publish of a session's activity record and session mirror takes: one of a fixed set of stripes, created once
 * and never removed like the Verify and spawn locks, so the lock files stay bounded and no unlink can split two loads onto two inodes.
 * @param common - The git common directory.
 * @param sessionId - The session.
 * @returns The lock file's path.
 */
export function publishLockPath(common: string, sessionId: string): string {
  // why: a 31-multiplier string hash of the session id alone, so both module loads of one session, of any version that stripes, pick the same stripe.
  const hash = [...sessionId].reduce((sum, char) => (sum * 31 + (char.codePointAt(0) ?? 0)) >>> 0, 0)
  return hostLockPath(common, `publish-${hash % publishStripes}`)
}

/**
 * Runs a publish of one of this session's records while this module load holds the session's publish lock: two loads of the session are
 * live together after a reload, and each would otherwise read the record and replace it around the other's write. The lock is a
 * kernel lock held by a process for exactly as long as the work runs, so a stalled load delays a publish and never corrupts one. Any
 * outcome but the work done under the lock writes nothing: the cause is kept where the pane's Process row shows it, and the next tick
 * tries again; the work passes the hold to its rename, which the holder process itself performs while it holds the lock, so a rename
 * never lands after the lock was lost, and a rename its holder ended before answering is told apart as unknown, naming the record.
 * @param port - The engine calls.
 * @param file - The record the publish writes, which the row names.
 * @param work - The publish, given the hold.
 * @returns Confirmed when the publish ran to its end under the lock; unknown when its holder ended before answering its rename;
 * refused otherwise, having written nothing.
 */
export async function publishFenced(port: EnginePort, file: string, work: (held: HeldLock) => Promise<void>): Promise<PublishOutcome> {
  const common = await readCommonDir(port)
  if (!common) return 'refused'
  const sessionId = await port.readSessionId()
  const lock = publishLockPath(common, sessionId)
  const started = await port.now()
  const outcome = await withHostLock(port, lock, `${sessionId}/publish-${holds.nonce}-${++holds.sequence}`, async held => {
    try {
      await work(held)
      return null
    } catch (error) {
      return error instanceof LostFenceError ? 'lost' : error instanceof UnansweredRenameError ? 'unknown' : { cause: formatError(error) }
    }
  }, { deadline: started + publishWaitMs, renames: true }).catch((error: unknown) => ({ kind: 'failed' as const, error: formatError(error) }))
  const fault: PublishFault | null = outcome.kind === 'done' ? outcome.value === 'lost' || outcome.value === 'unknown' ? { kind: outcome.value, lock } : outcome.value ? { kind: 'write', lock, cause: outcome.value.cause } : null
    : outcome.kind === 'timeout' ? { kind: 'timeout', lock, waitedMs: await port.now() - started, check: `perl ${await port.readPluginRoot()}/scripts/host-lock.pl list ${lock}` }
      : { kind: 'failed', lock, cause: outcome.kind === 'failed' ? outcome.error : 'the wait was cancelled' }
  if (fault) raiseFault(`publish:${file}`, { row: 'Process', text: describePublishFault(file, fault), cause: fault.kind === 'write' ? fault.cause : describePublishFault(file, fault) })
  else clearFault(`publish:${file}`)
  return !fault ? 'confirmed' : fault.kind === 'unknown' ? 'unknown' : 'refused'
}
