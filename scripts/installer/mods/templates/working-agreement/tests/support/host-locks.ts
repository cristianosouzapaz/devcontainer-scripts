import type { ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'
import type { MockClock } from 'claude-code/testing'

// why: the engine types leave out the timer globals, yet the fake's heartbeat runs in real time, as a hook's budget does.
declare function setTimeout(handler: () => void, delayMs: number): unknown

/** A place in a fake host lock's queue: the holder while it is first and locked. */
interface FakeTicket { id: string; isLocked: boolean; isKilled: boolean }

/** The world's host locks, standing in for `host-lock.pl`: each lock file's queue in arrival order. */
export interface HostLocks {
  queues: Map<string, FakeTicket[]>
  /**
   * Puts a ticket no process of the test owns at the front of a lock's queue, as another session's would be: a holder by default.
   * @param lock - The lock file.
   * @param id - The ticket's id.
   * @param isLocked - Whether it holds the lock; false seeds a waiter that sorts before every other ticket, as one re-created under a lower arrival number does.
   * @returns The ticket.
   */
  seed: (lock: string, id: string, isLocked?: boolean) => FakeTicket
  /**
   * Removes a ticket, as its process ending would, and wakes the queue.
   * @param lock - The lock file.
   * @param ticket - The ticket.
   */
  end: (lock: string, ticket: FakeTicket) => void
  /**
   * Ends the process behind the first ticket whose id starts with the prefix, as a kill would: its stream ends.
   * @param lock - The lock file.
   * @param prefix - The id's start, such as a session id and a slash.
   * @returns Whether a ticket was found.
   */
  kill: (lock: string, prefix: string) => boolean
  /**
   * Answers `perl host-lock.pl wait …` as the script does: its event lines, until the signal aborts, the stream is left or a kill.
   * @param argv - The spawn's argv.
   * @param signal - The dispatch's signal.
   * @returns The stream's pieces, then how it ended.
   */
  hold: (argv: readonly string[], signal: AbortSignal) => AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>
  /**
   * Answers `perl host-lock.pl list <lock>`.
   * @param argv - The run's argv.
   * @returns Its stdout.
   */
  list: (argv: readonly string[]) => string
  /** Wakes every fake holder, as a request file written for one does. */
  wake: () => void
}

/** The files a fake holder renames in: its request, taken as it is read, and the rename it asks, answering why it failed, or null. */
export interface FakeRenames { take: (path: string) => string | undefined; rename: (from: string, to: string) => string | null }

/** The pid a fake holder announces, as the script announces its own; no process has it, so the mod's SIGTERM to it ends nothing. */
const fakePid = 2147483647

/**
 * Tells whether an argv runs the mod's host-lock script.
 * @param argv - The argv.
 * @returns Whether it does.
 */
export const isHostLockArgv = (argv: readonly string[]): boolean => argv[0] === 'perl' && (argv[1]?.endsWith('/host-lock.pl') ?? false)

/**
 * Reads an option's value from a host-lock argv.
 * @param argv - The argv.
 * @param name - The option, such as --wait.
 * @returns Its value, or undefined.
 */
function readOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]
}

/**
 * Builds one event line as the script prints it.
 * @param text - The line.
 * @returns The stdout piece.
 */
const line = (text: string): ProcessSpawnChunk => ({ stream: 'stdout', text: `${text}\n` })

/**
 * Creates the world's host locks.
 * @param clock - The test's clock: a wait's deadline and a watch's checks move with it.
 * @param listDir - Names a directory's entries, for the watch.
 * @returns The host locks.
 */
export function createHostLocks(clock: MockClock, listDir: (dir: string) => string, files: FakeRenames): HostLocks {
  const queues = new Map<string, FakeTicket[]>()
  const sequence = { value: 0 }
  const wakers = new Set<() => void>()
  const wake = (): void => { for (const waker of [...wakers]) waker() }
  const queueOf = (lock: string): FakeTicket[] => {
    const known = queues.get(lock)
    if (known) return known
    const created: FakeTicket[] = []
    queues.set(lock, created)
    return created
  }
  const end = (lock: string, ticket: FakeTicket): void => {
    const queue = queueOf(lock)
    const index = queue.indexOf(ticket)
    if (index >= 0) queue.splice(index, 1)
    wake()
  }
  // why: a wait wakes on any queue change, its signal, its deadline on the test's clock, or a real second that checks the watch, since a tick on the test's clock would make each second of an advance wait for the mod's hook to read a piece.
  const sleep = (signal: AbortSignal, expiry: Promise<void>): Promise<void> => new Promise(resolve => {
    const done = (): void => { wakers.delete(done); resolve() }
    wakers.add(done)
    signal.addEventListener('abort', done, { once: true })
    void expiry.then(done)
    setTimeout(done, 1000)
  })
  async function* hold(argv: readonly string[], signal: AbortSignal): AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult> {
    const lock = argv[3] ?? ''
    const ticket: FakeTicket = { id: argv[4] ?? '', isLocked: false, isKilled: false }
    const queue = queueOf(lock)
    queue.push(ticket)
    wake()
    const wait = readOption(argv, '--wait')
    const watch = readOption(argv, '--watch')
    const deadline = wait === undefined ? Infinity : clock.now() + Number(wait) * 1000
    // why: armed once, so a test that moves the clock past the deadline in one step meets it within that step.
    const expiry = Number.isFinite(deadline) ? clock.sleep(deadline - clock.now()) : new Promise<void>(() => {})
    const state: { shown: string; watched: string; spins: number; at: number } = { shown: '', watched: watch === undefined ? '' : listDir(watch), spins: 0, at: clock.now() }
    const path = `${lock}.q/${String(++sequence.value).padStart(12, '0')}`
    const renames = argv.includes('--renames')
    try {
      yield line(`pid ${fakePid}`)
      if (renames) yield line(`ticket ${path}`)
      while (!signal.aborted && !ticket.isKilled) {
        // why: the script renames for its caller only while it holds the lock, as the request asks, and answers each one.
        const request = renames && ticket.isLocked ? files.take(`${path}.mv`)?.split('\n') : undefined
        if (request?.[2] === 'end') {
          const failure = files.rename(request[0] ?? '', request[1] ?? '')
          // why: a holder that ends right after its rename never answers it, as the script's process may.
          if (ticket.isKilled) break
          yield line(failure === null ? 'renamed' : `rename-failed ${failure}`)
          continue
        }
        // why: a wake that never waits would hang the test file with no message, so a loop spinning on a still clock fails it instead.
        state.spins = state.at === clock.now() ? state.spins + 1 : 0
        state.at = clock.now()
        if (state.spins > 10000) throw new Error(`fake host lock ${ticket.id} spins on ${lock} without the clock moving`)
        if (watch !== undefined) {
          const now = listDir(watch)
          if (now !== state.watched) { state.watched = now; yield line('poke') }
        }
        if (!ticket.isLocked) {
          const index = queue.indexOf(ticket)
          const position = `pos ${index + 1} ${queue.length}`
          if (position !== state.shown) { state.shown = position; yield line(position) }
          if (index === 0) { ticket.isLocked = true; yield line('locked'); continue }
          if (clock.now() >= deadline) { yield line('timeout'); return { code: 0, signal: null } }
        }
        // why: the script's wait deadline bounds only the wait for the lock, so a holder past it sleeps on, as a held lock does.
        await sleep(signal, ticket.isLocked ? new Promise<void>(() => {}) : expiry)
        // why: the kit charges a spawn hook per piece, anew at each pull, where a host process's wait costs no hook time at all; a blank line, which the mod reads past, starts the next piece.
        if (!signal.aborted && !ticket.isKilled) yield line('')
      }
      return { code: null, signal: 'SIGTERM' }
    } finally {
      end(lock, ticket)
    }
  }
  return {
    queues,
    seed: (lock, id, isLocked = true) => {
      const ticket: FakeTicket = { id, isLocked, isKilled: false }
      queueOf(lock).unshift(ticket)
      wake()
      return ticket
    },
    end,
    kill: (lock, prefix) => {
      const ticket = queueOf(lock).find(entry => entry.id.startsWith(prefix))
      if (!ticket) return false
      ticket.isKilled = true
      wake()
      return true
    },
    hold,
    wake,
    // why: the script names the holder by the mark on its ticket, never by arrival order, so the locked ticket is listed first wherever it stands.
    list: argv => {
      const queue = queueOf(argv[3] ?? '')
      const holder = queue.find(ticket => ticket.isLocked)
      return [...holder ? [`held ${holder.id}`] : [], ...queue.filter(ticket => ticket !== holder).map(ticket => `wait ${ticket.id}`)].map(row => `${row}\n`).join('')
    },
  }
}
