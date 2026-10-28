import { cleanOutput } from './run-command'
import { executeProcess } from '../lib/process'
import type { Identity, RecordedRunStatus, RunCommandView, RunView, VerifyRecord } from '../../types'
import { bestEffort } from './best-effort'
import type { EnginePort } from './engine-port'
import { refreshView } from './pane-view'
import { atomicReplace, readCommonDir, readSession, readUnit, recordsPath } from './record-store'
import { sameIdentity } from '../domain/records'
import { readRunDisplay, sessionMemory } from './session-memory'
import { readJson } from '../lib/json'
import { isFiniteNumber, isRecord, isStringArray } from '../lib/guards'

type FinishedRunStatus = RecordedRunStatus | 'cancelled'
interface FinishedRunPatch { status: FinishedRunStatus; kind?: RunView['kind'] }
interface ChangedRunPatch { status: 'tree changed'; changed: string[]; kind?: RunView['kind'] }
type RunViewPatch = FinishedRunPatch | ChangedRunPatch

const tailTimeoutMs = 5000

/**
 * Measures the active command after completed and waiting commands' durations.
 * @param commands - The displayed commands.
 * @param elapsed - Seconds since the run began.
 * @returns The nonnegative duration of the running command.
 */
function runningDuration(commands: RunCommandView[], elapsed: number): number {
  return Math.max(0, elapsed - commands.filter(command => command.status !== 'running').reduce((total, command) => total + command.duration, 0))
}

/**
 * Publishes live progress once per second, clearing it even when work throws.
 * @param port - Engine calls.
 * @param sid - The guarded session.
 * @param identity - The unit owning the display.
 * @param generation - Its declared lifetime.
 * @param initial - The commands and immutable run context.
 * @param signal - The dispatch's cancellation signal.
 * @param work - The dispatch, which updates display data separately from evidence.
 * @returns The tool's normal result.
 */
export async function withRunView(port: EnginePort, sid: string, identity: Identity, generation: string | undefined, initial: RunView, signal: AbortSignal, work: () => Promise<string>): Promise<string> {
  const control = new AbortController()
  sessionMemory.runViews.set(sid, { identity, generation, live: initial, published: initial, last: null })
  const paint = async (): Promise<void> => {
    while (!control.signal.aborted) {
      // An abort ends the wait.
      try { await port.clock.sleep(1000, control.signal) } catch { return }
      if (control.signal.aborted) return
      const live = sessionMemory.runViews.get(sid)?.live
      if (!live) return
      const current = live.commands.find(command => command.status === 'running')
      const tail = current ? await bestEffort(port, 'run tail read', () => executeProcess(port.processes, ['tail', '-n', '4', '--', `${live.log}.output`], { timeoutMs: tailTimeoutMs }), null) : null
      if (control.signal.aborted) return
      const now = await port.now()
      const latest = sessionMemory.runViews.get(sid)?.live
      if (!latest) return
      const next = { ...latest, duration: (now - initial.at) / 1000,
        commands: latest.commands.map(command => command.status === 'running' ? { ...command,
          duration: runningDuration(latest.commands, (now - initial.at) / 1000),
          ...(command === current && tail?.exitCode === 0 ? { output: cleanOutput(tail.stdout).split('\n').slice(-4).join('\n') } : {}),
        } : command) }
      updateRunView(sid, next)
      const memory = sessionMemory.runViews.get(sid)
      if (memory) sessionMemory.runViews.set(sid, { ...memory, published: next })
      const saved = (await port.readSessionState()).value
      if (!saved?.unit || saved.sessionId !== sid || !sameIdentity(saved.unit, identity)
        || saved.units.some(unit => sameIdentity(unit.identity, identity) && unit.generation !== generation)) return
      if (!control.signal.aborted) await port.writeLiveRun(next)
    }
  }
  const polling = { task: Promise.resolve() }
  try {
    await bestEffort(port, 'run view refresh', () => refreshView(port, { isQuiet: true, isSynced: true }), undefined)
    await bestEffort(port, 'live run start', () => port.writeLiveRun(initial), undefined)
    polling.task = bestEffort(port, 'run view paint', paint, undefined)
    return await work()
  } finally {
    control.abort()
    await polling.task
    if (!sessionMemory.runViews.get(sid)?.last) {
      const live = sessionMemory.runViews.get(sid)?.live
      await bestEffort(port, 'run view finish', () => finishRunView(port, sid, { status: 'cancelled', kind: live?.kind === 'Run' ? 'red' : 'Verify' }, signal), undefined)
    }
    const memory = sessionMemory.runViews.get(sid)
    if (memory) sessionMemory.runViews.set(sid, { ...memory, live: null })
    await bestEffort(port, 'final run view refresh', () => refreshView(port, { isQuiet: true, isSynced: true }), undefined)
    await bestEffort(port, 'live run clear', () => port.writeLiveRun(null), undefined)
  }
}

/**
 * Replaces display fields without publishing extra frames between timer ticks.
 * @param sid - The guarded session.
 * @param patch - Fields to replace.
 */
function updateRunView(sid: string, patch: Partial<Omit<RunView, 'status'>>): void {
  const memory = sessionMemory.runViews.get(sid)
  if (memory?.live) sessionMemory.runViews.set(sid, { ...memory, live: { ...memory.live, ...patch } })
}

/**
 * Replaces a command's display without changing any record or verdict.
 * @param sid - The guarded session.
 * @param index - The selected command.
 * @param patch - Its new display fields.
 */
export function updateRunCommand(sid: string, index: number, patch: Partial<RunCommandView>): void {
  const live = sessionMemory.runViews.get(sid)?.live
  if (live) updateRunView(sid, { commands: live.commands.map((command, i) => i === index ? { ...command, ...patch } : command) })
}

/**
 * Saves a display-only sidecar atomically; display failures cannot invalidate evidence.
 * @param port - Engine calls.
 * @param sid - The guarded session.
 * @param patch - The final run outcome.
 * @param signal - The run's cancellation signal.
 */
export async function finishRunView(port: EnginePort, sid: string, patch: RunViewPatch, signal: AbortSignal): Promise<void> {
  const memory = sessionMemory.runViews.get(sid)
  const live = memory?.live
  if (!memory || !live) return
  const elapsed = (await port.now() - live.at) / 1000
  const commands = live.commands.map(command => command.status === 'running' && patch.status === 'cancelled'
    ? { ...command, status: 'cancelled' as const, outcome: 'cancelled', duration: runningDuration(live.commands, elapsed) } : command)
  const last: RunView = { ...live, ...patch, commands, duration: commands.reduce((total, command) => total + command.duration, 0) }
  sessionMemory.runViews.set(sid, { ...memory, live: last, last })
  const common = await bestEffort(port, 'run common directory read', () => readCommonDir(port), null)
  // atomicReplace holds the error in sessionMemory.recordError unless the run was cancelled.
  if (common) await atomicReplace(port, recordsPath(common, 'runs', `${last.runId}.json`), JSON.stringify(last), signal).catch(() => {})
}

/**
 * Reads the latest display of each kind, falling back to authoritative record summaries.
 * @param port - Engine calls.
 * @returns Newest first, including an unrecorded run from this session.
 */
export async function readRunLog(port: EnginePort): Promise<RunView[]> {
  const session = await readSession(port)
  if (!session.unit) return []
  const unit = await readUnit(port, session.unit)
  const common = await readCommonDir(port)
  const display = await readRunDisplay(port, session.unit, unit.generation)
  const records = [
    ...unit.verifyRuns.map(record => ({ record, kind: 'Verify' as const })),
    ...unit.runs.map(record => ({ record, kind: record.outcome.kind === 'pass' ? 'green' as const : 'red' as const })),
  ].sort((a, b) => b.record.at - a.record.at)
  const runs: RunView[] = []
  for (const { record, kind } of records) {
    if (runs.some(run => run.kind === kind)) continue
    const result = record.outcome.kind === 'pass' ? 'exit 0' : record.outcome.kind === 'timeout' ? 'timed out' : formatExit(record.outcome.code, record.outcome.signal)
    const fallback: RunView = { runId: record.runId, kind, status: runStatus(record.outcome), result, selection: '', tree: record.tree, cwd: '', log: '', commands: [], duration: 0, at: record.at }
    // A missing, unreadable or misplaced sidecar leaves the record summary visible: the sidecar only adds display detail.
    try {
      if (!common || /[/\\]/.test(record.runId)) throw new Error('invalid sidecar location')
      const parsed: unknown = await readJson(port.files, recordsPath(common, 'runs', `${record.runId}.json`))
      const summary = isRunView(parsed) && parsed.runId === record.runId && parsed.kind === kind && parsed.tree === record.tree ? { ...parsed, result } : fallback
      runs.push(summary)
    } catch { runs.push(fallback) }
  }
  const extra = display?.live?.status === 'running' ? display.published
    : display?.last && !records.some(({ record }) => record.runId === display.last?.runId) ? display.last : null
  return extra ? [extra, ...runs] : runs
}

/**
 * Names a recorded outcome for display.
 * @param outcome - The recorded outcome.
 * @returns Its short label.
 */
export function runStatus(outcome: VerifyRecord['outcome']): RecordedRunStatus {
  return outcome.kind === 'pass' ? 'passed' : outcome.kind === 'timeout' ? 'timed out' : 'failed'
}

/**
 * Identifies a readable terminal sidecar without tightening its persisted schema.
 * @param value - The decoded sidecar.
 * @returns Whether the legacy display fields are readable.
 */
function isRunView(value: unknown): value is RunView {
  return isRecord(value) && ['runId', 'selection', 'tree', 'cwd', 'log'].every(key => typeof value[key] === 'string')
    && ['Verify', 'red', 'green'].includes(String(value.kind)) && ['passed', 'failed', 'timed out', 'tree changed', 'cancelled'].includes(String(value.status))
    && isFiniteNumber(value.at) && isFiniteNumber(value.duration) && value.duration >= 0
    && (value.changed === undefined || isStringArray(value.changed))
    && Array.isArray(value.commands) && value.commands.every(command => isRecord(command) && isStringArray(command.argv) && command.argv.length > 0 && ['waiting', 'passed', 'failed', 'timeout', 'cancelled'].includes(String(command.status))
      && isFiniteNumber(command.duration) && command.duration >= 0 && typeof command.outcome === 'string' && typeof command.output === 'string')
}

/**
 * Formats the signal when present, otherwise the exact exit code.
 * @param code - The process exit code.
 * @param signal - The process termination signal.
 * @returns The short exit description.
 */
export const formatExit = (code: number | null, signal: string | null): string => signal ? `signal ${signal}` : `exit ${code}`
