import { isGitOutsideProject, recogniseCommand } from '../domain/command-events'
import type { CommandContext, CommandEvent, CommandOutcome, LaunchedCommand, Observation } from '../domain/command-events'
import { hasDiagnoseStep } from '../domain/flow-definitions'
import type { Session } from '../domain/records'
import { completeHerdrRuns, readHerdrLaunch, readHerdrPaneCommand, trackDetachedHerdrRun, trackHerdrRun } from '../features/herdr'
import { listCheckouts } from '../lib/git'
import { isRecord, toStringOrEmpty } from '../lib/json'
import { formatError, unwrapOr } from '../lib/result'
import { listWriteTargets } from '../lib/shell-parser'
import type { ShellContext, WriteTarget } from '../lib/shell-parser'
import type { EnginePort } from './engine-port'
import { isInWorktree } from './main-checkout'
import { findUnitKey, readUnit } from './record-store'
import { hasStaleRedFile } from './red-files'
import { readWorkingTreeKey } from './repository'
import { trackBackgroundRun, trackDirectRun, untrackDirectRun } from './runs-in-flight'
import { readVerifyCommand } from './verify-config'

/** What a tool call returns: its result, flagged when the call failed, and the result as the model read it. */
export interface ToolRun { isError?: true; result?: unknown; text?: string }

/** A Bash call observed before it executes, and whether a verify run, or a run in the worktree, is now in flight. */
export interface DirectLaunch { launched: LaunchedCommand; isInFlight: boolean }

/** How a direct Bash call ended, and what it printed. */
interface DirectOutcome { outcome: CommandOutcome; output: string }

const isTracked = (launched: LaunchedCommand): boolean => !!launched.worktree || launched.events.some(event => event.kind === 'verify')

// What recognising a command in the session needs beyond its text. A verify run in a worktree tests the worktree, not
// the tree Verify judges, so there it is not recognised.
async function readCommandContext(port: EnginePort, session: Session): Promise<CommandContext> {
  const cwd = await port.readCwd()
  const home = await port.readHome()
  return {
    verifyCommand: isInWorktree(cwd) ? undefined : await readVerifyCommand(port),
    issues: session.issues,
    shell: { cwd, ...(home ? { home } : {}) },
    checkouts: unwrapOr(await listCheckouts(port.processes), null),
  }
}

/**
 * Lists the command lines a Bash call runs: its own, and the command a `herdr pane run` in it runs in the pane, which
 * the call's own line holds only as a quoted argument.
 *
 * @param command - The Bash command.
 * @returns The lines, the call's own first.
 */
function listCallLines(command: string): string[] {
  const pane = readHerdrPaneCommand(command)
  return pane === null ? [command] : [command, pane]
}

/**
 * Recognises what a Bash call is about to do, as the gates judge it: the events of its own line and of the command a
 * herdr pane runs, so a guarded command gets the same verdict either way.
 *
 * @param port - The engine calls.
 * @param session - The session the call runs in.
 * @param command - The Bash command.
 * @returns The events, with their arguments, of every line the call runs.
 */
export async function recogniseCall(port: EnginePort, session: Session, command: string): Promise<CommandEvent[]> {
  const context = await readCommandContext(port, session)
  return listCallLines(command).flatMap(line => recogniseCommand(line, context))
}

/**
 * Lists the files a Bash call writes, from its own line and from the command a herdr pane runs. The pane's working
 * directory is its own and unknown here, so a relative path there cannot be resolved and counts as a repository write.
 *
 * @param command - The Bash command.
 * @param context - The session's working directory and the home directory.
 * @returns Each written path, absolute, or null where it cannot be resolved.
 */
export function listCallWrites(command: string, context: ShellContext): WriteTarget[] {
  const pane = readHerdrPaneCommand(command)
  return [...listWriteTargets(command, context), ...(pane === null ? [] : listWriteTargets(pane, { ...context, cwd: null }))]
}

/**
 * Observes a command at its launch: the events it maps to, the worktree when the session works in the unit's worktree
 * of a flow with Diagnose before the green or while a red file is stale, and, for a verify run or a run in the worktree, the tree it starts on. A direct
 * run and a herdr run are both judged here, at launch; a herdr pane's own directory is unknown, so the session's stands in.
 *
 * @param port - The engine calls.
 * @param session - The session the command runs in.
 * @param command - The command line, or the command a herdr pane runs.
 * @returns The command as launched.
 */
async function launchCommand(port: EnginePort, session: Session, command: string): Promise<LaunchedCommand> {
  const unit = await readUnit(port, await findUnitKey(port, session))
  const cwd = await port.readCwd()
  const path = unit.worktree?.path
  const isInUnitWorktree = !!path && hasDiagnoseStep(session.flow) && (cwd === path || cwd.startsWith(`${path}/`))
  const isGreen = isInUnitWorktree && !!unit.red && unit.green === unit.red.command && !await hasStaleRedFile(port, unit)
  const worktree = path && isInUnitWorktree && !isGreen ? path : null
  const launched = { command, events: recogniseCommand(command, await readCommandContext(port, session)), startedAt: await port.now(), tree: null, worktree }
  return isTracked(launched) ? { ...launched, tree: await readWorkingTreeKey(port) } : launched
}

/**
 * Observes a Bash call before it executes, and tracks its verify run, or its run in the worktree, as in flight until `endDirectRun`.
 * A failure here leaves the call unobserved rather than denying it, and says so.
 *
 * @param port - The engine calls.
 * @param session - The session the call runs in.
 * @param command - The Bash command.
 * @returns The launch, or null when it could not be observed.
 */
export async function startDirectRun(port: EnginePort, session: Session, command: string): Promise<DirectLaunch | null> {
  try {
    const launched = await launchCommand(port, session, command)
    const isInFlight = isTracked(launched) && !!launched.tree
    if (isInFlight) trackDirectRun(launched)
    return { launched, isInFlight }
  } catch (error) {
    port.toast(`The working agreement could not observe the command (${formatError(error)}).`)
    return null
  }
}

/**
 * Ends a direct run once its Bash call returned. A call moved to the background keeps its run in flight under its task
 * id, unless the engine says no notification can follow (the task ends with its caller's final response).
 *
 * @param launch - The launch, or null when the call was not observed.
 * @param ran - The call's result, or null when the call threw.
 */
export function endDirectRun(launch: DirectLaunch | null, ran: ToolRun | null): void {
  if (!launch) return
  untrackDirectRun(launch.launched)
  const result = isRecord(ran?.result) ? ran.result : {}
  const taskId = toStringOrEmpty(result.backgroundTaskId)
  if (launch.isInFlight && taskId && !result.backgroundEndsWithFinalResponse) trackBackgroundRun(taskId, launch.launched)
}

// Whether a Bash call ran its command. A non-zero exit comes back as an error whose text opens with its exit code; any other
// error text is a call refused before it ran (a permission denied, the harness's own check), which ended nothing.
const hasRun = (ran: ToolRun): boolean => ran.isError !== true || ran.text === undefined || /^(?:Error: )?Exit code \d+/.test(ran.text)

// How a direct Bash call ended; the result carries no exit code, so a non-zero exit comes back as an error.
function readDirectOutcome(ran: ToolRun): DirectOutcome {
  const result = isRecord(ran.result) ? ran.result : {}
  const outcome: CommandOutcome = result.backgroundTaskId ? 'unfinished' : ran.isError !== true ? 'passed' : result.interrupted ? 'unfinished' : 'failed'
  return { outcome, output: toStringOrEmpty(result.stdout) }
}

// The git and PR operations the engine reports a direct Bash call did, whatever the command's text: a script or an alias the
// recogniser cannot read is still seen. A herdr run carries no such report, so this evidence exists for direct calls only.
function readReportedEvents(ran: ToolRun): CommandEvent[] {
  const result = isRecord(ran.result) ? ran.result : {}
  const operation = isRecord(result.gitOperation) ? result.gitOperation : {}
  const pullRequest = isRecord(operation.pr) && typeof operation.pr.number === 'number' ? { number: operation.pr.number, action: toStringOrEmpty(operation.pr.action) } : null
  return [
    ...(operation.commit ? [{ kind: 'commit' } as const] : []),
    ...(pullRequest?.action === 'created' ? [{ kind: 'pr-create', number: pullRequest.number } as const] : []),
    ...(pullRequest?.action === 'merged' ? [{ kind: 'pr-merge', number: pullRequest.number } as const] : []),
  ]
}

/**
 * Lists the commands a finished Bash call lets the steps observe: the call itself, with its exit as outcome, and every
 * herdr run whose exit marker a `wait-output` in it reported, with the marker's exit code as outcome. A `herdr pane run`
 * in the call starts tracking the command it runs, observed at launch as a direct call is, and is known as a writer
 * that may change the tree until its marker is reported. The git and PR operations the
 * engine reports for the call count as done even when the recogniser did not see them in its text, unless every git
 * command the call runs works outside the project. A call refused before it ran is not observed.
 *
 * @param port - The engine calls.
 * @param session - The session the call ran in.
 * @param command - The Bash command.
 * @param ran - The call's result.
 * @param launch - The call's launch, or null when it was not observed.
 * @returns The observations, each with its events, launch state and outcome.
 */
export async function observeBashCall(port: EnginePort, session: Session, command: string, ran: ToolRun, launch: DirectLaunch | null): Promise<Observation[]> {
  if (!hasRun(ran)) return []
  const { outcome, output } = readDirectOutcome(ran)
  const launched = launch?.launched ?? { command, events: [], startedAt: await port.now(), tree: null, worktree: null }
  // What git did in another repository (a scratch one) is not the unit's.
  const engineReported = readReportedEvents(ran)
  const reported = engineReported.length && !isGitOutsideProject(command, await readCommandContext(port, session)) ? engineReported : []
  const isPassed = outcome === 'passed'
  // On a passed call the engine's report replaces a recognised event of the same kind: it is what git did, and it carries the PR number.
  const events = isPassed ? [...launched.events.filter(event => !reported.some(other => other.kind === event.kind)), ...reported] : launched.events
  const direct: Observation[] = events.length || launched.worktree ? [{ ...launched, events, outcome, output }] : []
  // A failed call can still have done a git operation first (`git commit && false`): the report stands on its own.
  const observed: Observation[] = !isPassed && reported.length ? [...direct, { ...launched, events: reported, tree: null, worktree: null, outcome: 'passed', output }] : direct
  if (!isPassed) return observed
  const herdrLaunch = readHerdrLaunch(command)
  if (herdrLaunch) {
    trackDetachedHerdrRun(herdrLaunch)
    const launched = await launchCommand(port, session, herdrLaunch.command)
    if (launched.events.length || launched.worktree) trackHerdrRun(herdrLaunch, launched)
  }
  const exits = completeHerdrRuns(command, output)
  return [...observed, ...exits.map((exit): Observation => ({ ...exit.launched, outcome: exit.exitCode === 0 ? 'passed' : 'failed', output: '' }))]
}
