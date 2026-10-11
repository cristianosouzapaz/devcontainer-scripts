import type { ToolRun } from '../../hooks/core/command-observation'
import { root } from './world'
import type { Options } from './world'

/** A Write call's input. */
interface WriteCall { tool: 'Write'; file_path: string; content: string }

/** A Bash call's input. */
interface BashCall { tool: 'Bash'; command: string }

/** The session record of a session with no flow declared. */
export const noFlow = { flow: null, issues: [], info: {} }

/** A Close out on #1 and #2, so a PR body must carry both Closes lines. */
export const twoIssueCloseOut: Options = {
  session: { flow: 'close-out', issues: [1, 2], info: { 1: { title: 'a', labels: [] }, 2: { title: 'b', labels: [] } } },
}

/** A repository verify file naming `./test/run.sh`. */
export const verifyFile = JSON.stringify({ verify: './test/run.sh' })

/**
 * Builds a Write call that writes an empty file.
 *
 * @param path - An absolute path, or one relative to the repository root.
 * @returns The call.
 */
export const buildWriteCall = (path: string): WriteCall =>
  ({ tool: 'Write', file_path: path.startsWith('/') ? path : `${root}/${path}`, content: '' })

/**
 * Builds a Bash call.
 *
 * @param command - The command line.
 * @returns The call.
 */
export const buildBashCall = (command: string): BashCall => ({ tool: 'Bash', command })

/**
 * Builds the result of a Bash call the engine moved to the background, as it answers when a message is delivered mid-run.
 *
 * @param taskId - The background task's id.
 * @param extra - Further result fields, such as `backgroundEndsWithFinalResponse`.
 * @returns The tool run.
 */
export const buildBackgroundedRun = (taskId: string, extra: Record<string, unknown> = {}): ToolRun =>
  ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: taskId, backgroundedToDeliverMessage: true, ...extra } })

/**
 * Builds a task notification's text as the engine submits it.
 *
 * @param taskId - The task's id.
 * @param status - How the task ended: `completed`, `failed`, `killed`.
 * @returns The envelope.
 */
export const buildTaskNotification = (taskId: string, status: string): string =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>${status}</status>\n<summary>Background command "tests" ${status}</summary>\n</task-notification>`
