import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { coveredSkips, seedUnit } from '../support/parallel-worktrees'

import { createEmptySession } from '../../hooks/domain/records'
import { coordinator, noFlow } from '../support/builders'
import { callModTool, declareFlow, inside, readPromptContext, readRevision, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { buildScope, coordinatorHost, createWorld, placedFile, records, scopeFile } from '../support/world'
import type { Checkout, Options, World } from '../support/world'

/** A herdr workspace the fake server holds: its label, checkout and whether an agent runs in its pane. */
interface Workspace { id: string; label: string; path: string; hasAgent?: boolean }

/** An issue as the spawn's GitHub read returns it. */
interface Issue { state?: string; title?: string; labels?: string[]; parent?: number; blockedBy?: { number: number; state: string }[] }

/** The unit agent's input box: the submits it misses before it takes one, the prompts it loses before it shows one, the text typed and unsent, the prompts it took and whether it works. */
interface Agent { misses: number; drops?: number; typed: string; received: string[]; isWorking: boolean }

/** The model and effort a unit is spawned on, with the reason for them. */
interface Level { model?: string; effort?: string; reason: string }

/** A spawned unit: the world, its agent and the herdr workspaces. */
interface SpawnedUnit { world: World; agent: Agent; workspaces: Workspace[] }

/** A Verify run's outcome. */
type VerifyKind = 'pass' | 'fail'

/**
 * Answers herdr like a live server that keeps the workspaces it opens.
 * @param workspaces - The open workspaces, changed as the server opens worktrees and starts agents.
 * @param agent - The unit agent, whose submits miss while it is not ready.
 * @returns The world's herdr reply.
 */
const herdrServer = (workspaces: Workspace[], agent: Agent = { misses: 0, typed: '', received: [], isWorking: false }): Options['herdrReply'] => args => {
  const [noun, verb] = args
  const option = (name: string) => args[args.indexOf(name) + 1] ?? ''
  const submit = (): boolean => {
    if (agent.misses > 0) {
      agent.misses -= 1
      return false
    }
    agent.received.push(agent.typed)
    agent.typed = ''
    agent.isWorking = true
    return true
  }
  // why: claude takes /exit from the input box and leaves its pane to the shell.
  if (noun === 'agent' && verb === 'prompt' && args[3] === '/exit') {
    const workspace = workspaces.find(each => each.label === `wa-spawn:${args[2]?.replace('issue-', '')}`)
    if (workspace) workspace.hasAgent = false
    agent.isWorking = false
    return '{}'
  }
  if (noun === 'agent' && verb === 'prompt') {
    // why: a prompt sent before the TUI is ready never reaches its input box.
    if (agent.drops) {
      agent.drops -= 1
      return { exitCode: 1, stderr: 'agent_prompt_stalled' }
    }
    agent.typed += args[3] ?? ''
    // why: herdr 0.9.5 fails a waited prompt that saw no working or blocked state within 5s with agent_prompt_stalled, leaving the text typed.
    return submit() || !args.includes('--wait') ? '{}' : { exitCode: 1, stderr: 'agent_prompt_stalled' }
  }
  if (noun === 'agent' && verb === 'send-keys') {
    if (args.includes('Enter') && agent.typed) submit()
    return '{}'
  }
  if (noun === 'agent' && verb === 'wait') return agent.isWorking === !args.includes('idle') ? '{}' : { exitCode: 1, stderr: 'timeout' }
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
  if (noun === 'agent' && verb === 'read') return option('--source') === 'visible' ? `> ${agent.typed}\n? for shortcuts` : 'unit output'
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
    labels: { nodes: (issue.labels ?? ['ready-for-agent']).map(name => ({ name })) }, parent: issue.parent ? { number: issue.parent } : null, blockedBy: { nodes: issue.blockedBy ?? [] } } } } }) }
}

/**
 * Builds main and origin/main on m0, with #7's typed branch one commit past it and #8's untyped branch level with it.
 * @param worktrees - Extra checkouts git lists.
 * @returns The checkout of the coordinator on main.
 */
const repository = (worktrees: Checkout['worktrees'] = {}): Checkout => ({
  branch: 'main',
  graph: { commits: { m0: { parents: [], files: {} }, p1: { parents: ['m0'], files: { a: '1' } } },
    refs: { main: 'm0', 'origin/main': 'm0', 'feat/7-parent-work': 'p1', '8-idle-parent': 'm0', ...Object.fromEntries(Object.values(worktrees).map(each => [each.branch, 'm0'])) } },
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
 * Seeds the unit session of #12 on its spawned branch with these Verify outcomes, newest first.
 * @param world - The world.
 * @param outcomes - Each run's outcome.
 */
async function seedVerifies(world: World, outcomes: VerifyKind[]): Promise<void> {
  const verifyRuns = outcomes.map((kind, index) => ({ tree: `t${index}`, base: 'm0', configBlob: 'c', commands: [['t']], runId: `r${index}`, at: 1000 - index,
    outcome: kind === 'pass' ? { kind } : { kind, code: 1, signal: null } }))
  await seedUnit(world, 'unit-12', { branch: 'feat/12-spawn-a-unit', issues: [12] }, { verifyRuns })
}

/**
 * Starts #12 on a cheap level under a scope that delegates it, its agent idle after the start prompt.
 * @param $ - The test's engine.
 * @param on - The test's hook registration.
 * @param level - The model and effort, with the reason.
 * @returns The world, the agent and the unit's workspaces.
 */
async function spawnCheap($: Engine, on: On, level: Level = { model: 'haiku', effort: 'low', reason: 'a typo fix' }): Promise<SpawnedUnit> {
  const workspaces: Workspace[] = []
  const agent: Agent = { misses: 0, typed: '', received: [], isWorking: false }
  const world = createSpawnWorld(on, workspaces, { 12: {} }, { herdrReply: herdrServer(workspaces, agent) })
  await world.ready
  world.files.set(scopeFile('sid'), buildScope('sid', [12]))
  expect((await callModTool($, 'spawn', { number: 12, ...level })).isError).toBe(false)
  agent.isWorking = false
  return { world, agent, workspaces }
}

/**
 * Reads the spawn record of an issue's unit.
 * @param world - The world.
 * @param issue - The issue.
 * @returns The record's fields, none when spawn wrote none.
 */
const readSpawnRecord = (world: World, issue: number): Record<string, unknown> => JSON.parse(world.files.get(`${records}/spawn/${issue}.json`) ?? '{}')

/**
 * Seeds the unit session of an issue's branch as finished: every step before Commit covered, its worktree clean.
 * @param world - The world.
 * @param checkout - The repository, given the branch's worktree.
 * @param branch - The unit branch.
 * @param issue - The issue number.
 */
async function seedFinishedUnit(world: World, checkout: Checkout, branch: string, issue: number): Promise<void> {
  await world.ready
  checkout.worktrees = { ...checkout.worktrees, [`/wt/${branch}`]: { branch } }
  await seedUnit(world, `unit-${issue}`, { branch, issues: [issue] }, { skips: coveredSkips(), base: 'm0', baseBranch: 'main' })
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
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('m0')
  expect(world.files.has(placedFile('feat/12-spawn-a-unit', 'm0'))).toBe(true)
  expect(herdrRuns(world, 'worktree create')[0]).toContain('--branch feat/12-spawn-a-unit')
  expect(herdrRuns(world, 'worktree create')[0]).toContain('--label wa-spawn:12')
  expect(herdrRuns(world, 'agent start')[0]).toMatch(/^herdr agent start issue-12 .* -- --permission-mode default --session-id [0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(herdrRuns(world, 'agent prompt issue-12')[0]).toContain('#12')
})

test('the coordinator\'s instructions end the start prompt verbatim under their heading, and only text is taken', async ($, on) => {
  const agent: Agent = { misses: 0, typed: '', received: [], isWorking: false }
  createSpawnWorld(on, [], { 12: {} }, { herdrReply: herdrServer([], agent) })
  expect(await callModTool($, 'spawn', { number: 12, instructions: 42 })).toEqual({ text: expect.stringContaining('instructions must be text'), isError: true })
  expect((await callModTool($, 'spawn', { number: 12, instructions: 'ask before a suite run:\n  verify waits for my go' })).isError).toBe(false)
  expect(agent.received).toEqual([expect.stringMatching(/ worktree\. The coordinator is herdr pane [^\n]+\.\n\nUser's instructions:\nask before a suite run:\n {2}verify waits for my go$/)])
})

test('instructions for a unit already prompted are not sent, and the result says to send them with unit_prompt', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await callModTool($, 'spawn', { number: 12 })
  expect(await callModTool($, 'spawn', { number: 12, instructions: 'no verify' })).toEqual({ text: expect.stringContaining('send them with unit_prompt'), isError: false })
  expect(herdrRuns(world, 'agent prompt')).toHaveLength(1)
  expect(herdrRuns(world, 'agent prompt')[0]).not.toContain("User's instructions")
})

test('a title without a Conventional prefix gives an untyped branch, and another issue\'s branch is never taken for it', async ($, on) => {
  const world = createSpawnWorld(on, [], { 2: { title: 'Spawn a unit' } }, {},
    repository({ '/wt/12-spawn-a-unit': { branch: '12-spawn-a-unit' }, '/wt/fix/12-other': { branch: 'fix/12-other' } }))
  expect((await callModTool($, 'spawn', { number: 2 })).isError).toBe(false)
  expect(await readRevision(world, '2-spawn-a-unit')).toBe('m0')
})

for (const labels of [['needs-triage'], ['needs-info'], ['ready-for-human'], []]) {
  test(`an issue labelled ${labels[0] ?? 'with no triage label'} is refused by name and gets no unit`, async ($, on) => {
    const world = createSpawnWorld(on, [], { 12: { labels } })
    expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining(`#12 is ${labels[0] ?? 'not triaged'}`), isError: true })
    expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('')
    expect(herdrRuns(world, 'worktree')).toEqual([])
  })
}

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

test('a blocked issue starts from its dependency\'s branch once its dependency\'s unit is finished', async ($, on) => {
  const checkout = repository()
  const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: 7, state: 'OPEN' }, { number: 3, state: 'CLOSED' }] } }, {}, checkout)
  await seedFinishedUnit(world, checkout, 'feat/7-parent-work', 7)
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('p1')
})

test('a blocked issue whose dependency\'s unit has no commit of its own waits for it, however far its steps went', async ($, on) => {
  const checkout = repository()
  const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: 8, state: 'OPEN' }] } }, {}, checkout)
  await seedFinishedUnit(world, checkout, '8-idle-parent', 8)
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('#12 waits: #8\'s unit is working'), isError: true })
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('')
})

for (const [name, blockedBy, parent, base] of [
  ['a child spawned from its dependency\'s branch declares that branch as its parent', [{ number: 7, state: 'OPEN' }], 'feat/7-parent-work', 'p1'],
  ['a unit spawned with no dependency declares the default branch as its parent', [], 'main', 'm0'],
] as const) {
  test(name, async ($, on) => {
    const checkout = repository()
    const world = createSpawnWorld(on, [], { 12: { blockedBy: [...blockedBy] } }, {}, checkout)
    if (blockedBy.length) await seedFinishedUnit(world, checkout, parent, 7)
    expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
    // The unit's own session starts in the new worktree, on the spawned branch.
    checkout.branch = 'feat/12-spawn-a-unit'
    checkout.worktrees = { ...checkout.worktrees, '/repo': { branch: checkout.branch } }
    world.chat.id = 'unit'
    world.seedChat('unit', { ...createEmptySession('unit'), info: { 12: { title: 'feat(mod): spawn a unit', labels: ['ready-for-agent'] } } })
    await declareFlow($, 'small-feature', [12])
    expect(world.sessions.get('unit')?.units[0]).toMatchObject({ baseBranch: parent, base })
  })
}

for (const [name, refs, base, parent] of [
  ['a child of a dependency its parent was just fast-forwarded to starts from that parent and declares it as its parent',
    { 'feat/7-parent-work': 'p1', 'feat/5-collect': 'p1' }, 'p1', 'feat/5-collect'],
  ['a child of a dependency fast-forwarded into its parent starts from that parent\'s tip and declares it as its parent',
    { 'feat/7-parent-work': 'p1', 'feat/5-collect': 'c2' }, 'c2', 'feat/5-collect'],
  ['a child of a dependency merged into its parent with a merge commit starts from that parent\'s tip and declares it as its parent',
    { 'feat/7-parent-work': 'p1', 'feat/5-collect': 'c4' }, 'c4', 'feat/5-collect'],
  ['a child of a dependency not yet integrated into its parent starts from the dependency\'s branch',
    { 'feat/7-parent-work': 'p2', 'feat/5-collect': 'c2' }, 'p2', 'feat/7-parent-work'],
] as const) {
  test(name, async ($, on) => {
    const { graph } = repository()
    const checkout = repository()
    // #7 was cut from the collecting branch #5 and worked on; #5 took it by fast-forward (c2 follows p1) or by a merge
    // commit after moving on (c3 merges c1 and p1), then moved on past it.
    checkout.graph = { ...graph, commits: { ...graph?.commits, c2: { parents: ['p1'], files: { a: '1', c: '1' } }, p2: { parents: ['p1'], files: { a: '2' } },
      c1: { parents: ['m0'], files: { b: '1' } }, c3: { parents: ['c1', 'p1'], files: { a: '1', b: '1' } }, c4: { parents: ['c3'], files: { a: '1', b: '1', c: '1' } } },
      refs: { ...graph?.refs, ...refs }, created: { 'feat/7-parent-work': 'feat/5-collect' }, moved: ['feat/7-parent-work'] }
    const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: 7, state: 'OPEN' }] } }, {}, checkout)
    if (parent === 'feat/7-parent-work') await seedFinishedUnit(world, checkout, parent, 7)
    expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
    expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe(base)
    checkout.branch = 'feat/12-spawn-a-unit'
    checkout.worktrees = { ...checkout.worktrees, '/repo': { branch: checkout.branch } }
    world.chat.id = 'unit'
    world.seedChat('unit', { ...createEmptySession('unit'), info: { 12: { title: 'feat(mod): spawn a unit', labels: ['ready-for-agent'] } } })
    await declareFlow($, 'small-feature', [12])
    expect(world.sessions.get('unit')?.units[0]).toMatchObject({ baseBranch: parent, base })
  })
}

for (const [name, blockedBy] of [
  ['a sub-issue of an issue with a unit branch starts from that branch\'s tip and declares it as its parent', []],
  ['a sub-issue blocked by its own parent starts from the parent\'s tip, since the parent is where it lands, not what it waits for', [{ number: 5, state: 'OPEN' }]],
] as const) {
  test(name, async ($, on) => {
    const { graph } = repository()
    const checkout = repository()
    // #5's integration branch has moved past main; its own unit is still working.
    checkout.graph = { ...graph, commits: { ...graph?.commits, c2: { parents: ['p1'], files: { a: '1', c: '1' } } }, refs: { ...graph?.refs, 'chore/5-integrate': 'c2' } }
    const world = createSpawnWorld(on, [], { 12: { parent: 5, blockedBy: [...blockedBy] } }, {}, checkout)
    await world.ready
    world.files.set(scopeFile('sid'), buildScope('sid', [12]))
    expect((await callModTool($, 'plan')).text).toContain('can start now from chore/5-integrate')
    expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
    expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('c2')
    checkout.branch = 'feat/12-spawn-a-unit'
    checkout.worktrees = { ...checkout.worktrees, '/repo': { branch: checkout.branch } }
    world.chat.id = 'unit'
    world.seedChat('unit', { ...createEmptySession('unit'), info: { 12: { title: 'feat(mod): spawn a unit', labels: ['ready-for-agent'] } } })
    await declareFlow($, 'small-feature', [12])
    expect(world.sessions.get('unit')?.units[0]).toMatchObject({ baseBranch: 'chore/5-integrate', base: 'c2' })
  })
}

test('a blocked issue whose dependency\'s unit is still working says what it waits for and starts nothing', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: 7, state: 'OPEN' }] } })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('#12 waits: #7\'s unit is working'), isError: true })
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('')
  expect(herdrRuns(world, 'worktree')).toEqual([])
})

test('a blocked issue whose dependency has no branch says what it waits for and starts nothing', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: 9, state: 'OPEN' }] } })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('#9'), isError: true })
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('')
  expect(herdrRuns(world, 'worktree')).toEqual([])
})

test('spawn again reuses the live session and starts nothing', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await callModTool($, 'spawn', { number: 12 })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('already runs'), isError: false })
  expect(herdrRuns(world, 'worktree')).toHaveLength(1)
  expect(herdrRuns(world, 'agent start')).toHaveLength(1)
  expect(herdrRuns(world, 'agent prompt')).toHaveLength(1)
})

test('spawn of a live unit whose start prompt was never sent sends it now', async ($, on) => {
  const world = createSpawnWorld(on, [{ id: 'w5', label: 'wa-spawn:12', path: '/wt/12-spawn-a-unit', hasAgent: true }], {}, {},
    repository({ '/wt/12-spawn-a-unit': { branch: '12-spawn-a-unit' } }))
  await world.ready
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ isStarted: true, isPrompted: false }))
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('start prompt is sent now'), isError: false })
  expect(herdrRuns(world, 'agent start')).toEqual([])
  expect(herdrRuns(world, 'agent prompt issue-12 Work on issue #12')).toHaveLength(1)
  expect((await callModTool($, 'spawn', { number: 12 })).text).toMatch(/already runs .* in \/wt\/12-spawn-a-unit\.$/)
  expect(herdrRuns(world, 'agent prompt')).toHaveLength(1)
})

test('a unit that misses its start prompt\'s submit gets one more Enter and takes the prompt once', async ($, on) => {
  const agent: Agent = { misses: 1, typed: '', received: [], isWorking: false }
  createSpawnWorld(on, [], { 12: {} }, { herdrReply: herdrServer([], agent) })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('started as herdr agent issue-12'), isError: false })
  expect(agent).toMatchObject({ isWorking: true, typed: '', received: [expect.stringMatching(/^Work on issue #12 /)] })
})

test('a unit that never takes its start prompt is reported, and a later spawn submits the typed prompt without typing it again', async ($, on) => {
  const agent: Agent = { misses: 5, typed: '', received: [], isWorking: false }
  createSpawnWorld(on, [], { 12: {} }, { herdrReply: herdrServer([], agent) })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('did not take its start prompt'), isError: true })
  agent.misses = 0
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('start prompt is sent now'), isError: false })
  expect(agent).toMatchObject({ isWorking: true, typed: '', received: [expect.stringMatching(/^Work on issue #12 /)] })
  expect(agent.received[0]?.match(/Work on issue/g)).toHaveLength(1)
})

test('a later spawn types the start prompt again when the unit lost it before its input box showed it', async ($, on) => {
  const agent: Agent = { misses: 0, drops: 1, typed: '', received: [], isWorking: false }
  createSpawnWorld(on, [], { 12: {} }, { herdrReply: herdrServer([], agent) })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('did not take its start prompt'), isError: true })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('start prompt is sent now'), isError: false })
  expect(agent).toMatchObject({ isWorking: true, typed: '', received: [expect.stringMatching(/^Work on issue #12 /)] })
  expect((await callModTool($, 'spawn', { number: 12 })).text).toMatch(/already runs .*\.$/)
})

test('a failing herdr call reports herdr\'s own error', async ($, on) => {
  createSpawnWorld(on, [], {}, { herdrResult: { exitCode: 2, stderr: 'agent_not_found' } })
  expect(await callModTool($, 'unit_prompt', { number: 12, text: '-x text' })).toEqual({ text: expect.stringContaining('exit 2: agent_not_found'), isError: true })
})

test('a worktree without a session is reopened and resumes the session it started, without a new start prompt', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, {}, checkout)
  await callModTool($, 'spawn', { number: 12 })
  const sessionId = herdrRuns(world, 'agent start')[0]?.split(' ').at(-1)
  // The user closed the workspace; git still lists the checkout.
  workspaces.length = 0
  checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('resumed'), isError: false })
  expect(herdrRuns(world, 'worktree open')[0]).toContain('--path /wt/feat/12-spawn-a-unit')
  expect(herdrRuns(world, 'agent start')[1]).toContain(`--resume ${sessionId}`)
  expect(herdrRuns(world, 'agent prompt')).toHaveLength(1)
})

test('a resumed unit\'s result says how far its branch is behind its parent\'s tip and that its worktree holds uncommitted changes', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const world = createSpawnWorld(on, workspaces, { 12: { blockedBy: [{ number: 7, state: 'OPEN' }] } }, {}, checkout)
  await seedFinishedUnit(world, checkout, 'feat/7-parent-work', 7)
  expect((await callModTool($, 'spawn', { number: 12 })).text).not.toContain('behind')
  workspaces.length = 0
  checkout.graph = { ...checkout.graph!, commits: { ...checkout.graph!.commits, p2: { parents: ['p1'], files: { a: '2' } } },
    refs: { ...checkout.graph!.refs, 'feat/7-parent-work': 'p2' } }
  checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit', isDirty: true } }
  const resumed = (await callModTool($, 'spawn', { number: 12 })).text
  expect(resumed).toContain('resumed')
  expect(resumed).toContain('feat/12-spawn-a-unit is 1 commit(s) behind feat/7-parent-work\'s tip')
  expect(resumed).toContain('/wt/feat/12-spawn-a-unit has uncommitted changes')
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
  const world = createSpawnWorld(on, running, { 12: {}, 3: {} })
  const outcome = await callModTool($, 'spawn', { number: 12 })
  expect(outcome.isError).toBe(true)
  for (const issue of [1, 2, 3, 4]) expect(outcome.text).toContain(`#${issue}`)
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('')
  expect(await callModTool($, 'spawn', { number: 3 })).toEqual({ text: expect.stringContaining('already runs'), isError: false })
})

test('the cap counts only live units still working: an integrated unit and a workspace whose session is gone free their slots', async ($, on) => {
  const { graph } = repository()
  const checkout = repository()
  checkout.graph = { ...graph, commits: { ...graph?.commits, c2: { parents: ['p1'], files: { a: '1', c: '1' } } },
    refs: { ...graph?.refs, 'feat/5-collect': 'c2' }, created: { 'feat/7-parent-work': 'feat/5-collect' }, moved: ['feat/7-parent-work'] }
  const gone = [1, 2, 3].map(issue => ({ id: `w${issue}`, label: `wa-spawn:${issue}`, path: `/wt/${issue}` }))
  const world = createSpawnWorld(on, [...gone, { id: 'w7', label: 'wa-spawn:7', path: '/wt/7', hasAgent: true }], { 12: {} }, {}, checkout)
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).not.toBe('')
})

test('a unit workspace closed while spawn counts the cap holds no slot, and spawn goes on', async ($, on) => {
  const live = [1, 2, 3, 4].map(issue => ({ id: `w${issue}`, label: `wa-spawn:${issue}`, path: `/wt/${issue}`, hasAgent: true }))
  const server = herdrServer(live) as NonNullable<Options['herdrReply']>
  const closed = { exitCode: 1, stdout: JSON.stringify({ error: { code: 'workspace_not_found', message: 'workspace w4 not found' } }) }
  // The user closes #4's workspace after spawn listed the workspaces, before it lists w4's panes.
  const close = (): typeof closed => {
    live.splice(live.findIndex(each => each.id === 'w4'), 1)
    return closed
  }
  const world = createSpawnWorld(on, live, { 12: {} }, { herdrReply: args => args.join(' ') === 'pane list --workspace w4' ? close() : server(args) })
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).not.toBe('')
})

test('the cap counts a live unit reopened on a branch its parent already holds, until its new work lands', async ($, on) => {
  const { graph } = repository()
  const checkout = repository()
  checkout.graph = { ...graph, commits: { ...graph?.commits, c2: { parents: ['p1'], files: { a: '1', c: '1' } } },
    refs: { ...graph?.refs, 'feat/5-collect': 'c2' }, created: { 'feat/7-parent-work': 'feat/5-collect' }, moved: ['feat/7-parent-work'] }
  checkout.worktrees = { ...checkout.worktrees, '/wt/7': { branch: 'feat/7-parent-work' } }
  const live = [1, 2, 3, 7].map(issue => ({ id: `w${issue}`, label: `wa-spawn:${issue}`, path: `/wt/${issue}`, hasAgent: true }))
  const world = createSpawnWorld(on, live, { 12: {} }, {}, checkout)
  await seedUnit(world, 'unit-7', { branch: 'feat/7-parent-work', issues: [7] }, { skips: [], base: 'p1', baseBranch: 'feat/5-collect' }, 'fix')
  const outcome = await callModTool($, 'spawn', { number: 12 })
  expect(outcome).toEqual({ text: expect.stringContaining('#7 (/wt/7)'), isError: true })
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('')
})

test('the cap leaves out live units that finished:a child awaiting Integrate and a unit awaiting its PR', async ($, on) => {
  const { graph } = repository()
  const checkout = repository()
  checkout.graph = { ...graph, commits: { ...graph?.commits, e1: { parents: ['m0'], files: { e: '1' } } },
    refs: { ...graph?.refs, 'feat/5-collect': 'm0', '8-idle-parent': 'e1' }, created: { 'feat/7-parent-work': 'feat/5-collect', '8-idle-parent': 'main' } }
  checkout.worktrees = { ...checkout.worktrees, '/wt/7': { branch: 'feat/7-parent-work' }, '/wt/8': { branch: '8-idle-parent' } }
  const live = [1, 2, 7, 8].map(issue => ({ id: `w${issue}`, label: `wa-spawn:${issue}`, path: `/wt/${issue}`, hasAgent: true }))
  const world = createSpawnWorld(on, live, { 12: {}, 7: {}, 8: {} }, {}, checkout)
  for (const [issue, branch, entry] of [[7, 'feat/7-parent-work', { base: 'm0', baseBranch: 'feat/5-collect' }], [8, '8-idle-parent', { base: 'm0' }]] as const) {
    await seedUnit(world, `unit-${issue}`, { branch, issues: [issue] }, { skips: coveredSkips(), ...entry })
  }
  world.files.set(scopeFile('sid'), buildScope('sid', [7, 8]))
  expect((await callModTool($, 'plan')).text).toMatch(/^#7 .* · unit finished · .*\n#8 .* · unit finished · /)
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).not.toBe('')
})

test('the coordinator messages and reads a unit through the mod, and no other session can', async ($, on) => {
  const world = createSpawnWorld(on, [], {})
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Take option A.' })).isError).toBe(false)
  expect(herdrRuns(world, 'agent prompt')).toEqual(['herdr agent prompt issue-12 Take option A.'])
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

test('a coordinator in auto mode spawns and resumes its unit in auto mode, and the result names it', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, {}, checkout)
  await $.classic.UserPromptSubmit({ prompt: 'spawn #12', permission_mode: 'auto' } as never)
  expect((await callModTool($, 'spawn', { number: 12 })).text).toContain('in auto mode')
  workspaces.length = 0
  checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
  expect((await callModTool($, 'spawn', { number: 12 })).text).toContain('resumed')
  expect(herdrRuns(world, 'agent start').map(line => line.split(' -- ')[1]?.split(' ').slice(0, 2).join(' '))).toEqual(['--permission-mode auto', '--permission-mode auto'])
})

for (const mode of ['bypassPermissions', 'plan', undefined]) {
  test(`a coordinator in ${mode ?? 'an unreported'} mode spawns its unit in default mode`, async ($, on) => {
    const world = createSpawnWorld(on, [], { 12: {} })
    if (mode) await $.classic.UserPromptSubmit({ prompt: 'spawn #12', permission_mode: mode } as never)
    expect((await callModTool($, 'spawn', { number: 12 })).text).toContain('in default mode')
    expect(herdrRuns(world, 'agent start')[0]).toContain('-- --permission-mode default ')
  })
}

test('plan lists each delegated issue with its blockers\' unit states, the issues spawn would start now first with their base', async ($, on) => {
  const world = createSpawnWorld(on, [], { 7: {}, 12: { blockedBy: [{ number: 7, state: 'OPEN' }] }, 13: { blockedBy: [{ number: 9, state: 'OPEN' }] }, 14: { labels: ['needs-triage'] } })
  await world.ready
  world.files.set(scopeFile('sid'), buildScope('sid', [14, 13, 12, 7]))
  const plan = await callModTool($, 'plan')
  expect(plan.isError).toBe(false)
  expect(plan.text.split('\n')).toEqual([
    '#7 feat(mod): spawn a unit · unit working · blocked by none · has its unit: spawn reuses it',
    '#12 feat(mod): spawn a unit · unit none · blocked by #7 (working) · #12 waits: #7\'s unit is working',
    '#13 feat(mod): spawn a unit · unit none · blocked by #9 (none) · #13 waits: its dependency #9 has no unit branch yet',
    expect.stringMatching(/^#14 feat\(mod\): spawn a unit · unit none · blocked by none · #14 is needs-triage, and only a ready-for-agent issue gets a unit/),
  ])
  expect((await callModTool($, 'plan')).text).toBe(plan.text)
  expect(herdrRuns(world, '')).toEqual([])
})

test('plan bases a child of an integrated blocker on the branch that integrated it, as spawn does', async ($, on) => {
  const { graph } = repository()
  const checkout = repository()
  checkout.graph = { ...graph, commits: { ...graph?.commits, c2: { parents: ['p1'], files: { a: '1', c: '1' } } },
    refs: { ...graph?.refs, 'feat/5-collect': 'c2' }, created: { 'feat/7-parent-work': 'feat/5-collect' }, moved: ['feat/7-parent-work'] }
  const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: 7, state: 'OPEN' }] } }, {}, checkout)
  await world.ready
  world.files.set(scopeFile('sid'), buildScope('sid', [12]))
  expect((await callModTool($, 'plan')).text).toBe('#12 feat(mod): spawn a unit · unit none · blocked by #7 (integrated) · can start now from feat/5-collect')
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('c2')
})

test('an issue another running session has declared gets no unit from spawn, and plan names that session, until that session is gone', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await world.ready
  world.files.set(scopeFile('sid'), buildScope('sid', [12]))
  await seedUnit(world, 'manual', { branch: 'main', issues: [12] }, {})
  world.files.set(`${records}/host/manual.json`, JSON.stringify(coordinatorHost))
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('declared by session manual'), isError: true })
  expect((await callModTool($, 'plan')).text).toContain('declared by session manual')
  expect(herdrRuns(world, 'worktree create')).toEqual([])
  world.files.set(`${records}/host/manual.json`, JSON.stringify({ ...coordinatorHost, pid: 404 }))
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
})

test('plan is refused outside a coordinator session', async ($, on) => {
  createSpawnWorld(on, [], {}, { session: noFlow })
  expect(await callModTool($, 'plan')).toEqual({ text: expect.stringContaining('only a coordinator'), isError: true })
})

test('spawn with no model or effort starts the unit on the user\'s defaults, and the result says so', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  expect((await callModTool($, 'spawn', { number: 12 })).text).toContain('default model, default effort')
  expect(herdrRuns(world, 'agent start')[0]).not.toMatch(/--model|--effort/)
  expect(world.runs.some(line => line.startsWith('claude '))).toBe(false)
})

test('spawn with a model, an effort and a reason starts the unit on them and records all three for plan and the report', async ($, on) => {
  const { world } = await spawnCheap($, on)
  expect(herdrRuns(world, 'agent start')[0]).toContain(' -- --permission-mode default --model haiku --effort low --session-id ')
  expect(readSpawnRecord(world, 12)).toMatchObject({ model: 'haiku', effort: 'low', reason: 'a typo fix' })
  expect((await callModTool($, 'plan')).text).toContain('model haiku, effort low (a typo fix)')
  expect((await runFlowCommand($, 'report')).text).toContain('model haiku, effort low (a typo fix)')
})

for (const [name, args, refusal] of [
  ['an effort outside low, medium and high', { effort: 'max', reason: 'r' }, 'effort must be one of low, medium, high'],
  ['a model or effort without a reason', { model: 'haiku' }, 'reason must say'],
  ['a model name that reads as an option', { model: '--dangerously-skip-permissions', reason: 'r' }, 'model must be a model name'],
] as const) {
  test(`spawn refuses ${name} and starts nothing`, async ($, on) => {
    const world = createSpawnWorld(on, [], { 12: {} })
    expect(await callModTool($, 'spawn', { number: 12, ...args })).toEqual({ text: expect.stringContaining(refusal), isError: true })
    expect(herdrRuns(world, '')).toEqual([])
  })
}

test('an unknown model makes spawn fail with the CLI\'s own message, before any branch or worktree exists', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} }, { claude: () => ({ stdout: JSON.stringify({ is_error: true, result: 'There\'s an issue with the selected model (nope).' }) }) })
  expect(await callModTool($, 'spawn', { number: 12, model: 'nope', reason: 'r' }))
    .toEqual({ text: expect.stringContaining('does not run model nope, so nothing is started: There\'s an issue with the selected model'), isError: true })
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('')
  expect(herdrRuns(world, 'worktree')).toEqual([])
  expect(world.files.has(`${records}/spawn/12.json`)).toBe(false)
})

test('a resumed unit keeps its recorded model and effort, whatever the new call gives', async ($, on) => {
  const { world, workspaces } = await spawnCheap($, on)
  workspaces.length = 0
  const resumed = await callModTool($, 'spawn', { number: 12, effort: 'high', reason: 'other' })
  expect(resumed.text).toContain('its recorded model and effort are kept')
  expect(herdrRuns(world, 'agent start')[1]).toContain('--model haiku --effort low --resume ')
})

test('two consecutive red Verifies resume the idle unit on the default model with effort high and tell the coordinator', async ($, on) => {
  const { world } = await spawnCheap($, on)
  await seedVerifies(world, ['fail', 'fail'])
  expect(await readPromptContext($)).toContain('#12 escalated: two consecutive red Verifies')
  expect(herdrRuns(world, 'agent prompt issue-12 /exit')).toHaveLength(1)
  const restart = herdrRuns(world, 'agent start')[1]
  expect(restart).toContain(' --effort high --resume ')
  expect(restart).not.toContain('--model')
  expect(readSpawnRecord(world, 12)).toMatchObject({ effort: 'high', reason: 'escalated: two consecutive red Verifies' })
  expect(await readPromptContext($)).not.toContain('escalated')
  expect(herdrRuns(world, 'agent start')).toHaveLength(2)
})

test('a red Verify after a green one, or a unit on the user\'s defaults, is not escalated', async ($, on) => {
  const { world } = await spawnCheap($, on)
  await seedVerifies(world, ['fail', 'pass'])
  expect(await readPromptContext($)).not.toContain('escalated')
  expect(herdrRuns(world, 'agent prompt issue-12 /exit')).toEqual([])
  expect(await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).toMatchObject({ isError: false })
  expect(await callModTool($, 'escalate_unit', { number: 12, reason: 'again' })).toEqual({ text: expect.stringContaining('not escalated'), isError: true })
  expect(herdrRuns(world, 'agent start')).toHaveLength(2)
})

test('a coordinator request escalates an idle unit now, and a working one only once it is idle', async ($, on) => {
  const { world, agent } = await spawnCheap($, on)
  agent.isWorking = true
  expect((await callModTool($, 'escalate_unit', { number: 12, reason: 'an unexpected design decision' })).text).toContain('applied once it is idle')
  expect(await readPromptContext($)).not.toContain('escalated')
  expect(herdrRuns(world, 'agent prompt issue-12 /exit')).toEqual([])
  agent.isWorking = false
  expect(await readPromptContext($)).toContain('#12 escalated: coordinator request: an unexpected design decision')
  expect(herdrRuns(world, 'agent start')[1]).toContain(' --effort high --resume ')
  expect(readSpawnRecord(world, 12)).not.toHaveProperty('escalation')
})
