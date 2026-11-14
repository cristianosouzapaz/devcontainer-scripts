import type { Next } from 'claude-code'

import type { EnginePort } from '../../hooks/core/engine-port'
import { handleSessionStart } from '../../hooks/handlers/session'
import { renewModuleState, replaceModuleState } from '../../hooks/lib/module-state'
import type { ModuleSnapshot } from '../../hooks/lib/module-state'
import { buildStat, createTestPort, root } from './world'
import type { World } from './world'

/**
 * The mod's modules as this test file loaded them, driven by direct dispatch: the engine kit can neither reload a plugin nor reach the
 * memory of the instance it loaded, so this instance stands for each module a reload or a new process evaluates.
 *
 * A reload here starts over every holder a module declares with `moduleState`: `sessionMemory`, every queue (`withRecordLock`'s
 * included), the pane's refresh queue and painter, the handoff arming, tool-run's in-flight runs and every id sequence. It keeps only
 * what the plugin's options set when `register` runs (the handoff threshold, the spawn limits), since a reload runs `register` again with
 * the same options and the harness never runs it, and the port, which stands for the engine and is no module's.
 *
 * One module instance stands for both loads, and the plugin test runtime offers no async context to tell their continuations apart, so a
 * continuation the replaced load started before a reload reads the new load's memory when it resumes; `asOldModule` models only work
 * the replaced load starts after it. The mod's code therefore names its load before its first await and changes load memory only while
 * that load still runs, which the engine makes true anyway; what a replaced load may still change in the process state, its receipts,
 * the schedule explorer checks on the state itself.
 */
export interface ModuleHarness {
  port: EnginePort
  /** Runs the tick the latest session start registered, then lets the work it deferred settle. */
  tick: () => Promise<void>
  /** Runs work as the module the latest reload replaced, with that module's own state, as the engine runs a hook the old module still hears. */
  asOldModule: <T>(work: () => Promise<T>) => Promise<T>
  /** The module state of the module the latest reload replaced. */
  oldState: ModuleSnapshot
  /** The world the harness drives. */
  world: World
  /** The pid the harness's process runs as, which a new process changes. */
  pid: number
  /** How many turns the harness started and the last one's id, as the engine gives each turn an id of its own. */
  turns: { count: number; last: string }
}

/** The faults a harness host injects: which reads and writes fail, whether a write first runs on a stale value, and a wait before it. */
export interface FaultPlan {
  /** Fails a process-state write, before it lands, when it would write this state over that one. */
  failWrite?: (next: unknown, current: unknown) => boolean
  /** Lets a process-state write land and then answers it with a failure, as an answer lost on the way, when it would write this state over that one. */
  loseWrite?: (next: unknown, current: unknown) => boolean
  /** Fails a file read of this path. */
  failRead?: (path: string) => boolean
  /** Runs each change first on the value as it stood before the dispatch's last write, as a missed compare-and-set does, then on the current one. */
  staleRuns?: boolean
  /** Waits before a process-state write lands, given the state it would write. */
  beforeWrite?: (next: unknown, current: unknown) => Promise<void>
}

/** The first pid the harness's process runs as. */
const firstPid = 300

/**
 * Builds a direct-dispatch harness whose prompts land in the world's prompt log and whose tick runs only when the test says.
 * @param world - The test world.
 * @param overrides - Engine calls the test replaces.
 * @returns The harness.
 */
export function createModuleHarness(world: World, overrides: Partial<EnginePort> = {}): ModuleHarness {
  const held: { tick: () => Promise<void> } = { tick: async () => {} }
  const port: EnginePort = {
    ...createTestPort(world),
    // why: a reload cancels the old module's timers, so each session start's tick replaces the one before.
    repeat: (_delayMs, work) => { held.tick = work },
    submitPrompt: async text => { world.prompts.push(text) },
    runSlashCommand: async command => { world.commands.push(command) },
    ...overrides,
  }
  const harness: ModuleHarness = {
    port, world, pid: firstPid, oldState: [], turns: { count: 0, last: 't1' },
    tick: async () => { await held.tick(); await world.clock.settle() },
    asOldModule: async work => {
      if (!harness.oldState.length) throw new Error('no module was replaced: reload it first')
      const current = replaceModuleState(harness.oldState)
      try {
        return await work()
      } finally {
        harness.oldState = replaceModuleState(current)
      }
    },
  }
  seedOwnStat(harness)
  return harness
}

/**
 * Names the next turn the harness starts, a new id each time, as the engine names each turn.
 * @param harness - The direct-dispatch harness.
 * @returns The turn's id.
 */
export function nextTurnId(harness: ModuleHarness): string {
  harness.turns.count += 1
  harness.turns.last = `t${harness.turns.count}`
  return harness.turns.last
}

/**
 * Reloads the mod mid-session, as `/reload-plugins` or a change to a plugin file does: module memory starts over, the process, what the
 * host holds and the records on disk stay, and the new module hears `session.start`.
 * @param harness - The direct-dispatch harness.
 * @returns Once the new module's start settled.
 */
export async function reloadModule(harness: ModuleHarness): Promise<void> {
  harness.oldState = renewModuleState()
  await handleSessionStart(harness.port, { cwd: root, surface: null, isInteractive: false }, answerStart as unknown as Next<'session.start'>)
}

/**
 * Starts the mod in a new process, as a crash, a resume or a first start does: a new pid and start time, module memory empty, and none
 * of the process state the host held. The session record the host held is kept: a new process reloads it from its disk mirror
 * (initializeSession), which this world does not keep in step with its held store, so emptying it would lose the unit's record rather
 * than model the boundary; nothing in it tells a turn.
 * @param harness - The direct-dispatch harness.
 * @returns Once the module's start settled.
 */
export async function newProcess(harness: ModuleHarness): Promise<void> {
  harness.pid += 1
  seedOwnStat(harness)
  harness.world.processState.value = undefined
  harness.oldState = renewModuleState()
  await handleSessionStart(harness.port, { cwd: root, surface: null, isInteractive: false }, answerStart as unknown as Next<'session.start'>)
}

/**
 * Serves this process's /proc stat line, whose pid and start time name the process.
 * @param harness - The direct-dispatch harness.
 */
function seedOwnStat(harness: ModuleHarness): void {
  harness.world.files.set('/proc/self/stat', buildStat(harness.pid, String(harness.pid * 10)))
}

/**
 * Answers `session.start` as the chain beneath the mod does.
 * @param event - The start.
 * @returns The start's cwd.
 */
async function answerStart(event: { cwd: string }): Promise<{ cwd: string }> {
  return { cwd: event.cwd }
}

/**
 * Builds the port of one engine dispatch over the harness's: every process-state read gives the moment the dispatch first saw, moved
 * only by its own writes, as `$.state.get` reads one moment per dispatch; a compare-and-set runs its change first on that moment and,
 * when the host moved on meanwhile, misses and runs it again on the current value, as `update` retries a missed `ifVersion` write.
 * @param harness - The direct-dispatch harness.
 * @returns The dispatch's port.
 */
export function createDispatchPort(harness: ModuleHarness): EnginePort {
  const base = harness.port
  const moment: { held?: { value: unknown } } = {}
  return {
    ...base,
    readProcessState: async () => {
      moment.held ??= { value: await base.readProcessState() }
      return moment.held.value
    },
    updateProcessState: async change => {
      const seen = moment.held ? moment.held.value : await base.readProcessState()
      // why: a change run on a moment the host moved past is a missed write, whose outcome the retry on the current value replaces.
      if (JSON.stringify(seen) !== JSON.stringify(await base.readProcessState())) change(seen)
      const written = await base.updateProcessState(change)
      moment.held = { value: written }
      return written
    },
  }
}

/**
 * Builds a harness over a host that injects a fault plan into its process-state writes and file reads, so a race or a fault is stated
 * once in the test rather than written as an override of its own.
 * @param world - The test world.
 * @param plan - The faults.
 * @param overrides - Engine calls the test replaces besides.
 * @returns The harness.
 */
export function faultyHost(world: World, plan: FaultPlan, overrides: Partial<EnginePort> = {}): ModuleHarness {
  const base = createModuleHarness(world).port
  const previous: { value: unknown } = { value: undefined }
  return createModuleHarness(world, {
    updateProcessState: async change => {
      const current = world.processState.value
      // why: a change run on a value the host moved past is a missed write, whose outcome the retry on the current value replaces.
      if (plan.staleRuns && previous.value !== undefined) change(JSON.parse(JSON.stringify(previous.value)) as never)
      const next = change((current === undefined ? undefined : JSON.parse(JSON.stringify(current))) as never)
      await plan.beforeWrite?.(next, current)
      if (plan.failWrite?.(next, world.processState.value)) throw new Error('host busy')
      previous.value = world.processState.value
      const isLost = plan.loseWrite?.(next, world.processState.value) ?? false
      const written = await base.updateProcessState(change)
      if (isLost) throw new Error('no answer')
      return written
    },
    files: { ...world.boundaries.files, read: async path => {
      if (plan.failRead?.(path)) throw new Error(`EIO: i/o error, read '${path}'`)
      return world.boundaries.files.read(path)
    } },
    ...overrides,
  })
}
