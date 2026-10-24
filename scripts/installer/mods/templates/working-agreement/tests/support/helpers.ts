import type { CommandRunResult, PromptOrigin, ToolCallResult } from 'claude-code'
import type { Engine, Mounted } from 'claude-code/testing'
import type { World } from './world'

interface PaneOptions { columns?: number; rows?: number; requestId?: string; title?: string }

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
 * Reads the current step's label from the latest published pane view.
 * @param views - The pane views published by the test world.
 * @returns The current step's label, or undefined when none is published.
 */
export const readPaneCurrentStep = (views: World['views']): string | undefined =>
  views.at(-1)?.steps.find(step => step.state === 'current')?.label

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

/**
 * Mounts the stored pane view without requesting another refresh.
 * @param $ - The test engine.
 * @param options - Dimensions and pane identity varied by the scenario.
 * @returns The mounted terminal pane.
 */
export function mountPane($: Engine, options: PaneOptions = {}): Promise<Mounted<'terminal', 'Pane'>> {
  const { columns = 80, rows = 50, requestId = 'working-agreement', title = 'Flow' } = options
  return $.ui.mount({ plugin: 'working-agreement', surface: 'terminal', component: 'Pane', requestId,
    props: { title, isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} },
    viewport: { columns, rows },
  })
}
