import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

import { coordinator, noFlow } from '../support/builders'
import { callModTool, inside } from '../support/helpers'
import { test } from '../support/kit'
import { createTestPort, createWorld, records } from '../support/world'
import type { Checkout, Options, World } from '../support/world'

/** A herdr workspace the fake server holds: its label, checkout and whether an agent runs in its pane. */
interface Workspace { id: string; label: string; path: string; hasAgent?: boolean }

/** An issue as the spawn's GitHub read returns it. */
interface Issue { state?: string; title?: string; blockedBy?: { number: number; state: string }[] }


/**
 * Answers herdr like a live server that keeps the workspaces it opens.
 * @param workspaces - The open workspaces, changed as the server opens worktrees and starts agents.
 * @returns The world's herdr reply.
 */
const herdrServer = (workspaces: Workspace[]): Options['herdrReply'] => args => {
  const [noun, verb] = args
  const option = (name: string) => args[args.indexOf(name) + 1] ?? ''
  if (noun === 'workspace' && verb === 'list') {
    return JSON.stringify({ result: { workspaces: workspaces.map(each => ({ workspace_id: each.id, label: each.label, worktree: { checkout_path: each.path } })) } })
  }
  if (noun === 'worktree') {
    const opened = { id: `w${workspaces.length + 10}`, label: option('--label'), path: verb === 'open' ? option('--path') : `/wt/${option('--branch')}` }
    workspaces.push(opened)
    return JSON.stringify({ result: { root_pane: { pane_id: `${opened.id}:p1` } } })
  }
  if (noun === 'pane' && verb === 'list') {
    const workspace = workspaces.find(each => each.id === option('--workspace'))
    return JSON.stringify({ result: { panes: [{ pane_id: `${workspace?.id}:p1`, ...(workspace?.hasAgent ? { agent: 'claude' } : {}) }] } })
  }
  if (noun === 'agent' && verb === 'start') {
    const workspace = workspaces.find(each => option('--pane').startsWith(`${each.id}:`))
    if (workspace) workspace.hasAgent = true
  }
  if (noun === 'agent' && verb === 'read') return 'unit output'
  return '{}'
}

/**
 * Answers the spawn's issue read for these issues.
 * @param issues - The issues by number.
 * @returns The world's gh answer.
 */
const github = (issues: Record<number, Issue>): Options['gh'] => args => {
  const query = args.find(arg => arg.startsWith('query=') && arg.includes('blockedBy(first:50){nodes{number state}}'))
  const number = Number(query?.match(/issue\(number:(\d+)\)/)?.[1])
  const issue = issues[number]
  if (!query || !issue) return undefined
  return { stdout: JSON.stringify({ data: { repository: { issue: { state: issue.state ?? 'OPEN', title: issue.title ?? 'feat(mod): spawn a unit',
    blockedBy: { nodes: issue.blockedBy ?? [] } } } } }) }
}

/**
 * Builds main and origin/main on m0, with #7's branch one commit past it and #8's branch level with it.
 * @param worktrees - Extra checkouts git lists.
 * @returns The checkout of the coordinator on main.
 */
const repository = (worktrees: Checkout['worktrees'] = {}): Checkout => ({
  branch: 'main',
  graph: { commits: { m0: { parents: [], files: {} }, p1: { parents: ['m0'], files: { a: '1' } } },
    refs: { main: 'm0', 'origin/main': 'm0', '7-parent-work': 'p1', '8-idle-parent': 'm0', ...Object.fromEntries(Object.values(worktrees).map(each => [each.branch, 'm0'])) } },
  worktrees: { '/repo': { branch: 'main' }, ...worktrees },
})

/**
 * Creates a coordinator world inside herdr.
 * @param on - The test's hook registration.
 * @param workspaces - The herdr workspaces already open.
 * @param issues - The issues GitHub knows.
 * @param options - Options replacing the coordinator defaults.
 * @param checkout - The repository.
 * @returns The world.
 */
const createSpawnWorld = (on: On, workspaces: Workspace[], issues: Record<number, Issue>, options: Options = {},
  checkout = repository()): World => createWorld(on, checkout, { session: coordinator, herdrEnv: inside, herdrReply: herdrServer(workspaces), gh: github(issues), ...options })

/**
 * Lists the herdr commands a world ran, as text.
 * @param world - The world.
 * @param prefix - The leading words kept.
 * @returns The matching command lines.
 */
const herdrRuns = (world: World, prefix: string): string[] => world.herdrCalls.map(call => call.argv.join(' ')).filter(line => line.startsWith(`herdr ${prefix}`))

/**
 * Reads where a branch points in the world's repository.
 * @param world - The world.
 * @param branch - The branch.
 * @returns The commit, empty when it does not exist.
 */
async function readBranch(world: World, branch: string): Promise<string> {
  return (await createTestPort(world).processes.run(['git', 'rev-parse', '--verify', '--quiet', branch], { timeoutMs: 5000 })).stdout
}

test('spawn is refused outside a coordinator session and outside herdr', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} }, { session: noFlow })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('only a coordinator'), isError: true })
  expect(herdrRuns(world, '')).toEqual([])
})

test('spawn outside herdr names herdr', async ($, on) => {
  createSpawnWorld(on, [], { 12: {} }, { herdrEnv: {} })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('herdr'), isError: true })
})

test('a fresh issue gets its branch from the default branch, a labelled worktree and a started, prompted session', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: { title: 'feat(mod): Spawn a unit!' } })
  const outcome = await callModTool($, 'spawn', { number: 12 })
  expect(outcome).toEqual({ text: expect.stringContaining('started'), isError: false })
  expect(await readBranch(world, '12-spawn-a-unit')).toBe('m0')
  expect(herdrRuns(world, 'worktree create')[0]).toContain('--branch 12-spawn-a-unit')
  expect(herdrRuns(world, 'worktree create')[0]).toContain('--label wa-spawn:12')
  expect(herdrRuns(world, 'agent start')[0]).toMatch(/^herdr agent start issue-12 .* -- --session-id [0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(herdrRuns(world, 'agent prompt issue-12')[0]).toContain('#12')
})

test('a live spawn lock is waited on, never broken, and a stale one is broken', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await world.ready
  world.files.set(`${records}/spawn/lock/held`, '')
  world.modified.set(`${records}/spawn/lock`, world.clock.now())
  const waiting = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(31000)
  expect(await waiting).toEqual({ text: expect.stringContaining('another spawn holds the lock'), isError: true })
  world.modified.set(`${records}/spawn/lock`, world.clock.now() - 121000)
  const breaking = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(1000)
  expect((await breaking).text).toContain('started')
})

test('a blocked issue starts from its dependency\'s branch once that branch has a commit', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: 7, state: 'OPEN' }, { number: 3, state: 'CLOSED' }] } })
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  expect(await readBranch(world, '12-spawn-a-unit')).toBe('p1')
})

for (const [name, blocker, waitsFor] of [['has no commit past the default branch', 8, '8-idle-parent'], ['has no branch', 9, '#9']] as const) {
  test(`a blocked issue whose dependency ${name} says what it waits for and starts nothing`, async ($, on) => {
    const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: blocker, state: 'OPEN' }] } })
    expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining(waitsFor), isError: true })
    expect(await readBranch(world, '12-spawn-a-unit')).toBe('')
    expect(herdrRuns(world, 'worktree')).toEqual([])
  })
}

test('spawn again reuses the live session and starts nothing', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await callModTool($, 'spawn', { number: 12 })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('already runs'), isError: false })
  expect(herdrRuns(world, 'worktree')).toHaveLength(1)
  expect(herdrRuns(world, 'agent start')).toHaveLength(1)
  expect(herdrRuns(world, 'agent prompt')).toHaveLength(1)
})

test('a worktree without a session is reopened and resumes the session it started, without a new start prompt', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, {}, checkout)
  await callModTool($, 'spawn', { number: 12 })
  const sessionId = herdrRuns(world, 'agent start')[0]?.split(' ').at(-1)
  // The user closed the workspace; git still lists the checkout.
  workspaces.length = 0
  checkout.worktrees = { ...checkout.worktrees, '/wt/12-spawn-a-unit': { branch: '12-spawn-a-unit' } }
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('resumed'), isError: false })
  expect(herdrRuns(world, 'worktree open')[0]).toContain('--path /wt/12-spawn-a-unit')
  expect(herdrRuns(world, 'agent start')[1]).toContain(`-- --resume ${sessionId}`)
  expect(herdrRuns(world, 'agent prompt')).toHaveLength(1)
})

test('a unit workspace whose session ended gets its session back in its own pane', async ($, on) => {
  const world = createSpawnWorld(on, [{ id: 'w5', label: 'wa-spawn:12', path: '/wt/12-spawn-a-unit' }], {}, {},
    repository({ '/wt/12-spawn-a-unit': { branch: '12-spawn-a-unit' } }))
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  expect(herdrRuns(world, 'worktree')).toEqual([])
  expect(herdrRuns(world, 'agent start')[0]).toContain('--pane w5:p1')
})

test('beyond the cap spawn refuses and names the running units, while a running one is still reused', async ($, on) => {
  const running = [1, 2, 3, 4].map(issue => ({ id: `w${issue}`, label: `wa-spawn:${issue}`, path: `/wt/${issue}`, hasAgent: true }))
  const world = createSpawnWorld(on, running, { 12: {} })
  const outcome = await callModTool($, 'spawn', { number: 12 })
  expect(outcome.isError).toBe(true)
  for (const issue of [1, 2, 3, 4]) expect(outcome.text).toContain(`#${issue}`)
  expect(await readBranch(world, '12-spawn-a-unit')).toBe('')
  expect(await callModTool($, 'spawn', { number: 3 })).toEqual({ text: expect.stringContaining('already runs'), isError: false })
})

test('the coordinator messages and reads a unit through the mod, and no other session can', async ($, on) => {
  const world = createSpawnWorld(on, [], {})
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Take option A.' })).isError).toBe(false)
  expect(herdrRuns(world, 'agent prompt')).toEqual(['herdr agent prompt issue-12 -- Take option A.'])
  expect(await callModTool($, 'unit_read', { number: 12 })).toEqual({ text: 'unit output', isError: false })
})

test('a session without the coordinator role cannot message a unit', async ($, on) => {
  const world = createSpawnWorld(on, [], {}, { session: noFlow })
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'x' })).isError).toBe(true)
  expect(herdrRuns(world, 'agent')).toEqual([])
})

test('unit_read refuses a line count that is not a whole number from 1 to 500', async ($, on) => {
  createSpawnWorld(on, [], { 12: {} })
  for (const lines of [1.5, 0, 501]) expect((await callModTool($, 'unit_read', { number: 12, lines })).text).toContain('lines must be a whole number')
})
