import { readJson } from '../lib/json'
import { createQueue } from '../lib/queue'
import { removeFile } from '../lib/files'
import { executeProcess } from '../lib/process'
import { createEmptySession, createEmptyUnit, mergeSkills, parseSession, parseUnitRecord, retainRuns } from '../domain/records'
import type { Identity, Session, SessionRecord, Unit, UnitEntry, UnitRecord } from '../domain/records'
import { isAncestor, readGitOutput, runGit, hashObject } from '../lib/git'
import type { EnginePort } from './engine-port'
import { sessionMemory, holdError } from './session-memory'
import type { RunDisplay } from './session-memory'

interface SessionMirror { path: string; session: SessionRecord }

const temp = { sequence: 0 }
const queueMirror = createQueue()
// Caches live with the port: one engine event, or the session.start port's session refresh loop.
// A working directory's common dir and an identity's hash stay stable during a session.
const commonDirs = new WeakMap<EnginePort['readCwd'], Map<string, string>>()
const identityHashes = new WeakMap<EnginePort['readCwd'], Map<string, string>>()

/**
 * Resolves the shared git metadata directory through git, including linked worktrees.
 * @param port - The engine calls.
 * @returns The absolute common directory, or null outside a repository.
 */
export async function readCommonDir(port: EnginePort): Promise<string | null> {
  const key = JSON.stringify([await port.readSessionId(), await port.readCwd()])
  const memo = commonDirs.get(port.readCwd) ?? new Map<string, string>()
  commonDirs.set(port.readCwd, memo)
  const cached = memo.get(key)
  if (cached !== undefined) return cached
  const run = await runGit(port.processes, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = run.exitCode === 0 && run.stdout.trim() ? run.stdout.trim() : null
  if (common !== null) memo.set(key, common)
  return common
}

/**
 * Compares canonical unit identities.
 * @param left - One identity.
 * @param right - The other identity.
 * @returns Whether both name the same branch and exact issue set.
 */
export const sameIdentity = (left: Identity, right: Identity): boolean => canonical(left) === canonical(right)

/**
 * Selects this chat's run display only for the declared unit and generation.
 * @param sid - The chat session id.
 * @param identity - The declared unit, if any.
 * @param generation - The unit's declared lifetime.
 * @returns The matching display, or null when it belongs to another unit or lifetime.
 */
export function selectRunDisplay(sid: string, identity: Identity | null | undefined, generation: string | undefined): RunDisplay | null {
  const memory = sessionMemory.runViews.get(sid)
  return memory && identity && sameIdentity(memory.identity, identity) && memory.generation === generation ? memory : null
}

/**
 * Gives equivalent unit identities the same serialized representation.
 * @param identity - The branch and issues identifying the unit.
 * @returns The stable identity text.
 */
function canonical(identity: Identity): string {
  return JSON.stringify({ branch: identity.branch, issues: identity.issues })
}

/**
 * Allocates a temporary path shared by record writes and index captures.
 * @param port - The engine calls.
 * @param directory - The swept bucket holding the temporary file.
 * @returns A path unique within this session's module lifetime.
 */
export async function temporaryPath(port: EnginePort, directory: string): Promise<string> {
  return `${directory}/.tmp-${await port.readSessionId()}-${++temp.sequence}`
}

/**
 * Atomically replaces a record, retrying one failed attempt with a fresh temporary name.
 * @param port - The engine calls.
 * @param path - The final file path.
 * @param text - The entire serialized record.
 * @param signal - The cancellation signal of a write the user may cancel; a failure after it aborts is not held.
 */
export async function atomicReplace(port: EnginePort, path: string, text: string, signal?: AbortSignal): Promise<void> {
  for (const attempt of [0, 1]) {
    const directory = path.slice(0, path.lastIndexOf('/'))
    const temporary = await temporaryPath(port, directory)
    try {
      await port.files.write(temporary, text)
      const run = await executeProcess(port.processes, ['mv', '-f', '--', temporary, path])
      if (run.exitCode !== 0) throw new Error(run.stderr || 'atomic record replacement failed')
      sessionMemory.recordError = null
      return
    } catch (error) {
      // pruneFiles sweeps leftover .tmp- files.
      await removeFile(port.processes, temporary)
      if (attempt === 1) {
        // The engine cuts a cancelled call's `$` calls, so their rejection is not a record failure.
        if (!signal?.aborted) sessionMemory.recordError = holdError(sessionMemory.recordError, `${path}: ${error instanceof Error ? error.message : String(error)}`, await port.now())
        throw error
      }
    }
  }
}

/**
 * Seeds authoritative state from this chat's mirror only at startup.
 * @param port - The engine calls.
 */
export async function initializeSession(port: EnginePort): Promise<void> {
  const held = await port.readSessionState()
  if (held.value !== undefined) return
  const sid = await port.readSessionId()
  const common = await readCommonDir(port)
  const saved = common ? parseSession(await readJson(port.files, recordsPath(common, 's', `${sid}.json`))) : null
  if (!await port.writeSessionState(saved?.sessionId === sid ? saved : stripSession(createEmptySession(sid)), held.version)) await initializeSession(port)
}

/**
 * Hashes the canonical identity using the repository's object format.
 * @param port - The engine calls.
 * @param identity - The branch and sorted issue set.
 * @returns The shared declaration path.
 */
async function unitPath(port: EnginePort, identity: Identity): Promise<string> {
  const common = await readCommonDir(port)
  if (!common) throw new Error('check out a branch first')
  const text = canonical(identity)
  const key = JSON.stringify([await port.readSessionId(), common, text])
  const memo = identityHashes.get(port.readCwd) ?? new Map<string, string>()
  identityHashes.set(port.readCwd, memo)
  const cached = memo.get(key)
  if (cached !== undefined) return recordsPath(common, 'u', `${cached}.json`)
  const run = await hashObject(port.processes, text)
  if (run.exitCode !== 0 || !run.stdout.trim()) throw new Error(run.stderr || 'cannot hash unit identity')
  const hash = run.stdout.trim()
  memo.set(key, hash)
  return recordsPath(common, 'u', `${hash}.json`)
}

/**
 * Writes the shared flow declaration at declaration time only.
 * @param port - The engine calls.
 * @param record - The versioned declaration.
 */
export async function writeDeclaration(port: EnginePort, record: UnitRecord): Promise<void> {
  await atomicReplace(port, await unitPath(port, record.identity), JSON.stringify(record))
}

/**
 * Reads this chat's authoritative state and derives its flow solely from the shared declaration.
 * @param port - The engine calls.
 * @returns The session with its current flow and issue set.
 */
export async function readSession(port: EnginePort): Promise<Session> {
  const saved = (await port.readSessionState()).value ?? stripSession(createEmptySession(await port.readSessionId()))
  const declaration = saved.unit ? parseUnitRecord(await readJson(port.files, await unitPath(port, saved.unit))) : null
  return { ...saved, flow: declaration && saved.unit && sameIdentity(declaration.identity, saved.unit) ? declaration.flow : null, issues: saved.unit?.issues ?? [] }
}

/**
 * Separates persisted session facts from derived flow and issue fields.
 * @param session - The session with its derived fields.
 * @returns A detached session record suitable for persistence.
 */
function stripSession(session: Session): SessionRecord {
  const { flow: _flow, issues: _issues, ...record } = session
  return JSON.parse(JSON.stringify(record)) as SessionRecord
}

/**
 * Writes authoritative state with compare-and-set and mirrors the resulting whole value.
 * @param port - The engine calls.
 * @param session - The new chat record.
 */
export async function writeSession(port: EnginePort, session: Session): Promise<void> {
  const held = await port.readSessionState()
  if (!await port.writeSessionState(stripSession(session), held.version)) return writeSession(port, session)
  await mirrorSession(port, false)
}

/**
 * Serializes this chat's mirror writes from authoritative state.
 * @param port - The engine calls.
 * @param check - Whether a tick checks the mirror first; record writes replace it without reading.
 */
export async function mirrorSession(port: EnginePort, check = true): Promise<void> {
  return queueMirror(async () => {
    const saved = (await port.readSessionState()).value
    const common = await readCommonDir(port)
    if (!saved || !common) return
    const path = recordsPath(common, 's', `${saved.sessionId}.json`)
    const text = JSON.stringify(saved)
    if (check) {
      // The mirror may not exist yet.
      try { if (await port.files.read(path) === text) return } catch {}
    }
    await atomicReplace(port, path, text)
  })
}

/**
 * Reads the union of a unit's evidence across valid session mirrors, preferring this chat.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @returns The merged evidence.
 */
export async function readUnit(port: EnginePort, identity: Identity): Promise<Unit> {
  return mergeUnits(port, (await readEntries(port)).filter(entry => sameIdentity(entry.identity, identity)))
}

/**
 * Combines shared unit evidence while preferring a base still inherited by the branch.
 * @param port - The engine calls.
 * @param units - The active entries for the same unit.
 * @returns The merged unit with deduplicated evidence.
 */
async function mergeUnits(port: EnginePort, units: UnitEntry[]): Promise<Unit> {
  const evidence = units.reduce<Unit>((merged, unit) => ({
    ...unit, ...merged, skills: mergeSkills(merged.skills, unit.skills), verifyRuns: [...merged.verifyRuns, ...unit.verifyRuns].sort((a, b) => b.at - a.at)
      .filter((run, index, runs) => runs.findIndex(other => other.tree === run.tree && other.base === run.base) === index),
    base: merged.base ?? unit.base, baseBranch: merged.base ? merged.baseBranch : unit.baseBranch, skips: [...(merged.skips ?? []), ...(unit.skips ?? [])]
      .filter((skip, index, skips) => skips.findIndex(other => other.step === skip.step && other.reason === skip.reason) === index),
    approval: merged.approval ?? unit.approval,
  }), createEmptyUnit())
  const merged = { ...evidence, runs: retainRuns(units.flatMap(unit => unit.runs)) }
  const bases = [...new Set(units.flatMap(unit => unit.base ? [unit.base] : []))]
  if (bases.length < 2) return merged
  const branch = units[0]?.identity.branch
  const tip = await readGitOutput(port.processes, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (!tip) return merged
  const inherited = await Promise.all(bases.map(async base => await isAncestor(port.processes, base, tip) ? base : null))
  const base = inherited.find(base => base !== null) ?? merged.base
  return { ...merged, base, baseBranch: units.find(unit => unit.base === base)?.baseBranch }
}

/**
 * Reads every valid mirror plus this chat's authoritative record for a pruning snapshot.
 * @param port - The engine calls.
 * @param strict - Whether a failed listing aborts a file-pruning snapshot.
 * @returns Whole session records with their owned paths.
 */
export async function readSessionMirrors(port: EnginePort, strict = false): Promise<SessionMirror[]> {
  const session = await readSession(port)
  const common = await readCommonDir(port)
  const directory = recordsPath(common, 's')
  // The directory may not exist yet when the read is non-strict.
  const entries = await port.files.list(directory).catch(error => { if (strict) throw error; return [] })
  const others = await Promise.all(entries.map(entry => entry.name).filter(name => name.endsWith('.json') && name !== `${session.sessionId}.json`)
    .sort().map(async name => ({ path: recordsPath(common, 's', name), session: parseSession(await readJson(port.files, recordsPath(common, 's', name))) })))
  return [{ path: recordsPath(common, 's', `${session.sessionId}.json`), session }, ...others.flatMap(other => other.session ? [{ path: other.path, session: other.session }] : [])]
}

/**
 * Reads a declaration's current generation without accepting retired flows.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @returns The declaration, or null when absent.
 */
export async function readDeclaration(port: EnginePort, identity: Identity): Promise<UnitRecord | null> {
  return parseUnitRecord(await readJson(port.files, await unitPath(port, identity)))
}

/**
 * Excludes stale declaration generations from shared session evidence.
 * @param port - The engine calls.
 * @returns The unit entries belonging to active declarations.
 */
async function readEntries(port: EnginePort): Promise<UnitEntry[]> {
  const entries = (await readSessionMirrors(port)).flatMap(mirror => mirror.session.units)
  const active = await Promise.all(entries.map(async entry => {
    const declaration = await readDeclaration(port, entry.identity)
    if (declaration ? declaration.generation !== entry.generation : entry.generation !== undefined) return null
    return entry
  }))
  return active.filter((entry): entry is UnitEntry => entry !== null)
}

/**
 * Allocates a fresh declaration lifetime without consulting earlier chats' evidence.
 * @param port - The engine calls.
 * @returns A token unique to this session, time and local sequence.
 */
export async function nextGeneration(port: EnginePort): Promise<string> {
  return `${await port.readSessionId()}:${await port.now()}:${++temp.sequence}`
}

/**
 * Deletes a concluded identity's declaration through the process boundary.
 * @param port - The engine calls.
 * @param identity - The concluded identity with no live contribution.
 */
export async function deleteDeclaration(port: EnginePort, identity: Identity): Promise<void> {
  const removed = await removeFile(port.processes, await unitPath(port, identity))
  if (!removed.isOk) throw removed.cause
}

/**
 * Reads each distinct unit on a branch across all chats.
 * @param port - The engine calls.
 * @param branch - The unit's branch.
 * @returns The identities with their merged evidence.
 */
export async function readBranchUnits(port: EnginePort, branch: string): Promise<UnitEntry[]> {
  const entries = (await readEntries(port)).filter(entry => entry.identity.branch === branch)
  return Promise.all(entries.filter((entry, index) => entries.findIndex(other => sameIdentity(entry.identity, other.identity)) === index)
    .map(async entry => ({ ...await mergeUnits(port, entries.filter(other => sameIdentity(entry.identity, other.identity))), identity: entry.identity })))
}

/**
 * Updates this chat's contribution to its current unit without changing other chats' records.
 * @param port - The engine calls.
 * @param session - The chat whose unit is changed.
 * @param change - Builds the new evidence.
 */
export async function updateUnits(port: EnginePort, session: Session, change: (unit: Unit) => Unit): Promise<void> {
  if (!session.unit) return
  const identity = session.unit
  const changed = { ...change(await readUnit(port, identity)), identity }
  const current = await readSession(port)
  await writeSession(port, replaceUnitEntry(current, identity, changed))
}

/**
 * Replaces one identity's contribution while retaining every other unit in order.
 * @param session - The session to copy.
 * @param identity - The entry identity to replace.
 * @param entry - The replacement contribution.
 * @returns The session with the replacement appended.
 */
export function replaceUnitEntry(session: Session, identity: Identity, entry: UnitEntry): Session {
  return { ...session, units: [...session.units.filter(unit => !sameIdentity(unit.identity, identity)), entry] }
}

/**
 * Builds a record bucket or file path under the repository's shared metadata.
 * @param common - The common directory, including null for existing absent-repository paths.
 * @param bucket - The optional record bucket.
 * @param name - The optional filename within the bucket.
 * @returns The unchanged record location.
 */
export function recordsPath(common: string | null, bucket?: string, name?: string): string {
  return `${common}/working-agreement${bucket === undefined ? '' : `/${bucket}`}${name === undefined ? '' : `/${name}`}`
}
