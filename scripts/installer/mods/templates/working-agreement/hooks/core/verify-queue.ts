import { readLabelledJobs } from '../lib/github'
import { executeProcess } from '../lib/process'
import type { EnginePort } from './engine-port'
import { hostLockPath, readHostLock, withHostLock } from './host-lock'
import type { HostLockOutcome } from './host-lock'
import { atomicReplace, readCommonDir, readSession, recordsPath } from './record-store'
import { minuteMs } from './timing'
import { moduleState } from '../lib/module-state'
import type { QueueLine } from '../domain/step-states'

/** The call a ticket waits or holds for, as its id names it; `unknown` for a ticket that names none, as an older session writes it. */
type QueueCall ='run' | 'verify' | 'merge gate' | 'unknown'

/** A ticket's id read back: who it is, what it queues for, and the issues of the session that queued it. */
interface Ticket { id: string; call: QueueCall; issues: string }

/** A held Verify turn: the session's id in the queue, and the signal that aborts once its holder process ends. */
export interface VerifyTurn { common: string; id: string; lost: AbortSignal }

/** How a Verify-queue wait is bounded, watched and reported. */
export interface VerifyWait {
  /** When the wait gives up, in epoch ms. */
  deadline: number
  signal: AbortSignal
  /** Called whenever the session's position or the queue's length changes, and once the hold ends. */
  onMove: () => Promise<void>
  /** The directory a cancel arrives in, from readCancelMailbox: a change in it runs onPoke. */
  watch?: string
  /** The run log, whose process-group file the holder reads to stop a command its dead session left running. */
  log?: string
  /** Runs as the wait starts and whenever the watched directory changes, during the wait and the work, and may abort the signal: the cancel watch. */
  onPoke?: () => Promise<void>
  /** What the session queues for, which every reader of the queue names it by. */
  call: Exclude<QueueCall, 'unknown'>
}

/** A CI wait that ended without the runner known to be free, yet lets the commands run: an unreadable CI state, or the queue timeout. */
export type CiObservation = { kind: 'unknown'; error: string } | { kind: 'timeout'; minutes: number }

/**
 * Names how a holder's wait for the CI runner ended: no labelled job, an unreadable CI state with its error, the queue timeout with the
 * minutes waited, a cancel, or the hook budget's floor.
 */
export type CiWait = { kind: 'idle' | 'cancelled' | 'budget' } | CiObservation

/** The CI wait's bounds and listeners. */
export interface CiWaitOptions {
  deadline: number
  signal: AbortSignal
  /** Called when the CI wait starts or ends. */
  onMove: () => Promise<void>
  /** Runs after each step of a pause, and may abort the signal: the cancel watch, so a cancel ends the wait within a step. */
  onStep?: () => Promise<void>
}

/** The lock's name in the records' locks directory. */
const lockName = 'verify'
/** How often a holder asks GitHub whether a CI job holds the runner: each poll costs several API calls. */
const ciPollMs = 30000
/** The longest pause between two looks at a CI wait's signal. */
const stepMs = 1000
/** The budget a CI wait keeps in hand: the time a poll, the release and the answer take. */
const budgetFloorMs = 3000
// why: sessions older than the host lock take the Verify lock as this mkdir and break it once its lease is this old.
const legacyStaleMs = 30000
// why: two module loads of one process are live together after a reload, and their sequences start over independently, so each load names its holds apart.
const sequence = moduleState(() => ({ nonce: crypto.randomUUID().replaceAll('-', '').slice(0, 12), value: 0 }))
/** The calls a ticket can name. */
const calls = ['merge gate', 'verify', 'run'] as const

/**
 * Names the marker a holder writes while CI holds the runner; it names the holder, so a marker a dead holder left reads as nothing.
 * @param common - The git common directory.
 * @returns The marker's path.
 */
const ciMarkerPath = (common: string): string => hostLockPath(common, `${lockName}.ci`)

/**
 * Runs work once this session holds the repository's Verify lock, waiting first come, first served behind every other session's Run,
 * Verify and merge gate. The wait and the work keep one stream pull in flight, so neither runs the hook's budget down.
 * @param port - The engine calls.
 * @param common - The repository's common directory, shared by its worktrees.
 * @param sid - The waiting session.
 * @param work - What runs under the lock, given the held turn.
 * @param wait - The deadline, the signal and the listeners.
 * @returns The work's value, or how the wait ended without the lock.
 */
export async function withVerifyTurn<T>(port: EnginePort, common: string, sid: string, work: (turn: VerifyTurn) => Promise<T>, wait: VerifyWait): Promise<HostLockOutcome<T>> {
  // why: the id names the hold as well as the session, so the CI marker of an earlier hold of the same session never reads as this one's; its tail names the call and the issues for every reader.
  const issues = (await readSession(port)).issues.map(issue => ` #${issue}`).join('')
  const id = `${sid}/${await port.now()}-${sequence.nonce}-${++sequence.value} ${wait.call}${issues}`
  try {
    return await withHostLock(port, hostLockPath(common, lockName), id, held => work({ common, id, lost: held.lost }), {
      signal: wait.signal, deadline: wait.deadline, onPosition: wait.onMove,
      legacy: { dir: recordsPath(common, 'verify', 'lock'), staleMs: legacyStaleMs },
      ...wait.watch ? { watch: wait.watch } : {}, ...wait.onPoke ? { onPoke: wait.onPoke } : {}, ...wait.log ? { killGroup: `${wait.log}.pgid` } : {},
    })
  } finally {
    // why: the pane shows the session's place, so a hold that ends, however, shows it gone at once, as every move inside it does.
    await wait.onMove()
  }
}

/**
 * Holds the lock while a queued or in-progress CI job asks for one of the runner labels, so the waiters behind keep their order;
 * a marker naming the holder tells every reader of the queue that CI holds it. Each poll pauses in one host `sleep`.
 * @param port - The engine calls.
 * @param turn - The held turn.
 * @param labels - The runner labels that identify this machine's runner.
 * @param options - The deadline, the signal and the listeners.
 * @returns How the wait ended.
 */
export async function waitCiIdle(port: EnginePort, turn: VerifyTurn, labels: string[], options: CiWaitOptions): Promise<CiWait> {
  const marker = ciMarkerPath(turn.common)
  const state = { isMarked: false }
  const signal = AbortSignal.any([options.signal, turn.lost])
  const started = await port.now()
  try {
    while (!signal.aborted) {
      // why: past the floor the wait ends while the hook can still answer, before the engine drops the call.
      if (port.budgetLeft && port.budgetLeft() < budgetFloorMs) return { kind: 'budget' }
      const busy = await readLabelledJobs(port.processes, labels)
      if (!busy.isOk) return { kind: 'unknown', error: busy.error }
      if (!busy.value) return { kind: 'idle' }
      const now = await port.now()
      if (now >= options.deadline) return { kind: 'timeout', minutes: (now - started) / minuteMs }
      if (!state.isMarked) {
        await atomicReplace(port, marker, turn.id)
        state.isMarked = true
        await options.onMove()
      }
      // why: the holder's pull is in flight during the work, so these host sleeps cost no hook budget; steps of a second end the pause within one of a cancel.
      const pause = Math.min(ciPollMs, options.deadline - now)
      for (const step of Array.from({ length: Math.ceil(pause / stepMs) }, (_, index) => Math.min(stepMs, pause - index * stepMs))) {
        if (signal.aborted) break
        await executeProcess(port.processes, ['sleep', String(step / 1000)])
        await options.onStep?.()
      }
    }
    return { kind: 'cancelled' }
  } finally {
    if (state.isMarked) {
      // why: a marker left behind names a hold that ended, which no reader counts; the wait's outcome stands either way.
      await executeProcess(port.processes, ['rm', '-f', '--', marker]).catch(() => null)
      await options.onMove()
    }
  }
}

/**
 * Words what a CI wait could not establish, the line the gate and the unit's Verify both lead their answer with.
 * @param ci - How the wait ended.
 * @param isCommandStarted - Whether a command then started, the only case that ran anyway.
 * @returns The line, or null when the wait established that the runner was free or ended the run.
 */
export function describeCiWait(ci: CiWait, isCommandStarted: boolean): string | null {
  const fact = ci.kind === 'unknown' ? `CI state unknown (${ci.error})`
    : ci.kind === 'timeout' ? `CI still running when the ${Math.round(ci.minutes * 100) / 100} min wait ran out` : null
  return fact && isCommandStarted ? `${fact}, ran anyway` : fact
}

/**
 * Tells whether this session holds the repository's Verify lock, judged by the kernel lock alone.
 * @param port - The engine calls.
 * @returns Whether a run of this session holds its queue turn.
 */
export async function isOwnTurnLive(port: EnginePort): Promise<boolean> {
  const common = await readCommonDir(port)
  if (!common) return false
  const read = await readHostLock(port, hostLockPath(common, lockName))
  const queue = read.isOk ? read.value : null
  return !!queue?.isHeld && queue.ids[0]?.startsWith(`${await port.readSessionId()}/`) === true
}


/**
 * Reads a ticket's id back: the call and issues its tail names after the first space, or `unknown` with none for an id with no tail.
 * @param id - The id, as the queue lists it.
 * @returns The ticket.
 */
function parseTicket(id: string): Ticket {
  const tail = id.includes(' ') ? id.slice(id.indexOf(' ') + 1) : ''
  const call = calls.find(name => tail === name || tail.startsWith(`${name} #`)) ?? 'unknown'
  return { id, call, issues: call === 'unknown' ? '' : tail.slice(call.length).trim() }
}

/**
 * Starts a row with the call it names, or with the rest alone when the call is unknown, so no row names a call it cannot read.
 * @param call - The call.
 * @param rest - What follows the call, such as `waiting (1 ahead)`.
 * @returns The row with its first letter in capitals, such as `Merge gate waiting (1 ahead)` or `Waiting (1 ahead)`.
 */
function startRow(call: QueueCall, rest: string): string {
  const row = call === 'unknown' ? rest : `${call} ${rest}`
  return `${row.charAt(0).toUpperCase()}${row.slice(1)}`
}

/**
 * Words this session's wait in the queue for the pane and the sidebar alike.
 * @param own - This session's ticket.
 * @param ahead - How many tickets are ahead of it.
 * @param holder - The holder's ticket, or null while nobody holds the lock.
 * @returns The two lines.
 */
function formatWaiting(own: Ticket, ahead: number, holder: Ticket | null): QueueLine {
  const named = holder && holder.call !== 'unknown' ? `${holder.issues ? `${holder.issues} ` : ''}${holder.call}` : 'unknown'
  return { pane: startRow(own.call, `waiting: ${ahead} ahead${holder ? ` (holder: ${named})` : ''}`), sidebar: startRow(own.call, `waiting (${ahead} ahead)`) }
}

/**
 * Reads this session's place in the repository's Verify queue, judged by the kernel lock and the mark its holder leaves on its ticket.
 * @param port - The engine calls.
 * @returns The place worded for the pane and the sidebar, or null when the session waits for nothing or holds the lock for its own work.
 */
export async function readVerifyQueue(port: EnginePort): Promise<QueueLine | null> {
  const common = await readCommonDir(port)
  if (!common) return null
  const sid = await port.readSessionId()
  const read = await readHostLock(port, hostLockPath(common, lockName))
  if (!read.isOk) return null
  const queue = read.value
  const index = queue.ids.findIndex(id => id.startsWith(`${sid}/`))
  if (index < 0) return null
  const own = parseTicket(queue.ids[index] ?? '')
  if (index === 0 && queue.isHeld) {
    const marker = await port.files.read(ciMarkerPath(common)).catch(() => '')
    return marker.trim() === own.id ? { pane: startRow(own.call, 'holds the queue, waiting for CI'), sidebar: startRow(own.call, 'waiting for CI') } : null
  }
  return formatWaiting(own, index, queue.isHeld ? parseTicket(queue.ids[0] ?? '') : null)
}
