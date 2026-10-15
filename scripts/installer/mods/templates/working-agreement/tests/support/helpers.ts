import type { CommandRunResult, PromptOrigin, ToolCallResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { IssueComment } from './world'

/**
 * Runs `/flow` with these arguments, typed at the prompt unless another origin is given.
 *
 * @param $ - The test's engine.
 * @param args - Everything after `/flow`.
 * @param origin - Where the run comes from.
 * @returns What the command answered.
 */
export function runFlowCommand($: Engine, args: string, origin: PromptOrigin = { kind: 'composer' }): Promise<CommandRunResult> {
  return $.command.run({ command: 'flow', args, origin, presentation: { isFullscreen: false, columns: 80 } })
}

/**
 * Reads the Flow pane as `/flow status` prints it.
 *
 * @param $ - The test's engine.
 * @returns The status text.
 */
export const readFlowStatus = async ($: Engine): Promise<string | undefined> => (await runFlowCommand($, 'status')).text

/**
 * Submits a prompt typed by the user and reads the context the mod adds to it.
 *
 * @param $ - The test's engine.
 * @returns The context lines joined, or '' when there are none.
 */
export const readPromptContext = async ($: Engine): Promise<string> =>
  (await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })).context?.join('\n') ?? ''

/**
 * Names the step the prompt context calls current.
 *
 * @param $ - The test's engine.
 * @returns The step's label, or undefined when the context names none.
 */
export const readCurrentStep = async ($: Engine): Promise<string | undefined> => (await readPromptContext($)).match(/current step: (\w+)/)?.[1]

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
 * Delivers a task notification, as the engine does when a background task ends.
 *
 * @param $ - The test's engine.
 * @param text - The notification's text.
 * @returns The context lines the mod adds to the notification's own turn, joined.
 */
export const notifyTask = async ($: Engine, text: string): Promise<string> =>
  (await $.prompt.submit({ text, wait: false, origin: { kind: 'task-notification' } })).context?.join('\n') ?? ''

/**
 * Ends the main agent's turn as the classic stop reports it, with the background tasks still running.
 *
 * @param $ - The test's engine.
 * @param activeIds - The ids of the background tasks still running.
 * @returns Once the stop hooks ran.
 */
export const stopTurn = async ($: Engine, activeIds: string[]): Promise<void> => {
  await $.classic.Stop({ stop_hook_active: false, background_tasks: activeIds.map(id => ({ id, type: 'shell', status: 'running', description: '' })) })
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

/**
 * Posts a comment on issue #1 as the agent does with `gh issue comment`; GitHub then holds it as the issue's latest comment.
 *
 * @param $ - The test's engine.
 * @param comments - The world's `issueComments`, which the comment is added to.
 * @param body - The comment text.
 * @returns What the Bash call answered.
 */
export function postComment($: Engine, comments: Record<number, IssueComment[]>, body: string): Promise<ToolCallResult> {
  const list = (comments[1] ??= [])
  list.push({ url: `https://github.com/o/r/issues/1#issuecomment-${list.length + 1}`, body })
  return $.tool.call({ tool: 'Bash', command: `gh issue comment 1 --body "${body}"` })
}
