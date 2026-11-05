import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { test } from '../../support/kit'
import { buildChanged, buildChangedCheckout, buildVerifyRun, buildWriteCall, diagnosisComment, fixed, verifyFile } from '../../support/builders'
import { endTurn, inside, readFlowStatus, readPaneCurrentStep, readPromptContext, readSurfaces, releaseVerifyHolder, seedVerifyHolder } from '../../support/helpers'
import type { Surfaces } from '../../support/helpers'
import { common, createWorld, records, root } from '../../support/world'
import type { Checkout, Gate, Options, World } from '../../support/world'
import type { VerifyRecord } from '../../../types'

const verify = { tool: 'mcp__working-agreement__verify' } as const
const failed: VerifyRecord['outcome'] = { kind: 'fail', code: 1, signal: null }
/** A passing record on an older tree, which a later edit went back from. */
const passedBefore = buildVerifyRun({ tree: 'zero' })

/**
 * Builds a diagnosed and fixed Fix unit whose commands wait on a gate, shown in herdr.
 * @param unit - Fields that extend the unit record.
 * @param gate - Opens the held commands.
 * @param extra - Options that replace the defaults.
 * @returns The options.
 */
const fixOptions = (unit: Options['unit'], gate: Gate, extra: Options = {}): Options => ({
  session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'], comments: [diagnosisComment] } } },
  unit: { ...fixed, ...unit }, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
  verifyFile, approvedConfig: verifyFile, herdrEnv: inside, spawnGate: new Promise(resolve => { gate.open = resolve }), ...extra,
})

/**
 * Reads the latest herdr sidebar step token.
 * @param world - The test world.
 * @returns The `flow_step` value, or undefined before any report.
 */
const readSidebarStep = (world: World): string | undefined =>
  world.runs.findLast(command => command.startsWith('herdr '))?.match(/--token flow_step=(.*?) --token/)?.[1]

/**
 * Reads the detail the latest pane view shows on a step.
 * @param world - The test world.
 * @param label - The step's label.
 * @returns The step's detail, if any.
 */
const readPaneDetail = (world: World, label: string): string | undefined => world.views.at(-1)?.steps.find(step => step.label === label)?.detail

/**
 * Expects every surface to show Verify current with no fact while the run holds the tree.
 * @param $ - The test's engine.
 * @param world - The test world.
 */
async function expectVerifyRunning($: Engine, world: World): Promise<void> {
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Code\n')
  expect(status).toContain('▸ Verify\n')
  const context = await readPromptContext($)
  expect(context).toContain('current step: Verify')
  expect(context).toContain('Next action: wait for the running Verify to end.')
  expect(readPaneCurrentStep(world.views)).toBe('Verify')
  expect(world.views.at(-1)?.progress).toBe('3/6')
  expect(readPaneDetail(world, 'Verify')).toBeUndefined()
  expect(readSidebarStep(world)).toBe('▸ Verify')
}

/**
 * Expects every surface to show Code current with a fact, as before the run.
 * @param $ - The test's engine.
 * @param world - The test world.
 * @param fact - The went-back fact on Code.
 */
async function expectCodeCurrent($: Engine, world: World, fact: string): Promise<void> {
  expect(await readFlowStatus($)).toContain(`▸ Code · ${fact}\n`)
  expect(await readPromptContext($)).toContain('current step: Code')
  await endTurn($)
  expect(readPaneCurrentStep(world.views)).toBe('Code')
  expect(readPaneDetail(world, 'Code')).toBe(fact)
  expect(readSidebarStep(world)).toBe('▸ Code')
}

for (const [row, name, unit, checkout] of [
  [1, 'the first Verify', {}, buildChanged()],
  [2, 'a Verify after an edit', { verifyRuns: [passedBefore] }, buildChanged()],
  [3, 'a Verify after a red and a fix', { verifyRuns: [buildVerifyRun({ tree: 'zero', outcome: failed })] }, buildChanged()],
  [4, 'a Verify after the base moved on an unchanged tree', { verifyRuns: [buildVerifyRun({ commands: [['partial']] })], base: 'c1' }, buildChangedCheckout()],
  [5, 'a Verify rerun on the same tree after a red', { verifyRuns: [buildVerifyRun({ outcome: failed })] }, buildChanged()],
] as [number, string, Options['unit'], Checkout][]) {
  test(`row ${row}: ${name} makes Verify current with no fact on every surface while it runs`, async ($, on) => {
    const gate: Gate = {}
    const world = createWorld(on, checkout, fixOptions(unit, gate))
    const run = $.tool.call(verify)
    await world.clock.settle()
    await expectVerifyRunning($, world)
    gate.open?.()
    expect((await run).result).toContain('Verify passed')
  })
}

test('row 6: an edit during the run makes Code current with its went-back fact, then code changed during Verify once the run ends', async ($, on) => {
  const gate: Gate = {}
  const checkout: Checkout = buildChanged()
  const world = createWorld(on, checkout, fixOptions({ verifyRuns: [passedBefore] }, gate))
  const run = $.tool.call(verify)
  await world.clock.settle()
  checkout.tree = 'two'
  await expectCodeCurrent($, world, 'changed after Verify')
  gate.open?.()
  expect((await run).result).toContain('The commands change the tree')
  await endTurn($)
  expect(readPaneCurrentStep(world.views)).toBe('Code')
  expect(readPaneDetail(world, 'Code')).toBe('code changed during Verify')
  expect(readSidebarStep(world)).toBe('▸ Code')
})

test('row 7: a run whose queue lock is no longer live leaves every surface as before the run', async ($, on) => {
  const gate: Gate = {}
  const world = createWorld(on, buildChanged(), fixOptions({ verifyRuns: [passedBefore] }, gate))
  const run = $.tool.call(verify)
  await world.clock.settle()
  world.modified.set(`${records}/verify/lock`, world.clock.now() - 31000)
  await expectCodeCurrent($, world, 'changed after Verify')
  gate.open?.()
  await run
})

test('row 8: a Verify queued behind another session leaves Code current with its queue note', async ($, on) => {
  const gate: Gate = {}
  const world = createWorld(on, buildChanged(), fixOptions({ verifyRuns: [passedBefore] }, gate))
  seedVerifyHolder(world)
  gate.open?.()
  const run = $.tool.call(verify)
  await world.clock.settle()
  expect(await readFlowStatus($)).toContain('▸ Code · changed after Verify\n')
  expect(readPaneCurrentStep(world.views)).toBe('Code')
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Verify', value: 'queued, 2nd of 2', tone: 'text' })
  expect(readSidebarStep(world)).toBe('▸ Code · Verify queued, 2nd of 2')
  releaseVerifyHolder(world)
  await world.clock.advance(1000)
  expect((await run).result).toContain('Verify passed')
})

for (const [outcome, extra, current, sidebar, status] of [
  ['passes', {}, 'Commit', '▸ Commit', '✓ Verify\n'],
  ['fails', { spawnCode: 1 }, 'Verify', '✗ Verify', '✗ Verify · failed, exit 1\n'],
] as [string, Options, string, string, string][]) {
  test(`row 9: a run that ${outcome} shows its record once it ends`, async ($, on) => {
    const gate: Gate = {}
    const world = createWorld(on, buildChanged(), fixOptions({ verifyRuns: [passedBefore] }, gate, extra))
    gate.open?.()
    await $.tool.call(verify)
    expect(await readFlowStatus($)).toContain(status)
    expect(readPaneCurrentStep(world.views)).toBe(current)
    expect(readSidebarStep(world)).toBe(sidebar)
  })
}

test('row 10: a Diagnose run is no Verify and leaves Code current with its went-back fact', async ($, on) => {
  const gate: Gate = {}
  const world = createWorld(on, buildChanged(), fixOptions({ verifyRuns: [passedBefore] }, gate))
  const run = $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./check'] })
  await world.clock.settle()
  expect(await readFlowStatus($)).toContain('▸ Code · changed after Verify\n')
  expect(readPaneCurrentStep(world.views)).toBe('Code')
  expect(readSidebarStep(world)).toBe('▸ Code')
  gate.open?.()
  await run
})

for (const [outcome, written, after] of [
  ['an edit that lands', 'two', { pane: '▸ Code', sidebar: '▸ Code' }],
  ['a no-op write', 'one', { pane: '▸ Commit', sidebar: '▸ Commit' }],
] as [string, string, Surfaces][]) {
  test(`row 11: a turn that goes on past a passing Verify reopens Code at the start of its write, and ${outcome} decides after it`, async ($, on) => {
    const gate: Gate = {}
    const checkout = buildChanged()
    const during: Surfaces[] = []
    const world: World = createWorld(on, checkout, fixOptions({ verifyRuns: [buildVerifyRun()] }, gate, { afterTool: () => {
      during.push(readSurfaces(world))
      checkout.tree = written
    } }))
    gate.open?.()
    await $.turn.start({ text: 'go', turnId: 't' })
    expect(readSurfaces(world)).toEqual({ pane: '▸ Commit', sidebar: '▸ Commit' })
    await $.tool.call(buildWriteCall('src/a.ts'))
    expect(during).toEqual([{ pane: '▸ Code', sidebar: '▸ Code' }])
    expect(readPaneDetail(world, 'Code')).toBe('changed after Verify')
    await world.clock.settle()
    expect(readSurfaces(world)).toEqual(after)
    await endTurn($)
    expect(readSurfaces(world)).toEqual(after)
  })
}

for (const [tool, input] of [['Write', buildWriteCall('src/a.ts')], ['Bash', { tool: 'Bash', command: 'true' }]] as const) {
  test(`a ${tool} call starting while the minute's full read waits on GitHub runs at once, and a write reopens Code at its start`, async ($, on) => {
    const gate: Gate = {}
    const github: Gate = {}
    const checkout = buildChanged()
    const during: Surfaces[] = []
    const reads = { issues: 0 }
    const options = fixOptions({ verifyRuns: [buildVerifyRun()] }, gate, { afterTool: () => { during.push(readSurfaces(world)) },
      gh: args => { if (args.some(arg => arg.includes('issue(number:'))) reads.issues += 1; return undefined } })
    const world: World = createWorld(on, checkout, options)
    gate.open?.()
    await $.session.start({ cwd: root, surface: null, isInteractive: false })
    await $.turn.start({ text: 'go', turnId: 't' })
    expect(readSurfaces(world)).toEqual({ pane: '▸ Commit', sidebar: '▸ Commit' })
    // The tick's full read waits on its GitHub issue read until the test opens it, as on a slow link.
    options.issueGate = new Promise(resolve => { github.open = resolve })
    const before = reads.issues
    await world.clock.advance(60000)
    await world.clock.settle()
    expect(reads.issues > before).toBe(true)
    const call = $.tool.call(input as never)
    await world.clock.settle()
    expect(during).toHaveLength(1)
    if (tool === 'Write') expect(during[0]).toEqual({ pane: '▸ Code', sidebar: '▸ Code' })
    github.open?.()
    await call
    await world.clock.settle()
  })
}

test('a Write starting while a full read is queued behind a running one waits on neither, and reopens Code at its start', async ($, on) => {
  const gate: Gate = {}
  const github: Gate = {}
  const checkout = buildChanged()
  const during: Surfaces[] = []
  const options = fixOptions({ verifyRuns: [buildVerifyRun()] }, gate, { afterTool: () => { during.push(readSurfaces(world)) } })
  const world: World = createWorld(on, checkout, options)
  gate.open?.()
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await $.turn.start({ text: 'go', turnId: 't' })
  options.issueGate = new Promise(resolve => { github.open = resolve })
  await world.clock.advance(60000)
  // A watched ref changes while the tick's read waits on GitHub: its forced full read queues behind it.
  await $.classic.FileChanged({ file_path: `${common}/HEAD`, event: 'change' })
  const call = $.tool.call(buildWriteCall('src/a.ts'))
  await world.clock.settle()
  expect(during).toEqual([{ pane: '▸ Code', sidebar: '▸ Code' }])
  github.open?.()
  await call
  await world.clock.settle()
})
