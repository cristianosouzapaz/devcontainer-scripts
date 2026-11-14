import { isProcessStarted, readProcessState } from './process-state'
import type { ProcessHost } from '../../types'
import type { SessionLiveness } from '../domain/process-host'
import { parseHost } from '../domain/process-host'
import { removeFile } from '../lib/files'
import { isRecord } from '../lib/guards'
import { readJson } from '../lib/json'
import { hasExitedZero } from '../lib/process'
import { logFailure } from './best-effort'
import type { EnginePort } from './engine-port'
import { judgeSession, stampHost } from './host'
import { atomicReplace, readCommonDir, recordsPath, sweepBucket } from './record-store'

// why: A session's mirror is written only on its first record change and names no process, so whether another session still runs is read from this bucket, which every session refreshes on its tick, a resume changing its process.
const bucket = 'host'

/**
 * Records this session's process, when it changed since the last record.
 * @param port - The engine calls.
 * @returns Once the record names this process, or at once where the host exposes no full identity.
 */
export async function refreshSessionHost(port: EnginePort): Promise<void> {
  const common = await readCommonDir(port)
  const host = await stampHost(port)
  if (!common || !host) return
  // why: the record names the process an earlier version of the mod ran in, the evidence of whether its turn is this process's own, so it is never written over before that was read.
  if (!isProcessStarted() || (await readProcessState(port))?.legacy?.host === 'unread') return
  const path = recordsPath(common, bucket, `${await port.readSessionId()}.json`)
  const text = JSON.stringify(host)
  if (await port.files.read(path).catch(() => '') !== text) await atomicReplace(port, path, text)
}

/**
 * Judges whether another session still runs, from the process it last recorded.
 * @param port - The engine calls.
 * @param sessionId - The session.
 * @returns `live` for this session or a running recorded process, `gone` once it ended, and `unknown` without a readable record.
 */
export async function readSessionLiveness(port: EnginePort, sessionId: string): Promise<SessionLiveness> {
  return judgeSession(port, sessionId, async () => await readSessionHost(port, sessionId) ?? undefined)
}

/**
 * Reads the process another session last recorded.
 * @param port - The engine calls.
 * @param sessionId - The session.
 * @returns The process, or null without a readable record.
 */
export async function readSessionHost(port: EnginePort, sessionId: string): Promise<ProcessHost | null> {
  const common = await readCommonDir(port)
  // why: a record that cannot be read names no process, which liveness judges unknown, never gone.
  return common ? parseHost(await readJson(port.files, recordsPath(common, bucket, `${sessionId}.json`)).catch(() => undefined)) : null
}

/**
 * Tells whether two sessions last recorded the same process, as a session a handoff cleared and the one that went on in its process do.
 * @param port - The engine calls.
 * @param first - One session.
 * @param second - The other session.
 * @returns Whether both records are readable and name the same process.
 */
export async function isSameProcess(port: EnginePort, first: string, second: string): Promise<boolean> {
  const [one, other] = await Promise.all([readSessionHost(port, first), readSessionHost(port, second)])
  return !!one && !!other && isSameHost(one, other)
}

/**
 * Tells whether two recorded processes are the same one.
 * @param one - One process.
 * @param other - The other process.
 * @returns Whether every field that identifies a process matches.
 */
export function isSameHost(one: ProcessHost, other: ProcessHost): boolean {
  return one.pid === other.pid && one.pidStart === other.pidStart && one.pidns === other.pidns && one.bootId === other.bootId
}

/**
 * Reads the process a session last recorded, telling a record that cannot be read from one that is absent.
 * @param port - The engine calls.
 * @param sessionId - The session.
 * @returns The process, or null without a record, inside an object; null itself when the record could not be read.
 */
export async function readSessionHostStrictly(port: EnginePort, sessionId: string): Promise<{ value: ProcessHost | null } | null> {
  const common = await readCommonDir(port)
  if (!common) return { value: null }
  return readJson(port.files, recordsPath(common, bucket, `${sessionId}.json`)).then(value => ({ value: parseHost(value) }), () => null)
}

/**
 * Removes the process and activity records of every session whose recorded process ended, but for a session a spawn record still names.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @returns Once every record was judged.
 */
export async function pruneSessionHosts(port: EnginePort, common: string): Promise<void> {
  // why: a coordinator's tick tells a dead unit from one it cannot judge by this record, so a spawned session's outlives its process.
  const spawned = await readSpawnedSessions(port, common)
  await sweepBucket(port, common, bucket, async name => {
    const session = name.match(/^([^.][^/\\]*)\.json$/)?.[1]
    // why: a session's activity record means nothing once its process ended, so it goes with the host record.
    if (session && !spawned.has(session) && await readSessionLiveness(port, session) === 'gone') {
      logFailure(port, 'session host delete', hasExitedZero(await removeFile(port.processes, recordsPath(common, bucket, name), recordsPath(common, 'activity', name))))
    }
  })
}

/**
 * Lists the sessions the spawn records name.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @returns The session ids; an unreadable record names none.
 */
async function readSpawnedSessions(port: EnginePort, common: string): Promise<Set<string>> {
  const names = (await port.files.list(recordsPath(common, 'spawn')).catch(() => [])).map(entry => entry.name).filter(name => /^\d+\.json$/.test(name))
  // why: a spawn record that cannot be read names no session, which is then judged by its process alone, as any other session is.
  const records = await Promise.all(names.map(name => readJson(port.files, recordsPath(common, 'spawn', name)).catch(() => undefined)))
  return new Set(records.flatMap(record => isRecord(record) && typeof record.sessionId === 'string' ? [record.sessionId] : []))
}
