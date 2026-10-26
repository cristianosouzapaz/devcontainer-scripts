import { executeProcess } from '../lib/process'
import type { Identity, Unit, UnitEntry } from '../../types'
import type { CommandRun, RunRequest } from './run-command'
import type { EnginePort } from './engine-port'
import { readCommonDir, readUnit, sameIdentity, updateSession, replaceUnitEntry, recordsPath } from './record-store'
import { closeCommandLog, runCommand } from './run-command'
import { formatExit, updateRunCommand } from './run-view'
import { withRecordLock } from './session-memory'
import { createEmptyUnit } from '../domain/records'
import { readWorktrees } from '../lib/git'

interface RunLog { runId: string; log: string }
interface RunRefusal { error: string }
interface CommandExecution { run: CommandRun; status: string; duration: string; tail: string }

/** Holds a command tool's normal result. */
export interface ToolRunResult { result: string }

const running = new Set<string>()
const sequence = { value: 0 }

/**
 * Refuses a concurrent command-tool run in one session and turns thrown errors into normal results.
 * @param port - The engine calls.
 * @param label - The tool's display name.
 * @param work - The guarded dispatch.
 * @returns Its normal tool result.
 */
export async function withToolRun(port: EnginePort, label: string, work: (sid: string) => Promise<string>): Promise<ToolRunResult> {
  const sid = await port.readSessionId()
  if (running.has(sid)) return { result: 'a run is already in flight' }
  running.add(sid)
  try { return { result: await work(sid) } }
  catch (error) { return { result: `${label} could not run: ${error instanceof Error ? error.message : String(error)}` } }
  finally { running.delete(sid) }
}

/**
 * Locates the worktree holding a unit's branch.
 * @param port - The engine calls.
 * @param branch - The declared branch.
 * @returns Its root or undefined when it is checked out nowhere.
 */
export async function readUnitWorktree(port: EnginePort, branch: string): Promise<string | undefined> {
  const worktrees = await readWorktrees(port.processes)
  return worktrees?.find(worktree => worktree.branch === `refs/heads/${branch}`)?.root
}

/**
 * Checks platform support and creates the common command-log directory.
 * @param port - The engine calls.
 * @param sid - The session id.
 * @returns The unique log identity or a normal refusal.
 */
export async function prepareRunLog(port: EnginePort, sid: string): Promise<RunLog | RunRefusal> {
  const platform = await executeProcess(port.processes, ['uname', '-s'])
  // The POSIX sh wrapper relies on mkfifo and tail -c provided by Linux and macOS.
  if (!['Linux', 'Darwin'].includes(platform.stdout.trim())) return { error: 'Command runs require Linux or macOS.' }
  const common = await readCommonDir(port)
  if (!common) return { error: 'Cannot locate the repository metadata.' }
  const runId = `${await port.now()}-${++sequence.value}-${sid}`
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
 * @returns The process result, status, duration text and output tail.
 */
export async function executeCommand(port: EnginePort, sid: string, index: number, request: RunRequest, minutes: number): Promise<CommandExecution> {
  const run = await runCommand(port, request)
  const status = run.kind === 'timeout' ? `timed out after ${minutes} min` : run.kind === 'cancelled' ? 'cancelled' : formatExit(run.code, run.signal)
  const duration = `${Math.round(run.duration * 10) / 10}s`
  const tail = await closeCommandLog(port, request.log, `${status}; duration: ${duration}`)
  updateRunCommand(sid, index, { status: run.kind === 'ended' ? run.code === 0 && !run.signal ? 'passed' : 'failed' : run.kind, duration: run.duration, outcome: status, output: tail })
  return { run, status, duration, tail }
}

/**
 * Records this chat's contribution while cancellation and the unit's generation still allow it.
 * @param port - The engine calls.
 * @param identity - The unit owning the record.
 * @param unit - The evidence read before execution.
 * @param signal - The dispatch's cancellation signal.
 * @param change - The replacement fields for this chat's entry.
 * @returns Whether the record was written.
 */
export const recordToolRun = (port: EnginePort, identity: Identity, unit: Unit, signal: AbortSignal, change: (own: UnitEntry) => Partial<Unit>): Promise<boolean> =>
  withRecordLock(async () => {
    if (signal.aborted) return false
    const written = await updateSession(port, async current => {
      if (signal.aborted || (await readUnit(port, identity)).generation !== unit.generation) return null
      const own = current.units.find(entry => sameIdentity(entry.identity, identity) && entry.generation === unit.generation)
        ?? { ...createEmptyUnit(), identity, base: unit.base, baseBranch: unit.baseBranch, generation: unit.generation }
      return replaceUnitEntry(current, identity, { ...own, ...change(own) })
    })
    return written !== null
  })
