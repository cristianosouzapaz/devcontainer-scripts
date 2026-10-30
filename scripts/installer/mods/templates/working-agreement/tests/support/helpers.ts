import type { CommandRunResult, On, PromptOrigin, SkillPromptArgs, ToolCallResult } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine, Mounted } from 'claude-code/testing'
import type { FlowStepState, FlowView } from '../../types'
import { locatePosition } from '../../hooks/core/position'
import { readSession } from '../../hooks/core/record-store'
import { verifyFile, verifyId } from './builders'
import { common, createTestPort } from './world'
import type { World } from './world'

interface PaneOptions { columns?: number; rows?: number; requestId?: string; title?: string }

/** Holds a node of a drawn tree as the engine returns it. */
export interface DrawnNode { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** What the model reads of a tool call. */
export interface ToolOutcome { text: string; isError: boolean; deny?: string }

/** The environment of a session inside herdr, where every re-read reports the sidebar tokens. */
export const inside = { HERDR_ENV: '1', HERDR_PANE_ID: 'pane id' }

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
 * Reads every step's real state, as guidance and judgements see it, beneath the display projection.
 * @param world - The test world.
 * @returns Each step's state, keyed by its label.
 */
export async function readStepStates(world: World): Promise<Record<string, FlowStepState>> {
  const port = createTestPort(world)
  const position = await locatePosition(port, await readSession(port), true)
  return Object.fromEntries((position?.states ?? []).map(entry => [entry.step.label, entry.state]))
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
 * Calls one of the mod's tools.
 * @param $ - The test's engine.
 * @param tool - The tool's name after the mod's prefix.
 * @param args - The call's arguments.
 * @returns What the model reads: the text, whether it is an error, and any deny.
 */
export async function callModTool($: Engine, tool: string, args: object = {}): Promise<ToolOutcome> {
  const result = await $.tool.call({ tool: `mcp__working-agreement__${tool}`, ...args } as never)
  return { text: result.text ?? String(result.result ?? ''), isError: result.isError === true, ...(result.deny ? { deny: result.deny } : {}) }
}

/**
 * Ends the main agent's turn with an answer.
 *
 * @param $ - The test's engine.
 * @param answer - The turn's final text.
 * @returns Once the turn hooks ran.
 */
export const endTurn = async ($: Engine, answer = ''): Promise<void> => {
  await $.turn.complete({ reason: 'answer', answer, durationMs: 0, isAborted: false, turnId: 't' })
}

/**
 * Starts a skill, by default one the installer put in the user's skills.
 *
 * @param $ - The test's engine.
 * @param skill - The skill's name.
 * @param source - Where the skill was loaded from.
 * @returns Once the skill hooks ran.
 */
export const startSkill = async ($: Engine, skill: string, source: SkillPromptArgs['source'] = 'userSettings'): Promise<void> => {
  await $.skill.prompt({ skill, text: '', ...(source === undefined ? {} : { source }) })
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

/**
 * Joins a drawn tree's text, depth first; a node without text reads as its label, as a button draws.
 * @param node - The drawn node.
 * @returns Its text.
 */
export function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  const tree = node as DrawnNode
  return (tree.children ?? []).map(textOf).join('') || String(tree.props?.['label'] ?? '')
}

/**
 * Asserts that every color a drawn tree uses is one of the allowed theme keys, depth first.
 * @param node - The drawn node.
 * @param keys - The theme keys the surface may use.
 */
export function checkTheme(node: unknown, keys: readonly string[]): void {
  if (typeof node !== 'object' || node === null) return
  const { props, children } = node as DrawnNode
  for (const key of ['color', 'backgroundColor']) {
    if (props?.[key] !== undefined) expect(keys).toContain(props[key])
  }
  for (const child of children ?? []) checkTheme(child, keys)
}

/**
 * Approves a Verify config as the user does, by the id the preview names.
 * @param $ - The test's engine.
 * @param file - The config's text.
 * @returns The command's reply.
 */
export const approveVerify = ($: Engine, file = verifyFile): Promise<CommandRunResult> => runFlowCommand($, `approve verify ${verifyId(file)}`)

/**
 * Asserts that a mounted pane draws a text node with the given text and props.
 * @param pane - The mounted pane.
 * @param text - The node's whole text.
 * @param props - Props the node must carry, such as its color.
 */
export async function expectText(pane: Mounted<'terminal', 'Pane'>, text: string, props: Record<string, unknown>): Promise<void> {
  const found = (await pane.findAll({ type: 'Text' })).find(node => node.text === text && Object.entries(props).every(([key, value]) => node.props[key] === value))
  expect(found).toBeDefined()
}

/**
 * Serves the view the pane draws as the one the mod stored last, read from the holder at every draw so a test can swap it.
 * @param on - The test's engine hooks.
 * @param displayed - The holder of the view.
 */
export function serveDisplayed(on: On, displayed: { value: FlowView }): void {
  on('state.get', { plugin: 'working-agreement', key: 'view' }, () => ({ value: { value: displayed.value, version: 0 } }))
}

/**
 * Reads one keyed row of `/flow status`.
 * @param status - The status text.
 * @param key - The row's key.
 * @returns The row, or empty when the status has none.
 */
export const readStatusRow = (status: string | undefined, key: string): string => (status ?? '').split('\n').find(line => line.startsWith(key)) ?? ''

/**
 * Makes another session hold the Verify lock, its ticket first in the queue.
 * @param world - The test world.
 * @param owner - Owner fields replacing a holder with no host identity.
 * @param root - The common directory whose queue it holds.
 */
export function seedVerifyHolder(world: World, owner: Record<string, unknown> = {}, root = common): void {
  world.files.set(`${root}/working-agreement/verify/lock/owner.json`, JSON.stringify({ sid: 'holder', ticket: '000000000000000-holder', token: 'held',
    pidns: null, pid: null, pidStart: null, bootId: null, ...owner }))
  world.files.set(`${root}/working-agreement/verify/q/000000000000000-holder/lease`, '')
}

/**
 * Resolves a revision in the world's repository.
 * @param world - The world.
 * @param revision - The revision.
 * @returns The commit, empty when it does not resolve.
 */
export async function readRevision(world: World, revision: string): Promise<string> {
  return (await createTestPort(world).processes.run(['git', 'rev-parse', '--verify', '--quiet', revision], { timeoutMs: 5000 })).stdout
}
