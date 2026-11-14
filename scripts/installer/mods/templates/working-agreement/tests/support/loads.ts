import type { HookStream, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

import type { EnginePort } from '../../hooks/core/engine-port'
import { readLoadId } from '../../hooks/core/process-state'
import { renewModuleState, replaceModuleState } from '../../hooks/lib/module-state'
import type { ModuleSnapshot } from '../../hooks/lib/module-state'
import type { World } from './world'

/**
 * The kinds of engine call a schedule can suspend or fault: process-state reads and writes, session-store reads and writes, the
 * activity and host records, this process's identity, the other records (the session mirror among them), the host lock's stream, a
 * rename's answer, the pane's writes and patches, the registration of the mod's tools, a prompt's submit, the clock's reads, the
 * allocation of a load's number, and the rest: reads of the engine's fixed facts (ids, paths, settings, the pane's state) and the
 * prompt box's other calls, which no fault names.
 */
export type OpClass = 'state-read' | 'state-write' | 'session-read' | 'session-write' | 'activity' | 'host' | 'identity' | 'records' | 'lock' | 'rename' | 'paint'
  | 'registration' | 'submit' | 'clock' | 'seq' | 'other'

/**
 * How a rule acts on the next call of its class: `hold` suspends the call before it reaches the host, `park` lets it land and suspends
 * its answer, `fail` refuses it before it lands, and `lose` lets it land and answers with a failure, as an answer lost on the way. A
 * rename is seen only once the host lock's holder reports it landed, so it takes `park` and `lose` alone; its `hold` and `fail` are
 * those of the class of the record it renames onto.
 */
export type RuleMode = 'hold' | 'park' | 'fail' | 'lose'

/** A rule the schedule set: on the next call of its class, or on every one while sticky, until lifted. */
interface Rule { mode: RuleMode; cls: OpClass; isSticky: boolean }

/** What the schedule did to a run: how many fault rules fired, a sticky one counting once, and whether a suspension spanned a load's start. */
export interface FaultRecord { faults: number; isSuspendedAcrossLoad: boolean }

/**
 * One load of the mod: an evaluation of its modules with memory of its own, its timers and deferred work, which a reload cancels, and
 * whether its process ended, after which none of its calls answers.
 */
export interface Load {
  /** The id the load's own memory holds, which the scheduler checks each time it installs that memory. */
  id: string
  n: number; process: number; memory: ModuleSnapshot; tick: (() => Promise<void>) | null; deferred: (() => void)[]; isCancelled: boolean; isGone: boolean
  /** The dispatch moment of the session start's port, which its tick and deferred work use, started over at each of their runs. */
  resetMoment: () => void
}

/** What one moment holds: the process state and the session store's value, as one dispatch reads them. */
export interface Moment { process: unknown; session: Awaited<ReturnType<EnginePort['readSessionState']>> }

/** A process-state write that landed: the load that made it, and the value before and after. */
interface StateWrite { load: Load; before: unknown; after: unknown }

/** A call the schedule suspended: the load it belongs to, its class and what goes on with it once resumed. */
interface Parked { load: Load; cls: OpClass; name: string; go: () => void }

/** A wait on the engine clock: the load whose it is, when it is due, and how it ends. */
interface Timer { load: Load; due: number; resolve: () => void; reject: (error: unknown) => void }

/** A continuation ready to resume, as the load that awaits it. */
interface Ready { load: Load; settle: () => void }

/**
 * Runs loads of the mod side by side, each with memory of its own: only one load's memory is in the module holders at a time, and a
 * continuation resumes only as its own load, so a load a reload replaced resumes later against its own memory, as an independently
 * evaluated module does. Every engine call is a point the schedule may suspend, resume, fail or lose.
 */
export interface Scheduler {
  loads: Load[]
  rules: Rule[]
  parked: Parked[]
  writes: StateWrite[]
  /** Hears each process-state write as it lands. */
  onWrite: (write: StateWrite) => void
  /** What each load's first process-state read answered: its first look, which names the load it takes for its predecessor. */
  firstReads: Map<Load, unknown>
  /** The loads whose claim of a load number the schedule held or parked. */
  suspendedClaims: Set<Load>
  /** What the schedule actually did to the run so far: the fault rules that fired, and whether a call it suspended was still suspended as a load started. */
  readFaults: () => FaultRecord
  /** The newest load of the live process, null before the first. */
  current: () => Load | null
  /** Starts a load in a process: module memory starts over, as a fresh evaluation does. */
  spawn: (process: number) => Load
  /** Runs work as a load without waiting for it to end, then lets everything it woke settle. */
  run: <T>(load: Load, work: () => Promise<T>) => Promise<{ done: Promise<T> }>
  /** Resumes continuations until none is ready. */
  pump: () => Promise<void>
  /** Whether a suspended call is resuming now, so what it does, and all it unblocks, runs late. */
  isResuming: () => boolean
  /** Drops the oldest suspended call of a load that is not the newest: it never resumes, as work the host cut. */
  cut: () => void
  /** Resumes the oldest or newest suspended call. */
  resume: (which: 'oldest' | 'newest') => Promise<void>
  /** Moves the clock, resolving each wait due on the way as its own load. */
  advance: (ms: number) => Promise<void>
  /** Cancels a load's tick, deferred work and waits, as a reload does to the module it replaces. */
  cancel: (load: Load) => Promise<void>
  /** Ends every load of a process: none of their calls answers again. */
  end: (process: number) => void
  /** Runs one engine call of a load through the schedule's rules, as the load receives its answer. */
  op: <T>(load: Load, cls: OpClass, name: string, invoke: () => Promise<T>) => Promise<T>
  /** Builds a load's engine port over the world's; `unheard` hears a submit that failed before it reached the host, or whose answer was lost. */
  wrap: (load: Load, base: EnginePort, submit: (load: Load, text: string) => Promise<void>, unheard: (load: Load, text: string, how: 'unsent' | 'lost') => void) => EnginePort
  /** Runs the deferred work of the current load, each as a dispatch of its own. */
  runDeferred: () => Promise<void>
}

/**
 * Classifies a file path a call touches.
 * @param path - The path.
 * @param records - The records directory.
 * @returns The class.
 */
function classifyPath(path: string, records: string): OpClass {
  if (path.startsWith('/proc/')) return 'identity'
  if (path.includes(`${records}/activity/`)) return 'activity'
  if (path.includes(`${records}/host/`)) return 'host'
  return path.includes(records) ? 'records' : 'other'
}

/**
 * Creates the scheduler over a world.
 * @param world - The world.
 * @param records - The records directory.
 * @returns The scheduler.
 */
export function createScheduler(world: World, records: string): Scheduler {
  const loads: Load[] = []
  const rules: Rule[] = []
  const parked: Parked[] = []
  const writes: StateWrite[] = []
  const firstReads = new Map<Load, unknown>()
  const suspendedClaims = new Set<Load>()
  const fired = new Set<Rule>()
  const suspensions: { since: number; isCrossed: boolean; isOpen: boolean }[] = []
  // why: a suspension spans a reload exactly when a load started while it was still suspended, judged as it resumes or, if it never does, at the end.
  const suspend = (entry: Parked): void => {
    const suspension = { since: loads.length, isCrossed: false, isOpen: true }
    suspensions.push(suspension)
    parked.push({ ...entry, go: () => { suspension.isOpen = false; suspension.isCrossed = loads.length > suspension.since; entry.go() } })
  }
  const ready: Ready[] = []
  const timers: Timer[] = []
  const installed: { load: Load | null } = { load: null }
  const resuming = { value: false }
  const never = <T>(): Promise<T> => new Promise<T>(() => {})
  const enter = (load: Load): void => {
    if (installed.load === load) return
    const before = replaceModuleState(load.memory)
    if (installed.load) installed.load.memory = before
    installed.load = load
    if (readLoadId() !== load.id) throw new Error(`load ${load.n}'s memory names another load`)
  }
  const take = (cls: OpClass, mode: RuleMode): boolean => {
    const index = rules.findIndex(rule => rule.cls === cls && rule.mode === mode)
    const rule = rules[index]
    if (!rule) return false
    if (!rule.isSticky) rules.splice(index, 1)
    if (mode === 'fail' || mode === 'lose') fired.add(rule)
    return true
  }
  // why: a continuation resumes at once while its own load runs, and otherwise waits its turn, so no load's code ever runs on another's memory.
  const deliver = (load: Load, settle: () => void): void => {
    if (load.isGone) return
    if (installed.load === load) settle()
    else ready.push({ load, settle })
  }
  const pump = async (): Promise<void> => {
    for (;;) {
      await world.clock.settle()
      const next = ready.shift()
      if (!next) return
      if (next.load.isGone) continue
      enter(next.load)
      next.settle()
    }
  }
  /**
   * Runs one engine call of a load through the schedule's rules.
   * @param load - The load.
   * @param cls - The call's class.
   * @param name - The call, for a failure's message.
   * @param invoke - Makes the call.
   * @param onLost - Hears, as the call reaches the host, that the schedule will lose its answer.
   * @returns Its answer, as the load receives it.
   */
  const call = <T>(load: Load, cls: OpClass, name: string, invoke: () => Promise<T>, onLost?: () => void): Promise<T> => {
    if (load.isGone) return never()
    return new Promise<T>((resolve, reject) => {
      const answer = (settle: () => void): void => {
        if (cls !== 'other' && take(cls, 'park')) {
          if (cls === 'seq') suspendedClaims.add(load)
          suspend({ load, cls, name, go: () => { deliver(load, settle) } })
        }
        else deliver(load, settle)
      }
      const start = (): void => {
        if (load.isGone) return
        if (cls !== 'other' && take(cls, 'fail')) { deliver(load, () => { reject(new Error(`host busy: ${name}`)) }); return }
        const isLost = cls !== 'other' && take(cls, 'lose')
        const made = ((): Promise<T> => { try { return invoke() } catch (error) { return Promise.reject(error) } })()
        if (isLost) onLost?.()
        made.then(value => { answer(() => { if (isLost) reject(new Error(`no answer: ${name}`)); else resolve(value) }) }, (error: unknown) => { answer(() => { reject(error) }) })
      }
      if (cls !== 'other' && take(cls, 'hold')) {
        if (cls === 'seq') suspendedClaims.add(load)
        suspend({ load, cls, name, go: start })
      }
      else start()
    })
  }
  const scheduler: Scheduler = {
    loads, rules, parked, writes, firstReads, suspendedClaims, onWrite: () => {},
    readFaults: () => ({ faults: fired.size, isSuspendedAcrossLoad: suspensions.some(each => each.isCrossed || each.isOpen && loads.length > each.since) }),
    current: () => loads.filter(load => !load.isGone).at(-1) ?? null,
    spawn: process => {
      const load: Load = { id: '', n: loads.length + 1, process, memory: [], tick: null, deferred: [], isCancelled: false, isGone: false, resetMoment: () => {} }
      if (installed.load) installed.load.memory = renewModuleState()
      else renewModuleState()
      installed.load = load
      load.id = readLoadId()
      loads.push(load)
      return load
    },
    run: async (load, work) => {
      enter(load)
      const done = work()
      done.catch(() => null)
      await pump()
      return { done }
    },
    pump,
    resume: async which => {
      const index = which === 'oldest' ? parked.findIndex(each => !each.load.isGone) : parked.map(each => !each.load.isGone).lastIndexOf(true)
      const [each] = index < 0 ? [] : parked.splice(index, 1)
      if (!each) return
      enter(each.load)
      resuming.value = true
      try {
        each.go()
        await pump()
      } finally { resuming.value = false }
    },
    op: (load, cls, name, invoke) => call(load, cls, name, invoke),
    cut: () => {
      const newest = scheduler.current()
      const index = parked.findIndex(each => !each.load.isGone && each.load !== newest)
      if (index >= 0) parked.splice(index, 1)
    },
    isResuming: () => resuming.value,
    advance: async ms => {
      const target = world.clock.now() + ms
      for (;;) {
        const due = timers.filter(timer => timer.due <= target && !timer.load.isGone).sort((left, right) => left.due - right.due)[0]
        if (!due) break
        timers.splice(timers.indexOf(due), 1)
        if (due.due > world.clock.now()) await world.clock.set(due.due)
        enter(due.load)
        due.resolve()
        await pump()
      }
      await world.clock.set(target)
      await pump()
    },
    cancel: async load => {
      load.isCancelled = true
      load.tick = null
      load.deferred = []
      for (const timer of timers.filter(each => each.load === load)) {
        timers.splice(timers.indexOf(timer), 1)
        deliver(load, () => { timer.reject(new Error('the wait was cancelled: its module was replaced')) })
      }
      await pump()
    },
    end: process => {
      for (const load of loads.filter(each => each.process === process)) load.isGone = true
      for (const timer of timers.filter(each => each.load.isGone)) timers.splice(timers.indexOf(timer), 1)
    },
    runDeferred: async () => {
      const load = scheduler.current()
      if (!load || load.isCancelled) return
      const works = load.deferred
      load.deferred = []
      for (const work of works) {
        load.resetMoment()
        await scheduler.run(load, async () => { work() })
      }
    },
    wrap: (load, base, submit, unheard) => {
      const op = <A extends unknown[], T>(cls: OpClass | ((first: A[0]) => OpClass), name: string, invoke: (...args: A) => Promise<T>) => (...args: A): Promise<T> =>
        call(load, typeof cls === 'function' ? cls(args[0]) : cls, name, () => invoke(...args))
      const runArgv = (argv: string[]): OpClass => argv[0] === 'readlink' && (argv[1] ?? '').startsWith('/proc/') ? 'identity'
        : argv[0] === 'mv' ? classifyPath(argv.at(-1) ?? '', records) : 'other'
      const wrapStream = (stream: HookStream<ProcessSpawnChunk, ProcessSpawnResult>): HookStream<ProcessSpawnChunk, ProcessSpawnResult> => {
        const next = (): Promise<IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>> => call(load, 'lock', 'host lock', async () => {
          const piece = await stream.next()
          // why: a holder that ends right after its rename never answers it, as the script's process may: the rename landed, its answer is lost.
          if (!piece.done && piece.value.text.includes('renamed') && take('rename', 'lose')) return { done: true, value: { code: 0, signal: null } } as IteratorResult<ProcessSpawnChunk, ProcessSpawnResult>
          // why: a rename the holder reported landed, whose report the schedule holds back, reaches its load only once resumed.
          if (!piece.done && piece.value.text.includes('renamed') && take('rename', 'park')) await new Promise<void>(resolve => { suspend({ load, cls: 'rename', name: 'rename answer', go: resolve }) })
          return piece
        })
        // why: every answer of the stream resumes its load as its own, so none runs on another load's memory.
        const wrapped = {
          next, throw: (error: unknown) => call(load, 'other', 'host lock throw', () => stream.throw(error)), result: stream.result,
          return: (value: ProcessSpawnResult | PromiseLike<ProcessSpawnResult>) => call(load, 'other', 'host lock return', () => stream.return(value)),
          [Symbol.asyncIterator]() { return this },
        }
        return wrapped as unknown as HookStream<ProcessSpawnChunk, ProcessSpawnResult>
      }
      return {
        ...base,
        processes: { ...base.processes, run: op(runArgv, 'process', (argv: string[], options: Parameters<EnginePort["processes"]["run"]>[1]) => base.processes.run(argv, options)),
          spawn: request => load.isGone ? never() as never : wrapStream(base.processes.spawn(request)) },
        files: {
          stat: op((path: string) => classifyPath(path, records), 'stat', path => base.files.stat(path)),
          exists: op((path: string) => classifyPath(path, records), 'exists', path => base.files.exists(path)),
          read: op((path: string) => classifyPath(path, records), 'read', path => base.files.read(path)),
          write: op((path: string) => classifyPath(path, records), 'write', (path: string, text: string) => base.files.write(path, text)),
          list: op((path: string) => classifyPath(path, records), 'list', path => base.files.list(path)),
        },
        clock: { sleep: (delayMs, signal) => load.isGone ? never() : new Promise<void>((resolve, reject) => {
          const timer: Timer = { load, due: world.clock.now() + delayMs, resolve: () => { resolve() }, reject }
          timers.push(timer)
          signal.addEventListener('abort', () => {
            if (!timers.includes(timer)) return
            timers.splice(timers.indexOf(timer), 1)
            deliver(load, () => { reject(new Error('the wait was aborted')) })
          })
        }) },
        readSessionState: op('session-read', 'session read', () => base.readSessionState()),
        writeSessionState: op('session-write', 'session write', (value, version) => base.writeSessionState(value, version)),
        // why: a load's first look is the first read whose answer it receives, which a suspended answer delays.
        readProcessState: () => call(load, 'state-read', 'process-state read', () => base.readProcessState()).then(value => {
          if (!firstReads.has(load)) firstReads.set(load, value)
          return value
        }),
        updateProcessState: op('state-write', 'process-state write', change => {
          const before = world.processState.value
          const written = base.updateProcessState(change)
          // why: the world's write lands before its first await, so the value after it is the one this call wrote.
          const write = { load, before, after: world.processState.value }
          writes.push(write)
          scheduler.onWrite(write)
          return written
        }),
        logDebug: text => { if (!load.isGone) base.logDebug(text) },
        now: op('clock', 'now', () => base.now()),
        repeat: (_delayMs, work) => { if (!load.isGone && !load.isCancelled) load.tick = work },
        defer: work => { if (!load.isGone && !load.isCancelled) load.deferred.push(work) },
        readHerdrEnv: op('other', 'herdr env', () => base.readHerdrEnv()),
        readCwd: op('other', 'cwd', () => base.readCwd()),
        readClaudeDir: op('other', 'claude dir', () => base.readClaudeDir()),
        readPluginRoot: op('other', 'plugin root', () => base.readPluginRoot()),
        readSessionId: op('other', 'session id', () => base.readSessionId()),
        readContext: op('other', 'context', () => base.readContext()),
        readSessionStart: op('other', 'session start', () => base.readSessionStart()),
        readModel: op('other', 'model', () => base.readModel()),
        readAllowRemoteCommands: op('other', 'remote commands', () => base.readAllowRemoteCommands()),
        readView: op('other', 'view read', () => base.readView()),
        writeView: op('paint', 'view write', (view, seq) => base.writeView(view, seq)),
        patchView: op('paint', 'view patch', change => base.patchView(change)),
        claimLoadSeq: op('seq', 'load number', () => base.claimLoadSeq()),
        readLiveRun: op('other', 'live run read', () => base.readLiveRun()),
        writeLiveRun: op('paint', 'live run write', run => base.writeLiveRun(run)),
        readPaneView: op('other', 'pane view read', () => base.readPaneView()),
        writePaneView: op('paint', 'pane view write', view => base.writePaneView(view)),
        openPane: op('other', 'pane open', closeOnEscape => base.openPane(closeOnEscape)),
        copy: op('other', 'copy', (text, surface) => base.copy(text, surface)),
        runSlashCommand: op('other', 'slash command', (command, args) => base.runSlashCommand(command, args)),
        // why: a submit that fails before it reaches the host never entered, and one whose answer was lost entered or not unknown to the load, which cannot tell either from a submit that may have, so the truth notes both.
        submitPrompt: text => load.isGone ? never() : call(load, 'submit', 'submit', () => submit(load, text), () => { unheard(load, text, 'lost') }).catch((error: unknown) => {
          if (error instanceof Error && error.message === 'host busy: submit') unheard(load, text, 'unsent')
          throw error
        }),
        notify: op('other', 'notify', text => base.notify(text)),
        toast: text => { if (!load.isGone) base.toast(text) },
        suggestPrompt: op('other', 'suggestion', text => base.suggestPrompt(text)),
        registerSurface: op('registration', 'registration', () => base.registerSurface()),
      }
    },
  }
  return scheduler
}

/**
 * Builds the port of one engine dispatch over a load's: the dispatch's first read of the process state or of the session store takes
 * one moment of both, through one call the schedule may suspend or fault, whose value is the one it read as it landed, as every
 * `$.state.get` of one dispatch reads one moment across its keys; its own writes move that key's value on, and a missed
 * compare-and-set, of either key, takes a fresh moment of both. A process-state update runs its change on the moment first; when the host
 * moved past it, that run is a missed write, whose throw rejects the update as `update` throws from its first run, and the change runs
 * again on the current value.
 * @param port - The load's port.
 * @param readMoment - Reads both keys in one call of the load.
 * @param snapshot - Reads both keys as the host holds them now, with no call of its own, for a moment a missed write moves on to.
 * @returns The dispatch's port, and how to start its moment over.
 */
export function createMomentPort(port: EnginePort, readMoment: () => Promise<Moment>, snapshot: () => Moment): { port: EnginePort; reset: () => void } {
  const moment: { held?: Moment } = {}
  const clone = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T
  const take = async (): Promise<Moment> => {
    if (!moment.held) { const read = clone(await readMoment()); moment.held ??= read }
    return moment.held
  }
  return {
    reset: () => { moment.held = undefined },
    port: {
      ...port,
      readProcessState: async () => clone((await take()).process),
      readSessionState: async () => clone((await take()).session),
      updateProcessState: async change => {
        const seen = moment.held
        const missed = { value: false }
        const written = await port.updateProcessState(current => {
          if (seen && JSON.stringify(seen.process) !== JSON.stringify(current)) { missed.value = true; change(clone(seen.process) as never) }
          return change(current)
        })
        moment.held = missed.value || !seen ? { ...clone(snapshot()), process: clone(written) } : { ...seen, process: clone(written) }
        return written
      },
      writeSessionState: async (value, version) => {
        const isWritten = await port.writeSessionState(value, version)
        // why: a write that missed takes a fresh moment, as a missed compare-and-set does, so the caller's retry reads the value that won.
        moment.held = isWritten && moment.held ? { ...moment.held, session: { value: clone(value), version: version + 1 } } : undefined
        return isWritten
      },
    },
  }
}
