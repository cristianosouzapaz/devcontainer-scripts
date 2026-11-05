import type { DialogKey } from '../domain/dialogs'
import { findWorktreeRoot } from '../lib/git'
import { isIssueNumber } from '../lib/guards'
import type { EnginePort } from './engine-port'
import { isInsideHerdr, listHerdrWorktrees, readField, runHerdr, runHerdrText } from './herdr-worktrees'

/** A spawned unit's workspace in its host. */
export interface UnitWorkspace { issue: number; workspaceId: string; path: string }

/** What starting a unit session needs: the coordinator's checkout, the unit, its branch, its workspace if one is open, and the claude arguments. */
interface StartRequest { root: string; issue: number; branch: string; workspace: UnitWorkspace | undefined; argv: string[] }

/**
 * The session host's lifecycle, the only part of a host the mod drives: no message ever travels through it.
 * The claude arguments a start carries are opaque to the host, which passes them on unchanged.
 */
export interface UnitHost {
  list: (port: EnginePort) => Promise<UnitWorkspace[]>
  state: (port: EnginePort, workspace: UnitWorkspace | undefined, idleWaitMs: number) => Promise<SessionState>
  isBlocked: (port: EnginePort, workspace: UnitWorkspace) => Promise<boolean>
  start: (port: EnginePort, request: StartRequest) => Promise<void>
  name: (port: EnginePort, workspace: UnitWorkspace) => Promise<void>
  close: (port: EnginePort, workspace: UnitWorkspace) => Promise<void>
  screen: (port: EnginePort, workspace: UnitWorkspace) => Promise<string>
  keys: (port: EnginePort, workspace: UnitWorkspace, key: DialogKey) => Promise<void>
}

/** Whether a unit's session runs, and if so whether it is ready for input; a session whose activity was not asked for reads as working. */
type SessionState = 'none' | 'idle' | 'working'

/** Every spawned workspace's label is this followed by the issue number; the cap counts them. */
const labelPrefix = 'wa-spawn:'
const agentStartTimeoutMs = 60000
const blockedWaitMs = 1000

/**
 * herdr as the session host: a labelled worktree workspace per unit, its session an agent in that workspace's pane. A unit is addressed by
 * that pane, since herdr names an agent only when its start wait succeeds, and a slow start leaves a running session unnamed.
 */
const herdrHost: UnitHost = {
  list: async port => (await listHerdrWorktrees(port, labelPrefix)).flatMap(({ name, workspaceId, path }) =>
    isIssueNumber(Number(name)) ? [{ issue: Number(name), workspaceId, path }] : []),
  state: async (port, workspace, idleWaitMs) => {
    const pane = workspace ? (await listLivePanes(port, workspace.workspaceId)).find(hasAgent) : undefined
    if (!pane) return 'none'
    if (idleWaitMs <= 0) return 'working'
    const isIdle = await runHerdrText(port, ['agent', 'wait', String(readField(pane, 'pane_id')), '--until', 'idle', '--until', 'done', '--timeout', String(idleWaitMs)],
      idleWaitMs + 5000).then(() => true, () => false)
    return isIdle ? 'idle' : 'working'
  },
  // why: herdr's wait answers at once for a state already reached, so a short timeout reads the current state without polling.
  isBlocked: async (port, workspace) => {
    const pane = readField((await listLivePanes(port, workspace.workspaceId)).find(hasAgent), 'pane_id')
    if (typeof pane !== 'string') return false
    return runHerdrText(port, ['agent', 'wait', pane, '--until', 'blocked', '--timeout', String(blockedWaitMs)], blockedWaitMs + 5000).then(() => true, () => false)
  },
  start: async (port, { root, issue, branch, workspace, argv }) => {
    const pane = workspace ? await findIdlePane(port, workspace.workspaceId) : await openWorktree(port, root, issue, branch)
    await runHerdrText(port, ['agent', 'start', unitAgent(issue), '--kind', 'claude', '--pane', pane, '--timeout', String(agentStartTimeoutMs), '--', ...argv],
      agentStartTimeoutMs + 15000)
  },
  // why: herdr names an agent only when its start wait succeeds; a rename of the agent in the pane names one that wait missed.
  name: async (port, workspace) => {
    const pane = readField((await listLivePanes(port, workspace.workspaceId)).find(hasAgent), 'pane_id')
    if (typeof pane === 'string') await runHerdrText(port, ['agent', 'rename', pane, unitAgent(workspace.issue)]).catch(() => undefined)
  },
  close: async (port, workspace) => {
    await runHerdrText(port, ['workspace', 'close', workspace.workspaceId])
  },
  // why: a dialog is always on the visible screen, which herdr reads in every state, where a longer read needs the unit idle.
  screen: async (port, workspace) => runHerdrText(port, ['agent', 'read', await readAgentPane(port, workspace), '--source', 'visible']),
  keys: async (port, workspace, key) => {
    await runHerdrText(port, ['agent', 'send-keys', await readAgentPane(port, workspace), { Escape: 'esc' }[key]])
  },
}

/**
 * Names the herdr agent of an issue's unit session.
 * @param issue - The issue number.
 * @returns The name herdr gives the agent when its start wait succeeds, and the target of a unit whose pane is not found.
 */
export function unitAgent(issue: number): string {
  return `issue-${issue}`
}

/**
 * Names the herdr target of an issue's unit session: the pane its agent runs in, whatever name herdr gave it.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns The pane, or the agent name when no unit workspace holds a running agent.
 */
export async function readUnitTarget(port: EnginePort, issue: number): Promise<string> {
  const workspace = (await herdrHost.list(port)).find(each => each.issue === issue)
  const pane = workspace ? readField((await listLivePanes(port, workspace.workspaceId)).find(hasAgent), 'pane_id') : undefined
  return typeof pane === 'string' ? pane : unitAgent(issue)
}

/**
 * Picks the host unit sessions run in.
 * @param port - The engine calls.
 * @returns herdr when this session runs inside it, else null: without a host no unit starts.
 */
export async function readUnitHost(port: EnginePort): Promise<UnitHost | null> {
  return await isInsideHerdr(port) ? herdrHost : null
}

/**
 * Finds the pane a unit's session runs in.
 * @param port - The engine calls.
 * @param workspace - The unit's workspace.
 * @returns The pane.
 * @throws When no pane of the workspace runs an agent.
 */
async function readAgentPane(port: EnginePort, workspace: UnitWorkspace): Promise<string> {
  const pane = readField((await listLivePanes(port, workspace.workspaceId)).find(hasAgent), 'pane_id')
  if (typeof pane !== 'string') throw new Error(`no pane of workspace ${workspace.workspaceId} runs #${workspace.issue}'s session`)
  return pane
}

/**
 * Opens the unit's worktree as a labelled herdr workspace: the checkout git already lists, or a new one on the branch.
 * @param port - The engine calls.
 * @param root - The coordinator's checkout.
 * @param issue - The issue number.
 * @param branch - The unit branch.
 * @returns The workspace's root pane.
 * @throws When herdr fails or names no pane.
 */
async function openWorktree(port: EnginePort, root: string, issue: number, branch: string): Promise<string> {
  const path = await findWorktreeRoot(port.processes, branch)
  const label = ['--label', `${labelPrefix}${issue}`, '--no-focus']
  const reply = await runHerdr(port, path
    ? ['worktree', 'open', '--cwd', root, '--path', path, ...label]
    : ['worktree', 'create', '--cwd', root, '--branch', branch, '--base', branch, ...label])
  const pane = readField(reply, 'result', 'root_pane', 'pane_id')
  if (typeof pane !== 'string') throw new Error('herdr named no pane for the worktree')
  return pane
}

/**
 * Finds the pane of the unit's workspace to start its session in.
 * @param port - The engine calls.
 * @param workspaceId - The unit's workspace.
 * @returns The pane.
 * @throws When herdr fails or lists no pane.
 */
async function findIdlePane(port: EnginePort, workspaceId: string): Promise<string> {
  const pane = readField((await listPanes(port, workspaceId))[0], 'pane_id')
  if (typeof pane !== 'string') throw new Error(`herdr lists no pane in workspace ${workspaceId}`)
  return pane
}

/**
 * Lists a unit workspace's panes; a workspace closed since it was listed has none.
 * @param port - The engine calls.
 * @param workspaceId - The workspace.
 * @returns The panes, empty when the workspace is gone.
 * @throws When herdr fails while the workspace still exists.
 */
async function listLivePanes(port: EnginePort, workspaceId: string): Promise<unknown[]> {
  try {
    return await listPanes(port, workspaceId)
  } catch (error) {
    if ((await herdrHost.list(port)).some(workspace => workspace.workspaceId === workspaceId)) throw error
    return []
  }
}

/**
 * Lists a workspace's panes as herdr reports them.
 * @param port - The engine calls.
 * @param workspaceId - The workspace.
 * @returns The panes, empty when herdr names none.
 * @throws When herdr fails.
 */
async function listPanes(port: EnginePort, workspaceId: string): Promise<unknown[]> {
  const panes = readField(await runHerdr(port, ['pane', 'list', '--workspace', workspaceId]), 'result', 'panes')
  return Array.isArray(panes) ? panes as unknown[] : []
}

/**
 * Tells whether an agent runs in a pane.
 * @param pane - The pane as herdr reports it.
 * @returns Whether herdr names its agent.
 */
function hasAgent(pane: unknown): boolean {
  return typeof readField(pane, 'agent') === 'string'
}
