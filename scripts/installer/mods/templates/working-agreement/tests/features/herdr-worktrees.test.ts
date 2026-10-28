import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { inside, readFlowStatus } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Graph, Options } from '../support/world'

/** A herdr worktree workspace as `herdr workspace list` reports it. */
interface Workspace { id: string; label: string; path: string }

const created = '/workspace/.worktrees/repo/worktree-oak'

/**
 * Answers herdr like a live server: `worktree create` with the checkout, and `workspace list` with these workspaces.
 * @param workspaces - The open worktree workspaces.
 * @returns The world's herdr reply.
 */
const herdrServer = (workspaces: Workspace[] = []): Options['herdrReply'] => args => {
  if (args[0] === 'worktree' && args[1] === 'create') return JSON.stringify({ result: { worktree: { path: created }, root_pane: { pane_id: 'w2:p1' } } })
  if (args[0] === 'workspace' && args[1] === 'list') {
    return JSON.stringify({ result: { workspaces: [{ workspace_id: 'w1', label: 'repo', worktree: { checkout_path: '/repo' } },
      ...workspaces.map(workspace => ({ workspace_id: workspace.id, label: workspace.label, worktree: { checkout_path: workspace.path } }))] } })
  }
  return '{}'
}

/**
 * Builds main with `worktree-done` on its tip and `worktree-ahead` one commit past it.
 * @returns The history.
 */
const subagentGraph = (): Graph => ({
  commits: { m0: { parents: [], files: {} }, a1: { parents: ['m0'], files: { a: '1' } } },
  refs: { main: 'm0', 'origin/main': 'm0', 'worktree-done': 'm0', 'worktree-dirty': 'm0', 'worktree-ahead': 'a1', 'worktree-other': 'm0' },
})

/**
 * Places the chat on main with one subagent worktree per case.
 * @returns The checkout.
 */
const subagentCheckout = (): Checkout => ({
  branch: 'main', graph: subagentGraph(),
  worktrees: { '/repo': { branch: 'main' }, '/wt/done': { branch: 'worktree-done' }, '/wt/dirty': { branch: 'worktree-dirty', isDirty: true },
    '/wt/ahead': { branch: 'worktree-ahead' }, '/wt/other': { branch: 'worktree-other' } },
})

const subagentWorkspaces: Workspace[] = [
  { id: 'w2', label: 'claude-sid:done', path: '/wt/done' }, { id: 'w3', label: 'claude-sid:dirty', path: '/wt/dirty' },
  { id: 'w4', label: 'claude-sid:ahead', path: '/wt/ahead' }, { id: 'w5', label: 'claude-ffff0000:other', path: '/wt/other' },
]

test('inside herdr a created worktree is a herdr workspace in the volume', async ($, on) => {
  const world = createWorld(on, { branch: 'main' }, { herdrEnv: inside, herdrReply: herdrServer() })
  const result = await $.classic.WorktreeCreate({ name: 'oak', cwd: '/repo' } as never)
  expect(result.worktreePath).toBe(created)
  expect(world.herdrCalls.map(call => call.argv)).toContainEqual(['herdr', 'worktree', 'create', '--cwd', '/repo', '--branch', 'worktree-oak',
    '--base', 'HEAD', '--label', 'claude-sid:oak', '--no-focus'])
})

for (const [name, options] of [['outside herdr', {}], ['when herdr fails', { herdrEnv: inside, herdrResult: { exitCode: 1, stderr: 'no server' } }]] as const) {
  test(`${name} the worktree is left to Claude Code's git default`, async ($, on) => {
    createWorld(on, { branch: 'main' }, { ...options, herdrReply: herdrServer() })
    expect((await $.classic.WorktreeCreate({ name: 'oak', cwd: '/repo' } as never)).worktreePath).toBeUndefined()
  })
}

test('a failed herdr worktree creation shows in the status', async ($, on) => {
  createWorld(on, { branch: 'main' }, { herdrEnv: inside, herdrResult: { exitCode: 1, stderr: 'no server' } })
  await $.classic.WorktreeCreate({ name: 'oak', cwd: '/repo' } as never)
  expect(await readFlowStatus($)).toContain('worktree create · ')
})

test('a mod-created worktree is removed through herdr, another one is not', async ($, on) => {
  const world = createWorld(on, subagentCheckout(), { herdrEnv: inside, herdrReply: herdrServer(subagentWorkspaces) })
  await $.classic.WorktreeRemove({ worktree_path: '/wt/done' } as never)
  await $.classic.WorktreeRemove({ worktree_path: '/elsewhere' } as never)
  expect(world.herdrCalls.map(call => call.argv.join(' ')).filter(argv => argv.startsWith('herdr worktree remove'))).toEqual(['herdr worktree remove --workspace w2 --force'])
  expect(world.runs).toContain('git branch -d worktree-done')
})

test('the stop sweep removes only this session\'s idle worktrees', async ($, on) => {
  const world = createWorld(on, subagentCheckout(), { herdrEnv: inside, herdrReply: herdrServer(subagentWorkspaces) })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  await world.clock.settle()
  expect(world.herdrCalls.map(call => call.argv.join(' ')).filter(argv => argv.startsWith('herdr worktree remove'))).toEqual(['herdr worktree remove --workspace w2'])
  expect(world.runs.filter(run => run.startsWith('git branch -d'))).toEqual(['git branch -d worktree-done'])
})

test('no sweep while a background subagent runs', async ($, on) => {
  const world = createWorld(on, subagentCheckout(), { herdrEnv: inside, herdrReply: herdrServer(subagentWorkspaces) })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [{ id: 'a1', type: 'subagent', status: 'running', description: 'x' }] } as never)
  await world.clock.settle()
  expect(world.herdrCalls.some(call => call.argv.includes('remove'))).toBe(false)
})

test('EnterWorktree is refused inside herdr only', async ($, on) => {
  createWorld(on, { branch: 'main' }, { herdrEnv: inside })
  const reason = (await $.tool.call({ tool: 'EnterWorktree', name: 'oak' } as never)).deny ?? ''
  expect(reason).toContain('herdr worktree create --branch <branch> --base HEAD --no-focus')
  expect(reason).toContain('herdr agent start issue-<n> --kind claude')
  expect(reason).toContain('herdr agent prompt issue-<n> "Work on issue #<n> on branch <branch>."')
})

test('EnterWorktree runs outside herdr', async ($, on) => {
  createWorld(on, { branch: 'main' })
  expect((await $.tool.call({ tool: 'EnterWorktree', name: 'oak' } as never)).deny).toBeUndefined()
})

test('a resumed session sweeps its idle worktrees at start', async ($, on) => {
  const world = createWorld(on, subagentCheckout(), { herdrEnv: inside, herdrReply: herdrServer(subagentWorkspaces) })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await world.clock.settle()
  expect(world.herdrCalls.map(call => call.argv.join(' ')).filter(argv => argv.startsWith('herdr worktree remove'))).toEqual(['herdr worktree remove --workspace w2'])
})
