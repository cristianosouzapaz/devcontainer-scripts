import { fail, formatError, succeed } from './result'
import type { Result } from './result'

/**
 * Describes what a process printed and how it exited.
 */
export interface ProcessOutput { exitCode: number; stdout: string; stderr: string }

interface ProcessSuccess { isOk: true; value: ProcessOutput }
interface ProcessFailure { isOk: false; error: string; cause: unknown }

/**
 * Retains a rejected process's original cause alongside its formatted failure.
 */
export type ProcessResult = ProcessSuccess | ProcessFailure

/** How long a process may run before the engine stops it, and where it runs: the session's working directory when `cwd` is omitted. */
interface ProcessOptions extends ProcessInput { timeoutMs: number }

interface ProcessInput { cwd?: string; stdin?: string }

/** The engine's process runner. */
export interface ProcessPort { run: (commandLine: string[], options: ProcessOptions) => Promise<ProcessOutput> }

/** How long a process runs when the caller sets no timeout. */
const defaultTimeoutMs = 15000

/**
 * Executes a process while preserving rejected runs and every exit code.
 * @param processes - The engine's process runner.
 * @param commandLine - The program and its arguments.
 * @param options - Optional timeout, working directory and standard input.
 * @returns The unmodified process output.
 */
export function executeProcess(processes: ProcessPort, commandLine: string[], options: Partial<ProcessOptions> = {}): Promise<ProcessOutput> {
  return processes.run(commandLine, { timeoutMs: defaultTimeoutMs, ...options })
}

/**
 * Runs a process with a timeout.
 *
 * @param processes - The engine's process runner.
 * @param commandLine - The program and its arguments.
 * @param timeoutMs - How long it may run.
 * @param options - Optional standard input and working directory.
 * @returns Its output whatever its exit code, or a failure when it could not run or timed out.
 */
export async function runProcess(processes: ProcessPort, commandLine: string[], timeoutMs = defaultTimeoutMs, options: ProcessInput = {}): Promise<ProcessResult> {
  try {
    return succeed(await executeProcess(processes, commandLine, { timeoutMs, ...options }))
  } catch (error) {
    return { ...fail(`${commandLine[0]} could not run: ${formatError(error)}`), cause: error }
  }
}

/**
 * Narrows a run to one that exited zero.
 *
 * @param run - The run.
 * @param fallback - The error when a non-zero exit printed nothing to stderr.
 * @returns The output, or a failure carrying the first stderr line of a non-zero exit.
 */
export function hasExitedZero(run: Result<ProcessOutput>, fallback = 'exited non-zero'): Result<ProcessOutput> {
  if (!run.isOk || run.value.exitCode === 0) return run
  return fail(run.value.stderr.trim().split('\n')[0] || fallback)
}
