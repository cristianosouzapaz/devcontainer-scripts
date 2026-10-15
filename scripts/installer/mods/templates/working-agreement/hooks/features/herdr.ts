import type { LaunchedCommand } from '../domain/command-events'
import { isRecord, parseJson, toStringOrEmpty } from '../lib/json'
import { findRanCommands } from '../lib/shell-parser'

/** A `herdr pane run` call: the pane it runs in, the id of its exit marker and the command run in the pane. */
interface HerdrLaunch { pane: string; id: string; command: string }

/** A herdr run whose exit marker a `wait-output` reported: what was observed at launch, and the exit code the marker carries. */
interface HerdrExit { launched: LaunchedCommand; exitCode: number }

/** A herdr run in flight: its pane and what was observed at launch. */
interface HerdrRun { pane: string; launched: LaunchedCommand }

/** A herdr run not yet reported: the id of its exit marker and what was observed at launch. */
interface PendingRun { id: string; launched: LaunchedCommand }

/** The herdr runs the feature tracks for the life of one module load; a reload drops them, so nothing is left in flight that nothing can report. */
interface HerdrRuns {
  /** Runs not yet reported, by pane id, with the id of their exit marker. */
  pending: Record<string, PendingRun>
  /** Marker ids a run already reported; one never counts again. */
  consumed: Set<string>
  /** The marker id of every run launched with one, whatever it runs, by pane id, until a `wait-output` reports it. */
  detached: Record<string, string>
}

const runs: HerdrRuns = { pending: {}, consumed: new Set(), detached: {} }

// The words after the subcommand of the command's first `herdr pane <subcommand>`, or null. It is found as any command
// is, behind a prefix (env, sudo, timeout), a program path or herdr's own options, so none of them hides a pane run from the gates.
function readPaneCall(command: string, subcommand: string): string[] | null {
  for (const invocation of findRanCommands(command, 'herdr')) {
    if (!invocation.isParsed) continue
    const words = invocation.args.slice(invocation.args.findIndex(word => !word.startsWith('-')))
    if (words[0] === 'pane' && words[1] === subcommand) return words.slice(2)
  }
  return null
}

/**
 * Reads the command a `herdr pane run <pane> <command>` call runs in its pane, with or without an exit marker.
 *
 * @param command - The command line.
 * @returns The command run in the pane, or null when the call runs nothing in a pane.
 */
export function readHerdrPaneCommand(command: string): string | null {
  const [pane, ...rest] = readPaneCall(command, 'run') ?? []
  return pane ? rest.join(' ') : null
}

/**
 * Reads a `herdr pane run <pane> <command>` call that prints a per-launch `__EXIT_<id>=$?__` marker
 * (the id is `[A-Za-z0-9]+`, so output already in the pane cannot be mistaken for this run).
 *
 * @param command - The command line.
 * @returns The pane id, the marker id and the command run in the pane, without a trailing marker echo, so two launches of one
 *   command read alike; or null when the call is anything else or its marker id already reported a run.
 */
export function readHerdrLaunch(command: string): HerdrLaunch | null {
  const [pane, ...rest] = readPaneCall(command, 'run') ?? []
  const inner = rest.join(' ')
  const id = /__EXIT_([A-Za-z0-9]+)=\$\?__/.exec(inner)?.[1]
  const run = inner.replace(/\s*;\s*echo\s+\S*__EXIT_[A-Za-z0-9]+=\$\?__\S*\s*$/, '')
  return pane && id && !runs.consumed.has(id) ? { pane, id, command: run } : null
}

/**
 * Tracks a launched herdr run until a `wait-output` on its pane reports its marker; a later launch in the same pane replaces it.
 *
 * @param launch - The launch.
 * @param launched - What was observed at launch, handed back with the exit code.
 */
export function trackHerdrRun(launch: HerdrLaunch, launched: LaunchedCommand): void {
  runs.pending[launch.pane] = { id: launch.id, launched }
}

/**
 * Knows a launched herdr run, whatever it runs, as a writer that may change the tree until a `wait-output` reports its
 * marker; a later launch in the same pane replaces it.
 *
 * @param launch - The launch.
 */
export function trackDetachedHerdrRun(launch: HerdrLaunch): void {
  runs.detached[launch.pane] = launch.id
}

/**
 * Tells whether a herdr run launched with a marker has not been reported yet.
 *
 * @returns True when one has not.
 */
export const hasDetachedHerdrRuns = (): boolean => Object.keys(runs.detached).length > 0

/**
 * Lists what the herdr runs still in flight recorded at launch, with their panes.
 *
 * @returns Each run's pane and launch record.
 */
export function listHerdrRuns(): HerdrRun[] {
  return Object.entries(runs.pending).map(([pane, run]) => ({ pane, launched: run.launched }))
}

// The exit code a `wait-output` result's matched line reports for a marker id, or undefined when it names another run.
function readExitCode(stdout: string, id: string): number | undefined {
  const parsed = parseJson(stdout)
  const matched = parsed.isOk && isRecord(parsed.value) && isRecord(parsed.value.result) ? toStringOrEmpty(parsed.value.result.matched_line) : ''
  const code = new RegExp(`^__EXIT_${id}=(\\d+)__$`).exec(matched)?.[1]
  return code === undefined ? undefined : Number(code)
}

/**
 * Ends the herdr runs a `herdr pane wait-output` call reports: a pane run returns at once, so its outcome is the marker
 * line the wait prints. A wait with no matching marker leaves the run in flight.
 *
 * @param command - The command line.
 * @param stdout - What the call printed.
 * @returns The runs whose marker the wait reported, with their exit codes.
 */
export function completeHerdrRuns(command: string, stdout: string): HerdrExit[] {
  const waitArgs = readPaneCall(command, 'wait-output') ?? []
  for (const pane of waitArgs) {
    const id = runs.detached[pane]
    if (id !== undefined && readExitCode(stdout, id) !== undefined) delete runs.detached[pane]
  }
  return waitArgs.filter(word => word in runs.pending).flatMap(pane => {
    const { id, launched } = runs.pending[pane]!
    const exitCode = readExitCode(stdout, id)
    if (exitCode === undefined) return []
    delete runs.pending[pane]
    runs.consumed.add(id)
    return [{ launched, exitCode }]
  })
}
