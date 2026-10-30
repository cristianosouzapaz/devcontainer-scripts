import { readLabelledJobs } from '../lib/github'
import { readJson } from '../lib/json'
import { isRecord, isSafeInteger } from '../lib/guards'
import { executeProcess } from '../lib/process'
import type { EnginePort } from './engine-port'
import { readHost, readStartTime } from './host'
import type { Host } from './host'
import { atomicReplace, readCommonDir, recordsPath } from './record-store'

/** Holds the lock owner's record, which a holder rereads before it records a result. */
interface Owner extends Host { sid: string; ticket: string; token: string }
/** The queue's tickets split by whether their lease is fresh, each in arrival order. */
interface Tickets { live: string[]; stale: string[] }
/** Holds a session's place in the queue once it holds the lock. */
export interface VerifyTurn { dir: string; ticket: string; token: string }
/** Holds the turn a wait won. */
interface Acquired { kind: 'acquired'; turn: VerifyTurn }
/** Marks a wait that ended without the lock, leaving no ticket behind. */
interface Unserved { kind: 'timeout' | 'cancelled' }
/** Names how a wait for the lock ended. */
export type QueueWait = Acquired | Unserved
/** Names how a holder's wait for the CI runner ended: no labelled job, an unreadable CI state, the queue timeout, or a cancel. */
type CiWait = 'idle' | 'unknown' | 'timeout' | 'cancelled'

/** How often a holder or a waiter renews its lease. */
const renewMs = 5000
/** How old a lease may grow before another session treats it as dead. */
const staleMs = 30000
/** How often a waiter rereads the queue. */
const pollMs = 1000
/** How often a holder asks GitHub whether a CI job holds the runner: each poll costs several API calls. */
const ciPollMs = 30000
// A zero-padded epoch sorts tickets by arrival as plain names.
const ticketPattern = /^\d{15}-.+$/
const sequence = { value: 0 }

/**
 * Idles in a host `sleep`: a process call in flight stops the hook's budget clock, which a `$.clock` wait runs down,
 * so a queued wait outlasts the engine's ten-second hook budget; steps of one poll let an abort end it within one.
 * @param port - The engine calls.
 * @param ms - How long to idle.
 * @param signal - Ends the idle at the next step.
 */
async function idle(port: EnginePort, ms: number, signal: AbortSignal): Promise<void> {
  const until = await port.now() + ms
  while (!signal.aborted) {
    const left = until - await port.now()
    if (left <= 0) return
    await executeProcess(port.processes, ['sleep', String(Math.min(pollMs, left) / 1000)])
  }
}

/**
 * Reads the lock's owner record.
 * @param port - The engine calls.
 * @param dir - The queue directory.
 * @returns The owner, or null while the lock is free, half-written or unreadable.
 */
async function readOwner(port: EnginePort, dir: string): Promise<Owner | null> {
  const value = await readJson(port.files, `${dir}/lock/owner.json`).catch(() => undefined)
  if (!isRecord(value) || ![value.sid, value.ticket, value.token].every(field => typeof field === 'string')) return null
  const text = (field: unknown): string | null => typeof field === 'string' ? field : null
  return { sid: String(value.sid), ticket: String(value.ticket), token: String(value.token), pidns: text(value.pidns), pidStart: text(value.pidStart),
    bootId: text(value.bootId), pid: isSafeInteger(value.pid) && value.pid > 0 ? value.pid : null }
}

/**
 * Lists the tickets whose lease is fresh, in arrival order.
 * @param port - The engine calls.
 * @param dir - The queue directory.
 * @param now - The time the leases are judged at.
 * @returns The live tickets and the stale ones.
 */
async function readTickets(port: EnginePort, dir: string, now: number): Promise<Tickets> {
  const names = (await port.files.list(`${dir}/q`).catch(() => [])).map(entry => entry.name).filter(name => ticketPattern.test(name)).sort()
  const ages = await Promise.all(names.map(async name => now - await readMtime(port, `${dir}/q/${name}`)))
  return { live: names.filter((_, index) => ages[index]! <= staleMs), stale: names.filter((_, index) => ages[index]! > staleMs) }
}

/**
 * Reads a lease directory's modification time, which a listing reports as zero for directories.
 * @param port - The engine calls.
 * @param path - The directory.
 * @returns Its modification time in epoch ms, or zero once it is gone.
 */
async function readMtime(port: EnginePort, path: string): Promise<number> {
  return (await port.files.stat(path).catch(() => null))?.mtimeMs ?? 0
}

/**
 * Judges the lock dead when its lease expired, or when its owner's process is gone or its pid reused on this same host.
 * @param port - The engine calls.
 * @param dir - The queue directory.
 * @param now - The time the lease is judged at.
 * @param host - The reader's own host identity.
 * @returns Whether a waiter may break the lock.
 */
async function isLockStale(port: EnginePort, dir: string, now: number, host: Host): Promise<boolean> {
  const lock = await port.files.stat(`${dir}/lock`).catch(() => null)
  if (!lock) return false
  if (now - lock.mtimeMs > staleMs) return true
  const owner = await readOwner(port, dir)
  // A pid means nothing across pid namespaces or reboots, so there only the lease decides.
  if (!owner?.pid || !host.pidns || !host.bootId || owner.pidns !== host.pidns || owner.bootId !== host.bootId) return false
  return readStartTime(await port.files.read(`/proc/${owner.pid}/stat`).catch(() => '')) !== owner.pidStart
}

/**
 * Breaks a stale lock: the rename without -f has a single winner among waiters breaking it at once.
 * @param port - The engine calls.
 * @param dir - The queue directory.
 * @param sid - The breaking session.
 * @returns Whether this session moved the lock away.
 */
export async function breakStaleLock(port: EnginePort, dir: string, sid: string): Promise<boolean> {
  const moved = `${dir}/lock.stale-${sid}`
  if ((await executeProcess(port.processes, ['mv', '--', `${dir}/lock`, moved])).exitCode !== 0) return false
  await executeProcess(port.processes, ['rm', '-rf', '--', moved])
  return true
}

/**
 * Takes the lock with an atomic mkdir, breaking it first when its holder is dead.
 * @param port - The engine calls.
 * @param dir - The queue directory.
 * @param owner - The record the new holder writes.
 * @returns Whether this session now holds the lock.
 */
async function tryLock(port: EnginePort, dir: string, owner: Owner): Promise<boolean> {
  if ((await executeProcess(port.processes, ['mkdir', '--', `${dir}/lock`])).exitCode === 0) {
    await atomicReplace(port, `${dir}/lock/owner.json`, JSON.stringify(owner))
    return true
  }
  return await isLockStale(port, dir, await port.now(), owner) && await breakStaleLock(port, dir, owner.sid) && tryLock(port, dir, owner)
}

/**
 * Removes a session's ticket, and the lock when it still owns it.
 * @param port - The engine calls.
 * @param turn - The session's ticket and token.
 */
export async function leaveVerifyQueue(port: EnginePort, turn: VerifyTurn): Promise<void> {
  if ((await readOwner(port, turn.dir))?.token === turn.token) await executeProcess(port.processes, ['rm', '-rf', '--', `${turn.dir}/lock`])
  await executeProcess(port.processes, ['rm', '-rf', '--', `${turn.dir}/q/${turn.ticket}`])
}

/**
 * Waits first come, first served for the repository's Verify lock, renewing the ticket's lease; only the head tries the lock.
 * @param port - The engine calls.
 * @param common - The repository's common directory, shared by its worktrees.
 * @param sid - The waiting session.
 * @param deadline - When the wait gives up.
 * @param signal - The dispatch's cancellation signal.
 * @param onMove - Called whenever the session's position or the queue's length changes.
 * @returns The held turn, or how the wait ended without one; either way without a ticket left behind.
 */
export async function waitVerifyTurn(port: EnginePort, common: string, sid: string, deadline: number, signal: AbortSignal, onMove: () => Promise<void>): Promise<QueueWait> {
  const dir = recordsPath(common, 'verify')
  const start = await port.now()
  const turn: VerifyTurn = { dir, ticket: `${String(start).padStart(15, '0')}-${sid}`, token: `${start}-${++sequence.value}-${sid}` }
  const mkdir = async (...args: string[]) => {
    const run = await executeProcess(port.processes, ['mkdir', ...args])
    if (run.exitCode !== 0) throw new Error(run.stderr || 'cannot create the Verify queue')
  }
  await mkdir('-p', '--', `${dir}/q`)
  await mkdir('--', `${dir}/q/${turn.ticket}`)
  const state = { shown: '', renewed: start }
  const owner: Owner = { sid, ticket: turn.ticket, token: turn.token, ...await readHost(port) }
  const outcome = await (async (): Promise<QueueWait> => {
    while (!signal.aborted) {
      const now = await port.now()
      if (now >= deadline) return { kind: 'timeout' }
      if (now - state.renewed >= renewMs) {
        await executeProcess(port.processes, ['touch', '--', `${dir}/q/${turn.ticket}`])
        state.renewed = now
      }
      const { live, stale } = await readTickets(port, dir, now)
      for (const name of stale) await executeProcess(port.processes, ['rm', '-rf', '--', `${dir}/q/${name}`])
      // A ticket another session pruned while this one was suspended comes back under its own arrival time.
      if (!live.includes(turn.ticket)) await mkdir('--', `${dir}/q/${turn.ticket}`)
      const shown = `${live.indexOf(turn.ticket)}/${live.length}`
      if (shown !== state.shown) {
        state.shown = shown
        await onMove()
      }
      if (live[0] === turn.ticket && await tryLock(port, dir, owner)) return { kind: 'acquired', turn }
      // A dead holder's ticket can outlive its process by a lease; the next in line clears both rather than wait it out.
      if (live[1] === turn.ticket && live[0] === (await readOwner(port, dir))?.ticket && await isLockStale(port, dir, now, owner)
        && await breakStaleLock(port, dir, sid)) {
        await executeProcess(port.processes, ['rm', '-rf', '--', `${dir}/q/${live[0]}`])
        continue
      }
      await idle(port, pollMs, signal)
    }
    return { kind: 'cancelled' }
  })().catch(async (error: unknown) => {
    // why: the wait's own error is the one reported; a ticket left behind ages out with its lease.
    await leaveVerifyQueue(port, turn).catch(() => {})
    throw error
  })
  if (outcome.kind !== 'acquired') await leaveVerifyQueue(port, turn)
  return outcome
}

/**
 * Renews the holder's lock and ticket leases until stopped.
 * @param port - The engine calls.
 * @param turn - The held turn.
 * @returns A stop that resolves once renewal ended.
 */
export function holdVerifyTurn(port: EnginePort, turn: VerifyTurn): () => Promise<void> {
  const control = new AbortController()
  const renewal = (async () => {
    while (!control.signal.aborted) {
      // An abort ends the wait.
      try { await port.clock.sleep(renewMs, control.signal) } catch { return }
      // why: a missed renewal only ages the lease, and the next one, a renewal period later, renews it again.
      await executeProcess(port.processes, ['touch', '--', `${turn.dir}/lock`, `${turn.dir}/q/${turn.ticket}`]).catch(() => null)
    }
  })()
  return async () => { control.abort(); await renewal }
}

/**
 * Holds the lock while a queued or in-progress CI job asks for one of the runner labels, so the waiters behind keep their order;
 * a marker inside the lock tells every reader of the queue that CI holds it.
 * @param port - The engine calls.
 * @param turn - The held turn.
 * @param labels - The runner labels that identify this machine's runner.
 * @param deadline - When the wait gives up, the same bound as the wait for the lock.
 * @param signal - The dispatch's cancellation signal.
 * @param onMove - Called when the CI wait starts or ends.
 * @returns How the wait ended.
 */
export async function waitCiIdle(port: EnginePort, turn: VerifyTurn, labels: string[], deadline: number, signal: AbortSignal, onMove: () => Promise<void>): Promise<CiWait> {
  const marker = `${turn.dir}/lock/ci`
  const state = { isMarked: false }
  try {
    while (!signal.aborted) {
      const busy = await readLabelledJobs(port.processes, labels)
      if (!busy.isOk) return 'unknown'
      if (!busy.value) return 'idle'
      const now = await port.now()
      if (now >= deadline) return 'timeout'
      if (!state.isMarked) {
        await atomicReplace(port, marker, 'running')
        state.isMarked = true
        await onMove()
      }
      await idle(port, Math.min(ciPollMs, deadline - now), signal)
    }
    return 'cancelled'
  } finally {
    if (state.isMarked) {
      // why: a marker left behind only delays the next holder's CI check; the wait's outcome stands either way.
      await executeProcess(port.processes, ['rm', '-f', '--', marker]).catch(() => null)
      await onMove()
    }
  }
}

/**
 * Confirms the lock still carries the holder's token, which a waiter breaking it as stale replaced.
 * @param port - The engine calls.
 * @param turn - The held turn.
 * @returns Whether the holder still owns the lock.
 */
export async function isTurnHeld(port: EnginePort, turn: VerifyTurn): Promise<boolean> {
  return (await readOwner(port, turn.dir))?.token === turn.token
}

/**
 * Names a position the way the pane and the sidebar print it.
 * @param position - The one-based position.
 * @returns The ordinal, such as 2nd.
 */
function formatOrdinal(position: number): string {
  const tens = position % 100
  return `${position}${tens >= 11 && tens <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][position % 10] ?? 'th'}`
}

/**
 * Reads this session's place in the repository's Verify queue from the queue directory.
 * @param port - The engine calls.
 * @returns The queued fact, such as `queued, 2nd of 3` or `queued: CI running`, or null when the session waits for nothing or holds the lock for its run.
 */
export async function readVerifyQueue(port: EnginePort): Promise<string | null> {
  const common = await readCommonDir(port)
  if (!common) return null
  const sid = await port.readSessionId()
  const dir = recordsPath(common, 'verify')
  const { live } = await readTickets(port, dir, await port.now())
  const index = live.findIndex(name => name.endsWith(`-${sid}`))
  if (index < 0) return null
  if (index === 0 && (await readOwner(port, dir))?.sid === sid) return await port.files.exists(`${dir}/lock/ci`) ? 'queued: CI running' : null
  return `queued, ${formatOrdinal(index + 1)} of ${live.length}`
}
