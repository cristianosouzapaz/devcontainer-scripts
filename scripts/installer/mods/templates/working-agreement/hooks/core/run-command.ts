import { executeProcess } from '../lib/process'
import type { ProcessSpawnResult } from 'claude-code'
import type { EnginePort } from './engine-port'

/** A completed command, or a stop owned by the mod rather than inferred from signals. */
export type CommandRun = EndedCommand | CancelledCommand | TimedOutCommand
/** Holds a command that ended or timed out without cancellation. */
export type FinishedCommand = EndedCommand | TimedOutCommand
interface EndedCommand { kind: 'ended'; code: number | null; signal: string | null; duration: number }
type CommandStop = 'cancelled' | 'timeout'
interface CancelledCommand { kind: 'cancelled'; duration: number }
interface TimedOutCommand { kind: 'timeout'; duration: number }
/**
 * Holds a command, its immutable execution context and its cancellation signal.
 */
export interface RunRequest { argv: string[]; cwd: string; tree: string; log: string; deadline: number; signal: AbortSignal }
interface Cancellation { resolve?: (reason: 'cancelled') => void }
interface RunState { kind: CommandRun['kind']; status: ProcessSpawnResult }

/** The engine timer's 32-bit delay ceiling in milliseconds. */
const engineTimerMaxMs = 2147483647
/** The largest command log retained before its output is truncated. */
const logCapBytes = 10000000
/** The command output retained after the log reaches its cap. */
const outputTailBytes = 32768
/** The final command-output lines shown to the agent. */
const agentTailLines = 60
/** The UTF-8 bytes allowed in the command-output tail shown to the agent. */
const agentTailBytes = 8192
/** The 50 ms polls a stopped group gets after SIGTERM before SIGKILL: time for the log readers to flush. */
const killGraceTicks = 40

// Positional args carry all user content. The command remains the direct child;
// every reader inherits fd 9, holding the engine pipe through its final write.
// Draining after head closes prevents SIGPIPE; tee gives the rolling tail every
// original byte. Readers ignore TERM so they can persist bytes already in flight.
// An empty overflow file is removed here, since a cancelled run never reaches finishLog.
// The wrapper leads its own process group, whose id it records for killGroup.
const wrapper = `log=$1; header=$2; shift 2
printf "%s\\n" "$$" >"$log.pgid"
printf "%s\\n" "$header" >>"$log"
limit=$((${logCapBytes} - $(wc -c <"$log")))
[ "$limit" -ge 0 ] || limit=0
mkfifo "$log.fifo-in" "$log.fifo-tail" || exit
(
  trap '' TERM INT
  exec 9>&1
  (
    exec <"$log.fifo-tail"
    rm -f "$log.fifo-tail"
    : >"$log.output"
    while dd bs=${outputTailBytes} count=1 of="$log.output.chunk" 2>/dev/null; do
      [ -s "$log.output.chunk" ] || break
      cat "$log.output" "$log.output.chunk" | tail -c ${outputTailBytes} >"$log.output.next"
      mv -f "$log.output.next" "$log.output"
    done
    rm -f "$log.output.chunk" "$log.output.next"
  ) &
  (
    exec <"$log.fifo-in"
    rm -f "$log.fifo-in"
    exec tee "$log.fifo-tail"
  ) | { head -c "$limit" >>"$log"; dd bs=1 count=1 of="$log.overflow" 2>/dev/null || :; if [ -s "$log.overflow" ]; then cat >/dev/null; else rm -f "$log.overflow"; fi; }
  wait
) &
exec "$@" >"$log.fifo-in" 2>&1`
// The engine kills only the child it spawned (its descendant walk is a best-effort snapshot), so the
// wrapper first becomes a group leader: setsid on Linux, perl's setpgrp on macOS, which ships no setsid.
// Neither forks, since the engine's child never leads a group, so the engine still holds the leader.
const leader = `w='${wrapper.replaceAll("'", "'\\''")}'
command -v setsid >/dev/null 2>&1 && exec setsid sh -c "$w" "$0" "$@"
exec perl -e 'setpgrp(0, 0); exec @ARGV or die "cannot exec sh: $!\\n"' sh -c "$w" "$0" "$@"`
// A pgid cannot be reused while any member lives, and ESRCH means the group is already gone.
const killGroup = `log=$1; pgid=$(cat "$log.pgid" 2>/dev/null) || exit 0; rm -f "$log.pgid"
kill -TERM "-$pgid" 2>/dev/null || exit 0
i=0; while [ "$i" -lt ${killGraceTicks} ] && kill -0 "-$pgid" 2>/dev/null; do sleep 0.05; i=$((i + 1)); done
kill -KILL "-$pgid" 2>/dev/null || :`
const finishLog = `set -e; log=$1; footer=$2; if [ -s "$log.overflow" ]; then head -c ${logCapBytes} "$log" >"$log.tmp"; mv -f "$log.tmp" "$log"; printf "\\n[output truncated]\\n" >>"$log"; cat "$log.output" >>"$log"; fi; printf "\\n%s\\n" "$footer" >>"$log"; cat "$log.output"; rm -f "$log.output" "$log.output.chunk" "$log.output.next" "$log.overflow" "$log.tmp" "$log.pgid"`

/**
 * Returns the command's exact exit status or the mod's cancellation or timeout stop; a stop ends the command's whole process group before the stream closes.
 * @param port - Engine calls.
 * @param request - Command, immutable context, log destination and cancellation.
 * @returns Exact process status and the mod's own stop reason.
 */
export async function runCommand(port: EnginePort, request: RunRequest): Promise<CommandRun> {
  const started = await port.now()
  const control = new AbortController()
  const cancelled: Cancellation = {}
  const onAbort = () => cancelled.resolve?.('cancelled')
  const stop = new Promise<'cancelled'>(resolve => { cancelled.resolve = resolve })
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) onAbort()
  const wait = async (): Promise<CommandStop> => {
    try { await port.clock.sleep(Math.min(engineTimerMaxMs, Math.max(0, request.deadline - await port.now())), control.signal) }
    catch (error) { if (control.signal.aborted) return 'cancelled'; throw error }
    return await port.now() >= request.deadline ? 'timeout' : wait()
  }
  const timeout = wait()
  const stream = port.processes.spawn({ argv: ['sh', '-c', leader, 'verify', request.log,
    `\nargv: ${JSON.stringify(request.argv)}\ncwd: ${request.cwd}\ntree: ${request.tree}`, ...request.argv], cwd: request.cwd })
  const result: RunState = { kind: 'ended', status: { code: null, signal: null } }
  const pull = { done: false }
  try {
    while (true) {
      const pulled = await Promise.race([stream.next(), stop, timeout])
      if (pulled === 'cancelled' || pulled === 'timeout') { result.kind = pulled; break }
      if (pulled.done) { pull.done = true; result.status = pulled.value; break }
    }
  } finally {
    try { if (!pull.done) await executeProcess(port.processes, ['sh', '-c', killGroup, 'verify-kill', request.log]) }
    catch (error) { port.logDebug(`run group kill failed: ${error instanceof Error ? error.message : String(error)}`) }
    finally {
      // An abandoned dispatch does not terminate the child unless the consumer leaves the stream.
      try { await stream.return({ code: null, signal: null }) }
      finally {
        control.abort()
        request.signal.removeEventListener('abort', onAbort)
      }
    }
  }
  return { kind: request.signal.aborted ? 'cancelled' : result.kind, ...result.status, duration: (await port.now() - started) / 1000 }
}

/**
 * Appends the retained tail to a truncated log and returns the cleaned agent tail.
 * @param port - Engine calls.
 * @param log - Absolute log path.
 * @param footer - Exact command status and duration.
 * @returns The final sixty lines, bounded by UTF-8 bytes.
 */
export async function closeCommandLog(port: EnginePort, log: string, footer: string): Promise<string> {
  const result = await executeProcess(port.processes, ['sh', '-c', finishLog, 'verify-log', log, footer])
  if (result.exitCode !== 0) throw new Error(result.stderr || 'cannot finish run log')
  const text = cleanOutput(result.stdout).split('\n').slice(-agentTailLines).join('\n')
  const chars = [...text]
  const tail: string[] = []
  const size = { bytes: 0 }
  const encoder = new TextEncoder()
  for (const char of chars.reverse()) {
    const bytes = encoder.encode(char).length
    if (size.bytes + bytes > agentTailBytes) break
    size.bytes += bytes
    tail.push(char)
  }
  return tail.reverse().join('')
}

/**
 * Removes terminal escapes and normalizes output lines without interpreting them.
 * @param text - Raw command output.
 * @returns Plain output, without its final newline.
 */
export function cleanOutput(text: string): string {
  return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[ -/]*[0-~])/g, '').replace(/\r\n?/g, '\n').replace(/\n$/, '')
}
