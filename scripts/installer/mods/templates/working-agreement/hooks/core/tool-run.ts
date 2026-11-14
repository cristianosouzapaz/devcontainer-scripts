import { executeProcess } from '../lib/process'
import { formatErrorLine } from '../lib/result'
import type { Identity, Unit, UnitEntry } from '../../types'
import type { CommandRun, RunRequest } from './run-command'
import type { EnginePort } from './engine-port'
import type { CallFacts } from './command-calls'
import { readCommonDir, readDeclarationStrict, readUnit, updateSession, replaceUnitEntry, recordsPath } from './record-store'
import { closeCommandLog, runCommand } from './run-command'
import { formatExit, updateRunCommand } from './run-view'
import { withRecordLock } from './session-memory'
import { createEmptyUnit, sameIdentity } from '../domain/records'
import { moduleState } from '../lib/module-state'

interface RunLog { runId: string; log: string }
interface RunRefusal { error: string }
interface CommandExecution { run: CommandRun; status: string; duration: string; tail: string }

/** How a unit's lifetime ended while a command tool ran: its declaration deleted, replaced by a new generation, or unreadable. */
type EndedLifetime = 'concluded' | 're-declared' | 'unreadable'
/** Why a finished run has no record known to be written: its lifetime ended, the write failed, or what the write left is unknown. */
type UnrecordedOutcome = { kind: 'ended'; ended: EndedLifetime } | { kind: 'failed'; error: string } | { kind: 'unknown'; error: string }
/** What a command tool's record write did: written, with the mirror error when only the mirror failed, cancelled, or not known written. */
export type RecordOutcome = { kind: 'written'; mirrorError?: string } | { kind: 'cancelled' } | UnrecordedOutcome

/** Holds a command tool's normal result. */
export interface ToolRunResult { result: string }
/** The stops of the long tool dispatches in flight, by call, since the engine never aborts a hook beneath a guard it dropped; and the run id sequence. */
const runs = moduleState(() => ({ stoppable: new Map<string, Set<AbortController>>(), sequence: 0 }))

/**
 * Names a call for its stop handle: its tool use id, which the guard above reads on the same call, or its tool when the engine gave none.
 * @param event - The call.
 * @returns The key.
 */
export function callKey(event: { tool: string; tool_use_id?: string }): string {
  return event.tool_use_id || event.tool
}

/**
 * Runs a long tool dispatch that the guard above it can stop once the engine dropped its call; the stop is registered before the
 * dispatch awaits anything, so a drop at any point finds it.
 * @param call - The call's key, from callKey.
 * @param signal - The dispatch's cancellation signal.
 * @param work - The dispatch, given a signal that also aborts when the guard stops it.
 * @returns What the dispatch returns.
 */
export async function withStoppableDispatch<T>(call: string, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const control = new AbortController()
  const controls = runs.stoppable.get(call) ?? new Set<AbortController>()
  controls.add(control)
  runs.stoppable.set(call, controls)
  try { return await work(AbortSignal.any([signal, control.signal])) }
  finally {
    controls.delete(control)
    if (!controls.size && runs.stoppable.get(call) === controls) runs.stoppable.delete(call)
  }
}

/**
 * Stops the dispatches registered under a call's key.
 * @param call - The call's key, from callKey.
 * @returns How many dispatches it stopped.
 */
export function abortCall(call: string): number {
  const controls = [...runs.stoppable.get(call) ?? []]
  for (const control of controls) control.abort()
  return controls.length
}

/**
 * Checks platform support and creates the common command-log directory.
 * @param port - The engine calls.
 * @param sid - The session id.
 * @returns The unique log identity or a normal refusal.
 */
export async function prepareRunLog(port: EnginePort, sid: string): Promise<RunLog | RunRefusal> {
  const platform = await executeProcess(port.processes, ['uname', '-s'])
  // why: the POSIX sh wrapper relies on mkfifo and tail -c provided by Linux and macOS.
  if (!['Linux', 'Darwin'].includes(platform.stdout.trim())) return { error: 'Command runs require Linux or macOS.' }
  const common = await readCommonDir(port)
  if (!common) return { error: 'Cannot locate the repository metadata.' }
  const runId = `${await port.now()}-${++runs.sequence}-${sid}`
  const directory = recordsPath(common, 'runs')
  const mkdir = await executeProcess(port.processes, ['mkdir', '-p', '--', directory])
  if (mkdir.exitCode !== 0) throw new Error(mkdir.stderr || 'cannot create run log directory')
  return { runId, log: recordsPath(common, 'runs', `${sid}-${runId}.log`) }
}

/**
 * Runs a command, closes its log and updates its display.
 * @param port - The engine calls.
 * @param sid - The guarded session.
 * @param index - The command's display index.
 * @param request - The command and its execution context.
 * @param minutes - The timeout displayed when the deadline expires.
 * @param facts - The call's ledger facts, which hear of the command's start and end.
 * @returns The process result, status, duration text and output tail; a request stopped before its spawn closes no log and has no tail.
 */
export async function executeCommand(port: EnginePort, sid: string, index: number, request: RunRequest, minutes: number,
  facts?: Pick<CallFacts, 'command' | 'commandEnded'>): Promise<CommandExecution> {
  // why: a throw may come after the spawn, so it counts as a command that ran; only a request stopped before its spawn started none.
  const run = await runCommand(port, { ...request, ...facts?.command(request.log) }).catch((error: unknown) => { facts?.commandEnded(true); throw error })
  facts?.commandEnded(run.start !== 'unspawned')
  const status = run.kind === 'timeout' ? `timed out after ${minutes} min` : run.kind === 'cancelled' ? 'cancelled' : formatExit(run.code, run.signal)
  const duration = `${Math.round(run.duration * 10) / 10}s`
  if (run.start === 'unspawned') return { run, status, duration, tail: '' }
  // why: a command whose wrapper never said it started wrote no log to close, and its status is no outcome of the command.
  if (run.start === 'unstarted') {
    if (run.kind === 'cancelled') return { run, status, duration, tail: '' }
    throw new Error(`the command did not start (${status})`)
  }
  const tail = await closeCommandLog(port, request.log, `${status}; duration: ${duration}`)
  if (run.start === 'unconfirmed') throw new Error(`its command ended (${status}) with no start confirmed`)
  updateRunCommand(sid, index, { status: run.kind === 'ended' ? run.code === 0 && !run.signal ? 'passed' : 'failed' : run.kind, duration: run.duration, outcome: status, output: tail })
  return { run, status, duration, tail }
}

/**
 * Records this chat's contribution while cancellation and the unit's generation still allow it, and reads back what a failed write left.
 * @param port - The engine calls.
 * @param identity - The unit owning the record.
 * @param unit - The evidence read before execution.
 * @param signal - The dispatch's cancellation signal.
 * @param record - The run's id, which the written record carries, and the replacement fields for this chat's entry.
 * @param facts - The call's ledger facts, which hear the write start and resolve.
 * @returns Whether the record was written, its mirror with it, or why it was not, or that its state is unknown.
 */
export async function recordToolRun(port: EnginePort, identity: Identity, unit: Unit, signal: AbortSignal,
  record: { runId: string; change: (own: UnitEntry) => Partial<Unit> }, facts?: Pick<CallFacts, 'recording' | 'recorded'>): Promise<RecordOutcome> {
  facts?.recording(record.runId)
  const outcome = await writeToolRun(port, identity, unit, signal, record)
  facts?.recorded(outcome)
  return outcome
}

/**
 * Writes this chat's contribution under the record lock while cancellation and the unit's generation still allow it.
 * @param port - The engine calls.
 * @param identity - The unit owning the record.
 * @param unit - The evidence read before execution.
 * @param signal - The dispatch's cancellation signal.
 * @param record - The run's id and the replacement fields for this chat's entry.
 * @returns What the write did.
 */
const writeToolRun = (port: EnginePort, identity: Identity, unit: Unit, signal: AbortSignal,
  record: { runId: string; change: (own: UnitEntry) => Partial<Unit> }): Promise<RecordOutcome> =>
  withRecordLock(async () => {
    if (signal.aborted) return { kind: 'cancelled' }
    const lifetime = { hasMoved: false }
    const written = await updateSession(port, async current => {
      if (signal.aborted) return null
      if ((await readUnit(port, identity)).generation !== unit.generation) {
        lifetime.hasMoved = true
        return null
      }
      const own = current.units.find(entry => sameIdentity(entry.identity, identity) && entry.generation === unit.generation)
        ?? { ...createEmptyUnit(), identity, base: unit.base, baseBranch: unit.baseBranch, generation: unit.generation }
      return replaceUnitEntry(current, identity, { ...own, ...record.change(own) })
    }).then(value => ({ value }), (error: unknown) => ({ error: formatErrorLine(error) }))
    if ('error' in written) return readBackRecord(port, record.runId, written.error)
    if (written.value?.kind === 'unmirrored') return { kind: 'written', mirrorError: written.value.error }
    if (written.value) return { kind: 'written' }
    if (!lifetime.hasMoved) return { kind: 'cancelled' }
    // why: the generation read above swallows a failed mirror listing, so only the declaration itself tells an ended lifetime from a failed read.
    return { kind: 'ended', ended: await readLifetimeEnd(port, identity, unit) ?? 'unreadable' }
  })

/**
 * Tells how a unit's lifetime ended since its evidence was read, from its declaration.
 * @param port - The engine calls.
 * @param identity - The unit.
 * @param unit - The evidence read before the run, which carries the generation it ran under.
 * @returns How it ended, `unreadable` when the declaration could not be read, or null when it still runs under the same generation.
 */
export async function readLifetimeEnd(port: EnginePort, identity: Identity, unit: Unit): Promise<EndedLifetime | null> {
  const declaration = await readDeclarationStrict(port, identity).then(read => read, () => 'invalid' as const)
  // why: a declaration that cannot be read, or holds no valid record, proves neither a conclusion nor a new generation.
  if (declaration === 'invalid') return 'unreadable'
  // why: a concluded unit's declaration is deleted, while a re-declared one holds a new generation.
  if (!declaration) return unit.generation === undefined ? null : 'concluded'
  return declaration.generation === unit.generation ? null : 're-declared'
}

/**
 * Reads back, after a record write threw, whether the record reached the session state.
 * @param port - The engine calls.
 * @param runId - The run's id.
 * @param error - What the write threw.
 * @returns Written with the mirror error, not written, or unknown when the session state cannot be read.
 */
async function readBackRecord(port: EnginePort, runId: string, error: string): Promise<RecordOutcome> {
  const isWritten = await findRecordedRun(port, runId)
  if (isWritten === null) return { kind: 'unknown', error }
  return isWritten ? { kind: 'written', mirrorError: error } : { kind: 'failed', error }
}

/**
 * Looks up a run's record in the session state by its run id.
 * @param port - The engine calls.
 * @param runId - The run's id.
 * @returns Whether the record is there, or null when the session state cannot be read.
 */
export async function findRecordedRun(port: EnginePort, runId: string): Promise<boolean | null> {
  const saved = await port.readSessionState().then(state => state.value, () => undefined)
  if (!saved) return null
  return saved.units.some(entry => entry.runs.some(run => run.runId === runId) || entry.verifyRuns.some(run => run.runId === runId))
}

/**
 * Words a finished command run whose record is not known to be written.
 * @param tool - The tool's display name.
 * @param status - The commands' outcome, such as `exit 7` or `passed`.
 * @param outcome - Why no record is known to be written.
 * @param log - The run's log file.
 * @returns The first line of the tool's answer.
 */
export function describeUnrecorded(tool: 'Run' | 'Verify', status: string, outcome: UnrecordedOutcome, log: string): string {
  const ran = `${tool} stopped: ${tool === 'Run' ? 'the command' : 'the commands'} ran (${status})`
  const again = `call ${tool.toLowerCase()} again`
  const why = outcome.kind === 'failed' ? `no record written: ${outcome.error}; ${again}`
    : outcome.kind === 'unknown' ? `whether its record was written is unknown: ${outcome.error}; check /flow status before you ${again}`
    : outcome.ended === 'unreadable' ? `no record written: the unit's records could not be read, so whether it was concluded or re-declared is unknown; check /flow status and ${again}`
    : `no record written: the unit was ${outcome.ended} meanwhile`
  return `${ran}; ${why}. Log: ${log}`
}

/**
 * Names, for the Run log, why a finished run has no record known to be written.
 * @param outcome - Why no record is known to be written.
 * @returns The run's label, such as `not recorded · unit concluded`.
 */
export function labelUnrecorded(outcome: UnrecordedOutcome): string {
  if (outcome.kind === 'unknown') return 'record unknown'
  if (outcome.kind === 'failed') return 'not recorded · record write failed'
  return outcome.ended === 'unreadable' ? 'not recorded · unit records unreadable' : `not recorded · unit ${outcome.ended}`
}

/**
 * Words the note a written record whose session mirror failed carries.
 * @param error - What the mirror write threw.
 * @returns The note.
 */
export function describeMirrorFailure(error: string): string {
  return `recorded; the session mirror was not updated (${error}), so other sessions see this run once a later record write mirrors it`
}
