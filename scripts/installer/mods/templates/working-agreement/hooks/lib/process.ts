import { fail, formatError, succeed } from './result'
import type { Result } from './result'

/** What a process printed and how it exited. */
interface ProcessOutput { exitCode: number; stdout: string; stderr: string }

/** How long a process may run before the engine stops it, and where it runs: the session's working directory when `cwd` is omitted. */
interface ProcessOptions { timeoutMs: number; cwd?: string }

/** The engine's process runner. */
export interface ProcessPort { run: (commandLine: string[], options: ProcessOptions) => Promise<ProcessOutput> }

/** How long a process runs when the caller sets no timeout. */
const defaultTimeoutMs = 15000

/**
 * Runs a process with a timeout.
 *
 * @param processes - The engine's process runner.
 * @param commandLine - The program and its arguments.
 * @param timeoutMs - How long it may run.
 * @returns Its output whatever its exit code, or a failure when it could not run or timed out.
 */
export async function runCommand(processes: ProcessPort, commandLine: string[], timeoutMs = defaultTimeoutMs): Promise<Result<ProcessOutput>> {
  try {
    return succeed(await processes.run(commandLine, { timeoutMs }))
  } catch (error) {
    return fail(`${commandLine[0]} could not run: ${formatError(error)}`)
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
