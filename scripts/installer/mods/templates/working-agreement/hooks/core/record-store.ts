import { parseJson, readJson, readText } from '../lib/json'
import { settle, succeed, unwrapOr } from '../lib/result'
import type { Result } from '../lib/result'
import { createQueue } from '../lib/queue'
import { removeFile } from '../lib/files'
import { executeProcess, runProcess } from '../lib/process'
import { canonicalIdentity, createEmptySession, sameIdentity, createEmptyUnit, mergeUnique, parseObservedEnd, parseSession, parseUnitRecord, retainRuns } from '../domain/records'
import type { AuditNote, Identity, ObservedEndRecord, Session, SessionRecord, Unit, UnitEntry, UnitRecord } from '../domain/records'
import type { ProcessState } from '../../types'
import { isAncestor, readGitOutput, runGit, hashObject } from '../lib/git'
import type { EnginePort } from './engine-port'
import { UnansweredRenameError } from './host-lock'
import type { HeldLock } from './host-lock'
import { sessionMemory, holdError, unknownChat } from './session-memory'
import { isProcessStarted, readProcessState } from './process-state'
import { publishFenced } from './session-publish'
import { isFiniteNumber, isRecord } from '../lib/guards'
import { readFault } from './fault-registry'
import { moduleState } from '../lib/module-state'

/** The process a session mirror was written in and the `$.state` version it was written from. */
interface MirrorRevision { v: 1; generation: string; version: number }

/** A session's mirror file, as read with its path and modification time. */
export interface SessionMirror { path: string; session: SessionRecord; mtimeMs: number | null }

/** Holds where a unit's records live: the common directory and the hash its files are named by. */
interface IdentityHash { common: string; hash: string }

/** A session with the version of the authoritative value it was read from. */
export interface VersionedSession { session: Session; version: number }

/** A session write that landed: mirrored, or unmirrored with why, which readers in other sessions then lag behind until the tick publishes it. */
export type SessionWrite = (VersionedSession & { kind: 'written' }) | (VersionedSession & { kind: 'unmirrored'; error: string })

/** Maps the fresh session to the next one, or to null for no write; it may run more than once, so it has no side effects. */
type SessionChange = (session: Session) => Session | null | Promise<Session | null>

/** A record bucket: a swept one, or one whose temporary files, if any, live in subdirectories the sweep does not reach. */
export type RecordBucket = typeof recordBuckets[number] | 'sign' | 'log' | 'end' | 'verify' | 'mail'

/**
 * Every bucket atomicReplace writes to: pruneFiles sweeps each one's leftover temporary files. `owed` keeps a step's done the mod
 * could not send, one `<step id>.json` each holding the step id, the reply's id, the recipient, the issue, the mod's outcome line, and
 * the count and last error of its failed resends, and whether a prompt named it as stuck, until a resend lands.
 */
export const recordBuckets = ['s', 'u', 'd', 'ok', 'runs', 'delegation', 'delegated', 'spawn', 'placed', 'host', 'notices', 'retired', 'v', 'forwards', 'comments', 'deadletters', 'dd', 'activity', 'stalls', 'locks', 'owed'] as const

// why: a miss means another dispatch wrote in between; this many in a row means a writer that never settles.
const sessionWriteAttempts = 5

// why: two module loads of one process are live together after a reload, and their sequences start over independently, so each load names its own files.
const temp = moduleState(() => ({ nonce: crypto.randomUUID().replaceAll('-', '').slice(0, 12), sequence: 0 }))
const mirrorQueue = moduleState(() => ({ run: createQueue() }))
// why: caches live with the port (one engine event, or the session.start port's session refresh loop), and a working directory's common dir and an identity's hash stay stable during a session.
const memos = moduleState(() => ({ commonDirs: new WeakMap<EnginePort['readCwd'], Map<string, string>>(), identityHashes: new WeakMap<EnginePort['readCwd'], Map<string, string>>() }))

/**
 * Resolves the shared git metadata directory through git, including linked worktrees.
 * @param port - The engine calls.
 * @returns The absolute common directory, or null outside a repository.
 */
export async function readCommonDir(port: EnginePort): Promise<string | null> {
  const key = JSON.stringify([await port.readSessionId(), await port.readCwd()])
  const memo = memos.commonDirs.get(port.readCwd) ?? new Map<string, string>()
  memos.commonDirs.set(port.readCwd, memo)
  const cached = memo.get(key)
  if (cached !== undefined) return cached
  const run = await runGit(port.processes, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const common = run.exitCode === 0 && run.stdout.trim() ? run.stdout.trim() : null
  if (common !== null) memo.set(key, common)
  return common
}

/**
 * Allocates a temporary path shared by record writes and index captures.
 * @param port - The engine calls.
 * @param directory - The swept bucket holding the temporary file.
 * @returns A path no other module load of any session names.
 */
export async function temporaryPath(port: EnginePort, directory: string): Promise<string> {
  return `${directory}/.tmp-${await port.readSessionId()}-${temp.nonce}-${++temp.sequence}`
}

/** An unfenced record replace that left the record as it was: its temporary file was never written, or every rename exited non-zero. */
export class UnwrittenError extends Error {}

/** A write whose lock was lost before its holder renamed it, which therefore never ran under a lock it no longer held: an unwritten record. */
export class LostFenceError extends UnwrittenError {
  /**
   * Names the record left unwritten.
   * @param path - The record.
   */
  constructor(path: string) {
    super(`the lock over ${path} was lost before its rename, so it was not written`)
  }
}

/**
 * Atomically replaces a record, retrying one failed attempt with a fresh temporary name.
 * @param port - The engine calls.
 * @param path - The final file path.
 * @param text - The entire serialized record.
 * @param signal - The cancellation signal of a write the user may cancel; a failure after it aborts is not held.
 * @param fence - The lock the write runs under: the process that holds it renames, so no rename lands once the lock is lost.
 * @throws When the write fails twice, or the lock was lost before the rename; an UnwrittenError when an unfenced write's failure left the
 * record as it was.
 */
export async function atomicReplace(port: EnginePort, path: string, text: string, signal?: AbortSignal, fence?: HeldLock): Promise<void> {
  // why: a rename whose process call rejected, as a cancelled call's does, may have landed, so no later failure proves the record unchanged.
  const renames = { isUnanswered: false }
  for (const attempt of [0, 1]) {
    const directory = path.slice(0, path.lastIndexOf('/'))
    const temporary = await temporaryPath(port, directory)
    try {
      await port.files.write(temporary, text)
      if (fence?.lost.aborted) throw new LostFenceError(path)
      // why: a rename asked for and left unanswered may have landed, so it is never taken for one refused before it was asked.
      if (fence) await fence.rename(temporary, path).catch((error: unknown) => { throw error instanceof UnansweredRenameError || !fence.lost.aborted ? error : new LostFenceError(path) })
      else {
        const run = await executeProcess(port.processes, ['mv', '-f', '--', temporary, path]).catch((error: unknown) => {
          renames.isUnanswered = true
          throw error
        })
        if (run.exitCode !== 0) throw new Error(run.stderr || 'atomic record replacement failed')
      }
      sessionMemory.recordError = null
      return
    } catch (error) {
      // why: a .tmp- file this removal leaves behind is swept by pruneFiles, which covers every bucket of recordBuckets.
      await removeFile(port.processes, temporary)
      // why: a lost lock is no write failure to retry: the record is left to the load that holds the lock now.
      if (error instanceof LostFenceError || error instanceof UnansweredRenameError) throw error
      if (attempt === 1) {
        // why: the engine cuts a cancelled call's `$` calls, so their rejection is not a record failure.
        if (!signal?.aborted) sessionMemory.recordError = holdError(sessionMemory.recordError, `${path}: ${error instanceof Error ? error.message : String(error)}`, await port.now())
        // why: a fenced rename the holder answered as failed, like a write that failed before it, left the record as it was.
        throw renames.isUnanswered || signal?.aborted ? error : new UnwrittenError(error instanceof Error ? error.message : String(error))
      }
    }
  }
}

/**
 * Creates a file once, never over an existing one: writes it whole in a staging directory, then links it into place, so a reader
 * sees the complete file or none, and a second creation of the same path collides.
 * @param port - The engine calls.
 * @param staging - The directory the file is written in first, on the same file system as the path.
 * @param path - The final file path.
 * @param text - The entire file.
 * @returns Whether the file was created; false when the path already existed.
 */
export async function atomicCreate(port: EnginePort, staging: string, path: string, text: string): Promise<boolean> {
  const temporary = await temporaryPath(port, staging)
  try {
    await port.files.write(temporary, text)
    // why: a link fails when its target exists, where a rename would replace it.
    const run = await executeProcess(port.processes, ['ln', '--', temporary, path])
    if (run.exitCode === 0) {
      sessionMemory.recordError = null
      return true
    }
    if (await port.files.exists(path)) return false
    throw new Error(run.stderr || 'atomic record creation failed')
  } catch (error) {
    sessionMemory.recordError = holdError(sessionMemory.recordError, `${path}: ${error instanceof Error ? error.message : String(error)}`, await port.now())
    throw error
  } finally {
    // why: a crash before this leaves the file in staging, which pruning sweeps.
    await removeFile(port.processes, temporary)
  }
}

/**
 * Seeds authoritative state from this chat's mirror while it is unseeded.
 * @param port - The engine calls.
 * @throws When the mirror cannot be read: an empty seed would overwrite the record it holds.
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
 * Names a unit's file in a record bucket by its identity's hash.
 * @param port - The engine calls.
 * @param identity - The branch and sorted issue set.
 * @param bucket - The record bucket holding the unit's file.
 * @param extension - The file's extension.
 * @returns The unit's file in that bucket.
 */
async function unitPath(port: EnginePort, identity: Identity, bucket: RecordBucket = 'u', extension = 'json'): Promise<string> {
  const { common, hash } = await readIdentityHash(port, identity)
  return recordsPath(common, bucket, `${hash}.${extension}`)
}

/**
 * Hashes the canonical identity using the repository's object format, once per session, common dir and identity.
 * @param port - The engine calls.
 * @param identity - The branch and sorted issue set.
 * @returns The common directory and the identity's hash.
 */
async function readIdentityHash(port: EnginePort, identity: Identity): Promise<IdentityHash> {
  const common = await readCommonDir(port)
  if (!common) throw new Error('check out a branch first')
  const text = canonicalIdentity(identity)
  const key = JSON.stringify([await port.readSessionId(), common, text])
  const memo = memos.identityHashes.get(port.readCwd) ?? new Map<string, string>()
  memos.identityHashes.set(port.readCwd, memo)
  const cached = memo.get(key)
  if (cached !== undefined) return { common, hash: cached }
  const run = await hashObject(port.processes, text)
  if (run.exitCode !== 0 || !run.stdout.trim()) throw new Error(run.stderr || 'cannot hash unit identity')
  const hash = run.stdout.trim()
  memo.set(key, hash)
  return { common, hash }
}

/**
 * Names the directory of a unit's observed slice ends, which shares its declaration's hash and holds one file per writing session.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @returns The directory path.
 */
async function observedEndDirectory(port: EnginePort, identity: Identity): Promise<string> {
  const { common, hash } = await readIdentityHash(port, identity)
  return recordsPath(common, 'end', hash)
}

/**
 * Reads every session's observed slice end of a unit; a JSON file that is no valid observation counts as absent.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @returns The records, or the failure of a listing or file read that must not read as no observation.
 */
export async function readObservedEnds(port: EnginePort, identity: Identity): Promise<Result<ObservedEndRecord[]>> {
  const directory = await observedEndDirectory(port, identity)
  const names = await settle(listRecordNames(port, directory))
  if (!names.isOk) return names
  const records = await settle(Promise.all(names.value.filter(name => name.endsWith('.json'))
    .map(async name => parseObservedEnd(await readJson(port.files, `${directory}/${name}`)))))
  if (!records.isOk) return records
  return succeed(records.value.filter((record): record is ObservedEndRecord => record !== null && sameIdentity(record.identity, identity)))
}

/**
 * Replaces this session's own observed slice end of a unit; no other session writes that file.
 * @param port - The engine calls.
 * @param record - The observation.
 */
export async function writeObservedEnd(port: EnginePort, record: ObservedEndRecord): Promise<void> {
  await atomicReplace(port, await observedEndPath(port, record.identity), JSON.stringify(record))
}

/**
 * Names this session's observed slice end file of a unit.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @returns The file path.
 */
export async function observedEndPath(port: EnginePort, identity: Identity): Promise<string> {
  return `${await observedEndDirectory(port, identity)}/${await port.readSessionId()}.json`
}

/**
 * Removes a unit's observed slice ends and then their directory, leaving a temporary file of a write in flight, and the directory holding it, in place.
 * @param port - The engine calls.
 * @param directory - The unit's observed end directory.
 * @throws When the directory cannot be listed or a record cannot be removed.
 */
export async function deleteObservedEnds(port: EnginePort, directory: string): Promise<void> {
  const records = (await listRecordNames(port, directory)).filter(name => name.endsWith('.json'))
  if (records.length) {
    const removed = await removeFile(port.processes, ...records.map(name => `${directory}/${name}`))
    if (!removed.isOk) throw removed.cause
  }
  // why: rmdir refuses a directory that still holds a temporary file, which may belong to a live session with no session file yet.
  await runProcess(port.processes, ['rmdir', '--', directory])
}

/**
 * Names a unit's transition log, which shares its declaration's hash.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @returns The log path.
 */
export const unitLogPath = (port: EnginePort, identity: Identity): Promise<string> => unitPath(port, identity, 'log', 'jsonl')

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
  return (await readVersionedSession(port)).session
}

/**
 * Reads this chat's authoritative state with its version, deriving its flow solely from the shared declaration.
 *
 * Within one dispatch the value is the dispatch's moment: only its own writes and a missed compare-and-set move it on.
 * @param port - The engine calls.
 * @returns The session with its current flow and issue set, and the version it was read at.
 */
export async function readVersionedSession(port: EnginePort): Promise<VersionedSession> {
  // why: A seed that failed at startup is retried by every read until it lands, never replaced by an empty record.
  const first = await port.readSessionState()
  if (first.value === undefined) await initializeSession(port)
  const held = first.value === undefined ? await port.readSessionState() : first
  const saved = held.value ?? stripSession(createEmptySession(await port.readSessionId()))
  const declaration = saved.unit ? parseUnitRecord(await readJson(port.files, await unitPath(port, saved.unit))) : null
  const flow = declaration && saved.unit && sameIdentity(declaration.identity, saved.unit) ? declaration.flow : null
  // why: a chat that tracks no issue and declares none has no audit to be unrecorded, so the process state is read only for one that does.
  const auditNote = saved.audit || saved.unit?.issues.length ? await readAuditNote(saved.sessionId, () => readProcessState(port)) : undefined
  return { session: { ...saved, flow, issues: saved.unit?.issues ?? [], ...auditNote ? { auditNote } : {} }, version: held.version }
}

/**
 * Reads whether a chat's last turn-end audit's result may be missing from its record: from this load's memory when the process state
 * could not keep what it knows, else from the process state.
 * @param sessionId - The chat.
 * @param readProcess - Reads the process state, null when it cannot be read.
 * @returns The note, or undefined when the last audit's result was written.
 */
async function readAuditNote(sessionId: string, readProcess: () => Promise<ProcessState | null>): Promise<AuditNote | undefined> {
  const memory = sessionMemory.auditUnrecorded
  const key = memory.has(sessionId) ? sessionId : unknownChat
  if (memory.has(key)) {
    const kept = memory.get(key)
    return kept ? { kind: 'unrecorded', reason: kept } : undefined
  }
  const process = await readProcess()
  if (!process) return { kind: 'unknown', reason: `the process state could not be read: ${readFault('process-read') ?? 'cause unknown'}` }
  const reason = process.auditUnrecorded?.[sessionId]
  return reason === undefined ? undefined : { kind: 'unrecorded', reason }
}

/**
 * Separates persisted session facts from derived flow and issue fields.
 * @param session - The session with its derived fields.
 * @returns A detached session record suitable for persistence.
 */
function stripSession(session: Session): SessionRecord {
  const { flow, issues, auditNote, ...record } = session
  return JSON.parse(JSON.stringify(record)) as SessionRecord
}

/**
 * Applies a change to the fresh session with compare-and-set and mirrors the resulting whole value.
 *
 * A missed write re-reads, which the engine answers with the current value, and applies the change again,
 * so a record is never built from a read older than the one it replaces.
 * @param port - The engine calls.
 * @param change - Builds the next session from the fresh one.
 * @param attempt - The attempt this call makes.
 * @returns The written session with its version, as written, or as unmirrored with why when the write landed and only its mirror failed,
 * which readers in other sessions then lag behind until the tick publishes it; null when the change wrote nothing.
 * @throws When the write itself failed.
 */
export async function updateSession(port: EnginePort, change: SessionChange, attempt = 1): Promise<SessionWrite | null> {
  const held = await readVersionedSession(port)
  const next = await change(held.session)
  if (!next) return null
  if (await port.writeSessionState(stripSession(next), held.version)) {
    const written = { session: next, version: held.version + 1 }
    return mirrorSession(port, false).then((): SessionWrite => ({ kind: 'written', ...written }),
      (error: unknown): SessionWrite => ({ kind: 'unmirrored', ...written, error: error instanceof Error ? error.message : String(error) }))
  }
  if (attempt < sessionWriteAttempts) return updateSession(port, change, attempt + 1)
  const error = `session record: ${attempt} writes in a row lost to newer ones`
  sessionMemory.recordError = holdError(sessionMemory.recordError, error, await port.now())
  throw new Error(error)
}

/**
 * Serializes this chat's mirror writes from authoritative state, never landing a snapshot older than the mirror already written. Two
 * module loads of one session are live together after a reload, and readers in other sessions, as /flow report and merge_child, take
 * issue facts and the audit from this mirror. So the mirror is written under the session's publish lock, from the session read under it,
 * and only when the revision beside it, the process and the `$.state` version it was written from, is not newer; a revision or process
 * state that cannot be read writes nothing. The revision is
 * written before the mirror, so a failure between the two renames leaves the fence ahead of the mirror, never behind: the mirror's own
 * format has no room for it, as older modules reading it refuse unknown keys. A mirror of another process is never older, since that
 * process ended before this one began. A publish that cannot take the lock writes nothing and is shown on the pane; the tick tries again.
 * @param port - The engine calls.
 * @param check - Whether a tick checks the mirror first; record writes replace it without reading.
 * @throws When the publish wrote no mirror, with the failed write's error or why the lock was not held.
 */
export async function mirrorSession(port: EnginePort, check = true): Promise<void> {
  return mirrorQueue.run(async () => {
    const common = await readCommonDir(port)
    const sessionId = await port.readSessionId()
    if (!common) return
    const path = recordsPath(common, 's', `${sessionId}.json`)
    const revisionPath = mirrorRevisionPath(common, sessionId)
    const process = await readProcessState(port)
    // why: a state with no generation yet, one an earlier version seeded or one absent while this load's adoption is open, cannot fence the mirror against the one a newer load publishes, so the publish waits for the adoption, which publishes it then; the session write itself stands. A load that never started, as no real session has, mirrors unfenced.
    const isHeld = await port.readProcessState().then(value => value !== undefined, () => true)
    if (process && !process.generation && (isHeld || !isProcessStarted())) {
      sessionMemory.isMirrorDeferred = true
      return
    }
    const published = await publishFenced(port, path, async lock => {
      // why: a fence that cannot be read is never taken for none, or an older mirror could replace a newer one; the publish writes nothing and the tick tries again.
      if (!process) throw new Error('the process state could not be read, so the mirror fence is unknown')
      const generation = process.generation
      const held = await port.readSessionState()
      const saved = held.value
      if (!saved) return
      const text = JSON.stringify(saved)
      const written = parseMirrorRevision(await readJson(port.files, revisionPath).catch((error: unknown) => {
        throw new Error(`the mirror revision could not be read, so the mirror fence is unknown: ${error instanceof Error ? error.message : String(error)}`)
      }))
      if (generation && written?.generation === generation && written.version > held.version) return
      if (check) {
        // why: the mirror may not exist yet.
        try { if (await port.files.read(path) === text) return } catch {}
      }
      if (generation) await atomicReplace(port, revisionPath, JSON.stringify({ v: 1, generation, version: held.version } satisfies MirrorRevision), undefined, lock)
      await atomicReplace(port, path, text, undefined, lock)
    })
    const fault = readFault(`publish:${path}`)
    // why: a record write tells its caller the mirror was not updated, as a run's answer does, while the pane keeps the fault for the tick.
    if (published !== 'confirmed' && fault) throw new Error(fault)
  })
}

/**
 * Names the revision record beside a session mirror.
 * @param common - The git common directory.
 * @param sessionId - The session.
 * @returns The file path.
 */
export const mirrorRevisionPath = (common: string, sessionId: string): string => recordsPath(common, 's', `${sessionId}.rev`)

/**
 * Validates a mirror's revision record.
 * @param value - The decoded JSON.
 * @returns The revision, or null.
 */
const parseMirrorRevision = (value: unknown): MirrorRevision | null => isRecord(value) && value.v === 1 && typeof value.generation === 'string'
  && isFiniteNumber(value.version) ? { v: 1, generation: value.generation, version: value.version } : null

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
    ...unit, ...merged, skills: mergeUnique(merged.skills, unit.skills), verifyRuns: [...merged.verifyRuns, ...unit.verifyRuns].sort((a, b) => b.at - a.at)
      .filter((run, index, runs) => runs.findIndex(other => other.tree === run.tree && other.base === run.base) === index),
    base: merged.base ?? unit.base, baseBranch: merged.base ? merged.baseBranch : unit.baseBranch, skips: [...(merged.skips ?? []), ...(unit.skips ?? [])]
      .filter((skip, index, skips) => skips.findIndex(other => other.step === skip.step && other.reason === skip.reason) === index),
    ...(merged.delegated || unit.delegated ? { delegated: mergeUnique(merged.delegated ?? [], unit.delegated ?? []) } : {}),
    // why: A pin judges only the approval it was stored with, so both come from the same entry.
    ...(merged.approval ? { approval: merged.approval, approvedRed: merged.approvedRed } : { approval: unit.approval, approvedRed: unit.approvedRed }),
  }), createEmptyUnit())
  // why: each session counts only its own Verify calls, so the session that ran the newest one holds the current count.
  const newest = units.reduce<UnitEntry | undefined>((best, unit) => (unit.verifyRuns[0]?.at ?? -Infinity) > (best?.verifyRuns[0]?.at ?? -Infinity) ? unit : best, undefined)
  const { redVerifies, ...rest } = evidence
  const merged = { ...rest, ...newest?.redVerifies === undefined ? {} : { redVerifies: newest.redVerifies }, runs: retainRuns(units.flatMap(unit => unit.runs)) }
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
 * Reads every valid mirror plus this chat's authoritative record for a pruning snapshot; another session's mirror that is
 * not JSON, or no valid record, is skipped.
 * @param port - The engine calls.
 * @param strict - Whether a failed listing aborts a file-pruning snapshot.
 * @returns Whole session records with their owned paths and listed modification times; this chat's record has none.
 * @throws When another session's mirror cannot be read: skipping it would drop the units it holds.
 */
export async function readSessionMirrors(port: EnginePort, strict = false): Promise<SessionMirror[]> {
  const session = await readSession(port)
  const common = await readCommonDir(port)
  const directory = recordsPath(common, 's')
  // why: the directory may not exist yet when the read is non-strict.
  const entries = await port.files.list(directory).catch(error => { if (strict) throw error; return [] })
  const others = await Promise.all(entries.filter(({ name }) => name.endsWith('.json') && name !== `${session.sessionId}.json`)
    .sort((a, b) => a.name.localeCompare(b.name)).map(async ({ name, mtimeMs }) => {
      const path = recordsPath(common, 's', name)
      const text = await readText(port.files, path)
      return { path, mtimeMs, session: parseSession(text === undefined ? undefined : unwrapOr(parseJson(text), undefined)) }
    }))
  return [{ path: recordsPath(common, 's', `${session.sessionId}.json`), session, mtimeMs: null },
    ...others.flatMap(other => other.session ? [{ path: other.path, session: other.session, mtimeMs: other.mtimeMs }] : [])]
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
 * Reads a declaration, telling a missing one from one that is not a valid record.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @returns The declaration, null when absent, or `invalid` when its file holds no valid record.
 * @throws When the file cannot be read.
 */
export async function readDeclarationStrict(port: EnginePort, identity: Identity): Promise<UnitRecord | null | 'invalid'> {
  const raw = await readJson(port.files, await unitPath(port, identity))
  return raw === undefined ? null : parseUnitRecord(raw) ?? 'invalid'
}

/**
 * Reads every declaration on disk, including those no session entry names any more.
 * @param port - The engine calls.
 * @returns Every declaration, or none when no declaration was ever written.
 * @throws When the declarations cannot be listed, or a listed one cannot be read or parsed: a pruning sweep must not
 * judge a unit without its declaration.
 */
export async function readDeclarations(port: EnginePort): Promise<UnitRecord[]> {
  const common = await readCommonDir(port)
  const names = await listRecordNames(port, recordsPath(common, 'u'))
  return Promise.all(names.filter(name => /^[0-9a-f]+\.json$/.test(name)).map(async name => {
    // why: a declaration that cannot be read or parsed is named below by its file, which fails the whole read.
    const record = parseUnitRecord(await readJson(port.files, recordsPath(common, 'u', name)).catch(() => null))
    if (!record) throw new Error(`unreadable declaration ${name}`)
    return record
  }))
}

/**
 * Lists a record bucket, reading a bucket no record was ever written to as empty.
 * @param port - The engine calls.
 * @param directory - The bucket.
 * @returns The names in the bucket.
 * @throws When the bucket cannot be listed and its absence is not confirmed: a failed listing must not read as no records.
 */
export async function listRecordNames(port: EnginePort, directory: string): Promise<string[]> {
  const entries = await port.files.list(directory).catch(async (error: unknown) => {
    // why: the bucket is created by its first record, so a missing one only means no record yet; a failed stat is no proof of absence.
    if (await isConfirmedAbsent(port, directory)) return []
    throw error
  })
  return entries.map(entry => entry.name)
}

/**
 * Tells whether a path is confirmed absent: the engine's failures carry no missing-file code, so only the listing of an ancestor that
 * holds no next part of the path proves it.
 * @param port - The engine calls.
 * @param path - The absolute path.
 * @returns Whether an ancestor's listing confirmed the path absent; false when no ancestor could be listed.
 */
async function isConfirmedAbsent(port: EnginePort, path: string): Promise<boolean> {
  const cut = path.lastIndexOf('/')
  if (cut <= 0) return false
  const parent = path.slice(0, cut)
  const names = await port.files.list(parent).then(entries => entries.map(entry => entry.name), () => null)
  return names ? !names.includes(path.slice(cut + 1)) : isConfirmedAbsent(port, parent)
}

/**
 * Sweeps every file of a record bucket in listing order.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param bucket - The bucket.
 * @param sweep - Judges one file by its name and removes it when it is stale.
 * @returns Once every file was swept.
 */
export async function sweepBucket(port: EnginePort, common: string, bucket: RecordBucket, sweep: (name: string) => Promise<void>): Promise<void> {
  // why: the bucket may not exist yet.
  for (const { name } of await port.files.list(recordsPath(common, bucket)).catch(() => [])) await sweep(name)
}

/**
 * Reads the unit entries of every chat that belong to active declarations, refusing to read any record as absent.
 * @param port - The engine calls.
 * @returns The active entries.
 * @throws When a bucket cannot be listed, or a listed mirror or declaration cannot be read or parsed.
 */
async function readEntriesStrictly(port: EnginePort): Promise<UnitEntry[]> {
  const session = await readSession(port)
  const common = await readCommonDir(port)
  const names = (await listRecordNames(port, recordsPath(common, 's'))).filter(name => name.endsWith('.json') && name !== `${session.sessionId}.json`)
  const others = await Promise.all(names.map(async name => {
    // why: a mirror that cannot be read or parsed is named below by its file, which fails the whole read.
    const mirror = parseSession(await readJson(port.files, recordsPath(common, 's', name)).catch(() => null))
    if (!mirror) throw new Error(`unreadable session mirror ${name}`)
    return mirror
  }))
  const declarations = await readDeclarations(port)
  return [session, ...others].flatMap(record => record.units).filter(entry => {
    const declaration = declarations.find(record => sameIdentity(record.identity, entry.identity))
    return isActiveEntry(entry, declaration)
  })
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
    return isActiveEntry(entry, declaration) ? entry : null
  }))
  return active.filter((entry): entry is UnitEntry => entry !== null)
}

/**
 * Tells whether a unit entry belongs to its identity's active declaration: an entry without a declaration counts only when it has no generation.
 * @param entry - The unit entry.
 * @param declaration - Its identity's declaration, if any.
 * @returns Whether the entry is evidence of the active lifetime.
 */
function isActiveEntry(entry: UnitEntry, declaration: UnitRecord | null | undefined): boolean {
  return declaration ? declaration.generation === entry.generation : entry.generation === undefined
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
 * Names the records a unit identity owns apart from its transition log: its declaration and its observed slice end directory.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @returns The paths, whether or not they exist.
 */
export async function listIdentityRecords(port: EnginePort, identity: Identity): Promise<string[]> {
  const { common, hash } = await readIdentityHash(port, identity)
  return [recordsPath(common, 'u', `${hash}.json`), recordsPath(common, 'end', hash)]
}

/**
 * Reads each distinct unit on a branch across all chats.
 * @param port - The engine calls.
 * @param branch - The unit's branch.
 * @returns The identities with their merged evidence.
 */
export async function readBranchUnits(port: EnginePort, branch: string): Promise<UnitEntry[]> {
  return mergeEntries(port, (await readEntries(port)).filter(entry => entry.identity.branch === branch))
}

/**
 * Reads each distinct unit on a branch across all chats, failing instead of dropping a record it cannot read.
 * @param port - The engine calls.
 * @param branch - The units' branch.
 * @returns The identities with their merged evidence, or the failure of a record read: a record read as absent would drop a unit.
 */
export async function readBranchUnitsStrictly(port: EnginePort, branch: string): Promise<Result<UnitEntry[]>> {
  const read: Result<UnitEntry[]> = await settle(readEntriesStrictly(port))
  return read.isOk ? succeed(await mergeEntries(port, read.value.filter(entry => entry.identity.branch === branch))) : read
}

/**
 * Reads each distinct unit across all chats whose merged evidence caches the given branch as its base branch, except
 * a Close out, which is never a child unit.
 * @param port - The engine calls.
 * @param baseBranch - The branch the units were cut from.
 * @returns The identities with their merged evidence, or the failure of a record read: a record read as absent would drop a unit.
 */
export async function readBaseBranchUnits(port: EnginePort, baseBranch: string): Promise<Result<UnitEntry[]>> {
  const read: Result<UnitEntry[]> = await settle(readEntriesStrictly(port))
  if (!read.isOk) return read
  const entries = read.value
  // why: A unit's base branch is decided across all its entries, so an entry naming another base can still be the one that counts.
  const named = entries.filter(entry => entry.baseBranch === baseBranch)
  const units = await mergeEntries(port, entries.filter(entry => named.some(other => sameIdentity(entry.identity, other.identity))))
  const declarations = await settle(readDeclarations(port))
  if (!declarations.isOk) return declarations
  const isCloseOut = (unit: UnitEntry): boolean => declarations.value.some(record => sameIdentity(record.identity, unit.identity) && record.flow === 'close-out')
  return succeed(units.filter(unit => unit.baseBranch === baseBranch && !isCloseOut(unit)))
}

/**
 * Merges entries into one unit per distinct identity.
 * @param port - The engine calls.
 * @param entries - The active entries.
 * @returns The identities with their merged evidence, in first-seen order.
 */
async function mergeEntries(port: EnginePort, entries: UnitEntry[]): Promise<UnitEntry[]> {
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
  await updateSession(port, async current => replaceUnitEntry(current, identity, { ...change(await readUnit(port, identity)), identity }))
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
export function recordsPath(common: string | null, bucket?: RecordBucket, name?: string): string {
  return `${common}/working-agreement${bucket === undefined ? '' : `/${bucket}`}${name === undefined ? '' : `/${name}`}`
}
