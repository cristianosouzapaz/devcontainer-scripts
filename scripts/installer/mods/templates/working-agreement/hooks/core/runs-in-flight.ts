import type { CommandOutcome, LaunchedCommand, Observation } from '../domain/command-events'
import type { RunInFlight } from '../domain/step-states'
import { hasDetachedHerdrRuns, listHerdrRuns } from '../features/herdr'

/** A task end the engine notified: the task's id and the status it ended with. */
interface TaskEnd { id: string; status: string }

/** A run whose Bash call moved to the background: what was observed at launch, and whether a turn end found its task gone. */
interface BackgroundRun { launched: LaunchedCommand; isEnded: boolean }

/** Verify and test runs of Bash calls still executing; each is removed by identity when its call ends. */
const directRuns = new Set<LaunchedCommand>()

/**
 * Verify and test runs of Bash calls moved to the background, by task id, until their task end is notified or they lapse.
 * They live for one module load, so a session restart leaves nothing in flight that nothing can report.
 */
const backgroundRuns = new Map<string, BackgroundRun>()

/**
 * The ids of the background tasks a call left running, whatever they run (a Bash call moved to the background, a Monitor),
 * which may write the tree between calls. They never count as runs in flight; a user prompt absorbs nothing while one is known.
 */
const detachedTasks = new Set<string>()

/**
 * Tracks a direct run as in flight until its Bash call returns.
 *
 * @param launched - What was observed at launch.
 */
export function trackDirectRun(launched: LaunchedCommand): void {
  directRuns.add(launched)
}

/**
 * Stops tracking a direct run once its Bash call returned.
 *
 * @param launched - What was observed at launch, the same object `trackDirectRun` received.
 */
export function untrackDirectRun(launched: LaunchedCommand): void {
  directRuns.delete(launched)
}

/**
 * Keeps a run in flight under its task id once its Bash call moved to the background, until its task end is notified or it lapses.
 *
 * @param taskId - The background task's id.
 * @param launched - What was observed at launch.
 */
export function trackBackgroundRun(taskId: string, launched: LaunchedCommand): void {
  backgroundRuns.set(taskId, { launched, isEnded: false })
}

/**
 * Knows a background task a call left running until its end is notified, it is stopped, or a turn end finds it gone.
 *
 * @param taskId - The task's id.
 */
export function trackDetachedTask(taskId: string): void {
  detachedTasks.add(taskId)
}

/**
 * Forgets a background task once it ended.
 *
 * @param taskId - The task's id.
 */
export function settleDetachedTask(taskId: string): void {
  detachedTasks.delete(taskId)
}

/**
 * Tells whether a writer a call left running may still change the tree: a known background task, or a herdr pane run
 * carrying an exit marker no `wait-output` reported yet.
 *
 * @returns True when one is known.
 */
export const hasDetachedRuns = (): boolean => detachedTasks.size > 0 || hasDetachedHerdrRuns()

/**
 * Reads the task ends a task notification's text reports, one per `<task-notification>` envelope it holds.
 *
 * @param text - The notification as the engine submitted it.
 * @returns Each envelope's task id and status; an envelope missing either is left out.
 */
export function readTaskEnds(text: string): TaskEnd[] {
  return [...text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)].flatMap(([, body]) => {
    const id = /<task-id>([^<]+)<\/task-id>/.exec(body ?? '')?.[1]?.trim()
    const status = /<status>([^<]+)<\/status>/.exec(body ?? '')?.[1]?.trim()
    return id && status ? [{ id, status }] : []
  })
}

/**
 * Settles a background run at its task's end: `completed` is exit 0, `failed` a non-zero exit, anything else (`killed`)
 * an end without an outcome.
 *
 * @param end - The task's id and status.
 * @returns The run's observation, or null when no run in flight has that task id.
 */
export function settleBackgroundRun(end: TaskEnd): Observation | null {
  const run = backgroundRuns.get(end.id)
  if (!run) return null
  backgroundRuns.delete(end.id)
  const outcome: CommandOutcome = end.status === 'completed' ? 'passed' : end.status === 'failed' ? 'failed' : 'unfinished'
  return { ...run.launched, outcome, output: '' }
}

/**
 * Drops the background runs launched on another tree than the current one: their outcome could no longer count, and a
 * tree that later returns to the same content does not bring back a run that read files mid-change.
 *
 * @param tree - The current tree, or null when it could not be read, which drops nothing.
 */
export function lapseBackgroundRuns(tree: string | null): void {
  if (!tree) return
  for (const [id, run] of backgroundRuns) if (run.launched.tree !== tree) backgroundRuns.delete(id)
}

/**
 * Drops the background runs whose task ended without a notification. A turn end that no longer lists a run's task marks
 * it ended; the next turn end drops it if it is still unsettled, since a notification queued at the first is delivered
 * before the second. A task listed again is not ended. A known background task the turn end no longer lists is forgotten
 * at once: whatever it wrote before it ended, the turn end's own tree comparison judges.
 *
 * @param activeIds - The ids of the session's background tasks still running or pending.
 * @returns True when a run was dropped.
 */
export function reconcileBackgroundRuns(activeIds: string[]): boolean {
  for (const id of detachedTasks) if (!activeIds.includes(id)) detachedTasks.delete(id)
  const dropped = [...backgroundRuns].filter(([id, run]) => run.isEnded && !activeIds.includes(id)).map(([id]) => id)
  for (const id of dropped) backgroundRuns.delete(id)
  for (const [id, run] of backgroundRuns) backgroundRuns.set(id, { ...run, isEnded: !activeIds.includes(id) })
  return dropped.length > 0
}

/**
 * Finds a run in flight on a tree, direct, in the background or in a herdr pane.
 *
 * @param tree - The tree the run must have started on, or null when there is none.
 * @param kind - Whether the run must run the verify command, or some of the unit's tests.
 * @returns How the run reports, or null when none is in flight on that tree.
 */
export function findRunInFlight(tree: string | null, kind: 'verify' | 'test'): RunInFlight | null {
  const isMatch = (launched: LaunchedCommand): boolean => !!tree && launched.tree === tree && launched.events.some(event => event.kind === kind)
  if ([...directRuns].some(isMatch)) return { kind: 'direct' }
  if ([...backgroundRuns.values()].some(run => isMatch(run.launched))) return { kind: 'background' }
  const herdr = listHerdrRuns().find(run => isMatch(run.launched))
  return herdr ? { kind: 'herdr', pane: herdr.pane } : null
}

/**
 * Tells whether any run is in flight, direct, in the background or in a herdr pane.
 *
 * @returns True when one is.
 */
export const hasRunsInFlight = (): boolean => directRuns.size > 0 || backgroundRuns.size > 0 || listHerdrRuns().length > 0
