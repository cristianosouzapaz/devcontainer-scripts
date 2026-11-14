import { runProcess } from './process'
import type { ProcessOutput, ProcessPort, ProcessResult } from './process'
import { fail, succeed } from './result'
import type { Result } from './result'
import { retry } from './retry'
import type { RetryPolicy, RetryVerdict } from './retry'

/**
 * How a gh call failed, by phase: its request was never sent, its outcome is unknown, GitHub answered with a transient
 * server error, reported the object missing, rate limited it, or refused it for good.
 */
type GhFailure = 'never-sent' | 'unknown' | 'server' | 'not-found' | 'rate-limited' | 'permanent'

/** What a gh call may change: nothing, something a repeat leaves as it is, or something a repeat would duplicate. */
export type GhEffect = 'read' | 'idempotent' | 'once'

/** A gh call's last attempt, its failure class (null when it exited zero) and how many attempts it took. */
export interface GhCall { run: ProcessResult; failure: GhFailure | null; attempts: number }

/** The start of the failure a read reports for an object GitHub says does not exist; gh's own error follows it. */
export const notFound = 'not found'

// why: three attempts, each cut by its own timeout, bound a call; one client retrying a short blip needs no more.
const policy: RetryPolicy = { maxAttempts: 3, delaySeconds: 1 }
const transient = new Set<GhFailure>(['never-sent', 'unknown', 'server'])

/**
 * Classifies one gh attempt from its whole output, never from a shortened error line.
 * @param run - The attempt.
 * @returns The failure class, or null for exit zero.
 */
function classifyGh(run: ProcessResult): GhFailure | null {
  if (!run.isOk) return run.kind === 'timeout' ? 'unknown' : 'permanent'
  const { exitCode, stdout, stderr } = run.value
  if (exitCode === 0) return null
  if (exitCode === 4) return 'permanent'
  // why: gh api --include prints the response head on stdout, the status line first, so the status is looked for there as well as on stderr.
  const text = `${stderr}\n${/^HTTP\/\S+ \d{3}\b.*/.exec(stdout)?.[0] ?? ''}`
  const status = /\bHTTP(?:\/\S+)? (\d{3})\b/.exec(text)?.[1]
  if (status === '429' || /rate limit/i.test(text)) return 'rate-limited'
  if (status === '404' || /Could not resolve to|NOT_FOUND/.test(text)) return 'not-found'
  if (status === '502' || status === '503' || status === '504') return 'server'
  if (/dial tcp|no such host|TLS handshake|connection refused|network is unreachable|error connecting to/i.test(text)) return 'never-sent'
  if (/connection reset|\bEOF\b|broken pipe|stream error|i\/o timeout|Client\.Timeout/i.test(text)) return 'unknown'
  return 'permanent'
}

/**
 * Tells whether an attempt is worth repeating: a transient failure is, unless a repeat could duplicate what the call
 * changes. A write made once is never repeated here, even after a request never sent: one gh command sends several
 * requests, and an earlier one may have landed.
 * @param failure - The attempt's failure class.
 * @param effect - What the call may change.
 * @returns The verdict.
 */
function judge(failure: GhFailure | null, effect: GhEffect): RetryVerdict {
  return effect !== 'once' && failure !== null && transient.has(failure) ? 'retry' : 'done'
}

/**
 * Reads gh's whole error from its stderr, since gh may put the cause after a first line such as `failed to update <url>:`.
 * @param stderr - gh's stderr.
 * @returns Every non-empty line, one per line, so a one-row surface can show the first and a full report all of them.
 */
function readErrorLine(stderr: string): string {
  return stderr.trim().split('\n').map(line => line.trim()).filter(Boolean).join('\n')
}

/**
 * Words an attempt's failure in one line.
 * @param run - The attempt.
 * @returns gh's error, or the process failure.
 */
function firstLine(run: ProcessResult): string {
  return run.isOk ? readErrorLine(run.value.stderr) || `exited ${run.value.exitCode}` : run.error
}

/**
 * Runs gh with every retry its class and effect allow, waiting in a host `sleep` and reporting each retry.
 * @param processes - The engine's process runner.
 * @param args - The gh arguments.
 * @param effect - What the call may change.
 * @param timeoutMs - How long one attempt may run; the process default when omitted.
 * @returns The last attempt, its failure class and the attempts made.
 */
export async function callGh(processes: ProcessPort, args: string[], effect: GhEffect = 'read', timeoutMs?: number): Promise<GhCall> {
  const commandLine = ['gh', ...args]
  const { result, attempts } = await retry(() => runProcess(processes, commandLine, timeoutMs), {
    policy, classify: run => judge(classifyGh(run), effect),
    sleep: async seconds => { await runProcess(processes, ['sleep', String(seconds)]) },
    onRetry: (attempt, run) => processes.onRetry?.({ command: commandLine.slice(0, 3).join(' '), attempt, error: firstLine(run) }),
  })
  return { run: result, failure: classifyGh(result), attempts }
}

/**
 * Narrows a gh call to its output, wording each failure by its real cause.
 * @param call - The call.
 * @param fallback - The error for a refusal that printed nothing to stderr.
 * @returns The output on exit zero, or `GitHub unreachable after N attempts`, `not found` or a rate limit, each followed by gh's whole error, or that error alone.
 */
export function readGhOutput(call: GhCall, fallback = 'exited non-zero'): Result<ProcessOutput> {
  const { run, failure, attempts } = call
  if (failure === null && run.isOk) return succeed(run.value)
  if (failure !== null && transient.has(failure)) return fail(`GitHub unreachable after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${firstLine(run)}`)
  const stderr = run.isOk ? readErrorLine(run.value.stderr) : ''
  const withStderr = (label: string): string => stderr ? `${label}: ${stderr}` : label
  if (failure === 'not-found') return fail(withStderr(notFound))
  if (failure === 'rate-limited') {
    const after = run.isOk ? /^retry-after: *(\d+)/im.exec(run.value.stdout)?.[1] : undefined
    return fail(withStderr(after ? `rate limited, retry after ${after} s` : 'rate limited, retry later'))
  }
  return fail(run.isOk ? readErrorLine(run.value.stderr) || fallback : run.error)
}

/**
 * Tells whether a call failed transiently, so a write it made may or may not have landed: even a request never sent
 * may follow an earlier request of the same gh command that did.
 * @param call - The call.
 * @returns Whether its outcome is unknown.
 */
export function isOutcomeUnknown(call: GhCall): boolean {
  return call.failure !== null && transient.has(call.failure)
}
