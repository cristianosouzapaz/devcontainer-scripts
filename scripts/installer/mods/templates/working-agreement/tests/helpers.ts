import type { Engine } from 'claude-code/testing'
import type { CommandRunResult, PromptOrigin, ToolCallResult } from 'claude-code'

import { root } from './world'
import type { Options } from './world'

/** A Write call's input. */
export interface WriteCall { tool: 'Write'; file_path: string; content: string }

/** A Bash call's input. */
export interface BashCall { tool: 'Bash'; command: string }

/** The session record of a session with no flow declared. */
export const noFlow = { flow: null, issues: [], hadIssue: false, info: {} }

/** A Close out on #1 and #2, so a PR body must carry both Closes lines. */
export const twoIssueCloseOut: Options = {
  session: { flow: 'close-out', issues: [1, 2], info: { 1: { title: 'a', labels: [] }, 2: { title: 'b', labels: [] } } },
}

/** A repository verify file naming `./test/run.sh`. */
export const verifyFile = JSON.stringify({ verify: './test/run.sh' })

/**
 * Runs `/flow` with these arguments, typed at the prompt unless another origin is given.
 *
 * @param $ - The test's engine.
 * @param args - Everything after `/flow`.
 * @param origin - Where the run comes from.
 * @returns What the command answered.
 */
export function flow($: Engine, args: string, origin: PromptOrigin = { kind: 'composer' }): Promise<CommandRunResult> {
  return $.command.run({ command: 'flow', args, origin, presentation: { isFullscreen: false, columns: 80 } })
}

/**
 * Reads the Flow pane as `/flow status` prints it.
 *
 * @param $ - The test's engine.
 * @returns The status text.
 */
export const flowStatus = async ($: Engine): Promise<string | undefined> => (await flow($, 'status')).text

/**
 * Submits a prompt typed by the user and reads the context the mod adds to it.
 *
 * @param $ - The test's engine.
 * @returns The context lines joined, or '' when there are none.
 */
export const promptContext = async ($: Engine): Promise<string> =>
  (await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })).context?.join('\n') ?? ''

/**
 * Names the step the prompt context calls current.
 *
 * @param $ - The test's engine.
 * @returns The step's label, or undefined when the context names none.
 */
export const currentStep = async ($: Engine): Promise<string | undefined> => (await promptContext($)).match(/current step: (\w+)/)?.[1]

/**
 * Submits a prompt under a permission mode, which the mod records.
 *
 * @param $ - The test's engine.
 * @param permissionMode - The mode.
 * @returns Once the prompt hook ran.
 */
export const setPermissionMode = async ($: Engine, permissionMode: string): Promise<void> => {
  await $.classic.UserPromptSubmit({ prompt: 'go', permission_mode: permissionMode })
}

/**
 * Builds a Write call that writes an empty file.
 *
 * @param path - An absolute path, or one relative to the repository root.
 * @returns The call.
 */
export const writeCall = (path: string): WriteCall =>
  ({ tool: 'Write', file_path: path.startsWith('/') ? path : `${root}/${path}`, content: '' })

/**
 * Builds a Bash call.
 *
 * @param command - The command line.
 * @returns The call.
 */
export const bashCall = (command: string): BashCall => ({ tool: 'Bash', command })

/**
 * Calls declare_flow as the agent, or as a subagent when an agent id is given.
 *
 * @param $ - The test's engine.
 * @param id - The flow's id.
 * @param issues - The issue numbers.
 * @param agentId - The subagent's id.
 * @returns What the call answered.
 */
export const declareFlow = ($: Engine, id: string, issues: number[] = [], agentId?: string): Promise<ToolCallResult> =>
  $.tool.call({ tool: 'mcp__working-agreement__declare_flow', flow: id, issues, ...(agentId ? { agentId } : {}) })

/**
 * Ends the main agent's turn with an answer.
 *
 * @param $ - The test's engine.
 * @returns Once the turn hooks ran.
 */
export const endTurn = async ($: Engine): Promise<void> => {
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
}

/**
 * Starts a skill.
 *
 * @param $ - The test's engine.
 * @param skill - The skill's name.
 * @returns Once the skill hooks ran.
 */
export const startSkill = async ($: Engine, skill: string): Promise<void> => {
  await $.skill.prompt({ skill, text: '' })
}
