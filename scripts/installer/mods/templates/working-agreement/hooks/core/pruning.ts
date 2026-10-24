import { removeFile } from '../lib/files'
import { hasExitedZero } from '../lib/process'
import type { UnitEntry } from '../domain/records'
import { bestEffort, logFailure } from './best-effort'
import type { EnginePort } from './engine-port'
import { createReadPort } from './read-port'
import { deleteDeclaration, readCommonDir, readSession, readSessionMirrors, sameIdentity, writeSession, recordsPath } from './record-store'
import { sessionMemory } from './session-memory'
import { readGit } from './repository'
import { readGithubStatus } from './github-sync'
import { readCandidates, readConclusion } from './unit-github'

/**
 * Prunes concluded records and orphan files after every GitHub read in the sweep succeeds.
 * Other chats' records are only ever deleted whole; a mixed record remains untouched.
 * @param engine - The engine calls.
 * @returns Once the concluded records and orphan files are pruned.
 */
export async function pruneConcluded(engine: EnginePort): Promise<void> {
  const port = createReadPort(engine)
  const git = await readGit(port)
  if (!git || await readGithubStatus(port, true) !== 'connected') return
  const mirrors = await readSessionMirrors(port)
  const units = mirrors.flatMap(mirror => mirror.session.units)
  const branches = [...new Set(units.map(unit => unit.identity.branch))]
  const candidates = await Promise.all(branches.map(async branch => ({ branch, read: await readCandidates(port, branch, git.base, false, true) })))
  if (candidates.some(candidate => !candidate.read.isOk)) return
  const judgements = await Promise.all(units.map(async unit => {
    const read = candidates.find(candidate => candidate.branch === unit.identity.branch)?.read
    if (!read?.isOk) return null
    const conclusion = await readConclusion(port, unit.identity, unit, read.value)
    return conclusion.isOk ? { unit, isConcluded: !!conclusion.value } : null
  }))
  if (judgements.some(judgement => judgement === null)) return
  const isConcluded = (unit: UnitEntry): boolean => judgements.some(judgement => judgement?.unit === unit && judgement.isConcluded)
  const session = await readSession(port)
  const own = mirrors.find(mirror => mirror.session.sessionId === session.sessionId)?.session.units ?? []
  if (own.some(isConcluded)) await writeSession(port, { ...session, units: own.filter(unit => !isConcluded(unit)) })
  for (const mirror of mirrors.filter(mirror => mirror.session.sessionId !== session.sessionId)) {
    if (mirror.session.units.every(isConcluded)) logFailure(port, 'session mirror delete', hasExitedZero(await removeFile(port.processes, mirror.path)))
  }
  for (const unit of units.filter(isConcluded)) {
    if (!units.some(other => sameIdentity(other.identity, unit.identity) && !isConcluded(other))) await bestEffort(port, 'declaration delete', () => deleteDeclaration(port, unit.identity), undefined)
  }
  await bestEffort(port, 'file prune', () => pruneFiles(port), undefined)
}

/**
 * Removes orphaned records and run artifacts while preserving live owners and displayed runs.
 * @param port - The engine calls.
 */
async function pruneFiles(port: EnginePort): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  const sid = await port.readSessionId()
  // Existence keeps an owner live even if its mirror cannot be parsed.
  const sessions = await port.files.list(recordsPath(common, 's'))
  const live = new Set([`${sid}.json`, ...sessions.map(entry => entry.name)])
  const mirrors = await readSessionMirrors(port, true)
  const named = new Set(mirrors.flatMap(mirror => mirror.session.units.flatMap(unit => [...unit.verifyRuns, ...unit.runs].map(run => run.runId))))
  const memory = sessionMemory.runViews.get(sid)
  const held = new Set([memory?.live?.runId, memory?.published.runId, memory?.last?.runId])
  for (const bucket of ['s', 'u', 'd', 'ok', 'runs']) {
    // The bucket directory may not exist yet.
    const entries = await port.files.list(recordsPath(common, bucket)).catch(() => [])
    for (const { name } of entries) {
      const temporary = name.match(/^\.tmp-([^/\\]+)-\d+(?:\.lock)?$/)
      const sidecar = bucket === 'runs' ? name.match(/^(\d+-\d+-([^/\\]+))\.json$/) : null
      const log = bucket === 'runs' ? name.match(/^([^/\\]+)-(\d+-\d+-\1)\.log(?:\.output|\.tmp|\.fifo-(?:in|tail|count))?$/) : null
      const owner = temporary?.[1] ?? sidecar?.[2] ?? log?.[1]
      const runId = sidecar?.[1] ?? log?.[2]
      if (!owner) continue
      const dead = !live.has(`${owner}.json`)
      if (temporary ? dead : runId && !named.has(runId) && (dead || owner === sid && !held.has(runId))) {
        logFailure(port, 'orphan file delete', hasExitedZero(await removeFile(port.processes, recordsPath(common, bucket, name))))
      }
    }
  }
}
