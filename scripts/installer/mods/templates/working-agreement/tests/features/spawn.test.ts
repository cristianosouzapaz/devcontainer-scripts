import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { coveredSkips, seedUnit } from '../support/parallel-worktrees'

import { createEmptySession } from '../../hooks/domain/records'
import { coordinator, noFlow } from '../support/builders'
import { callModTool, declareFlow, holdSpawnLock, inside, readPromptContext, readRevision, releaseSpawnLock, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { tickMs } from '../../hooks/core/timing'
import { rebindUnitSession } from '../../hooks/core/rebind'
import { busyWaitMs, deriveSessionId, findDeclaringSession } from '../../hooks/core/spawn'
import { escalateIdleUnits } from '../../hooks/core/escalation'
import { buildScope, buildStat, common, coordinatorHost, createTestPort, createWorld, markSpawned, placedFile, records, root, scopeFile } from '../support/world'
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
/** The repository's spawn lock file. */
const spawnLockFile = `${records}/locks/spawn`
/** The clause naming the branch a fresh spawn of issue 12 cut and the base it recorded. */
const createdCut = 'created #12\'s branch feat/12-spawn-a-unit from main, recorded that base in its spawn record, and keeps it'
/** That clause as an unfinished spawn's answer gives it. */
const keptCut = `this spawn already ${createdCut}`
/** The check of that cut. */
const reflogCheck = '`git reflog show feat/12-spawn-a-unit | tail -1`'

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
async function spawnCheap($: Engine, on: On, level: Level = { model: 'haiku', effort: 'low', reason: 'a typo fix' }, options: Options = {}): Promise<SpawnedUnit> {
  const workspaces: Workspace[] = []
  const agent = createAgent()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, options, repository(), agent)
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

// contract: a held spawn lock is waited on and never broken, however old; once its holder ends, the next spawn takes it
test('a held spawn lock is waited on, never broken, and taken once its holder ends', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await world.ready
  holdSpawnLock(world)
  await world.clock.advance(601000)
  const waiting = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(31000)
  expect(await waiting).toEqual({ text: expect.stringContaining('another spawn holds the lock'), isError: true })
  releaseSpawnLock(world)
  const taking = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(1000)
  expect((await taking).text).toContain('started')
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
    // why: the unit's own session starts in the new worktree, on the spawned branch, so the checkout moves there.
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
    // why: issue 7 was cut from issue 5's collecting branch and worked on; issue 5 took it by fast-forward (c2 follows p1) or by a merge commit after moving on (c3 merges c1 and p1), then moved on past it.
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

for (const [name, blockedBy, scope] of [
  ['a sub-issue of an issue with a unit branch starts from that branch\'s tip and declares it as its parent', [], [12]],
  ['a sub-issue of a delegated issue with a unit branch starts from that branch\'s tip and declares it as its parent', [], [5, 12]],
  ['a sub-issue blocked by its own parent starts from the parent\'s tip, since the parent is where it lands, not what it waits for', [{ number: 5, state: 'OPEN' }], [12]],
] as const) {
  // contract: a sub-issue of an issue with a unit branch starts from that branch's tip, whether or not the parent is delegated, and plan names that branch
  test(name, async ($, on) => {
    const { graph } = repository()
    const checkout = repository()
    // why: issue 5's integration branch has moved past main; its own unit is still working.
    checkout.graph = { ...graph, commits: { ...graph?.commits, c2: { parents: ['p1'], files: { a: '1', c: '1' } } }, refs: { ...graph?.refs, 'chore/5-integrate': 'c2' } }
    const world = createSpawnWorld(on, [], { 12: { parent: 5, blockedBy: [...blockedBy] } }, {}, checkout)
    await world.ready
    world.files.set(scopeFile('sid'), buildScope('sid', [...scope]))
    expect((await callModTool($, 'plan')).text).toContain('parent #5 (unit branch chore/5-integrate) · blocked by')
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

// why: issue 5's integration branch holds issue 7's work (p1) and issue 8's (q1) through i1; q2 is issue 8's work cut from issue 7's branch, held by i2; c2 holds issue 7's work only. Issues 7 and 8 have finished units unless they are listed as working.
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
  expect(await spawning).toEqual({ text: expect.stringMatching(/spawn stopped: #12 did not acknowledge its start assignment \(message [\w-]+\) within 120 s of its send after the session's start: its session took no mail/), isError: true })
  expect(herdrRuns(world, 'workspace close')).toEqual([])
  // why: the unit's mod takes the message late, at its next prompt.
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
  // why: an earlier spawn wrote the session id but never isStarted, and that session has declared the issue.
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
  // why: the unit's mod takes its mail late, at its first prompt.
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
  // why: the live session's doorbell delivers it.
  takeMail(agent, 12)
  await world.clock.advance(1000)
  expect(await spawning).toEqual({ text: expect.stringMatching(/its start assignment \(message [\w-]+\) was acknowledged now/), isError: false })
  expect(herdrRuns(world, 'agent start')).toEqual([])
  expect((await callModTool($, 'spawn', { number: 12 })).text).toMatch(/already runs .* in \/wt\/12-spawn-a-unit; its session is live, so no message was sent\.$/)
  expect(readBox(world, 12, 'cur')).toHaveLength(1)
})

test('an assign longer than a message carries starts no session, and a spawn that cut the branch first stops naming it, never refused', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  const outcome = await callModTool($, 'spawn', { number: 12, instructions: 'x'.repeat(9000) })
  expect(outcome).toEqual({ text: expect.stringContaining('over the 8000 a message carries'), isError: true })
  expect(outcome.text).toContain('stopped')
  expect(outcome.text).not.toContain('refused')
  expect(outcome.text).toContain(`before that, this spawn ${createdCut}; check it with ${reflogCheck}`)
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('m0')
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
  // why: the user closed the workspace; git still lists the checkout.
  workspaces.length = 0
  checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('resumed'), isError: false })
  expect(herdrRuns(world, 'worktree open')[0]).toContain('--path /wt/feat/12-spawn-a-unit')
  expect(herdrRuns(world, 'agent start')[1]).toContain(`--resume ${sessionId}`)
  expect(readBox(world, 12, 'cur')).toEqual([expect.objectContaining({ kind: 'assign' }), expect.objectContaining({ kind: 'inform', body: expect.stringMatching(/^This session was resumed on default model, default effort\. Go on with issue #12 /) })])
})

// contract: a spawn of a unit whose record names the session a handoff continued it in resumes that session and keeps it, never the derived one
test('a reopened unit whose handoff rebound its spawn record resumes the recorded session and keeps it', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, {}, checkout)
  await callModTool($, 'spawn', { number: 12 })
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...readSpawnRecord(world, 12), sessionId: 'handed-off' }))
  workspaces.length = 0
  checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('resumed'), isError: false })
  expect(unitArgvs(world)[1]?.slice(-2)).toEqual(['--resume', 'handed-off'])
  expect(readSpawnRecord(world, 12).sessionId).toBe('handed-off')
})

// contract: a resumed unit that still owes a cancel is told to answer that cancel, never to go on with the work it cancelled
test('a resumed unit with a cancel owed gets an inform naming the cancel, not one to go on with its issue', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, {}, checkout)
  await callModTool($, 'spawn', { number: 12 })
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Stop: moved to #13.', kind: 'cancel' })).isError).toBe(false)
  const cancel = [...readBox(world, 12, 'new'), ...readBox(world, 12, 'cur')].find(mail => mail.kind === 'cancel')!
  workspaces.length = 0
  checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('resumed'), isError: false })
  const inform = [...readBox(world, 12, 'new'), ...readBox(world, 12, 'cur')].find(mail => mail.kind === 'inform' && mail.body.includes('resumed'))!
  expect(inform.body).toContain(cancel.id)
  expect(inform.body).not.toContain('Go on with issue')
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
  // why: the user closes issue 4's workspace after spawn listed the workspaces, before it lists w4's panes.
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
    '#7 feat(mod): spawn a unit · unit working · blocked by none · has its unit: spawn reuses it (0/4 units running; spawn rechecks under its lock)',
    '#12 feat(mod): spawn a unit · unit none · blocked by #7 (working) · #12 waits: #7\'s unit is working',
    '#13 feat(mod): spawn a unit · unit none · blocked by #9 (none) · #13 waits: its dependency #9 has no unit branch yet',
    expect.stringMatching(/^#14 feat\(mod\): spawn a unit · unit none · blocked by none · #14 is needs-triage, and only a ready-for-agent issue gets a unit/),
  ])
  expect((await callModTool($, 'plan')).text).toBe(plan.text)
  // why: plan reads the host to count the cap, and changes nothing there.
  expect(herdrRuns(world, '').filter(run => !/^herdr (workspace|pane) list\b/.test(run))).toEqual([])
})

test('plan bases a child of an integrated blocker on the branch that integrated it, as spawn does', async ($, on) => {
  const { graph } = repository()
  const checkout = repository()
  checkout.graph = { ...graph, commits: { ...graph?.commits, c2: { parents: ['p1'], files: { a: '1', c: '1' } } },
    refs: { ...graph?.refs, 'feat/5-collect': 'c2' }, created: { 'feat/7-parent-work': 'feat/5-collect' }, moved: ['feat/7-parent-work'] }
  const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: 7, state: 'OPEN' }] } }, {}, checkout)
  await world.ready
  world.files.set(scopeFile('sid'), buildScope('sid', [12]))
  expect((await callModTool($, 'plan')).text).toBe('#12 feat(mod): spawn a unit · unit none · blocked by #7 (integrated) · can start now from feat/5-collect (0/4 units running; spawn rechecks under its lock)')
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

// contract: a sub-issue whose native parent is delegated with it but has no unit yet is held: spawn starts nothing and plan names the parent as the reason
test('a sub-issue whose delegated parent has no unit is held, never cut from the default branch, and plan names the parent', async ($, on) => {
  const world = createSpawnWorld(on, [], { 5: { labels: ['ready-for-human'] }, 12: { parent: 5 } })
  await world.ready
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('its parent #5 is delegated and has no unit branch yet'), isError: true })
  expect(herdrRuns(world, 'worktree')).toEqual([])
  expect((await callModTool($, 'plan')).text).toContain('#12 feat(mod): spawn a unit · unit none · parent #5 (no unit branch)')
})

test('spawn records the base it cut a unit from, and its result and plan name it, the default branch included', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await world.ready
  expect((await callModTool($, 'spawn', { number: 12 })).text).toContain(' cut from main')
  expect((await callModTool($, 'plan')).text).toMatch(/^#12 feat\(mod\): spawn a unit · unit \w+ · default model, default effort · cut from main · /)
})

test('spawn and plan name the dependency branch a blocked unit was cut from', async ($, on) => {
  const { graph } = repository()
  const checkout = repository()
  checkout.graph = { ...graph, commits: { ...graph?.commits, c2: { parents: ['p1'], files: { a: '1', c: '1' } } },
    refs: { ...graph?.refs, 'feat/5-collect': 'c2' }, created: { 'feat/7-parent-work': 'feat/5-collect' }, moved: ['feat/7-parent-work'] }
  const world = createSpawnWorld(on, [], { 12: { blockedBy: [{ number: 7, state: 'OPEN' }] } }, {}, checkout)
  await world.ready
  expect((await callModTool($, 'spawn', { number: 12 })).text).toContain(' cut from feat/5-collect')
  expect((await callModTool($, 'plan')).text).toContain(' · cut from feat/5-collect · ')
})

test('a unit spawned before spawn recorded its base reads base not recorded in plan, with the reflog check, never today\'s default branch', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} }, {}, repository({ '/wt/12': { branch: '12-spawn-a-unit' } }))
  await world.ready
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ isStarted: true, isPrompted: true }))
  const plan = (await callModTool($, 'plan')).text
  expect(plan).toContain(' · base not recorded: check with `git reflog show 12-spawn-a-unit | tail -1` (the entry may have expired) · ')
  expect(plan).not.toContain('cut from')
})

test('a spawn record that cannot be read gives base unknown in plan, with the reflog check, never base not recorded', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} }, { failRead: path => path.endsWith('/spawn/12.json') }, repository({ '/wt/12': { branch: '12-spawn-a-unit' } }))
  await world.ready
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ isStarted: true, isPrompted: true, base: 'main' }))
  const plan = (await callModTool($, 'plan')).text
  expect(plan).toMatch(/ · base unknown \(its spawn record cannot be read: .+\): check with `git reflog show 12-spawn-a-unit \| tail -1` \(the entry may have expired\) · /)
  expect(plan).not.toContain('base not recorded')
  expect(plan).not.toContain('cut from')
})

test('the recorded base is in the spawn record on disk and survives an escalation rewrite of it', async ($, on) => {
  const { world } = await spawnCheap($, on)
  expect(JSON.parse(world.files.get(`${records}/spawn/12.json`) ?? '{}')).toMatchObject({ base: 'main' })
  expect((await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).isError).toBe(false)
  expect(JSON.parse(world.files.get(`${records}/spawn/12.json`) ?? '{}')).toMatchObject({ base: 'main' })
  expect((await callModTool($, 'plan')).text).toContain(' · cut from main · ')
})

test('spawn on a branch that already exists records no base and says base not recorded with the reflog check', async ($, on) => {
  const world = createSpawnWorld(on, [], { 7: {} })
  await world.ready
  expect((await callModTool($, 'spawn', { number: 7 })).text).toContain('on feat/7-parent-work, base not recorded: check with `git reflog show feat/7-parent-work | tail -1` (the entry may have expired)')
  expect(JSON.parse(world.files.get(`${records}/spawn/7.json`) ?? '{}')).not.toHaveProperty('base')
})

test('a cut that loses to another spawn, whose branch spawn then finds, records no base', async ($, on) => {
  const checkout = repository()
  const lose: Options['failRun'] = argv => {
    if (!argv.includes('update-ref') || !argv.includes('refs/heads/feat/12-spawn-a-unit')) return undefined
    // why: another spawn created the branch between this spawn's look and its create-only write.
    checkout.graph = { ...checkout.graph ?? { commits: {}, refs: {} }, refs: { ...checkout.graph?.refs, 'feat/12-spawn-a-unit': 'p1' } }
    return { exitCode: 1, stderr: 'fatal: reference already exists' }
  }
  const world = createSpawnWorld(on, [], { 12: {} }, { failRun: lose }, checkout)
  await world.ready
  const outcome = await callModTool($, 'spawn', { number: 12 })
  expect(outcome).toEqual({ text: expect.stringContaining('on feat/12-spawn-a-unit, base not recorded'), isError: false })
  expect(JSON.parse(world.files.get(`${records}/spawn/12.json`) ?? '{}')).not.toHaveProperty('base')
})

test('a base the spawn record cannot take after the cut stops spawn, naming the branch it created and the check, never refused', async ($, on) => {
  // why: spawn writes its record through the spawn lock's fenced rename, which its holder answers as failed.
  const world = createSpawnWorld(on, [], { 12: {} }, { renameFails: target => target.endsWith('/spawn/12.json') })
  await world.ready
  const outcome = await callModTool($, 'spawn', { number: 12 })
  expect(outcome.isError).toBe(true)
  expect(outcome.text).toContain('stopped')
  expect(outcome.text).not.toContain('refused')
  expect(outcome.text).toContain('feat/12-spawn-a-unit was created from main, but its spawn record could not take that base')
  expect(outcome.text).toContain('`git reflog show feat/12-spawn-a-unit | tail -1`')
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('m0')
  expect(herdrRuns(world, 'agent start')).toEqual([])
})

test('plan counts the running units against the cap for an issue spawn would start', async ($, on) => {
  const running = [1, 2, 3].map(issue => ({ id: `w${issue}`, label: `wa-spawn:${issue}`, path: `/wt/${issue}`, hasAgent: true }))
  const world = createSpawnWorld(on, running, { 12: {} })
  await world.ready
  expect((await callModTool($, 'plan')).text).toBe('#12 feat(mod): spawn a unit · unit none · blocked by none · can start now from main (3/4 units running; spawn rechecks under its lock)')
})

test('at the cap plan says an issue waits for a free slot and lists it after the startable ones, while an open workspace is reused', async ($, on) => {
  const running = [20, 21, 22, 23].map(issue => ({ id: `w${issue}`, label: `wa-spawn:${issue}`, path: `/wt/${issue}`, hasAgent: true }))
  const world = createSpawnWorld(on, running, { 3: {}, 7: {}, 21: {} })
  await world.ready
  expect((await callModTool($, 'plan')).text.split('\n')).toEqual([
    '#21 feat(mod): spawn a unit · unit none · blocked by none · can start now from main (its workspace is open)',
    '#3 feat(mod): spawn a unit · unit none · blocked by none · waits for a free slot (4/4 units running; spawn rechecks under its lock)',
    '#7 feat(mod): spawn a unit · unit working · blocked by none · has its unit, its workspace closed: waits for a free slot (4/4 units running; spawn rechecks under its lock)',
  ])
})

test('at the cap a unit whose workspace is open is reused by plan and spawn alike, and one whose workspace is closed waits in both', async ($, on) => {
  const running = [7, 21, 22, 23].map(issue => ({ id: `w${issue}`, label: `wa-spawn:${issue}`, path: `/wt/${issue}`, hasAgent: true }))
  const world = createSpawnWorld(on, running, { 7: {}, 8: {} }, {}, repository({ '/wt/7': { branch: 'feat/7-parent-work' } }))
  await world.ready
  world.files.set(`${records}/spawn/7.json`, JSON.stringify({ isStarted: true, isPrompted: true }))
  const plan = (await callModTool($, 'plan')).text
  expect(plan).toMatch(/^#7 .* · has its unit: spawn reuses it \(its workspace is open\)$/m)
  expect(plan).toMatch(/^#8 .* · has its unit, its workspace closed: waits for a free slot \(4\/4 units running; spawn rechecks under its lock\)$/m)
  expect(await callModTool($, 'spawn', { number: 7 })).toEqual({ text: expect.stringContaining('already runs'), isError: false })
  expect(await callModTool($, 'spawn', { number: 8 })).toEqual({ text: expect.stringContaining('units already run, the cap is 4'), isError: true })
})

test('outside herdr plan says whether spawn can reuse a unit is unknown, names only the reason, and never promises reuse', async ($, on) => {
  const world = createSpawnWorld(on, [], { 7: {} }, { herdrEnv: {} })
  await world.ready
  const plan = (await callModTool($, 'plan')).text
  expect(plan).toBe('#7 feat(mod): spawn a unit · unit working · blocked by none · has its unit; whether spawn can reuse it now is unknown: this session does not run inside herdr, which hosts every unit session')
})

test('a failed workspace listing leaves whether spawn can reuse a unit unknown in plan, with the herdr check', async ($, on) => {
  const live = [{ id: 'w1', label: 'wa-spawn:1', path: '/wt/1', hasAgent: true }]
  const server = herdrServer(live) as NonNullable<Options['herdrReply']>
  const world = createSpawnWorld(on, live, { 7: {} }, { herdrReply: args => args.slice(0, 2).join(' ') === 'workspace list' ? { exitCode: 1, stderr: 'herdr: server not running' } : server(args) })
  await world.ready
  const plan = (await callModTool($, 'plan')).text
  expect(plan).toMatch(/^#7 feat\(mod\): spawn a unit · unit working · blocked by none · has its unit; whether spawn can reuse it now is unknown: .*server not running.*; check with `herdr workspace list`$/)
  expect(plan).not.toContain('spawn reuses it')
})

test('four running units, one listed malformed, leave the count unknown in plan and refuse spawn alike, never a free slot', async ($, on) => {
  const live = [1, 2, 3].map(issue => ({ id: `w${issue}`, label: `wa-spawn:${issue}`, path: `/wt/${issue}`, hasAgent: true }))
  const server = herdrServer(live) as NonNullable<Options['herdrReply']>
  const listing = (): string => JSON.stringify({ result: { workspaces: [...live.map(each => ({ workspace_id: each.id, label: each.label, worktree: { checkout_path: each.path } })),
    { workspace_id: 'w4', label: 'wa-spawn:4', worktree: {} }] } })
  const world = createSpawnWorld(on, live, { 12: {} }, { herdrReply: args => args.slice(0, 2).join(' ') === 'workspace list' ? listing() : server(args) })
  await world.ready
  const plan = (await callModTool($, 'plan')).text
  expect(plan).toMatch(/^#12 feat\(mod\): spawn a unit · unit none · blocked by none · would start from main, but running units unknown: .*entry 4 malformed \(wa-spawn:4\).*; check with `herdr workspace list`$/)
  expect(plan).not.toMatch(/\d\/4 units running/)
  const spawned = await callModTool($, 'spawn', { number: 12 })
  expect(spawned).toEqual({ text: expect.stringMatching(/running units unknown: .*entry 4 malformed \(wa-spawn:4\).*; check with `herdr workspace list`/), isError: true })
  expect(spawned.text).not.toContain('stopped')
  expect(await readRevision(world, 'feat/12-spawn-a-unit')).toBe('')
})

for (const [name, reply, reason] of [
  ['herdr fails to list the workspaces', (args: string[]) => args.slice(0, 2).join(' ') === 'workspace list' ? { exitCode: 1, stderr: 'herdr: server not running' } : undefined, 'server not running'],
  ['herdr answers the workspace list without a list', (args: string[]) => args.slice(0, 2).join(' ') === 'workspace list' ? '{"result":{}}' : undefined, 'without a workspace list'],
  ['herdr answers a pane list without a list', (args: string[]) => args.slice(0, 2).join(' ') === 'pane list' ? '{"result":{}}' : undefined, 'without a pane list'],
] as const) {
  test(`plan says the running units are unknown when ${name}, never that the issue can start`, async ($, on) => {
    const live = [{ id: 'w1', label: 'wa-spawn:1', path: '/wt/1', hasAgent: true }]
    const server = herdrServer(live) as NonNullable<Options['herdrReply']>
    const world = createSpawnWorld(on, live, { 12: {} }, { herdrReply: args => reply(args) ?? server(args) })
    await world.ready
    const plan = (await callModTool($, 'plan')).text
    expect(plan).toMatch(new RegExp(`^#12 feat\\(mod\\): spawn a unit · unit none · blocked by none · would start from main, but running units unknown: .*${reason}.*; check with \`herdr workspace list\`$`))
    expect(plan).not.toContain('can start now')
    expect(plan).not.toMatch(/\d\/4 units running/)
  })
}

test('plan for a coordinator that delegates the issues it creates, with none yet, says so', async ($, on) => {
  const world = createSpawnWorld(on, [], {})
  await world.ready
  world.files.set(scopeFile('sid'), JSON.stringify({ v: 1, sessionId: 'sid', issues: [], coversCreated: true, host: coordinatorHost }))
  expect((await callModTool($, 'plan')).text).toBe('This coordinator delegates the issues it creates; none yet.')
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

// contract: an escalation of a unit whose record names the session a handoff continued it in resumes that session and keeps it
test('an escalation of a unit whose handoff rebound its spawn record resumes the recorded session and keeps it', async ($, on) => {
  const { world } = await spawnCheap($, on)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...readSpawnRecord(world, 12), sessionId: 'handed-off' }))
  expect((await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).isError).toBe(false)
  expect(unitArgvs(world)[1]?.slice(-2)).toEqual(['--resume', 'handed-off'])
  expect(readSpawnRecord(world, 12)).toMatchObject({ sessionId: 'handed-off', effort: 'high' })
})

for (const first of ['rebind', 'escalation'] as const) {
  // contract: an escalation and a handoff's rebind serialize on the spawn lock, and whichever runs second keeps the first's changes: the rebound session and the raised level
  test(`an escalation and a handoff's rebind racing on the spawn lock keep each other's changes when the ${first} runs first`, async ($, on) => {
    const { world } = await spawnCheap($, on)
    const before = readSpawnRecord(world, 12)
    const rebind = (): Promise<unknown> => rebindUnitSession(createTestPort(world), [12], String(before.sessionId), 'handed-off')
    const escalate = (): Promise<unknown> => callModTool($, 'escalate_unit', { number: 12, reason: 'r' })
    holdSpawnLock(world)
    const runs = first === 'rebind' ? [rebind(), escalate()] : [escalate(), rebind()]
    releaseSpawnLock(world)
    await Promise.all(runs)
    expect(readSpawnRecord(world, 12)).toMatchObject({ isStarted: true, isPrompted: true, mode: before.mode, startedAt: before.startedAt, assignId: before.assignId,
      sessionId: 'handed-off', effort: 'high', reason: 'escalated: coordinator request: r' })
  })
}

// contract: an escalation request on a working unit reads and writes the spawn record under the spawn lock, so a rebind that honours the lock never lands between its read and its write and is lost
test('an escalation request keeps a handoff\'s rebind that honours the spawn lock', async ($, on) => {
  const record = `${records}/spawn/12.json`
  const race = { reads: 0, isArmed: false, isWritten: false }
  // why: a writer that honours the spawn lock stands in for the rebind; it writes during the request's second record read only while no one holds the lock.
  const { world, agent } = await spawnCheap($, on, undefined, { failRead: path => {
    if (!race.isArmed || path !== record || ++race.reads !== 2) return false
    const isHeld = world.hostLocks.queues.get(`${records}/locks/spawn`)?.some(ticket => ticket.isLocked) ?? false
    if (!isHeld) {
      world.files.set(record, JSON.stringify({ ...readSpawnRecord(world, 12), sessionId: 'handed-off' }))
      race.isWritten = true
    }
    return false
  } })
  agent.isWorking = true
  const before = readSpawnRecord(world, 12)
  race.isArmed = true
  expect((await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).isError).toBe(false)
  race.isArmed = false
  // why: a rebind that found the lock held runs once the request released it.
  if (!race.isWritten) await rebindUnitSession(createTestPort(world), [12], String(before.sessionId), 'handed-off')
  expect(readSpawnRecord(world, 12)).toMatchObject({ isStarted: true, mode: before.mode, startedAt: before.startedAt, sessionId: 'handed-off', escalation: 'r' })
})

for (const [name, isAnswered, expected] of [
  ['answered as failed', true, '#12\'s unit works, and its escalation request was not recorded: rename failed; nothing was changed, so run escalate_unit again'],
  ['never answered', false, '#12\'s unit works, and whether its escalation request was recorded is unknown: its write was not answered (the lock holder ended'],
] as const) {
  // contract: an escalation request's outcome follows what its fenced rename established
  test(`an escalation request whose rename is ${name} says what was established`, async ($, on) => {
    const fault = { isArmed: false }
    // why: an answered failure fails every attempt, as a rename that cannot succeed does; an unanswered one ends the holder at the first.
    const { world, agent } = await spawnCheap($, on, undefined, { renameFails: target => {
      if (!fault.isArmed || target !== `${records}/spawn/12.json`) return false
      if (isAnswered) return true
      fault.isArmed = false
      world.hostLocks.kill(spawnLockFile, 'sid')
      return false
    } })
    agent.isWorking = true
    fault.isArmed = true
    const outcome = await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain(expected)
  })
}

// contract: an escalation request whose spawn lock is lost between staging its write and the rename never renames over a competing writer's record, and never says it was recorded
test('an escalation request that loses the spawn lock before its rename leaves a competing writer\'s record in place', async ($, on) => {
  const race = { isArmed: false, competitor: '' }
  const { world, agent } = await spawnCheap($, on, undefined, { afterWrite: path => {
    if (!race.isArmed || !path.startsWith(`${records}/spawn/.tmp-`)) return
    race.isArmed = false
    world.hostLocks.kill(spawnLockFile, 'sid')
    race.competitor = JSON.stringify({ ...readSpawnRecord(world, 12), sessionId: 'handed-off' })
    world.files.set(`${records}/spawn/12.json`, race.competitor)
  } })
  agent.isWorking = true
  race.isArmed = true
  const outcome = await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })
  expect(world.files.get(`${records}/spawn/12.json`)).toBe(race.competitor)
  expect(outcome.isError).toBe(true)
  expect(outcome.text).not.toContain('recorded and applied')
})

// contract: an escalation clear whose spawn lock is lost between staging its write and the rename never renames over a competing writer's record, and the sweep tells it
test('an escalation clear that loses the spawn lock before its rename leaves a competing writer\'s record in place, and is told', async ($, on) => {
  const race = { isArmed: false, competitor: '' }
  const { world } = await spawnCheap($, on, undefined, { afterWrite: path => {
    if (!race.isArmed || !path.startsWith(`${records}/spawn/.tmp-`)) return
    race.isArmed = false
    world.hostLocks.kill(spawnLockFile, 'sid')
    race.competitor = JSON.stringify({ ...readSpawnRecord(world, 12), sessionId: 'handed-off' })
    world.files.set(`${records}/spawn/12.json`, race.competitor)
  } })
  const { model, effort, ...topLevel } = readSpawnRecord(world, 12)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...topLevel, escalation: 'r' }))
  race.isArmed = true
  const notices = await escalateIdleUnits(createTestPort(world))
  expect(world.files.get(`${records}/spawn/12.json`)).toBe(race.competitor)
  expect(notices.map(each => each.notice)).toEqual([expect.stringMatching(/^#12 is at the top level, (but its escalation request could not be cleared|and whether its escalation request was cleared is unknown)/)])
})

// contract: an escalation clear whose rename goes unanswered says whether it was cleared is unknown, with what to check, and the tick delivers that to the coordinator
test('an escalation clear whose rename goes unanswered reaches the coordinator\'s mailbox as unknown', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await spawnCheap($, on, undefined, { renameFails: target => {
    if (fault.isArmed && target === `${records}/spawn/12.json`) {
      fault.isArmed = false
      world.hostLocks.kill(spawnLockFile, 'sid')
    }
    return false
  } })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  const { model, effort, ...topLevel } = readSpawnRecord(world, 12)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...topLevel, escalation: 'r' }))
  fault.isArmed = true
  await world.clock.advance(tickMs)
  await world.clock.settle()
  const mail = [...world.files.entries()].filter(([path]) => path.startsWith(`${records}/mail/coordinator-sid/new/`)).map(([, text]) => JSON.parse(text) as { body: string })
  expect(mail.map(each => each.body)).toContainEqual(expect.stringContaining('#12 is at the top level, and whether its escalation request was cleared is unknown (the lock holder ended'))
})

// contract: an escalation request whose unit's spawn record was removed while it waited for the spawn lock says no request was recorded, never that it was
test('an escalation request whose unit is retired while it waits for the spawn lock says no request was recorded', async ($, on) => {
  const { world, agent } = await spawnCheap($, on)
  agent.isWorking = true
  holdSpawnLock(world)
  const requested = callModTool($, 'escalate_unit', { number: 12, reason: 'r' })
  await world.clock.advance(busyWaitMs * 3)
  await world.clock.settle()
  world.files.delete(`${records}/spawn/12.json`)
  releaseSpawnLock(world)
  const outcome = await requested
  expect(outcome).toEqual({ isError: true, text: expect.stringContaining('#12 has no unit spawn started any more: its spawn record was removed, or no longer names a started unit, '
    + 'since escalate_unit first read it, so no escalation request was recorded; check it with plan') })
  expect(world.files.has(`${records}/spawn/12.json`)).toBe(false)
})

// contract: a spawn after a handoff takes the superseded session, whose mirror still declares the issue and whose process still runs, for the unit's own, never for another declaring session
test('a spawn after a handoff is not refused by the superseded session that still declares the issue in a live process', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const world = createSpawnWorld(on, workspaces, { 12: {} }, {}, checkout)
  await callModTool($, 'spawn', { number: 12 })
  const first = String(readSpawnRecord(world, 12).sessionId)
  const identity = { branch: 'feat/12-spawn-a-unit', issues: [12] }
  const declare = (session: string): void => {
    world.files.set(`${records}/s/${session}.json`, JSON.stringify({ ...world.sessions.get('sid'), role: undefined, sessionId: session, info: {}, unit: identity,
      units: [{ identity, skills: [], verifyRuns: [], runs: [] }] }))
    world.files.set(`${records}/host/${session}.json`, JSON.stringify(coordinatorHost))
  }
  declare(first)
  expect(await findDeclaringSession(createTestPort(world), 12)).toBe(null)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...readSpawnRecord(world, 12), sessionId: 'elsewhere' }))
  expect(await findDeclaringSession(createTestPort(world), 12)).toBe(first)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...readSpawnRecord(world, 12), sessionId: first }))
  expect((await rebindUnitSession(createTestPort(world), [12], first, 'handed-off')).kind).toBe('checked')
  declare('handed-off')
  expect(await findDeclaringSession(createTestPort(world), 12)).toBe(null)
  workspaces.length = 0
  checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('resumed'), isError: false })
  expect(unitArgvs(world)[1]?.slice(-2)).toEqual(['--resume', 'handed-off'])
  // why: the superseded session resumed on its own in another process declares the issue beside the unit, so it counts again.
  world.files.set('/proc/201/stat', buildStat(201, '7100'))
  world.files.set(`${records}/host/${first}.json`, JSON.stringify({ ...coordinatorHost, pid: 201, pidStart: '7100' }))
  expect(await findDeclaringSession(createTestPort(world), 12)).toBe(first)
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
  expect(flagValue(restart, '--model')).toBe('default')
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

// contract: an escalation recorded on a working unit is applied at the coordinator's next tick once the unit is idle, without waiting for a prompt
test('a coordinator request on a working unit is applied at the coordinator\'s tick once it is idle, with no prompt', async ($, on) => {
  const { world, agent } = await spawnCheap($, on)
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  agent.isWorking = true
  expect((await callModTool($, 'escalate_unit', { number: 12, reason: 'a design decision' })).text).toContain('applied once it is idle')
  agent.isWorking = false
  await world.clock.advance(tickMs)
  await world.clock.settle()
  expect(flagValue(unitArgvs(world)[1], '--effort')).toBe('high')
})

// contract: an escalation that fails at the coordinator's tick is told to the coordinator's own mailbox as an inform from the mod
test('an escalation that fails at the coordinator\'s tick reaches the coordinator\'s mailbox', async ($, on) => {
  const { world, agent } = await spawnCheap($, on)
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  agent.isWorking = true
  await callModTool($, 'escalate_unit', { number: 12, reason: 'a design decision' })
  agent.isWorking = false
  holdSpawnLock(world)
  await world.clock.advance(tickMs)
  await world.clock.advance(31000)
  await world.clock.settle()
  await world.clock.advance(tickMs)
  await world.clock.advance(31000)
  await world.clock.settle()
  const mail = [...world.files.entries()].filter(([path]) => path.startsWith(`${records}/mail/coordinator-sid/new/`)).map(([, text]) => JSON.parse(text) as unknown)
  expect(mail).toEqual([expect.objectContaining({ kind: 'inform', author: 'mod', issue: 12, body: expect.stringContaining('#12 not escalated: another spawn holds the lock') })])
  expect(unitArgvs(world)).toHaveLength(1)
})

// contract: a sweep outside herdr that finds a red unit below the top level tells the coordinator's mailbox it was not escalated, never skips it
test('a red unit whose coordinator runs outside herdr is told not escalated in the coordinator\'s mailbox at its tick', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} }, { herdrEnv: {} })
  await world.ready
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ isStarted: true, isPrompted: true, mode: 'default', sessionId: 'unit-12', model: 'haiku', effort: 'low',
    reason: 'a typo fix' }))
  await seedVerifies(world, ['fail', 'fail'])
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await world.clock.advance(tickMs)
  await world.clock.settle()
  const mail = [...world.files.entries()].filter(([path]) => path.startsWith(`${records}/mail/coordinator-sid/new/`)).map(([, text]) => JSON.parse(text) as unknown)
  expect(mail).toEqual([expect.objectContaining({ kind: 'inform', author: 'mod', issue: 12,
    body: expect.stringContaining('#12 not escalated (two consecutive red Verifies): this session does not run inside herdr') })])
})

// contract: an escalation another sweep completed while this one waited for the spawn lock is no failure: nothing is told
test('a sweep that finds the unit already raised once it holds the spawn lock tells no failure', async ($, on) => {
  const { world, agent } = await spawnCheap($, on)
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  agent.isWorking = true
  await callModTool($, 'escalate_unit', { number: 12, reason: 'a design decision' })
  agent.isWorking = false
  holdSpawnLock(world)
  await world.clock.advance(tickMs)
  const { model, effort, escalation, ...raised } = readSpawnRecord(world, 12)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...raised, effort: 'high' }))
  releaseSpawnLock(world)
  await world.clock.advance(31000)
  await world.clock.settle()
  expect([...world.files.keys()].filter(path => path.startsWith(`${records}/mail/coordinator-sid/new/`))).toEqual([])
  expect(await readPromptContext($)).not.toContain('not escalated')
  expect(unitArgvs(world)).toHaveLength(1)
})

for (const [name, configModel, model, words] of [
  ['the model the engine reports', 'opus', 'opus', 'model opus'],
  ['the account\'s default model when the engine reports none', undefined, 'default', 'the account\'s default model'],
] as const) {
  // contract: an escalated resume passes the user's effective model explicitly with effort high, and escalate_unit names the model it passed
  test(`an escalated resume runs on ${name} with effort high, and the answer names it`, async ($, on) => {
    const { world } = await spawnCheap($, on, undefined, configModel ? { configModel } : {})
    const escalated = await callModTool($, 'escalate_unit', { number: 12, reason: 'a design decision' })
    expect(escalated).toEqual({ text: expect.stringContaining(`#12 escalated: coordinator request: a design decision. It resumed on ${words} with effort high`), isError: false })
    expect([flagValue(unitArgvs(world)[1], '--model'), flagValue(unitArgvs(world)[1], '--effort')]).toEqual([model, 'high'])
  })
}

// contract: an escalation's notice names the resume message it sent, and the unit's mailbox is not said to have told it of the escalation otherwise
test('an escalation that sends a resume message names it in its notice', async ($, on) => {
  const { world } = await spawnCheap($, on)
  const escalated = (await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).text
  const inform = readBox(world, 12, 'cur').find(mail => mail.kind === 'inform')
  expect(escalated).toContain(`with effort high, and its resume message (message ${inform?.id}) told it so.`)
})

// contract: an escalation of a unit whose start assignment is closed sends it nothing, and its notice says so
test('an escalation of a unit whose start assignment is closed says no message was sent', async ($, on) => {
  const { world } = await spawnCheap($, on)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...readSpawnRecord(world, 12), assignClosed: 'integrated without done' }))
  const escalated = (await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).text
  expect(escalated).toContain('with effort high; its start assignment is closed, so no message was sent.')
  expect(escalated).not.toContain('told it so')
  expect(readBox(world, 12, 'cur').map(mail => mail.kind)).toEqual(['assign'])
})

// contract: an escalation of a unit whose start assignment it never took sends no second message, and its notice names the one it waits on
test('an escalation of a unit that never took its start assignment reuses it and says no new message was sent', async ($, on) => {
  const { world } = await spawnCheap($, on)
  const assign = readBox(world, 12, 'cur')[0]?.id
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...readSpawnRecord(world, 12), isPrompted: false }))
  const escalated = (await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).text
  expect(escalated).toContain(`with effort high; its start assignment (message ${assign}) was already in its mailbox, so no new message was sent.`)
  expect(escalated).not.toContain('told it so')
  expect(readBox(world, 12, 'cur').map(mail => mail.kind)).toEqual(['assign'])
})

// contract: an escalation of a unit that never got its start assignment as mail sends it, and its notice does not claim the assignment named the escalation
test('an escalation that sends a start assignment says it does not name the escalation', async ($, on) => {
  const { world } = await spawnCheap($, on)
  const { assignId, ...record } = readSpawnRecord(world, 12)
  world.files.set(`${records}/spawn/12.json`, JSON.stringify(record))
  const escalated = (await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).text
  const assign = readBox(world, 12, 'cur').filter(mail => mail.kind === 'assign').at(-1)
  expect(escalated).toContain(`with effort high; its start assignment (message ${assign?.id}) was sent, which does not name the escalation.`)
  expect(escalated).not.toContain('told it so')
})

// contract: a spawn that cannot read the unit's mailbox sends no second start assignment, and says the mailbox state is unknown
test('a spawn whose mailbox listing fails sends nothing and says whether its assignment is there is unknown', async ($, on) => {
  const workspaces: Workspace[] = [{ id: 'w5', label: 'wa-spawn:12', path: '/wt/feat/12-spawn-a-unit' }]
  const world = createSpawnWorld(on, workspaces, { 12: {} }, { listFailurePrefix: `${records}/mail/12/` },
    repository({ '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }))
  await world.ready
  world.files.set(`${records}/mail/12/cur/a1.1.json`, JSON.stringify({ v: 1, id: 'a1', kind: 'assign' }))
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ isStarted: true, isPrompted: false, assignId: 'a1' }))
  const spawned = await callModTool($, 'spawn', { number: 12 })
  expect(spawned).toEqual({ text: expect.stringContaining('#12\'s session was started, but its mailbox could not be read, so whether its start assignment is in it (message a1) is unknown, and no message was sent'), isError: true })
  expect([...world.files.keys()].filter(path => path.startsWith(`${records}/mail/12/`))).toEqual([`${records}/mail/12/cur/a1.1.json`])
})

/**
 * Makes listing issue 12's read mail fail while the fault is on, as an I/O error that starts mid-test does.
 * @param fault - Whether the fault is on, changed by the test.
 * @returns The world option.
 */
const unreadableCur = (fault: { isOn: boolean }): Options => ({ listFails: directory => fault.isOn && directory === `${records}/mail/12/cur` })

/**
 * Closes issue 12's workspace while git still lists its checkout, so the next spawn reopens and resumes it.
 * @param workspaces - The open workspaces.
 * @param checkout - The repository.
 */
function closeWorkspace(workspaces: Workspace[], checkout: Checkout): void {
  workspaces.length = 0
  checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
}

// contract: a resume that cannot read whether the start assignment was answered sends no inform claiming it is open, and says the state is unknown with where to check
test('a resumed unit whose read mail cannot be listed is sent no inform, and the answer says whether its assignment was answered is unknown', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const fault = { isOn: false }
  const world = createSpawnWorld(on, workspaces, { 12: {} }, unreadableCur(fault), checkout)
  await callModTool($, 'spawn', { number: 12 })
  closeWorkspace(workspaces, checkout)
  fault.isOn = true
  const assign = readBox(world, 12, 'cur')[0]?.id
  const resumed = await callModTool($, 'spawn', { number: 12 })
  fault.isOn = false
  expect(resumed).toEqual({ text: `[working-agreement] spawn stopped: #12's session was started, but ${unreadMailbox(`was answered (message ${assign})`)}`, isError: true })
  expect(readBox(world, 12, 'cur').map(mail => mail.kind)).toEqual(['assign'])
})

// contract: a start whose ack poll cannot read the mailbox says whether the unit took its message is unknown, never that it took no mail
test('a start whose mailbox cannot be read when the ack wait ends says whether the unit took its message is unknown', async ($, on) => {
  const fault = { isOn: true }
  const world = createSpawnWorld(on, [], { 12: {} }, unreadableCur(fault))
  const spawning = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(121000)
  const spawned = await spawning
  const assign = readBox(world, 12, 'cur')[0]?.id
  expect(spawned).toEqual({ text: `[working-agreement] spawn stopped: #12's start assignment (message ${assign}) was sent, but its mailbox could not be read when the 120 s `
    + `ack wait ended, so whether the unit took it is unknown; check ${records}/mail/12 and unit_read. A later spawn waits for this same message and never sends a second one; `
    + `before that, this spawn ${createdCut}, then started #12's session; check it with ${reflogCheck}, then spawn again once the cause is fixed`, isError: true })
})

/**
 * Words spawn's clause for a start message withheld because the unit's mailbox could not be read.
 * @param question - What could not be told of the start assignment.
 * @returns The clause.
 */
const unreadMailbox = (question: string): string =>
  `its mailbox could not be read, so whether its start assignment ${question} is unknown, and no message was sent; check ${records}/mail/12 and spawn again`

for (const [unread, base] of [['reply to its start assignment', 'coordinator-sid'], ['start assignment', '12']] as const) {
  // contract: a resume that cannot read a message its start assignment's state depends on sends nothing, and says the state is unknown with where to check
  test(`a resumed unit whose ${unread} cannot be read is sent nothing, and the answer says whether its assignment was answered is unknown`, async ($, on) => {
    const workspaces: Workspace[] = []
    const checkout = repository()
    const fault = { isOn: false }
    const world = createSpawnWorld(on, workspaces, { 12: {} }, { failRead: path => fault.isOn && path.startsWith(`${records}/mail/${base}/cur/`) }, checkout)
    await callModTool($, 'spawn', { number: 12 })
    const assign = readBox(world, 12, 'cur')[0]?.id ?? ''
    if (base === 'coordinator-sid') {
      world.files.set(`${records}/mail/coordinator-sid/cur/d1.1.json`, JSON.stringify({ v: 1, id: 'd1', kind: 'done', from: '12', to: 'coordinator-sid', issue: 12, in_reply_to: assign,
        seq: 1, created_at: '2026-01-01T00:00:00.000Z', expects: '', attempt: 1, body: 'Finished.', refs: [], author: 'agent' }))
    }
    closeWorkspace(workspaces, checkout)
    fault.isOn = true
    const resumed = await callModTool($, 'spawn', { number: 12 })
    fault.isOn = false
    expect(resumed).toEqual({ text: `[working-agreement] spawn stopped: #12's session was started, but ${unreadMailbox(`was answered (message ${assign})`)}`, isError: true })
    expect(readBox(world, 12, 'cur').map(mail => mail.kind)).toEqual(['assign'])
  })
}

// contract: a resume whose host start failed and whose mailbox cannot be read says the session may not run, never that it was started
test('a resume whose host start failed and whose mailbox cannot be read says the session may not run', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const agent = createAgent()
  const fault = { isOn: false }
  const world = createSpawnWorld(on, workspaces, { 12: {} }, unreadableCur(fault), checkout, agent)
  await callModTool($, 'spawn', { number: 12 })
  closeWorkspace(workspaces, checkout)
  agent.isSlow = true
  fault.isOn = true
  const resuming = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(hostWaitMs + 1000)
  const resumed = await resuming
  expect(resumed.text).toContain('#12\'s session may not run (the host\'s start said: ')
  expect(resumed.text).not.toContain('was started')
})

// contract: escalate_unit whose resume cannot read the unit's mailbox answers stopped, never refused, with the escalation and what is unknown
test('escalate_unit whose resume cannot read the mailbox answers stopped with the escalation and what is unknown', async ($, on) => {
  const fault = { isOn: false }
  const { world } = await spawnCheap($, on, undefined, unreadableCur(fault))
  const assign = readBox(world, 12, 'cur')[0]?.id
  fault.isOn = true
  expect(await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).toEqual({ text: '[working-agreement] escalate_unit stopped: #12 escalated: coordinator request: r. '
    + `It resumed on the account's default model with effort high, but ${unreadMailbox(`was answered (message ${assign})`)}.`, isError: true })
})

// contract: an escalation whose resume start failed and whose mailbox cannot be read never says the unit resumed
test('escalate_unit whose resume start failed and whose mailbox cannot be read says the resume may not run', async ($, on) => {
  const fault = { isOn: false }
  const { world, agent } = await spawnCheap($, on, undefined, unreadableCur(fault))
  const assign = readBox(world, 12, 'cur')[0]?.id
  agent.isSlow = true
  fault.isOn = true
  const escalating = callModTool($, 'escalate_unit', { number: 12, reason: 'r' })
  await world.clock.advance(hostWaitMs + 1000)
  expect(await escalating).toEqual({ text: '[working-agreement] escalate_unit stopped: #12 escalated: coordinator request: r. Its resume on the account\'s default model with effort high '
    + `may not run (the host's start said: herdr agent start: exit 1: timed out waiting for agent startup); ${unreadMailbox(`was answered (message ${assign})`)}.`, isError: true })
})

// contract: an escalation whose resume cannot read the unit's mailbox says the unit was escalated and resumed, and what is unknown, never that it was not escalated
test('an escalation whose resume cannot read the mailbox says it escalated and what is unknown', async ($, on) => {
  const fault = { isOn: false }
  const { world } = await spawnCheap($, on, undefined, unreadableCur(fault))
  fault.isOn = true
  await seedVerifies(world, ['fail', 'fail'])
  const context = await readPromptContext($)
  expect(context).toContain('#12 escalated: two consecutive red Verifies. It resumed on the account\'s default model with effort high, but its mailbox could not be read')
  expect(context).not.toContain('not escalated')
})

// contract: a spawn of a live unit already past its start assignment sends it nothing, and its answer says so
test('a spawn of a live unit already prompted says no message was sent', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await callModTool($, 'spawn', { number: 12 })
  expect((await callModTool($, 'spawn', { number: 12 })).text).toContain('; its session is live, so no message was sent.')
  expect(readBox(world, 12, 'cur')).toHaveLength(1)
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

/**
 * Fails herdr's workspace listing once herdr ran a command starting with these words, and while the fault stays on.
 * @param after - The leading words of the herdr command that turns the fault on, such as `agent start`.
 * @param fault - Whether the fault is on, switched on by that command and off by the test.
 * @returns The world's failing runs.
 */
const listFailsAfter = (after: string, fault: { isOn: boolean }): Options => ({ failRun: argv => {
  if (argv.join(' ').startsWith(`herdr ${after}`)) fault.isOn = true
  return fault.isOn && argv.join(' ').startsWith('herdr workspace list') ? { exitCode: 1, stderr: 'workspace list failed' } : undefined
} })

/**
 * Reads the coordinator's unread mailbox.
 * @param world - The world.
 * @returns Each message.
 */
const readCoordinatorBox = (world: World): unknown[] => [...world.files.entries()]
  .filter(([path]) => path.startsWith(`${records}/mail/coordinator-sid/new/`)).map(([, text]) => JSON.parse(text) as unknown)

/**
 * Runs one of the coordinator's ticks, followed by the escalation sweep's wait for the spawn lock.
 * @param world - The world.
 */
async function runTick(world: World): Promise<void> {
  await world.clock.advance(tickMs)
  await world.clock.advance(31000)
  await world.clock.settle()
}

// contract: a spawn that fails after its host start began answers that it did not finish, never refused, and leaves unit_prompt no starting refusal
test('a spawn whose host listing fails after its start marker did not finish, and leaves unit_prompt no starting refusal', async ($, on) => {
  const fault = { isOn: false }
  const agent: Agent = { ...createAgent(), isSlow: true }
  const world = createSpawnWorld(on, [], { 12: {} }, listFailsAfter('agent start', fault), repository(), agent)
  await world.ready
  const spawning = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(hostWaitMs + 1000)
  expect(await spawning).toEqual({ text: '[working-agreement] spawn did not finish (#12\'s session start was under way when it failed: herdr workspace list: exit 1: '
    + `workspace list failed; ${keptCut}): it may have done part of its work; `
    + 'check unit_read 12 and plan, and `git reflog show feat/12-spawn-a-unit | tail -1` before retrying', isError: true })
  fault.isOn = false
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'News.' })).text).not.toContain('being started by spawn')
})

// contract: a start marker left by a spawn whose process ended (no spawn lock held) does not make unit_prompt refuse as starting
test('a start marker no spawn lock holder stands behind does not refuse unit_prompt', async ($, on) => {
  const { world } = await spawnCheap($, on)
  world.files.set(`${records}/spawn/12.starting`, String(world.clock.now()))
  expect(await callModTool($, 'unit_prompt', { number: 12, text: 'News.' })).toEqual({ text: expect.stringContaining('Sent to #12\'s mailbox'), isError: false })
})

// contract: an orphan start marker is removed once this coordinator holds the spawn lock again, so its own later spawn does not revive it
test('an orphan start marker does not refuse unit_prompt while the coordinator spawns another unit', async ($, on) => {
  const agent = createAgent()
  const world = createSpawnWorld(on, [], { 12: {}, 13: {} }, {}, repository(), agent)
  await world.ready
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  world.files.set(`${records}/spawn/12.starting`, 'sid')
  agent.isSlow = true
  const spawning = callModTool($, 'spawn', { number: 13 })
  await world.clock.advance(hostWaitMs / 2)
  expect(await callModTool($, 'unit_prompt', { number: 12, text: 'News.' })).toEqual({ text: expect.stringContaining('Sent to #12\'s mailbox'), isError: false })
  expect(await callModTool($, 'unit_prompt', { number: 13, text: 'Early.' })).toEqual({ text: expect.stringContaining('retry unit_prompt once spawn has returned'), isError: true })
  await world.clock.advance(hostWaitMs + 300000)
  await spawning
})

// contract: a spawn lock whose state cannot be read never reads as free: unit_prompt sends nothing and says it cannot tell whether spawn is starting the unit
test('a start marker beside a spawn lock that cannot be read refuses unit_prompt as unknown', async ($, on) => {
  const fault = { isOn: false }
  // why: the lock script exits 2 with its error on a lock it cannot open, as its own Bats test of that path shows.
  const { world } = await spawnCheap($, on, undefined, { failRun: argv => fault.isOn && argv[0] === 'perl' && argv[2] === 'list'
    ? { exitCode: 2, stderr: `host-lock: cannot open ${argv[3]}: Is a directory` } : undefined })
  world.files.set(`${records}/spawn/12.starting`, 'sid')
  fault.isOn = true
  expect(await callModTool($, 'unit_prompt', { number: 12, text: 'News.' })).toEqual({ text: expect.stringContaining(`cannot tell whether spawn is starting #12 (the lock ${records}/locks/spawn `
    + `could not be read: host-lock: cannot open ${records}/locks/spawn: Is a directory)`), isError: true })
  expect(readBox(world, 12, 'new')).toEqual([])
})

// contract: a start marker that cannot be read is never read as absent: unit_prompt sends nothing and says it cannot tell
test('a start marker that cannot be read refuses unit_prompt as unknown', async ($, on) => {
  const { world } = await spawnCheap($, on, undefined, { readFailurePrefix: `${records}/spawn/12.starting` })
  world.files.set(`${records}/spawn/12.starting`, 'sid')
  expect(await callModTool($, 'unit_prompt', { number: 12, text: 'News.' })).toEqual({ text: expect.stringContaining('cannot tell whether spawn is starting #12 (its start marker'), isError: true })
})

// contract: an escalation whose session outlives its host's close stops with the session's observed state, never refused, and raises no level
test('an escalation whose session does not end after its close stops and names the session still seen', async ($, on) => {
  const { world } = await spawnCheap($, on, undefined, { failRun: argv => argv.join(' ').startsWith('herdr workspace close') ? { exitCode: 0, stdout: '{}' } : undefined })
  const escalating = callModTool($, 'escalate_unit', { number: 12, reason: 'r' })
  await world.clock.advance(60000)
  expect(await escalating).toEqual({ text: '[working-agreement] escalate_unit stopped: #12\'s host was asked to close its session for the escalation, but a session still ran in its '
    + 'workspace 30 s later, so its level was not raised; check unit_read 12, then run escalate_unit for #12 again', isError: true })
  expect(readSpawnRecord(world, 12)).toMatchObject({ effort: 'low' })
})

// contract: an escalation whose new level cannot be recorded after its session was closed stops, says the session was closed, and that spawn N resumes it on its old level
test('an escalation whose level write fails after the close says the session was closed and that spawn keeps the old level', async ($, on) => {
  const fault = { isOn: false }
  const { world } = await spawnCheap($, on, undefined, { renameFails: target => fault.isOn && target === `${records}/spawn/12.json`,
    failRun: argv => { if (argv.join(' ').startsWith('herdr workspace close')) fault.isOn = true; return undefined } })
  expect(await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).toEqual({ text: '[working-agreement] escalate_unit stopped: #12\'s session was closed for its escalation '
    + '(coordinator request: r), but its new level could not be recorded: rename failed. `spawn 12` resumes it on its old level; run escalate_unit for #12 again to raise it.', isError: true })
  expect(herdrRuns(world, 'workspace close')).toHaveLength(1)
})

// contract: an escalation whose resume fails after the level was written stops, says the level was recorded and the session closed, and names spawn N
test('an escalation whose resume fails after the level write says the level was recorded, the session closed, and to run spawn', async ($, on) => {
  const fault = { isOn: false }
  await spawnCheap($, on, undefined, listFailsAfter('workspace close', fault))
  expect(await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).toEqual({ text: '[working-agreement] escalate_unit stopped: #12\'s escalation to the account\'s default model '
    + 'with effort high was recorded (coordinator request: r), but its session was closed: running units unknown: herdr workspace list: exit 1: workspace list failed; '
    + 'check with `herdr workspace list`. Run `spawn 12` to resume it.', isError: true })
})

// contract: an escalation whose reopened session never acknowledges its resume message says the session runs, and names spawn N
test('an escalation whose reopened session does not acknowledge says it runs and to run spawn', async ($, on) => {
  const { world, agent } = await spawnCheap($, on)
  agent.isDeaf = true
  const escalating = callModTool($, 'escalate_unit', { number: 12, reason: 'r' })
  await world.clock.advance(300000)
  expect(await escalating).toEqual({ text: expect.stringMatching(new RegExp('^\\[working-agreement\\] escalate_unit stopped: #12\'s escalation to the account\'s default model with effort '
    + 'high was recorded \\(coordinator request: r\\), but its session runs: #12 did not acknowledge its resume message .* Run `spawn 12` to resume it\\.$')), isError: true })
})

// contract: an escalation failure notice that was sent is not sent again when its record cannot be cleared
test('an escalation failure notice whose record clear fails after its send is not sent again', async ($, on) => {
  const box: { world?: World } = {}
  // why: the record write after the send fails, as a disk fault that starts once the coordinator's mailbox holds the notice would.
  const { world, agent } = await spawnCheap($, on, undefined, { renameFails: target => target === `${records}/spawn/12.json`
    && [...box.world?.files.keys() ?? []].some(path => path.startsWith(`${records}/mail/coordinator-sid/new/`)) })
  box.world = world
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  agent.isWorking = true
  await callModTool($, 'escalate_unit', { number: 12, reason: 'a design decision' })
  agent.isWorking = false
  holdSpawnLock(world)
  await runTick(world)
  await runTick(world)
  await runTick(world)
  expect(readCoordinatorBox(world)).toEqual([expect.objectContaining({ kind: 'inform', author: 'mod', issue: 12, body: expect.stringContaining('#12 not escalated: another spawn holds the lock') })])
})

// contract: an escalation failure notice whose first send to the coordinator's mailbox fails is sent again at a later tick
test('an escalation failure notice whose first send fails reaches the coordinator\'s mailbox at a later tick', async ($, on) => {
  const fault = { isOn: false }
  const mailFault = { isOn: false }
  const { world, agent } = await spawnCheap($, on, undefined, { ...listFailsAfter('workspace close', fault),
    renameFails: target => mailFault.isOn && target.startsWith(`${records}/mail/coordinator-sid/`) })
  mailFault.isOn = true
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  agent.isWorking = true
  await callModTool($, 'escalate_unit', { number: 12, reason: 'a design decision' })
  agent.isWorking = false
  await runTick(world)
  mailFault.isOn = false
  await runTick(world)
  expect(readCoordinatorBox(world)).toEqual([expect.objectContaining({ kind: 'inform', author: 'mod', issue: 12, body: expect.stringContaining('Run `spawn 12` to resume it.') })])
})

/**
 * Reads the user's unread mailbox bodies.
 * @param world - The world.
 * @returns Each message's body.
 */
const readUserBox = (world: World): string[] => [...world.files.entries()]
  .filter(([path]) => path.startsWith(`${records}/mail/user/new/`)).map(([, text]) => (JSON.parse(text) as { body: string }).body)

// contract: an escalation whose close poll gets a malformed host answer did not finish, never says the session was closed, and raises no level
test('an escalation whose close poll reads a malformed pane list did not finish and raises no level', async ($, on) => {
  const closed = { isOn: false }
  const { world } = await spawnCheap($, on, undefined, { failRun: argv => {
    const line = argv.join(' ')
    if (line.startsWith('herdr workspace close')) {
      closed.isOn = true
      return { exitCode: 0, stdout: '{}' }
    }
    return closed.isOn && line.startsWith('herdr pane list') ? { exitCode: 0, stdout: '{}' } : undefined
  } })
  expect(await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).toEqual({ text: expect.stringContaining('escalate_unit did not finish (#12\'s session was being '
    + 'closed for its escalation, and its level was not raised, when '), isError: true })
  expect(readSpawnRecord(world, 12)).toMatchObject({ effort: 'low' })
})

// contract: an escalation failure notice whose record cannot be written under the spawn lock is told to the user once, with the notice, and still reaches the coordinator once its send succeeds
test('an escalation failure notice that cannot be recorded warns the user once and still reaches the coordinator', async ($, on) => {
  const { world, agent } = await spawnCheap($, on)
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  agent.isWorking = true
  await callModTool($, 'escalate_unit', { number: 12, reason: 'a design decision' })
  agent.isWorking = false
  // why: the spawn record is written only under the spawn lock, so another holder makes the notice's record write fail.
  holdSpawnLock(world)
  await runTick(world)
  await runTick(world)
  await runTick(world)
  await runTick(world)
  expect(readUserBox(world)).toEqual([expect.stringMatching(/^The coordinator could not record #12's escalation failure notice on its spawn record \(another spawn holds the lock.*The notice: #12 not escalated: another spawn holds the lock/)])
  expect(readCoordinatorBox(world)).toEqual([expect.objectContaining({ kind: 'inform', author: 'mod', issue: 12, body: expect.stringContaining('#12 not escalated: another spawn holds the lock') })])
})

// contract: a spawn that loses its spawn lock before the host start, having written nothing, is refused, never stopped
test('a spawn that loses its lock before the host start, having changed nothing, is refused', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const slow = { isOn: false }
  const world = createSpawnWorld(on, workspaces, { 12: {} }, { herdrDelayMs: args => slow.isOn && args[0] === 'workspace' && args[1] === 'list' ? 10000 : 0 }, checkout)
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  closeWorkspace(workspaces, checkout)
  slow.isOn = true
  const spawning = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(5000)
  expect(world.hostLocks.kill(`${records}/locks/spawn`, 'sid')).toBe(true)
  slow.isOn = false
  await world.clock.advance(10000)
  expect(await spawning).toEqual({ text: '[working-agreement] spawn refused: #12\'s session was not started: this process lost the spawn lock before the host start, '
    + 'so nothing was changed; spawn it again', isError: true })
  expect(herdrRuns(world, 'agent start')).toHaveLength(1)
})

/**
 * Makes the next read of the herdr environment throw once the fault is on, as an engine whose environment read fails once does.
 * @param fault - Whether the fault is on, changed by the test and cleared by the failed read.
 * @returns The world option.
 */
const failEnvironment = (fault: { isOn: boolean }): Options => ({ envFails: name => {
  if (!fault.isOn || name !== 'HERDR_PANE_ID') return false
  fault.isOn = false
  return true
} })

/**
 * Seeds issue 12's live unit in workspace w5, its spawn record naming the session spawn derives for it.
 * @param on - The test's hook registration.
 * @param options - The world options.
 * @param agent - The unit session.
 * @param record - The spawn record's fields beside the started flag and the session id.
 * @returns The world.
 */
async function createLiveUnit(on: On, options: Options, agent: Agent, record: Record<string, unknown>): Promise<World> {
  const world = createSpawnWorld(on, [{ id: 'w5', label: 'wa-spawn:12', path: '/wt/12-spawn-a-unit', hasAgent: true }], { 12: {} }, options,
    repository({ '/wt/12-spawn-a-unit': { branch: '12-spawn-a-unit' } }), agent)
  await world.ready
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ isStarted: true, sessionId: await deriveSessionId(common, 12), ...record }))
  return world
}

/**
 * Lists every message of a unit's mailbox, unread and read.
 * @param world - The world.
 * @param issue - The unit's issue.
 * @returns Each message.
 */
const readMail = (world: World, issue: number): { id: string; kind: string; body: string }[] => [...readBox(world, issue, 'new'), ...readBox(world, issue, 'cur')]

/**
 * Makes herdr's worktree open or create fail, as a host that opens no workspace does.
 * @param workspaces - The open workspaces.
 * @param after - What runs once that failure was answered.
 * @returns The world's herdr reply.
 */
const failWorktree = (workspaces: Workspace[], after: () => void = () => undefined): NonNullable<Options['herdrReply']> => {
  const server = herdrServer(workspaces) as NonNullable<Options['herdrReply']>
  return args => {
    if (args[0] !== 'worktree') return server(args)
    after()
    return { exitCode: 1, stdout: JSON.stringify({ error: { code: 'git_failed', message: 'cannot open the worktree' } }) }
  }
}

// contract: a live unit's spawn whose record cannot take the id of the start assignment it sent stops, naming the message and that the record does not hold it, never refused
test('a live unit whose spawn record cannot take its sent start assignment\'s id stops, naming the message', async ($, on) => {
  const box: { world?: World } = {}
  const world = await createLiveUnit(on, { renameFails: target => target === `${records}/spawn/12.json` && !!box.world && readMail(box.world, 12).length > 0 },
    createAgent(), { isPrompted: false })
  box.world = world
  const spawned = await callModTool($, 'spawn', { number: 12 })
  const id = readMail(world, 12)[0]?.id
  expect(spawned).toEqual({ text: `[working-agreement] spawn stopped: rename failed; before that, this spawn sent #12's start assignment (message ${id}) to its running `
    + `session, but its spawn record does not hold that id; check unit_read 12 and ${records}/mail/12 before spawning again`, isError: true })
})

// contract: a live unit's spawn that fails after it recorded the sent start assignment's id stops, naming the recorded message, never refused
test('a live unit whose spawn record fails after it recorded the sent start assignment stops, naming the recorded message', async ($, on) => {
  const box: { world?: World } = {}
  const renames = { count: 0 }
  const world = await createLiveUnit(on, { renameFails: target => target === `${records}/spawn/12.json` && !!box.world && readMail(box.world, 12).length > 0
    && ++renames.count >= 2 }, { ...createAgent(), isLive: true, issue: 12 }, { isPrompted: false })
  box.world = world
  const spawned = await callModTool($, 'spawn', { number: 12 })
  const id = readMail(world, 12)[0]?.id
  expect(spawned).toEqual({ text: `[working-agreement] spawn stopped: rename failed; before that, this spawn sent #12's start assignment (message ${id}) to its running session, `
    + 'then recorded that message in its spawn record, then named its running agent issue-12; a later spawn waits for this same message; check unit_read 12 before '
    + 'spawning again', isError: true })
  expect(readSpawnRecord(world, 12)).toMatchObject({ assignId: id })
})

// contract: a live unit's spawn whose start assignment send throws did not finish, since the message may have been delivered, never refused
test('a live unit whose start assignment send throws did not finish', async ($, on) => {
  await createLiveUnit(on, { failRun: argv => argv[0] === 'ln' && (argv[3] ?? '').startsWith(`${records}/mail/12/new/`)
    ? { exitCode: 1, stderr: 'ln: No space left on device' } : undefined }, createAgent(), { isPrompted: false })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: '[working-agreement] spawn did not finish (#12\'s start assignment was being sent to its running '
    + `session when it failed: ln: No space left on device): it may have done part of its work; check ${records}/mail/12 and unit_read 12 before retrying`, isError: true })
})

// contract: a live unit whose mailbox cannot be read, its session id already recorded, is refused: nothing was sent or written
test('a live unit whose mailbox cannot be read and whose record names its session is refused, its record unchanged', async ($, on) => {
  const world = await createLiveUnit(on, { listFailurePrefix: `${records}/mail/12/` }, createAgent(), { isPrompted: false, assignId: 'a1' })
  world.files.set(`${records}/mail/12/cur/a1.1.json`, JSON.stringify({ v: 1, id: 'a1', kind: 'assign' }))
  const before = world.files.get(`${records}/spawn/12.json`)
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: `[working-agreement] spawn refused: #12's session runs, but ${unreadMailbox('is in it (message a1)')}`,
    isError: true })
  expect(world.files.get(`${records}/spawn/12.json`)).toBe(before)
})

// contract: an over-long start assignment for a unit with a pending close is refused before any write, its spawn record byte-identical
test('an over-long start assignment for a unit whose close is pending is refused and leaves its spawn record as it was', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} })
  await callModTool($, 'spawn', { number: 12 })
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...readSpawnRecord(world, 12), isClosing: true }))
  const before = world.files.get(`${records}/spawn/12.json`)
  expect(await callModTool($, 'spawn', { number: 12, instructions: 'x'.repeat(9000) })).toEqual({ text: expect.stringMatching(new RegExp('^\\[working-agreement\\] spawn refused: '
    + 'the start assignment is \\d+ characters, over the 8000 a message carries: put the rest in an issue comment and send its URL$')), isError: true })
  expect(world.files.get(`${records}/spawn/12.json`)).toBe(before)
})

// contract: a live, already-prompted unit's pending close is dropped by a recorded write, and a later failure stops naming it, never refused
test('a live unit whose pending close was dropped stops on a later failure, naming the drop', async ($, on) => {
  const armed = { isOn: false, lists: 0 }
  const world = createSpawnWorld(on, [], { 12: {} }, { failRun: argv => armed.isOn && argv.join(' ').startsWith('herdr workspace list') && ++armed.lists >= 2
    ? { exitCode: 1, stderr: 'workspace list failed' } : undefined })
  await callModTool($, 'spawn', { number: 12 })
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ ...readSpawnRecord(world, 12), isClosing: true }))
  armed.isOn = true
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: '[working-agreement] spawn stopped: herdr workspace list: exit 1: workspace list failed; before that, '
    + 'this spawn dropped #12\'s pending close from its spawn record; check unit_read 12 and plan before spawning again', isError: true })
  expect(readSpawnRecord(world, 12)).not.toHaveProperty('isClosing')
})

// contract: a herdr environment read that throws inside the start, before any write, is refused and writes no spawn record
test('a spawn whose herdr environment read throws before the start is refused and writes no spawn record', async ($, on) => {
  const fault = { isOn: false }
  // why: spawn lists the host's workspaces once it holds the spawn lock, after its host check read the environment.
  const world = createSpawnWorld(on, [], { 7: {} }, { ...failEnvironment(fault), failRun: argv => {
    if (argv.join(' ').startsWith('herdr workspace list')) fault.isOn = true
    return undefined
  } })
  await world.ready
  const spawned = await callModTool($, 'spawn', { number: 7 })
  expect(world.files.has(`${records}/spawn/7.json`)).toBe(false)
  expect(spawned).toEqual({ text: '[working-agreement] spawn refused: no implementation for env.get; nothing was changed; spawn it again', isError: true })
  expect(herdrRuns(world, 'agent start')).toEqual([])
})

// contract: a spawn record read that throws before the start, with nothing written, is refused and leaves the record byte-identical
test('a resume whose spawn record read throws before the start is refused and leaves the record as it was', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const fault = { isOn: false, isArmed: false }
  // why: spawn looks for the session's saved conversation right before the start reads the record it restores on a failed start.
  const world = createSpawnWorld(on, workspaces, { 12: {} }, { failRead: path => fault.isOn && path === `${records}/spawn/12.json`, envFails: name => {
    if (fault.isArmed && name === 'CLAUDE_CONFIG_DIR') fault.isOn = true
    return false
  } }, checkout)
  await callModTool($, 'spawn', { number: 12 })
  closeWorkspace(workspaces, checkout)
  const { sessionId, ...record } = readSpawnRecord(world, 12)
  expect(sessionId).toBeDefined()
  world.files.set(`${records}/spawn/12.json`, JSON.stringify(record))
  const before = world.files.get(`${records}/spawn/12.json`)
  fault.isArmed = true
  const resumed = await callModTool($, 'spawn', { number: 12 })
  fault.isOn = false
  expect(world.files.get(`${records}/spawn/12.json`)).toBe(before)
  expect(resumed).toEqual({ text: '[working-agreement] spawn refused: no implementation for fs.read; nothing was changed; spawn it again', isError: true })
  expect(herdrRuns(world, 'agent start')).toHaveLength(1)
})

// contract: a start marker write that fails on a unit with nothing changed is refused, and no session start runs
test('a spawn whose start marker cannot be written is refused and starts no session', async ($, on) => {
  const world = createSpawnWorld(on, [], { 7: {} }, { renameFails: target => target === `${records}/spawn/7.starting` })
  await world.ready
  expect(await callModTool($, 'spawn', { number: 7 })).toEqual({ text: '[working-agreement] spawn refused: rename failed; nothing was changed; spawn it again', isError: true })
  expect(herdrRuns(world, 'agent start')).toEqual([])
  expect(world.files.has(`${records}/spawn/7.json`)).toBe(false)
})

// contract: a spawn record write that fails just before the host start, with nothing changed, is refused, never did not finish, and no session start runs
test('a resume whose spawn record cannot be written before the host start is refused and starts no session', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const fault = { isOn: false }
  const world = createSpawnWorld(on, workspaces, { 12: {} }, { renameFails: target => fault.isOn && target === `${records}/spawn/12.json` }, checkout)
  await callModTool($, 'spawn', { number: 12 })
  closeWorkspace(workspaces, checkout)
  const before = world.files.get(`${records}/spawn/12.json`)
  fault.isOn = true
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: '[working-agreement] spawn refused: rename failed; nothing was changed; spawn it again', isError: true })
  expect(world.files.get(`${records}/spawn/12.json`)).toBe(before)
  expect(herdrRuns(world, 'agent start')).toHaveLength(1)
})

// contract: a herdr environment read that throws before the spawn lock is refused: nothing was changed
test('a spawn whose herdr environment read throws before the lock is refused, nothing changed', async ($, on) => {
  const fault = { isOn: false }
  const world = createSpawnWorld(on, [], { 12: {} }, failEnvironment(fault))
  await world.ready
  fault.isOn = true
  const spawned = await callModTool($, 'spawn', { number: 12 })
  expect(spawned).toEqual({ text: '[working-agreement] spawn refused: no implementation for env.get; nothing was changed; spawn it again', isError: true })
  expect(world.files.has(`${records}/spawn/12.json`)).toBe(false)
})

// contract: a branch creation that fails after its placement was recorded stops, naming the placement, never refused
test('a spawn whose branch cannot be created after its placement was recorded stops, naming the placement', async ($, on) => {
  const world = createSpawnWorld(on, [], { 12: {} }, { failRun: argv => argv.includes('update-ref') ? { exitCode: 1, stderr: 'fatal: update-ref failed' } : undefined })
  await world.ready
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: '[working-agreement] spawn stopped: #12\'s branch feat/12-spawn-a-unit could not be created '
    + '(fatal: update-ref failed); before that, this spawn recorded its placement at m0; spawn again once the cause is fixed', isError: true })
  expect(world.files.has(placedFile('feat/12-spawn-a-unit', 'm0'))).toBe(true)
})

// contract: after a failed host start, a workspace listing that holds no workspace list leaves the start unresolved: did not finish, never refused
test('a failed host start whose workspace listing is malformed did not finish', async ($, on) => {
  const workspaces: Workspace[] = []
  const armed = { isOn: false }
  const server = failWorktree(workspaces, () => { armed.isOn = true })
  createSpawnWorld(on, workspaces, { 12: {} }, { herdrReply: args => armed.isOn && args[0] === 'workspace' && args[1] === 'list' ? '{}' : server(args) })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: '[working-agreement] spawn did not finish (#12\'s session start was under way when it failed: '
    + `herdr answered workspace list without a workspace list; ${keptCut}): it may have done part of its work; check unit_read 12 and plan, and ${reflogCheck} before retrying`,
  isError: true })
})

// contract: after a failed host start with no workspace, a worktree list that cannot be read leaves the start unresolved, naming git worktree list
test('a failed host start with no workspace and an unreadable worktree list did not finish, naming git worktree list', async ($, on) => {
  const workspaces: Workspace[] = []
  const armed = { isOn: false }
  createSpawnWorld(on, workspaces, { 12: {} }, { herdrReply: failWorktree(workspaces, () => { armed.isOn = true }),
    failRun: argv => armed.isOn && argv[0] !== 'herdr' && argv.includes('worktree') && argv.includes('list') ? { exitCode: 1, stderr: 'fatal: cannot list worktrees' } : undefined })
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: '[working-agreement] spawn did not finish (#12\'s session start was under way when it failed: '
    + 'the host\'s start said: herdr worktree create: exit 1: cannot open the worktree, and it opened no workspace; `git worktree list` could not be read to find '
    + `a checkout of feat/12-spawn-a-unit; ${keptCut}): it may have done part of its work; check unit_read 12 and plan, and ${reflogCheck} before retrying`, isError: true })
})

// contract: after a failed host start with no workspace, a checkout that existed before is described as found, never as created by this attempt
test('a failed host start on a checkout that existed before says the checkout exists, never that this attempt created it', async ($, on) => {
  const workspaces: Workspace[] = []
  createSpawnWorld(on, workspaces, { 12: {} }, { herdrReply: failWorktree(workspaces) }, repository({ '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }))
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: '[working-agreement] spawn refused: #12\'s session was not started: its host opened no workspace for '
    + 'it (herdr worktree open: exit 1: cannot open the worktree), and a checkout of feat/12-spawn-a-unit exists at /wt/feat/12-spawn-a-unit, which this call did not create; '
    + 'a later spawn opens it', isError: true })
})

// contract: a failed host start whose worktree create left a checkout stops, naming the checkout this attempt created and the branch it cut
test('a failed host start whose worktree create added a checkout stops, naming the checkout it created', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  createSpawnWorld(on, workspaces, { 12: {} }, { herdrReply: failWorktree(workspaces, () => {
    checkout.worktrees = { ...checkout.worktrees, '/wt/feat/12-spawn-a-unit': { branch: 'feat/12-spawn-a-unit' } }
  }) }, checkout)
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: '[working-agreement] spawn stopped: #12\'s session was not started: its host opened no workspace for '
    + 'it (herdr worktree create: exit 1: cannot open the worktree), and a checkout of feat/12-spawn-a-unit exists at /wt/feat/12-spawn-a-unit, created by this attempt; '
    + `before that, this spawn ${createdCut}; a later spawn opens that checkout`, isError: true })
})

for (const [name, before] of [['no spawn record', undefined], ['a hand-formatted spawn record', '{\n  "isStarted": false,\n  "note": "kept"\n}\n']] as const) {
  // contract: a start that opened no workspace puts the spawn record back byte for byte, or leaves no record where there was none, and is refused
  test(`a failed host start on a unit with ${name} leaves the record exactly as it was`, async ($, on) => {
    const workspaces: Workspace[] = []
    const world = createSpawnWorld(on, workspaces, { 7: {} }, { herdrReply: failWorktree(workspaces) })
    await world.ready
    if (before !== undefined) world.files.set(`${records}/spawn/7.json`, before)
    expect(await callModTool($, 'spawn', { number: 7 })).toEqual({ text: '[working-agreement] spawn refused: #7\'s session was not started: its host opened no workspace for '
      + 'it (herdr worktree create: exit 1: cannot open the worktree), and no checkout of feat/7-parent-work exists', isError: true })
    expect(world.files.get(`${records}/spawn/7.json`)).toBe(before)
  })
}

// contract: an ack timeout's answer names the branch this spawn cut and the session it started, beside the message it waited for
test('an ack timeout names the branch this spawn cut', async ($, on) => {
  const agent: Agent = { ...createAgent(), isDeaf: true }
  const world = createSpawnWorld(on, [], { 12: {} }, {}, repository(), agent)
  const spawning = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(121000)
  const spawned = await spawning
  const id = readMail(world, 12)[0]?.id
  expect(spawned).toEqual({ text: `[working-agreement] spawn stopped: #12 did not acknowledge its start assignment (message ${id}) within 120 s of its send after the `
    + 'session\'s start: its session took no mail, so it does not work on the issue. Read it with unit_read; a later spawn waits for this same message and never sends a '
    + `second one; before that, this spawn ${createdCut}, then started #12's session; check it with ${reflogCheck}, then spawn again once the cause is fixed`, isError: true })
})

// contract: a live unit's rename that fails after its start assignment was sent and recorded did not finish, naming the rename under way
test('a live unit whose agent rename fails did not finish, naming the rename', async ($, on) => {
  const world = await createLiveUnit(on, { failRun: argv => argv.join(' ').startsWith('herdr agent rename') ? { exitCode: 1, stderr: 'rename refused' } : undefined },
    { ...createAgent(), isLive: true, issue: 12 }, { isPrompted: false })
  const spawned = await callModTool($, 'spawn', { number: 12 })
  const id = readMail(world, 12)[0]?.id
  expect(spawned).toEqual({ text: '[working-agreement] spawn did not finish (#12\'s running agent was being named issue-12 when it failed: herdr agent rename: exit 1: '
    + `rename refused; this spawn already sent #12's start assignment (message ${id}) to its running session, then recorded that message in its spawn record): it may have `
    + 'done part of its work; check unit_read 12 before retrying', isError: true })
})

// contract: a start marker left in place after a later failure is a change: the spawn stops naming it, never refused as nothing changed
test('a spawn whose start marker cannot be removed after its record write failed stops, naming the marker', async ($, on) => {
  const world = createSpawnWorld(on, [], { 7: {} }, { renameFails: target => target === `${records}/spawn/7.json`, removeExitCode: 1 })
  await world.ready
  expect(await callModTool($, 'spawn', { number: 7 })).toEqual({ text: `[working-agreement] spawn stopped: rename failed; before that, this spawn left its start marker ${records}/`
    + 'spawn/7.starting in place, since removing it failed (delete failed); the next spawn lock hold removes that marker; spawn it again', isError: true })
  expect(herdrRuns(world, 'agent start')).toEqual([])
})

// contract: an escalation whose resume fails on its record write before the host start stops naming the close and the level, never "nothing was changed"
test('an escalation whose resume cannot write the spawn record stops, naming the close and the recorded level', async ($, on) => {
  const fault = { isArmed: false, renames: 0 }
  await spawnCheap($, on, undefined, { renameFails: target => fault.isArmed && target === `${records}/spawn/12.json` && ++fault.renames >= 2 })
  fault.isArmed = true
  expect(await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })).toEqual({ text: '[working-agreement] escalate_unit stopped: #12\'s escalation to the account\'s '
    + 'default model with effort high was recorded (coordinator request: r), but its session was closed: rename failed. Run `spawn 12` to resume it.', isError: true })
})

// contract: an escalation whose resume cannot read the mailbox nor see its session afterwards never says the unit resumed: its start did not finish
test('an escalation whose resume start stays unresolved never says the unit resumed', async ($, on) => {
  const fault = { isArmed: false, isOn: false }
  const { world } = await spawnCheap($, on, undefined, { listFails: directory => fault.isArmed && directory === `${records}/mail/12/cur`, failRun: argv => {
    const line = argv.join(' ')
    if (fault.isArmed && line.startsWith('herdr agent start')) fault.isOn = true
    return fault.isOn && line.startsWith('herdr workspace list') ? { exitCode: 1, stderr: 'workspace list failed' } : undefined
  } })
  fault.isArmed = true
  const escalated = await callModTool($, 'escalate_unit', { number: 12, reason: 'r' })
  const assign = readBox(world, 12, 'cur')[0]?.id
  const notice = '#12\'s escalation to the account\'s default model with effort high was recorded (coordinator request: r), but its resume did not finish, and its '
    + 'session is in a state that could not be read (herdr workspace list: exit 1: workspace list failed): #12\'s session start was under way when it failed: #12\'s session '
    + `was started, but ${unreadMailbox(`was answered (message ${assign})`)}. Then run \`spawn 12\` to resume it.`
  expect(escalated).toEqual({ text: `[working-agreement] escalate_unit did not finish (${notice}): it may have done part of its work; check unit_read 12 and plan before retrying`,
    isError: true })
})

// contract: a start whose marker removal never answers did not finish, naming the session it started and the marker to check, never a success
test('a start whose start marker removals go unanswered did not finish, naming the started session and the marker', async ($, on) => {
  const path = `${records}/spawn/12.starting`
  // why: the engine cuts or times out the rm, so its call rejects with no exit code.
  const world = createSpawnWorld(on, [], { 12: {} }, { failRun: argv => {
    if (argv[0] === 'rm' && argv.at(-1) === path) throw new Error('rm timed out')
    return undefined
  } })
  const spawned = await callModTool($, 'spawn', { number: 12 })
  const id = readMail(world, 12)[0]?.id
  expect(spawned).toEqual({ text: `[working-agreement] spawn did not finish (#12's start marker ${path} was being removed when it failed: rm could not run: no implementation `
    + `for process.run; ${keptCut}, then sent #12's start assignment (message ${id}) to its session, then recorded that message in its spawn record, then started #12's `
    + `session, then recorded its acknowledgement in its spawn record): it may have done part of its work; check ${path}, and ${reflogCheck} before retrying`, isError: true })
})

// contract: an unread mailbox after a start whose strict look sees no session records the workspace as opened, never a session started
test('a resume whose mailbox cannot be read and whose session never came up says its workspace was opened, never that a session started', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const agent = createAgent()
  const fault = { isOn: false }
  const world = createSpawnWorld(on, workspaces, { 12: {} }, unreadableCur(fault), checkout, agent)
  await callModTool($, 'spawn', { number: 12 })
  const assign = readBox(world, 12, 'cur')[0]?.id
  closeWorkspace(workspaces, checkout)
  Object.assign(agent, { isAbsent: true, isLive: false })
  fault.isOn = true
  const resuming = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(hostWaitMs + 1000)
  const resumed = await resuming
  fault.isOn = false
  expect(resumed).toEqual({ text: '[working-agreement] spawn stopped: #12\'s session may not run (the host\'s start said: herdr agent start: exit 1: timed out waiting for '
    + `agent startup), but ${unreadMailbox(`was answered (message ${assign})`)}; before that, this spawn opened #12's workspace, where no session runs; check unit_read 12 `
    + 'and plan before spawning again', isError: true })
  expect(resumed.text).not.toContain('started #12')
})

// contract: an ack timeout whose pane list is no list closes no workspace and did not finish, never a false close
test('an ack timeout whose pane list is malformed closes no workspace and did not finish', async ($, on) => {
  const armed = { isOn: false }
  const agent: Agent = { ...createAgent(), isDeaf: true }
  const world = createSpawnWorld(on, [], { 12: {} }, { failRun: argv => armed.isOn && argv.join(' ').startsWith('herdr pane list') ? { exitCode: 0, stdout: '{}' } : undefined },
    repository(), agent)
  const spawning = callModTool($, 'spawn', { number: 12 })
  await world.clock.advance(119000)
  armed.isOn = true
  await world.clock.advance(2000)
  const id = readMail(world, 12)[0]?.id
  expect(await spawning).toEqual({ text: '[working-agreement] spawn did not finish (#12\'s session start was under way when it failed: herdr answered pane list of '
    + `workspace w10 without a pane list; ${keptCut}, then sent #12's start assignment (message ${id}) to its session, then recorded that message in its spawn record, `
    + `then recorded in its spawn record that the unit has not taken it): it may have done part of its work; check unit_read 12 and plan, and ${reflogCheck} before retrying`,
  isError: true })
  expect(herdrRuns(world, 'workspace close')).toEqual([])
})

// contract: a resume whose owed-mail read fails sends no inform telling the unit to go on, and did not finish
test('a resume whose owed mail cannot be read sends no go-on inform and did not finish', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const fault = { isArmed: false, lists: 0 }
  const world = createSpawnWorld(on, workspaces, { 12: {} }, { listFails: directory => fault.isArmed && directory === `${records}/mail/12/cur` && ++fault.lists === 3 }, checkout)
  await callModTool($, 'spawn', { number: 12 })
  closeWorkspace(workspaces, checkout)
  fault.isArmed = true
  const resumed = await callModTool($, 'spawn', { number: 12 })
  fault.isArmed = false
  expect(resumed).toEqual({ text: '[working-agreement] spawn did not finish (#12\'s session start was under way when it failed: whether #12 owes a cancel could not be '
    + `read (could not list ${records}/mail/12/cur; check with ls ${records}/mail/12/cur), so no resume message was sent): it may have done part of its work; `
    + 'check unit_read 12 and plan before retrying', isError: true })
  expect(readMail(world, 12).map(mail => mail.kind)).toEqual(['assign'])
})

// contract: a repository root read that fails is never reported as being outside a git repository
test('a spawn whose repository root read fails is refused without saying it is outside a git repository', async ($, on) => {
  const fault = { isOn: false }
  const world = createSpawnWorld(on, [], { 12: {} }, { beforeRun: argv => {
    if (fault.isOn && argv.includes('--show-toplevel')) throw new Error('Resource temporarily unavailable')
  } })
  await world.ready
  fault.isOn = true
  const spawned = await callModTool($, 'spawn', { number: 12 })
  fault.isOn = false
  expect(spawned).toEqual({ text: '[working-agreement] spawn refused: the repository root could not be read: git could not run: no implementation for process.run; '
    + 'nothing was changed; spawn it again', isError: true })
  expect(spawned.text).not.toContain('not in a git repository')
})

// contract: a spawn record rename the lock holder never answers may have landed: the spawn did not finish, never refused as unwritten
test('a resume whose spawn record rename is cut mid-call did not finish', async ($, on) => {
  const workspaces: Workspace[] = []
  const checkout = repository()
  const fault = { isOn: false }
  // why: the holder ends during the fenced rename, so its answer never comes.
  const world = createSpawnWorld(on, workspaces, { 12: {} }, { renameFails: target => {
    if (fault.isOn && target === `${records}/spawn/12.json`) {
      fault.isOn = false
      world.hostLocks.kill(spawnLockFile, 'sid')
    }
    return false
  } }, checkout)
  await callModTool($, 'spawn', { number: 12 })
  closeWorkspace(workspaces, checkout)
  fault.isOn = true
  const resumed = await callModTool($, 'spawn', { number: 12 })
  fault.isOn = false
  expect(resumed).toEqual({ text: `[working-agreement] spawn did not finish (#12's spawn record was being written when it failed: the lock holder ended before it answered `
    + `the rename of ${records}/spawn/12.json, so whether it was written is unknown): it may have done part of its work; check ${records}/spawn/12.json before retrying`, isError: true })
  expect(herdrRuns(world, 'agent start')).toHaveLength(1)
})
