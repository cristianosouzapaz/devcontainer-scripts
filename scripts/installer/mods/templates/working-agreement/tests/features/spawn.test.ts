import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { coveredSkips, seedUnit } from '../support/parallel-worktrees'

import { createEmptySession } from '../../hooks/domain/records'
import { coordinator, noFlow } from '../support/builders'
import { callModTool, declareFlow, inside, readPromptContext, readRevision, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { buildScope, coordinatorHost, createWorld, markSpawned, placedFile, records, scopeFile } from '../support/world'
import type { Checkout, Options, World } from '../support/world'

/** A herdr workspace the fake server holds: its label, checkout, whether an agent runs in its pane, and whether herdr left that agent unnamed. */
interface Workspace { id: string; label: string; path: string; hasAgent?: boolean; isUnnamed?: boolean }

/** An issue as the spawn's GitHub read returns it. */
interface Issue { state?: string; title?: string; labels?: string[]; parent?: number; blockedBy?: { number: number; state: string }[] }

/**
 * The unit's session as its own mod runs it: once started it takes and acknowledges the mail that reaches its mailbox unless it is deaf,
 * the mail bodies it took, how many messages waited unread at each of its starts, whether it works, its issue once started, and the world
 * whose mailbox it reads, set once the world exists. A slow one outlasts herdr's start wait, which then fails and leaves the agent
 * unnamed; an absent one never comes up at all.
 */
interface Agent {
  isDeaf?: boolean; isSlow?: boolean; isAbsent?: boolean; isLive?: boolean; issue?: number; received: string[]; unreadAtStart: number[]; isWorking: boolean
  world?: World
  /** The error code herdr answers a recent-history read with, as it does for a fullscreen unit that is not idle. */
  readRefusal?: string
}

/** The model and effort a unit is spawned on, with the reason for them. */
interface Level { model?: string; effort?: string; reason: string }

/** A spawned unit: the world, its agent and the herdr workspaces. */
interface SpawnedUnit { world: World; agent: Agent; workspaces: Workspace[] }

/** A Verify run's outcome. */
type VerifyKind = 'pass' | 'fail'

const labelPrefix = 'wa-spawn:'
/** How long herdr waits for an agent it starts, which a slow agent's start takes in full. */
const hostWaitMs = 60000

/**
 * Answers herdr like a live server that keeps the workspaces it opens.
 * @param workspaces - The open workspaces, changed as the server opens worktrees and starts agents.
 * @param agent - The unit agent, whose submits miss while it is not ready.
 * @returns The world's herdr reply.
 */
const herdrServer = (workspaces: Workspace[], agent: Agent = createAgent()): Options['herdrReply'] => args => {
  const [noun, verb] = args
  const option = (name: string) => args[args.indexOf(name) + 1] ?? ''
  // why: herdr names an agent only when its start wait succeeds, so a name it never set addresses nothing.
  if (noun === 'agent' && workspaces.some(each => each.isUnnamed && `issue-${each.label.replace(labelPrefix, '')}` === args[2])) {
    return { exitCode: 1, stdout: JSON.stringify({ error: { code: 'agent_not_found', message: `agent ${args[2]} not found` } }) }
  }
  if (noun === 'agent' && verb === 'wait') return agent.isWorking === !args.includes('idle') ? '{}' : { exitCode: 1, stderr: 'timeout' }
  if (noun === 'workspace' && verb === 'list') {
    return JSON.stringify({ result: { workspaces: workspaces.map(each => ({ workspace_id: each.id, label: each.label, worktree: { checkout_path: each.path } })) } })
  }
  // why: closing a workspace ends the session in its pane; the conversation stays for a resume.
  if (noun === 'workspace' && verb === 'close') {
    workspaces.splice(workspaces.findIndex(each => each.id === args[2]), 1)
    agent.isWorking = false
    agent.isLive = false
    return '{}'
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
    const issue = Number(args[2]?.replace('issue-', ''))
    if (agent.world) agent.unreadAtStart.push(readBox(agent.world, issue, 'new').length)
    if (workspace && !agent.isAbsent) Object.assign(workspace, { hasAgent: true, isUnnamed: agent.isSlow })
    if (!agent.isAbsent) Object.assign(agent, { isLive: true, issue })
    if (agent.isSlow || agent.isAbsent) return { exitCode: 1, stdout: JSON.stringify({ error: { code: 'timeout', message: 'timed out waiting for agent startup' } }) }
  }
  if (noun === 'agent' && verb === 'rename') {
    const workspace = workspaces.find(each => args[2] === `${each.id}:p1` && each.hasAgent)
    if (!workspace) return { exitCode: 1, stdout: JSON.stringify({ error: { code: 'agent_not_found', message: `agent ${args[2]} not found` } }) }
    workspace.isUnnamed = false
  }
  if (noun === 'agent' && verb === 'read' && agent.readRefusal && option('--source') === 'recent') {
    return { exitCode: 1, stderr: JSON.stringify({ error: { code: agent.readRefusal, message: `cannot read ${option('--lines')} lines` } }) }
  }
  if (noun === 'agent' && verb === 'read') return option('--source') === 'visible' ? 'visible screen' : 'unit output'
  return '{}'
}

/**
 * Builds a unit session that takes its mail.
 * @returns The agent, idle.
 */
const createAgent = (): Agent => ({ received: [], unreadAtStart: [], isWorking: false })

/**
 * Acts as the unit's own mod injecting its unread mail: each message moves from new/ to cur/, its body taken, and a turn starts.
 * @param agent - The unit session.
 * @param issue - The unit's issue.
 */
function takeMail(agent: Agent, issue: number): void {
  const files = agent.world?.files
  if (!files) return
  for (const path of [...files.keys()].filter(each => each.startsWith(`${records}/mail/${issue}/new/`))) {
    const text = files.get(path) ?? '{}'
    files.set(path.replace('/new/', '/cur/'), text)
    files.delete(path)
    agent.received.push(String((JSON.parse(text) as { body?: unknown }).body))
    agent.isWorking = true
  }
}

/**
 * Lists the messages of a unit's mailbox directory.
 * @param world - The world.
 * @param issue - The unit's issue.
 * @param box - The directory.
 * @returns Each message's kind and body.
 */
const readBox = (world: World, issue: number, box: 'new' | 'cur'): { id: string; kind: string; body: string }[] => [...world.files.entries()]
  .filter(([path]) => path.startsWith(`${records}/mail/${issue}/${box}/`)).map(([, text]) => JSON.parse(text) as { id: string; kind: string; body: string })

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
 * Builds main and origin/main on m0, with issue 7's typed branch one commit past it and issue 8's untyped branch level with it.
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
 * Creates a coordinator world inside herdr whose scope delegates every issue GitHub knows.
 * @param on - The test's hook registration.
 * @param workspaces - The herdr workspaces already open.
 * @param issues - The issues GitHub knows, all of them delegated.
 * @param options - Options replacing the coordinator defaults.
 * @param checkout - The repository.
 * @param agent - The unit session herdr starts.
 * @returns The world.
 */
const createSpawnWorld = (on: On, workspaces: Workspace[], issues: Record<number, Issue>, options: Options = {},
  checkout = repository(), agent = createAgent()): World => {
  const world = createWorld(on, checkout, { session: coordinator, herdrEnv: inside, herdrReply: herdrServer(workspaces, agent), gh: github(issues),
    herdrDelayMs: args => args[0] === 'agent' && args[1] === 'start' && (agent.isSlow || agent.isAbsent) ? hostWaitMs : 0,
    // why: a running unit's mail watch rings as soon as a message lands, so its session takes it before spawn next looks.
    beforeRun: () => { if (agent.isLive && !agent.isDeaf && agent.issue) takeMail(agent, agent.issue) }, ...options })
  agent.world = world
  // why: spawn starts only a delegated issue, so every issue GitHub knows here is in the coordinator's scope unless a test sets its own.
  world.files.set(scopeFile('sid'), buildScope('sid', Object.keys(issues).map(Number)))
  return world
}

/**
 * Lists the herdr commands a world ran, as text.
 * @param world - The world.
 * @param prefix - The leading words kept.
 * @returns The matching command lines.
 */
const herdrRuns = (world: World, prefix: string): string[] => world.herdrCalls.map(call => call.argv.join(' ')).filter(line => line.startsWith(`herdr ${prefix}`))

/**
 * Lists the claude arguments of each unit session a world started, as herdr received them.
 * @param world - The world.
 * @returns Each herdr agent start's words after its `--`, in order.
 */
const unitArgvs = (world: World): string[][] => world.herdrCalls.map(call => call.argv)
  .filter(argv => argv[1] === 'agent' && argv[2] === 'start').map(argv => argv.slice(argv.indexOf('--') + 1))

/**
 * Reads the session settings a unit's claude arguments carry.
 * @param argv - The claude arguments.
 * @returns The parsed `--settings` JSON.
 */
const readSettings = (argv: string[] = []): unknown => JSON.parse(argv[argv.indexOf('--settings') + 1] ?? 'null') as unknown

/**
 * Reads the value a unit's claude arguments give a flag, wherever the flag stands.
 * @param argv - The claude arguments.
 * @param flag - The flag, such as `--model`.
 * @returns The word after the flag, or undefined without the flag.
 */
const flagValue = (argv: string[] = [], flag: string): string | undefined => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined

/**
 * Seeds the unit session of issue 12 on its spawned branch with these Verify outcomes, newest first, and the red count they leave.
 * @param world - The world.
 * @param outcomes - Each run's outcome.
 */
async function seedVerifies(world: World, outcomes: VerifyKind[]): Promise<void> {
  const verifyRuns = outcomes.map((kind, index) => ({ tree: `t${index}`, base: 'm0', configBlob: 'c', commands: [['t']], runId: `r${index}`, at: 1000 - index,
    outcome: kind === 'pass' ? { kind } : { kind, code: 1, signal: null } }))
  const reds = outcomes.indexOf('pass')
  await seedUnit(world, 'unit-12', { branch: 'feat/12-spawn-a-unit', issues: [12] }, { verifyRuns, redVerifies: reds < 0 ? outcomes.length : reds })
}

/**
 * Starts issue 12 on a cheap level under a scope that delegates it, its agent idle after the start prompt.
 * @param $ - The test's engine.
 * @param on - The test's hook registration.
 * @param level - The model and effort, with the reason.
 * @returns The world, the agent and the unit's workspaces.
 */
async function spawnCheap($: Engine, on: On, level: Level = { model: 'haiku', effort: 'low', reason: 'a typo fix' }): Promise<SpawnedUnit> {
  const workspaces: Workspace[] = []
  const agent = createAgent()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, {}, repository(), agent)
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
const readSpawnRecord = (world: World, issue: number): Record<string, unknown> => JSON.parse(world.files.get(`${records}/spawn/${issue}.json`) ?? '{}') as Record<string, unknown>

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

// contract: spawn starts nothing for a ready-for-agent issue the user has not delegated to this coordinator, whether it delegates nothing or other issues
test('spawn refuses an issue outside the coordinator\'s delegation scope and starts nothing', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {}, 13: {} })
  await world.ready
  world.files.delete(scopeFile('sid'))
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('is not in this coordinator\'s delegation scope'), isError: true })
  world.files.set(scopeFile('sid'), buildScope('sid', [13]))
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('is not in this coordinator\'s delegation scope'), isError: true })
  expect(herdrRuns(world, '')).toEqual([])
  expect(world.files.has(`${records}/spawn/12.json`)).toBe(false)
})

test('a fresh issue gets its branch from the default branch, a labelled worktree, a started session and an acknowledged assign, never a typed prompt', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: { title: 'feat(mod): Spawn a unit!' } })
  const outcome = await callModTool($, 'spawn', { number: 12 })
  expect(outcome).toEqual({ text: expect.stringContaining('started'), isError: false })
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('m0')
  expect(world.files.has(placedFile('feat/12-spawn-a-unit', 'm0'))).toBe(true)
  expect(herdrRuns(world, 'worktree create')[0]).toContain('--branch feat/12-spawn-a-unit')
  expect(herdrRuns(world, 'worktree create')[0]).toContain('--label wa-spawn:12')
  expect(flagValue(unitArgvs(world)[0], '--session-id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  expect(flagValue(unitArgvs(world)[0], '--permission-mode')).toBe('default')
  expect(outcome.text).toMatch(/its start assignment \(message [\w-]+\) acknowledged/)
  expect(readBox(world, 12, 'cur')).toEqual([expect.objectContaining({ kind: 'assign', body: expect.stringMatching(/^Work on issue #12 on branch feat\/12-spawn-a-unit/) })])
  expect(readBox(world, 12, 'new')).toEqual([])
  expect([...herdrRuns(world, 'agent prompt'), ...herdrRuns(world, 'agent send-keys'), ...herdrRuns(world, 'pane send')]).toEqual([])
})

test('the coordinator\'s instructions end the start prompt verbatim under their heading, and only text is taken', async ($, on) => {
  const agent = createAgent()
  createSpawnWorld(on, [], { 12: {} }, {}, repository(), agent)
  expect(await callModTool($, 'spawn', { number: 12, instructions: 42 })).toEqual({ text: expect.stringContaining('instructions must be text'), isError: true })
  expect((await callModTool($, 'spawn', { number: 12, instructions: 'ask before a suite run:\n  verify waits for my go' })).isError).toBe(false)
  expect(agent.received).toEqual([expect.stringMatching(/ worktree\. The coordinator is herdr pane [^\n]+\.\n\nUser's instructions:\nask before a suite run:\n {2}verify waits for my go$/)])
})

test('instructions for a unit already prompted are not sent, and the result says to send them with unit_prompt', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await callModTool($, 'spawn', { number: 12 })
  expect(await callModTool($, 'spawn', { number: 12, instructions: 'no verify' })).toEqual({ text: expect.stringContaining('send them with unit_prompt'), isError: false })
  expect(readBox(world, 12, 'cur')).toHaveLength(1)
  expect(readBox(world, 12, 'cur')[0]?.body).not.toContain("User's instructions")
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
  world.modified.set(`${records}/spawn/lock`, world.clock.now() - 601000)
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
    // Issue 7 was cut from issue 5's collecting branch and worked on; issue 5 took it by fast-forward (c2 follows p1) or by a merge
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
    // Issue 5's integration branch has moved past main; its own unit is still working.
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

// Issue 5's integration branch holds issue 7's work (p1) and issue 8's (q1) through i1; q2 is issue 8's work cut from issue 7's
// branch, held by i2; c2 holds issue 7's work only. Issues 7 and 8 have finished units unless they are listed as working.
for (const [name, blockedBy, refs, created, moved, working, tip] of [
  ['a sub-issue whose one blocker is integrated into its parent\'s branch starts from that branch\'s tip',
    [7], { 'chore/5-integrate': 'c2' }, { 'feat/7-parent-work': 'chore/5-integrate' }, ['feat/7-parent-work'], [], 'c2'],
  ['a sub-issue whose two blockers are both integrated into its parent\'s branch starts from that branch\'s tip',
    [7, 8], { 'chore/5-integrate': 'i1', '8-idle-parent': 'q1' }, { 'feat/7-parent-work': 'chore/5-integrate', '8-idle-parent': 'chore/5-integrate' },
    ['feat/7-parent-work', '8-idle-parent'], [], 'i1'],
  ['a sub-issue whose blocker was cut from a sibling\'s branch and is held by its parent\'s branch starts from that branch\'s tip',
    [7, 8], { 'chore/5-integrate': 'i2', '8-idle-parent': 'q2' }, { 'feat/7-parent-work': 'chore/5-integrate', '8-idle-parent': 'feat/7-parent-work' },
    ['feat/7-parent-work', '8-idle-parent'], [], 'i2'],
  ['a sub-issue with mixed blockers waits and names only the ones not integrated into its parent\'s branch, each with its reason',
    [7, 8, 9], { 'chore/5-integrate': 'c2', '8-idle-parent': 'q1' }, { 'feat/7-parent-work': 'chore/5-integrate', '8-idle-parent': 'chore/5-integrate' },
    ['feat/7-parent-work', '8-idle-parent'], [8], 'its dependency #8\'s unit is working; its dependency #9 has no unit branch yet'],
  ['a sub-issue whose finished blocker is not yet held by its parent\'s branch waits for it',
    [7, 8], { 'chore/5-integrate': 'c2', '8-idle-parent': 'q1' }, { 'feat/7-parent-work': 'chore/5-integrate', '8-idle-parent': 'chore/5-integrate' },
    ['feat/7-parent-work', '8-idle-parent'], [], 'its dependency #8 is not integrated into chore/5-integrate yet'],
  ['a sub-issue whose blocker\'s branch has not moved since it was cut waits for it, though its parent\'s branch holds its tip',
    [7, 8], { 'chore/5-integrate': 'c2', '8-idle-parent': 'm0' }, { 'feat/7-parent-work': 'chore/5-integrate', '8-idle-parent': 'chore/5-integrate' },
    ['feat/7-parent-work'], [], 'its dependency #8'],
] as const) {
  test(name, async ($, on) => {
    const { graph } = repository()
    const checkout = repository()
    checkout.graph = { ...graph, commits: { ...graph?.commits, c2: { parents: ['p1'], files: { a: '1', c: '1' } }, q1: { parents: ['m0'], files: { b: '1' } },
      i1: { parents: ['p1', 'q1'], files: { a: '1', b: '1' } }, q2: { parents: ['p1'], files: { a: '1', b: '1' } }, i2: { parents: ['q2'], files: { a: '1', b: '1', c: '1' } } },
    refs: { ...graph?.refs, ...refs }, created: { ...created }, moved: [...moved] }
    const world = createSpawnWorld(on, [], { 12: { parent: 5, blockedBy: blockedBy.map(number => ({ number, state: 'OPEN' })) } }, {}, checkout)
    for (const [issue, branch] of [[7, 'feat/7-parent-work'], [8, '8-idle-parent']] as const) {
      if ((blockedBy as readonly number[]).includes(issue) && !(working as readonly number[]).includes(issue)) await seedFinishedUnit(world, checkout, branch, issue)
    }
    world.files.set(scopeFile('sid'), buildScope('sid', [12]))
    const isStart = /^[a-z0-9]+$/.test(tip)
    const plan = (await callModTool($, 'plan')).text
    const spawned = await callModTool($, 'spawn', { number: 12 })
    if (!isStart) {
      expect(spawned).toEqual({ text: expect.stringContaining(`#12 waits: ${tip}`), isError: true })
      expect(spawned.text).not.toContain('#7')
      expect(plan).toContain(`#12 waits: ${tip}`)
      expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('')
      return
    }
    expect(plan).toContain('can start now from chore/5-integrate')
    expect(spawned.isError).toBe(false)
    expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe(tip)
    checkout.branch = 'feat/12-spawn-a-unit'
    checkout.worktrees = { ...checkout.worktrees, '/repo': { branch: checkout.branch } }
    world.chat.id = 'unit'
    world.seedChat('unit', { ...createEmptySession('unit'), info: { 12: { title: 'feat(mod): spawn a unit', labels: ['ready-for-agent'] } } })
    await declareFlow($, 'small-feature', [12])
    expect(world.sessions.get('unit')?.units[0]).toMatchObject({ baseBranch: 'chore/5-integrate', base: tip })
  })
}

test('an issue with two open blockers and no parent branch still waits, since a child unit has one parent', async ($, on) => {
  const checkout = repository()
  const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: 7, state: 'OPEN' }, { number: 8, state: 'OPEN' }] } }, {}, checkout)
  await seedFinishedUnit(world, checkout, 'feat/7-parent-work', 7)
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('#12 waits: it is blocked by #7, #8, and a child unit has one parent'), isError: true })
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('')
})

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
  expect(readBox(world, 12, 'cur')).toHaveLength(1)
})

test('spawn of a unit whose close waits for its turn to end cancels that close, keeping the rest of its record', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await callModTool($, 'spawn', { number: 12 })
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...readSpawnRecord(world, 12), isClosing: true }))
  expect((await callModTool($, 'spawn', { number: 12 })).text).toContain('already runs')
  await readPromptContext($)
  expect(herdrRuns(world, 'workspace close')).toEqual([])
})

test('a unit that does not acknowledge its assign within 120 s of its send makes spawn fail loudly, and a later spawn waits for that same message', async ($, on) => {
  const agent: Agent = { ...createAgent(), isDeaf: true }
  const world = createSpawnWorld(on, [], { 12: {} }, {}, repository(), agent)
  const spawning = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(119000)
  expect(readBox(world, 12, 'new')).toHaveLength(1)
  await world.clock.advance(2000)
  expect(await spawning).toEqual({ text: expect.stringMatching(/#12 did not acknowledge its start assignment \(message [\w-]+\) within 120 s of its send after the session's start: its session took no mail/), isError: true })
  expect(herdrRuns(world, 'workspace close')).toEqual([])
  // The unit's mod takes the message late, at its next prompt.
  agent.isDeaf = false
  takeMail(agent, 12)
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringMatching(/its start assignment \(message [\w-]+\) was acknowledged now/), isError: false })
  expect(readBox(world, 12, 'cur')).toHaveLength(1)
  expect(herdrRuns(world, 'agent start')).toHaveLength(1)
})

/**
 * Starts issue 12 under a scope that delegates it, while the clock runs past the host's start wait and the ack wait after it.
 * @param $ - The test's engine.
 * @param world - The world.
 * @param args - The spawn arguments beside the issue number.
 * @returns The spawn's outcome.
 */
async function spawnPastHostWait($: Engine, world: World, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  await world.ready
  world.files.set(scopeFile('sid'), buildScope('sid', [12]))
  const spawning = callModTool($, 'spawn', { number: 12, ...args })
  await world.clock.advance(hostWaitMs + 300000)
  return spawning
}

/**
 * Names the session id spawn started a unit under, as its first herdr agent start gave it.
 * @param world - The world.
 * @returns The session id.
 */
const startedSession = (world: World): string => herdrRuns(world, 'agent start')[0]?.split(' ').at(-1) ?? ''

// contract: spawn's own start and resume messages reach the mailbox only once the host's start has returned, on every host start
test('a fresh start, an escalation restart and a resume each find an empty mailbox at the host\'s start, and get their message after it', async ($, on) => {
  const { world, agent, workspaces } = await spawnCheap($, on)
  expect((await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).isError).toBe(false)
  agent.isWorking = false
  workspaces.length = 0
  expect((await callModTool($, 'spawn', { number: 12 })).text).toContain('resumed')
  expect(herdrRuns(world, 'agent start')).toHaveLength(3)
  expect(agent.unreadAtStart).toEqual([0, 0, 0])
  expect(agent.received).toEqual([expect.stringMatching(/^Work on issue #12 /), expect.stringMatching(/^This session was resumed /), expect.stringMatching(/^This session was resumed /)])
})

// contract: no coordinator message, a cancel included, reaches a unit while spawn starts its session; unit_prompt refuses and says to retry
test('unit_prompt, a cancel included, is refused while spawn starts the unit\'s session, and goes through once spawn has returned', async ($, on) => {
  const agent: Agent = { ...createAgent(), isSlow: true }
  const world = createSpawnWorld(on, [], { 12: {} }, {}, repository(), agent)
  await world.ready
  const spawning = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(hostWaitMs / 2)
  expect(await callModTool($, 'unit_prompt', { number: 12, text: 'Early news.' })).toEqual({ text: expect.stringContaining('retry unit_prompt once spawn has returned'), isError: true })
  expect(await callModTool($, 'unit_prompt', { number: 12, kind: 'cancel', text: 'Stop.' })).toEqual({ text: expect.stringContaining('retry unit_prompt once spawn has returned'), isError: true })
  await world.clock.advance(hostWaitMs)
  expect((await spawning).isError).toBe(false)
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Later news.' })).isError).toBe(false)
  expect(agent.received.some(body => body.includes('Early news.'))).toBe(false)
})

// contract: a start that fails before the host opened any workspace records no start and waits for no ack
test('a start that fails before any workspace exists records no start, waits for no ack, and says so', async ($, on) => {
  const workspaces: Workspace[] = []
  const server = herdrServer(workspaces) as NonNullable<Options['herdrReply']>
  const world = createSpawnWorld(on, workspaces, { 12: {} }, { herdrReply: args => args[0] === 'worktree'
    ? { exitCode: 1, stdout: JSON.stringify({ error: { code: 'git_failed', message: 'cannot create the worktree' } }) } : server(args) })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('its host opened no workspace for it'), isError: true })
  const plan = (await callModTool($, 'plan')).text
  expect(plan).toContain('#12 ')
  expect(plan).not.toContain('default model')
  expect(readBox(world, 12, 'new')).toEqual([])
  expect(herdrRuns(world, 'agent start')).toEqual([])
})

// contract: a session that acks its assign is the unit even when herdr's start wait timed out
test('a start that outlasts the host\'s wait, whose session acks its assign, ends as a delegated unit that unit_read and the idle wait reach', async ($, on) => {
  const agent: Agent = { ...createAgent(), isSlow: true }
  const checkout = repository()
  const world = createSpawnWorld(on, [], { 12: {} }, {}, checkout, agent)
  expect(await spawnPastHostWait($, world, { model: 'haiku', effort: 'low', reason: 'a typo fix' })).toEqual({ text: expect.stringContaining('started'), isError: false })
  expect(herdrRuns(world, 'agent rename')).toEqual(['herdr agent rename w10:p1 issue-12'])
  expect(await callModTool($, 'unit_read', { number: 12 })).toEqual({ text: 'unit output', isError: false })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('already runs'), isError: false })
  agent.isSlow = false
  agent.isWorking = false
  expect((await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).text).not.toContain('once it is idle')
  expect(herdrRuns(world, 'workspace close')).toHaveLength(1)
  checkout.branch = 'feat/12-spawn-a-unit'
  checkout.worktrees = { ...checkout.worktrees, '/repo': { branch: checkout.branch } }
  world.chat.id = startedSession(world)
  world.seedChat(world.chat.id, { ...createEmptySession(world.chat.id), info: { 12: { title: 'feat(mod): spawn a unit', labels: ['ready-for-agent'] } } })
  await declareFlow($, 'small-feature', [12])
  expect(await readPromptContext($)).toContain('This unit is delegated')
})

// contract: a start that never brings a session up and gets no ack closes its workspace, and spawn says so
test('no ack by the deadline and no live session: spawn closes the workspace and says so', async ($, on) => {
  const workspaces: Workspace[] = []
  const world = createSpawnWorld(on, workspaces, { 12: {} }, {}, repository(), { ...createAgent(), isAbsent: true })
  expect(await spawnPastHostWait($, world)).toEqual({ text: expect.stringContaining('workspace was closed'), isError: true })
  expect(herdrRuns(world, 'workspace close')).toHaveLength(1)
  expect(workspaces).toEqual([])
})

// contract: a second spawn takes over the session an earlier spawn started for the issue, matched by its record
test('a second spawn adopts the session an earlier spawn started for the same issue and never refuses it as declared by that session', async ($, on) => {
  const agent: Agent = { ...createAgent(), isSlow: true }
  const world = createSpawnWorld(on, [], { 12: {} }, {}, repository(), agent)
  await spawnPastHostWait($, world)
  const session = startedSession(world)
  // An earlier spawn wrote the session id but never isStarted, and that session has declared the issue.
  const { isStarted, ...unstarted } = readSpawnRecord(world, 12)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify(unstarted))
  await seedUnit(world, session, { branch: 'feat/12-spawn-a-unit', issues: [12] }, {})
  world.files.set(`${records}/host/${session}.json`, JSON.stringify(coordinatorHost))
  const again = await callModTool($, 'spawn', { number: 12 })
  expect(again.text).not.toContain('declared by')
  expect(again).toEqual({ text: expect.stringContaining('already runs'), isError: false })
  expect(herdrRuns(world, 'agent start')).toHaveLength(1)
})

// contract: a respawn resumes a session whose transcript exists, whatever the record says about its start
test('a respawn whose transcript exists and whose record lacks isStarted resumes the session', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, { herdrEnv: { ...inside, CLAUDE_CONFIG_DIR: '/claude' } }, checkout)
  await callModTool($, 'spawn', { number: 12 })
  const session = startedSession(world)
  const { isStarted, ...unstarted } = readSpawnRecord(world, 12)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify(unstarted))
  world.files.set(`/claude/projects/-wt-feat-12-spawn-a-unit/${session}.jsonl`, '{}\n')
  workspaces.length = 0
  checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  expect(herdrRuns(world, 'agent start').at(-1)).toContain(`--resume ${session}`)
})

// contract: the ack wait starts at the send that follows the host's start and lasts longer than the host's own wait
test('the ack deadline counts from the send after the host\'s start returns and outlasts the host\'s wait', async ($, on) => {
  const agent: Agent = { ...createAgent(), isSlow: true, isDeaf: true }
  const world = createSpawnWorld(on, [], { 12: {} }, {}, repository(), agent)
  await world.ready
  const outcome: { value?: { text: string; isError: boolean } } = {}
  const spawning = callModTool($, 'spawn', { number: 12 }).then(value => Object.assign(outcome, { value }))
  await world.clock.advance(hostWaitMs + hostWaitMs + 1000)
  expect(outcome.value).toBeUndefined()
  // The unit's mod takes its mail late, at its first prompt.
  agent.isDeaf = false
  takeMail(agent, 12)
  await world.clock.advance(2000)
  await spawning
  expect(outcome.value).toEqual({ text: expect.stringMatching(/started .*its start assignment \(message [\w-]+\) acknowledged/), isError: false })
})

test('spawn of a live unit whose assign was never sent sends it, and waits for the unit to take it', async ($, on) => {
  const agent = createAgent()
  const world = createSpawnWorld(on, [{ id: 'w5', label: 'wa-spawn:12', path: '/wt/12-spawn-a-unit', hasAgent: true }], { 12: {} }, {},
    repository({ '/wt/12-spawn-a-unit': { branch: '12-spawn-a-unit' } }), agent)
  await world.ready
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ isStarted: true, isPrompted: false }))
  const spawning = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(1000)
  expect(readBox(world, 12, 'new')).toEqual([expect.objectContaining({ kind: 'assign' })])
  // The live session's doorbell delivers it.
  takeMail(agent, 12)
  await world.clock.advance(1000)
  expect(await spawning).toEqual({ text: expect.stringMatching(/its start assignment \(message [\w-]+\) was acknowledged now/), isError: false })
  expect(herdrRuns(world, 'agent start')).toEqual([])
  expect((await callModTool($, 'spawn', { number: 12 })).text).toMatch(/already runs .* in \/wt\/12-spawn-a-unit\.$/)
  expect(readBox(world, 12, 'cur')).toHaveLength(1)
})

test('an assign longer than a message carries starts nothing', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  expect(await callModTool($, 'spawn', { number: 12, instructions: 'x'.repeat(9000) })).toEqual({ text: expect.stringContaining('over the 8000 a message carries'), isError: true })
  expect(herdrRuns(world, 'agent start')).toEqual([])
})

test('a failing herdr call reports herdr\'s own error', async ($, on) => {
  createSpawnWorld(on, [], {}, { herdrResult: { exitCode: 2, stderr: 'agent_not_found' } })
  expect(await callModTool($, 'unit_read', { number: 12 })).toEqual({ text: expect.stringContaining('exit 2: agent_not_found'), isError: true })
})

test('a worktree without a session is reopened, resumes the session it started, and its open assign gets an inform, never a second assign', async ($, on) => {
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
  expect(readBox(world, 12, 'cur')).toEqual([expect.objectContaining({ kind: 'assign' }), expect.objectContaining({ kind: 'inform', body: expect.stringMatching(/^This session was resumed on default model, default effort\. Go on with issue #12 /) })])
})

test('a resumed unit whose assign got its done is sent nothing, and one started before assigns were mail gets its assign', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, {}, checkout)
  await callModTool($, 'spawn', { number: 12 })
  const assign = readBox(world, 12, 'cur')[0]?.id ?? ''
  const done = { v: 1, id: 'd1', kind: 'done', from: '12', to: 'coordinator-sid', issue: 12, in_reply_to: assign, seq: 1, created_at: '2026-01-01T00:00:00.000Z',
    expects: '', attempt: 1, body: 'Finished.', refs: [], author: 'agent' }
  world.files.set(`${records}/mail/coordinator-sid/cur/d1.1.json`, JSON.stringify(done))
  const reopen = async (): Promise<string> => {
    workspaces.length = 0
    checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
    return (await callModTool($, 'spawn', { number: 12 })).text
  }
  expect(await reopen()).not.toContain('acknowledged')
  expect(readBox(world, 12, 'cur')).toHaveLength(1)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...readSpawnRecord(world, 12), assignId: undefined }))
  expect(await reopen()).toMatch(/its start assignment \(message [\w-]+\) acknowledged/)
  expect(readBox(world, 12, 'cur').map(message => message.kind)).toEqual(['assign', 'assign'])
})

test('a reopened unit resumes only a saved conversation: a session that never took a prompt starts again under its own id', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, { herdrEnv: { ...inside, CLAUDE_CONFIG_DIR: '/claude' } }, checkout)
  await callModTool($, 'spawn', { number: 12 })
  const sessionId = herdrRuns(world, 'agent start')[0]?.split(' ').at(-1) ?? ''
  const reopen = async (): Promise<string | undefined> => {
    workspaces.length = 0
    checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
    expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
    return herdrRuns(world, 'agent start').at(-1)
  }
  expect(await reopen()).toContain(`--session-id ${sessionId}`)
  world.files.set(`/claude/projects/-wt-feat-12-spawn-a-unit/${sessionId}.jsonl`, '{}\n')
  expect(await reopen()).toContain(`--resume ${sessionId}`)
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
  const world = createSpawnWorld(on, [{ id: 'w5', label: 'wa-spawn:12', path: '/wt/12-spawn-a-unit' }], { 12: {} }, {},
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
  world.files.set(`${records}/spawn/3.json`, JSON.stringify({ isStarted: true, isPrompted: true }))
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
  const agent = createAgent()
  const server = herdrServer(live, agent) as NonNullable<Options['herdrReply']>
  const closed = { exitCode: 1, stdout: JSON.stringify({ error: { code: 'workspace_not_found', message: 'workspace w4 not found' } }) }
  // The user closes issue 4's workspace after spawn listed the workspaces, before it lists w4's panes.
  const close = (): typeof closed => {
    live.splice(live.findIndex(each => each.id === 'w4'), 1)
    return closed
  }
  const world = createSpawnWorld(on, live, { 12: {} }, { herdrReply: args => args.join(' ') === 'pane list --workspace w4' ? close() : server(args) }, repository(), agent)
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('started'), isError: false })
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
  world.files.set(scopeFile('sid'), buildScope('sid', [7, 8, 12]))
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).not.toBe('')
})

test('the coordinator messages and reads a unit through the mod, and no other session can', async ($, on) => {
  const world = createSpawnWorld(on, [], {})
  markSpawned(world, [12], 'unit-12')
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Take option A.' })).isError).toBe(false)
  expect([...world.files.values()].some(text => text.includes('"body":"Take option A."'))).toBe(true)
  expect(herdrRuns(world, 'agent prompt')).toEqual([])
  expect(await callModTool($, 'unit_read', { number: 12 })).toEqual({ text: 'unit output', isError: false })
})

test('a session without the coordinator role cannot message a unit', async ($, on) => {
  const world = createSpawnWorld(on, [], {}, { session: noFlow })
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'x' })).isError).toBe(true)
  expect(herdrRuns(world, 'agent')).toEqual([])
})

test('unit_read gives a unit that is not idle its visible screen, under a note saying so', async ($, on) => {
  const world = createSpawnWorld(on, [], {}, {}, repository(), { ...createAgent(), readRefusal: 'agent_not_idle' })
  markSpawned(world, [12], 'unit-12')
  expect(await callModTool($, 'unit_read', { number: 12, lines: 80 })).toEqual({
    text: 'Unit not idle: returned only its visible screen (80 lines requested); read again once it is idle for the full history.\nvisible screen', isError: false,
  })
})

test('unit_read passes any other herdr refusal through without a second read', async ($, on) => {
  const world = createSpawnWorld(on, [], {}, {}, repository(), { ...createAgent(), readRefusal: 'agent_not_found' })
  markSpawned(world, [12], 'unit-12')
  expect(await callModTool($, 'unit_read', { number: 12 })).toEqual({ text: expect.stringContaining('agent_not_found'), isError: true })
  expect(herdrRuns(world, 'agent read').filter(line => line.includes('--source visible'))).toEqual([])
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
  expect(unitArgvs(world).map(argv => flagValue(argv, '--permission-mode'))).toEqual(['auto', 'auto'])
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
  expect([flagValue(unitArgvs(world)[0], '--model'), flagValue(unitArgvs(world)[0], '--effort')]).toEqual(['haiku', 'low'])
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
  expect([flagValue(unitArgvs(world)[1], '--model'), flagValue(unitArgvs(world)[1], '--effort')]).toEqual(['haiku', 'low'])
  expect(unitArgvs(world)[1]).toContain('--resume')
})

test('two consecutive red Verifies resume the idle unit on the default model with effort high and tell the coordinator', async ($, on) => {
  const { world } = await spawnCheap($, on)
  await seedVerifies(world, ['fail', 'fail'])
  expect(await readPromptContext($)).toContain('#12 escalated: two consecutive red Verifies')
  expect(herdrRuns(world, 'workspace close')).toHaveLength(1)
  expect(herdrRuns(world, 'agent prompt')).toEqual([])
  expect(readBox(world, 12, 'cur').at(-1)).toMatchObject({ kind: 'inform', body: expect.stringContaining('resumed on default model, effort high (escalated: two consecutive red Verifies)') })
  const restart = unitArgvs(world)[1]
  expect(flagValue(restart, '--effort')).toBe('high')
  expect(restart).toContain('--resume')
  expect(restart).not.toContain('--model')
  expect((await callModTool($, 'plan')).text).toContain('default model, effort high (escalated: two consecutive red Verifies)')
  expect(await readPromptContext($)).not.toContain('escalated')
  expect(herdrRuns(world, 'agent start')).toHaveLength(2)
})

test('a red Verify after a green one, or a unit on the user\'s defaults, is not escalated', async ($, on) => {
  const { world } = await spawnCheap($, on)
  await seedVerifies(world, ['fail', 'pass'])
  expect(await readPromptContext($)).not.toContain('escalated')
  expect(herdrRuns(world, 'workspace close')).toEqual([])
  expect(await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).toMatchObject({ isError: false })
  expect(await callModTool($, 'escalate_unit', { number: 12, reason: 'again' })).toEqual({ text: expect.stringContaining('not escalated'), isError: true })
  expect(herdrRuns(world, 'agent start')).toHaveLength(2)
})

test('a coordinator request escalates an idle unit now, and a working one only once it is idle', async ($, on) => {
  const { world, agent } = await spawnCheap($, on)
  agent.isWorking = true
  expect((await callModTool($, 'escalate_unit', { number: 12, reason: 'an unexpected design decision' })).text).toContain('applied once it is idle')
  expect(await readPromptContext($)).not.toContain('escalated')
  expect(herdrRuns(world, 'workspace close')).toEqual([])
  agent.isWorking = false
  expect(await readPromptContext($)).toContain('#12 escalated: coordinator request: an unexpected design decision')
  expect(flagValue(unitArgvs(world)[1], '--effort')).toBe('high')
  expect(await readPromptContext($)).not.toContain('escalated')
  expect(unitArgvs(world)).toHaveLength(2)
})

test('a pending escalation request is cleared when the sweep finds the unit at the top level', async ($, on) => {
  const { world, agent } = await spawnCheap($, on)
  agent.isWorking = true
  expect((await callModTool($, 'escalate_unit', { number: 12, reason: 'a design decision' })).text).toContain('applied once it is idle')
  const { model, effort, ...topLevel } = readSpawnRecord(world, 12)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify(topLevel))
  agent.isWorking = false
  expect(await readPromptContext($)).not.toContain('escalated')
  expect(unitArgvs(world)).toHaveLength(1)
})

test('a spawn of a unit at the top level drops a stale escalation request instead of keeping it', async ($, on) => {
  const { world, workspaces } = await spawnCheap($, on)
  const { model, effort, ...topLevel } = readSpawnRecord(world, 12)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...topLevel, escalation: 'stale' }))
  workspaces.length = 0
  expect((await callModTool($, 'spawn', { number: 12, reason: 'r' })).isError).toBe(false)
  expect(await readPromptContext($)).not.toContain('escalated')
  expect(unitArgvs(world)).toHaveLength(2)
})

/**
 * Names the session settings every unit starts with while the user leaves continueAtUsageLimit off.
 * @param mode - The unit's permission mode.
 * @returns The settings object.
 */
const unitSettings = (mode: string): Record<string, unknown> => ({
  skillOverrides: { 'auto-mode-setup': 'off' }, permissions: { defaultMode: mode }, promptSuggestionEnabled: false, spinnerTipsEnabled: false,
  feedbackSurveyRate: 0, env: { CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1' }, tui: 'fullscreen',
})

test('a first start, an escalation restart and a resume each carry the same session settings and remove AskUserQuestion', async ($, on) => {
  const { world, workspaces } = await spawnCheap($, on)
  expect((await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).isError).toBe(false)
  workspaces.length = 0
  expect((await callModTool($, 'spawn', { number: 12 })).text).toContain('resumed')
  const argvs = unitArgvs(world)
  expect(argvs).toHaveLength(3)
  for (const argv of argvs) {
    expect(readSettings(argv)).toEqual(unitSettings('default'))
    expect(argv.slice(argv.indexOf('--disallowedTools'), argv.indexOf('--disallowedTools') + 2)).toEqual(['--disallowedTools', 'AskUserQuestion'])
  }
  expect(argvs.map(argv => argv[argv.indexOf('--settings') + 1])).toEqual(Array(3).fill(argvs[0]?.[argvs[0].indexOf('--settings') + 1]))
})

test('the settings\' default mode is the --permission-mode a unit starts in', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await $.classic.UserPromptSubmit({ prompt: 'spawn #12', permission_mode: 'auto' } as never)
  await callModTool($, 'spawn', { number: 12 })
  const argv = unitArgvs(world)[0] ?? []
  expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('auto')
  expect(readSettings(argv)).toEqual(unitSettings('auto'))
})

test('with continueAtUsageLimit on, the settings also continue at a usage limit', { options: { continueAtUsageLimit: true } }, async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await callModTool($, 'spawn', { number: 12 })
  expect(readSettings(unitArgvs(world)[0])).toEqual({ ...unitSettings('default'), autoContinueAtUsageLimit: true })
})
