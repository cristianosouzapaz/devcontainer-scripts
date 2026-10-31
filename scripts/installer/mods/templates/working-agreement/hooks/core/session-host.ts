import type { SessionLiveness } from '../domain/process-host'
import { parseHost } from '../domain/process-host'
import { removeFile } from '../lib/files'
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
  return judgeSession(port, sessionId, async () => {
    const common = await readCommonDir(port)
    return common ? parseHost(await readJson(port.files, recordsPath(common, bucket, `${sessionId}.json`)).catch(() => undefined)) ?? undefined : undefined
  })
}

/**
 * Removes the process record of every session whose recorded process ended.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @returns Once every record was judged.
 */
export function pruneSessionHosts(port: EnginePort, common: string): Promise<void> {
  return sweepBucket(port, common, bucket, async name => {
    const session = name.match(/^([^.][^/\\]*)\.json$/)?.[1]
    if (session && await readSessionLiveness(port, session) === 'gone') logFailure(port, 'session host delete', hasExitedZero(await removeFile(port.processes, recordsPath(common, bucket, name))))
  })
}
