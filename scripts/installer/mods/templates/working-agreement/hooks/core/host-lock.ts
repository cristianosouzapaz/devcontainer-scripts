import type { HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import { executeProcess } from '../lib/process'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { recordsPath } from './record-store'

/** A lock older sessions still take as an atomic `mkdir`, held beside the flock for one release, and the age they break it at. */
interface LegacyLock { dir: string; staleMs: number }

/** How a wait for a host lock is bounded, watched and reported. */
export interface HostLockOptions {
  /** Ends the wait when it aborts; absent, only the deadline ends it. */
  signal?: AbortSignal
  /** When the wait gives up, in epoch ms; absent, it waits as long as the signal allows. */
  deadline?: number
  /** A directory whose entries changing calls onPoke, such as the session's mailbox. */
  watch?: string
  /** A file naming the process group the work runs its command in: a holder that ends while it holds the lock stops that group first. */
  killGroup?: string
  legacy?: LegacyLock
  /** Hears the session's one-based place in the queue and the queue's length, whenever either changes. */
  onPosition?: (position: number, length: number) => Promise<void>
  /** Runs once as the wait starts and again whenever the watched directory changes, during the wait and the work. */
  onPoke?: () => Promise<void>
  /** Whether the holder renames for the work, which the work's rename then asks of it. */
  renames?: boolean
}

/**
 * The held lock as the work sees it: lost aborts if the process holding the flock ends before the work does; rename, with the holder
 * started to rename, has that process rename a file while it holds the flock, so a rename never lands after the lock was lost.
 */
export interface HeldLock { lost: AbortSignal; rename: (from: string, to: string) => Promise<void> }

/** How a hold ended: the work's value, the deadline, the signal, or a holder that could not start or ended before it held the lock. */
export type HostLockOutcome<T> = { kind: 'done'; value: T } | { kind: 'timeout' } | { kind: 'cancelled' } | { kind: 'failed'; error: string }

/**
 * The queue as a reader sees it: whether the lock is held, and the ids, the holder's first while held, then the waiters in arrival order.
 * The holder is the ticket its holder marked, never the first to arrive; while no live ticket carries the mark, as under a holder of an older
 * script, the first live ticket in arrival order, which is how that holder took the lock; a held lock with no live ticket lists an empty id.
 */
export interface HostLockQueue { isHeld: boolean; ids: string[] }

/** The holder's output, split into lines, read by one pump that keeps a pull in flight until the stream ends. */
interface LineFeed {
  take: () => Promise<string | null>
  stderr: () => string
  /** Resolves with the holder's pid once it printed it, or with null once the stream ended without it. */
  pid: Promise<number | null>
  /** The holder's ticket file, once it printed it. */
  ticket: () => string | null
  isEnded: () => boolean
}

/** The pump's mutable state. */
interface FeedState { lines: (string | null)[]; waiters: ((line: string | null) => void)[]; rest: string; stderr: string; isEnded: boolean; ticket: string | null }

/** The script every holder and reader runs, shipped with the mod. */
const scriptName = 'host-lock.pl'

/**
 * Names a host lock's permanent lock file in the mod's records directory, which is created once and never moved or removed.
 * @param common - The git common directory.
 * @param name - The lock's name.
 * @returns The lock file's path.
 */
export function hostLockPath(common: string, name: string): string {
  return recordsPath(common, 'locks', name)
}

/**
 * Feeds the stream's stdout lines to one reader: the pump pulls the next piece as soon as the last arrived, so a pull stays in
 * flight the whole time, which stops the hook's budget clock while the holder waits or holds.
 * @param stream - The holder's stream.
 * @returns The feed: take resolves null once the stream ended.
 */
function feedLines(stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>): LineFeed {
  const state: FeedState = { lines: [], waiters: [], rest: '', stderr: '', isEnded: false, ticket: null }
  const known: { resolve?: (pid: number | null) => void } = {}
  const pid = new Promise<number | null>(resolve => { known.resolve = resolve })
  const push = (line: string | null): void => {
    const announced = line === null ? null : /^pid (\d+)$/.exec(line)
    if (announced) { known.resolve?.(Number(announced[1])); return }
    const ticket = line === null ? null : /^ticket (.+)$/.exec(line)
    if (ticket) { state.ticket = ticket[1] ?? null; return }
    const waiter = state.waiters.shift()
    if (waiter) waiter(line)
    else state.lines.push(line)
  }
  void (async () => {
    try {
      for (;;) {
        const piece = await stream.next()
        if (piece.done) return
        if (piece.value.stream === 'stderr') { state.stderr += piece.value.text; continue }
        const parts = (state.rest + piece.value.text).split('\n')
        state.rest = parts.pop() ?? ''
        for (const part of parts) push(part)
      }
    } catch (error) {
      state.stderr += error instanceof Error ? error.message : String(error)
    } finally {
      state.isEnded = true
      known.resolve?.(null)
      push(null)
    }
  })()
  return {
    take: () => state.lines.length ? Promise.resolve(state.lines.shift() ?? null) : new Promise(resolve => { state.waiters.push(resolve) }),
    stderr: () => state.stderr.trim(),
    pid,
    ticket: () => state.ticket,
    isEnded: () => state.isEnded,
  }
}

/**
 * Resolves once the signal aborts.
 * @param signal - The signal.
 * @returns The abort, as a value the races below tell from a line.
 */
function onceAborted(signal: AbortSignal): Promise<'aborted'> {
  return new Promise(resolve => {
    if (signal.aborted) resolve('aborted')
    else signal.addEventListener('abort', () => { resolve('aborted') }, { once: true })
  })
}

/**
 * Builds the holder's argv.
 * @param port - The engine calls.
 * @param lock - The lock file.
 * @param id - Who waits, as readers list it.
 * @param options - The deadline, the watched directory and the legacy lock.
 * @returns The argv.
 */
async function holderArgv(port: EnginePort, lock: string, id: string, options: HostLockOptions): Promise<string[]> {
  const wait = options.deadline === undefined ? [] : ['--wait', String(Math.max(0, Math.ceil((options.deadline - await port.now()) / 1000)))]
  const watch = options.watch === undefined ? [] : ['--watch', options.watch]
  const killGroup = options.killGroup === undefined ? [] : ['--kill-group', options.killGroup]
  const legacy = options.legacy ? ['--legacy', options.legacy.dir, '--legacy-stale', String(Math.ceil(options.legacy.staleMs / 1000))] : []
  return ['perl', `${await port.readPluginRoot()}/scripts/${scriptName}`, 'wait', lock, id, ...wait, ...watch, ...killGroup, ...legacy, ...options.renames ? ['--renames'] : []]
}

/**
 * Runs work while this session holds a host lock: a flock taken first come, first served and held by one host process for exactly as
 * long as the work runs. Each wait and the work keep a stream pull in flight, raced with the signal, so neither runs the hook's budget
 * down; leaving, by any path, closes the stream, which ends the process and frees the lock and its ticket. A holder that ends during
 * the work aborts `lost`, and the work then stops what it started before the lock is given back.
 * @param port - The engine calls.
 * @param lock - The lock file, from hostLockPath.
 * @param id - Who waits, as readers list it: the session id.
 * @param work - What runs under the lock.
 * @param options - The signal, deadline, watch, legacy lock and listeners.
 * @returns The work's value, or how the hold ended without it.
 */
export async function withHostLock<T>(port: EnginePort, lock: string, id: string, work: (held: HeldLock) => Promise<T>, options: HostLockOptions): Promise<HostLockOutcome<T>> {
  const directory = lock.slice(0, lock.lastIndexOf('/'))
  const made = await executeProcess(port.processes, ['mkdir', '-p', '--', directory])
  if (made.exitCode !== 0) return { kind: 'failed', error: made.stderr.trim() || `cannot create ${directory}` }
  const signal = options.signal ?? new AbortController().signal
  if (signal.aborted) return { kind: 'cancelled' }
  const stream = port.processes.spawn({ argv: await holderArgv(port, lock, id, options) })
  const feed = feedLines(stream)
  const aborted = onceAborted(signal)
  try {
    await options.onPoke?.()
    for (;;) {
      if (signal.aborted) return { kind: 'cancelled' }
      const line = await Promise.race([aborted, feed.take()])
      if (line === 'aborted') return { kind: 'cancelled' }
      if (line === null) return { kind: 'failed', error: feed.stderr() || 'the host lock process ended before it held the lock' }
      if (line === 'locked') break
      if (line === 'timeout') return { kind: 'timeout' }
      if (line === 'poke') await options.onPoke?.()
      const position = /^pos (\d+) (\d+)$/.exec(line)
      if (position) await options.onPosition?.(Number(position[1]), Number(position[2]))
    }
    if (signal.aborted) return { kind: 'cancelled' }
    const lost = new AbortController()
    const held: { isDone: boolean; renamed: ((line: string | null) => void) | null } = { isDone: false, renamed: null }
    // why: the feed's pull stays in flight during the work, so the stream's end, the holder gone, reads as the lock lost.
    void (async () => {
      for (;;) {
        const line = await feed.take()
        if (held.isDone) return
        if (line === null) { lost.abort(); held.renamed?.(null); return }
        if (line === 'poke') await options.onPoke?.()
        if (line === 'renamed' || line.startsWith('rename-failed')) held.renamed?.(line)
      }
    })()
    const rename = async (from: string, to: string): Promise<void> => {
      const ticket = feed.ticket()
      if (!options.renames || !ticket) throw new Error('this hold renames nothing: its holder was not started to rename')
      if (lost.signal.aborted) throw new Error(`the lock was lost before ${to} was renamed`)
      const answer = new Promise<string | null>(resolve => { held.renamed = resolve })
      await port.files.write(`${ticket}.mv`, `${from}\n${to}\nend\n`)
      const line = await answer
      held.renamed = null
      if (line === null) throw new UnansweredRenameError(to)
      if (line !== 'renamed') throw new Error(line.slice('rename-failed'.length).trim() || 'atomic record replacement failed')
    }
    try { return { kind: 'done', value: await work({ lost: lost.signal, rename }) } }
    finally { held.isDone = true }
  } finally {
    // why: the holder prints nothing while it holds, so the feed's pull stays pending and the engine's return() waits behind it; a SIGTERM ends the holder through its own cleanup, which ends the stream, and only then is the stream left.
    const holder = await feed.pid
    if (holder !== null && !feed.isEnded()) await executeProcess(port.processes, ['kill', '-TERM', String(holder)]).catch(() => null)
    await stream.return({ code: null, signal: null }).catch(() => undefined)
  }
}

/**
 * Reads a host lock's queue, judged by the kernel lock alone: a ticket counts only while its owner lives.
 * @param port - The engine calls.
 * @param lock - The lock file.
 * @returns The queue, or why it could not be read: an unread lock is never free.
 */
export async function readHostLock(port: EnginePort, lock: string): Promise<Result<HostLockQueue>> {
  const run = await executeProcess(port.processes, ['perl', `${await port.readPluginRoot()}/scripts/${scriptName}`, 'list', lock])
    .catch((error: unknown) => formatErrorLine(error))
  if (typeof run === 'string') return fail(`the lock ${lock} could not be read: ${run}`)
  if (run.exitCode !== 0) return fail(`the lock ${lock} could not be read: ${run.stderr.trim() || `exit ${run.exitCode}`}`)
  const rows = run.stdout.split('\n').filter(Boolean).map(row => /^(held|wait) (.*)$/.exec(row)).filter(row => row !== null)
  return succeed({ isHeld: rows[0]?.[1] === 'held', ids: rows.map(row => row[2] ?? '') })
}

/** A rename the holder was asked for that ended before it answered: the rename may have landed or not, so the record's state is unknown. */
export class UnansweredRenameError extends Error {
  readonly path: string
  /**
   * Names the record whose rename went unanswered.
   * @param path - The record.
   */
  constructor(path: string) {
    super(`the lock holder ended before it answered the rename of ${path}, so whether it was written is unknown`)
    this.path = path
  }
}
