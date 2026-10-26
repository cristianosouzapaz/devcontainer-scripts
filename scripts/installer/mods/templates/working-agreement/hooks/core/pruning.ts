import { removeFile } from '../lib/files'
import { hasExitedZero } from '../lib/process'
import type { UnitEntry } from '../domain/records'
import { bestEffort, logFailure } from './best-effort'
import type { EnginePort } from './engine-port'
import { createReadPort } from './read-port'
import { deleteDeclaration, readCommonDir, readSession, readSessionMirrors, sameIdentity, updateSession, recordsPath } from './record-store'
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
  const candidates = await Promise.all(branches.map(async branch => ({ branch, read: await readCandidates(port, branch, false, true) })))
  if (candidates.some(candidate => !candidate.read.isOk)) return
  const judgements = await Promise.all(units.map(async unit => {
    const read = candidates.find(candidate => candidate.branch === unit.identity.branch)?.read
    if (!read?.isOk) return null
    const conclusion = await readConclusion(port, unit.identity, unit, read.value)
    return conclusion.isOk ? { unit, isConcluded: !!conclusion.value } : null
  }))
  if (judgements.some(judgement => judgement === null)) return
  // The session's own entries are re-read fresh, so an entry is matched by its identity and lifetime.
  const isConcluded = (unit: UnitEntry): boolean => judgements.some(judgement => judgement?.isConcluded
    && sameIdentity(judgement.unit.identity, unit.identity) && judgement.unit.generation === unit.generation)
  const session = await readSession(port)
  const own = mirrors.find(mirror => mirror.session.sessionId === session.sessionId)?.session.units ?? []
  if (own.some(isConcluded)) await updateSession(port, current => current.units.some(isConcluded) ? { ...current, units: current.units.filter(unit => !isConcluded(unit)) } : null)
  for (const mirror of mirrors.filter(mirror => mirror.session.sessionId !== session.sessionId)) {
    if (mirror.session.units.every(isConcluded)) logFailure(port, 'session mirror delete', hasExitedZero(await removeFile(port.processes, mirror.path)))
  }
  for (const unit of units.filter(isConcluded)) {
    if (!units.some(other => sameIdentity(other.identity, unit.identity) && !isConcluded(other))) await bestEffort(port, 'declaration delete', () => deleteDeclaration(port, unit.identity), undefined)
  }
  await bestEffort(port, 'file prune', () => pruneFiles(port), undefined)
}

/**
 * Removes orphaned records, run artifacts and transition logs while preserving live owners and displayed runs;
 * a unit's log lives as long as its declaration.
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
  // A failed listing must not read as no declarations, which would delete every log.
  const declared = new Set((await port.files.list(recordsPath(common, 'u'))).map(entry => entry.name))
  // The log bucket may not exist yet.
  for (const { name } of await port.files.list(recordsPath(common, 'log')).catch(() => [])) {
    const hash = name.match(/^([0-9a-f]+)\.jsonl$/)?.[1]
    if (hash && !declared.has(`${hash}.json`)) logFailure(port, 'orphan log delete', hasExitedZero(await removeFile(port.processes, recordsPath(common, 'log', name))))
  }
}
