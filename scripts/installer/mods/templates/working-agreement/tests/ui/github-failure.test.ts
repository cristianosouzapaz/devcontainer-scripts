import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { declareFlow, endTurn, readCurrentStep, readFlowStatus, readPromptContext, readStatusRow } from '../support/helpers'
import { diagnosed, diagnosisComment, noFlow } from '../support/builders'
import { refreshView } from '../../hooks/core/pane-view'
import { runWithDeadline } from '../../hooks/lib/process'
import type { ProcessPort } from '../../hooks/lib/process'
import { createTestPort, createWorld } from '../support/world'
import type { Gate, Options, World } from '../support/world'
import type { EnginePort } from '../../hooks/core/engine-port'

// A Small feature on #1 whose Spec is done on GitHub's labels.
const specDone: Options = { unit: { skills: ['grilling', 'to-spec'] }, issueLabels: { 1: ['ready-for-agent'] } }
// Past the issue sync's TTL.
const pastTtl = 61000

/**
 * Reads the step lines of `/flow status`.
 * @param status - The status text.
 * @returns Every step's line, in order.
 */
const stepLines = (status: string | undefined): string[] => (status ?? '').split('\n').filter(line => /^[✓▸○↷✗●?] /u.test(line))

/**
 * Reads the Flow pane's GitHub row.
 * @param world - The test world.
 * @returns The row's text, or undefined when the pane shows none.
 */
const paneGithub = (world: World): string | undefined => world.views.at(-1)?.meta.find(row => row.key === 'GitHub')?.value

/**
 * Reads the GitHub row of `/flow status`.
 * @param status - The status text.
 * @returns The row.
 */
const statusGithub = (status: string | undefined): string => readStatusRow(status, 'GitHub')

/**
 * Counts the reachability probes the mod has run.
 * @param world - The world.
 * @returns The number of `gh api user` runs.
 */
const countProbes = (world: World): number => world.runs.filter(run => run.startsWith('gh api user')).length

for (const [failure, fail, reason] of [
  ['the reachability probe', (options: Options) => { options.failing = 'gh api user' }, 'gh could not run: '],
  ['the issue read', (options: Options) => { options.missing = [1] }, 'not found'],
  ['gh authentication', (options: Options) => { options.isLoggedOut = true }, 'gh auth login'],
] as const) {
  test(`a failed sync on ${failure} keeps Spec done, the later steps and the next action unchanged`, async ($, on) => {
    const options: Options = { ...specDone }
    const world = createWorld(on, { branch: 'feat' }, options)
    await world.clock.advance(pastTtl)
    const steps = stepLines(await readFlowStatus($))
    const context = await readPromptContext($)
    fail(options)
    await world.clock.advance(pastTtl)
    expect(await readPromptContext($)).toBe(context)
    const status = await readFlowStatus($)
    expect(status).toContain('✓ Spec')
    expect(stepLines(status)).toEqual(steps)
    expect(await readCurrentStep($)).toBe('Code')
  })

  test(`a failed sync on ${failure} shows one GitHub row with its reason and the facts' read time until a read succeeds`, async ($, on) => {
    const options: Options = { ...specDone }
    const world = createWorld(on, { branch: 'feat' }, options)
    await world.clock.advance(pastTtl)
    await readFlowStatus($)
    expect(paneGithub(world)).toBeUndefined()
    fail(options)
    // Past the second within which a forced read reuses the last probe.
    await world.clock.advance(2000)
    const status = await readFlowStatus($)
    expect(paneGithub(world)).toMatch(/^read failed \(.+\) · facts from \d{2}:\d{2}$/)
    expect(paneGithub(world)).toContain(reason)
    expect(status?.split('\n').filter(line => line.startsWith('GitHub'))).toHaveLength(1)
    expect(statusGithub(status)).toContain(reason)
    expect(statusGithub(status)).toMatch(/ · facts from \d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}$/)
    Object.assign(options, { failing: undefined, missing: undefined, isLoggedOut: undefined })
    await world.clock.advance(2000)
    const recovered = await readFlowStatus($)
    expect(paneGithub(world)).toBeUndefined()
    expect(statusGithub(recovered)).toMatch(/^GitHub {5}last ok \d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}$/)
  })
}

test('unforced syncs during an outage do not probe GitHub again within the TTL, and a forced one does', async ($, on) => {
  const options: Options = { ...specDone }
  const world = createWorld(on, { branch: 'feat' }, options)
  const probes = (): number => countProbes(world)
  await world.clock.advance(pastTtl)
  await readPromptContext($)
  const connected = probes()
  await endTurn($)
  expect(probes()).toBe(connected)
  options.failing = 'gh api user'
  await world.clock.advance(pastTtl)
  await readPromptContext($)
  const failed = probes()
  for (const _prompt of [1, 2, 3]) await readPromptContext($)
  expect(probes()).toBe(failed)
  await world.clock.advance(2000)
  await endTurn($)
  expect(probes()).toBeGreaterThan(failed)
})

test('a tick during an outage does not probe GitHub again within the TTL, and an explicit signal does', async (_$, on) => {
  const world = createWorld(on, { branch: 'feat' }, { ...specDone, failing: 'gh api user' })
  const port = createTestPort(world)
  const probes = (): number => countProbes(world)
  await refreshView(port, { isForced: true, causes: ['turn'] })
  const failed = probes()
  await world.clock.advance(2000)
  await refreshView(port, { isForced: true, causes: ['tick'] })
  expect(probes()).toBe(failed)
  await refreshView(port, { isForced: true, causes: ['turn'] })
  expect(probes()).toBeGreaterThan(failed)
})

test('an issue never read successfully shows its read error as the current step\'s fact', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...specDone, session: { info: {} }, isLoggedOut: true })
  expect(await readFlowStatus($)).toContain('▸ Grill · GitHub read failed (not authenticated — run gh auth login)')
})

test('a probe that outlives its timeout is worded as a timeout on the pane', async (_$, on) => {
  const world = createWorld(on, { branch: 'feat' }, { ...specDone })
  const port = createTestPort(world)
  // The engine clock moves past the deadline while the probe runs, as a real one does before the engine rejects it.
  const clock = { at: pastTtl }
  const run: ProcessPort['run'] = async (argv, options) => {
    if (!argv.join(' ').startsWith('gh api user')) return port.processes.run(argv, options)
    clock.at += options.timeoutMs
    throw new Error('aborted')
  }
  const now = async (): Promise<number> => clock.at
  await refreshView({ ...port, now, processes: { ...port.processes, run: (argv, options) => runWithDeadline(run, now, argv, options) } }, { isForced: true })
  expect(paneGithub(world)).toMatch(/^read failed \(gh timed out after 8 s\)/)
})

test('an issue never read successfully shows a failed issue read with the same prefix as a failed probe', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...specDone, session: { info: {} }, missing: [1] })
  expect(await readFlowStatus($)).toContain('▸ Grill · GitHub read failed (not found)')
})

test('/flow status probes GitHub once during an outage', async ($, on) => {
  const options: Options = { ...specDone }
  const world = createWorld(on, { branch: 'feat' }, options)
  await readFlowStatus($)
  options.failing = 'gh api user'
  await world.clock.advance(pastTtl)
  const before = countProbes(world)
  await readFlowStatus($)
  expect(countProbes(world) - before).toBe(1)
})

test('a re-declaration whose comments read fails keeps Diagnose done and shows the failure', async ($, on) => {
  const options: Options = { session: noFlow, unit: diagnosed, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] } }
  const world = createWorld(on, { branch: 'fix' }, options)
  await declareFlow($, 'fix', [1])
  expect(await readFlowStatus($)).toContain('✓ Diagnose')
  options.comments = { 1: { error: 'comments unreadable' } }
  await declareFlow($, 'fix', [1])
  expect(paneGithub(world)).toMatch(/^read failed \(comments unreadable\)/)
  expect(stepLines(await readFlowStatus($))).toContain('✓ Diagnose')
})

/**
 * Holds an observation's issue read until the gate opens, then answers it or fails it.
 * @param port - The port the observation runs on.
 * @param gate - The promise that opens the read.
 * @param isFailed - Whether the held read fails once it opens.
 * @returns The port whose issue read waits.
 */
function holdIssueRead(port: EnginePort, gate: Promise<void>, isFailed: boolean): EnginePort {
  return { ...port, processes: { ...port.processes, run: async (argv, options) => {
    if (!argv.some(arg => arg.includes('issue(number:'))) return port.processes.run(argv, options)
    await gate
    if (isFailed) throw new Error('older read failed')
    return port.processes.run(argv, options)
  } } }
}

for (const [older, isFailed] of [['succeeds', false], ['fails', true]] as const) {
  test(`an older sync that ${older} after a newer one stored its facts changes neither the facts nor the GitHub row`, async (_$, on) => {
    const options: Options = { ...specDone, issueLabels: { 1: ['ready-for-agent', 'older'] } }
    const world = createWorld(on, { branch: 'feat' }, options)
    const port = createTestPort(world)
    const gate: Gate = {}
    const opened = new Promise<void>(resolve => { gate.open = resolve })
    const pending = refreshView(holdIssueRead(port, opened, isFailed), { isForced: true })
    await world.clock.settle()
    options.issueLabels = { 1: ['ready-for-agent', 'newer'] }
    await refreshView(port, { isForced: true })
    options.issueLabels = { 1: ['ready-for-agent', 'older'] }
    gate.open?.()
    await pending
    await refreshView(port, { isQuiet: true })
    expect(world.views.at(-1)?.labels).toContain('newer')
    expect(world.views.at(-1)?.labels).not.toContain('older')
    expect(paneGithub(world)).toBeUndefined()
  })
}

test('a declaration on other issues whose comments read fails dates no facts with the previous unit\'s read', async ($, on) => {
  const world = createWorld(on, { branch: 'fix', ahead: 1 }, {
    session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'] }, comments: { 2: { error: 'comments unreadable' } },
  })
  await declareFlow($, 'small-feature', [1])
  await readFlowStatus($)
  await world.clock.advance(pastTtl)
  expect((await declareFlow($, 'fix', [2])).deny).toBeUndefined()
  expect(paneGithub(world)).toBe('read failed (comments unreadable)')
})
