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

// why: A session's mirror is written only on its first record change and names no process, so whether another session
// still runs is read from this bucket, which every session refreshes on its tick, a resume changing its process.
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
  return common ? parseHost(await readJson(port.files, recordsPath(common, bucket, `${sessionId}.json`)).catch(() => undefined)) : null
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
  const records = await Promise.all(names.map(name => readJson(port.files, recordsPath(common, 'spawn', name)).catch(() => undefined)))
  return new Set(records.flatMap(record => isRecord(record) && typeof record.sessionId === 'string' ? [record.sessionId] : []))
}
