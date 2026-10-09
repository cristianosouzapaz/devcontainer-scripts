import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { bashCall, currentStep, flow, flowStatus, promptContext, verifyFile, writeCall } from './helpers'
import { stepSymbol } from '../hooks/progress'
import { world } from './world'
import type { Checkout } from './world'

// A Fix session on #1 whose unit has already run diagnosing-bugs.
const diagnosed = { session: { flow: 'fix', info: { 1: { title: 'bug', labels: [] } } }, unit: { skills: ['diagnosing-bugs'], start: 'c0' } }
const failed = { isError: true as const, result: { stdout: '', stderr: '', interrupted: false } }
const passed = { isError: undefined, result: { stdout: '', stderr: '', interrupted: false } }
const hashes = { 'test/fix.bats': 'h1' }

// Failing commands that count as a red for the unit's test file, by what they name.
const reds: [string, string][] = [
  ['the test file', 'bats test/fix.bats'],
  ['a directory containing it', 'bats test/'],
  ['the verify command', './test/run.sh'],
]
// Failing commands that do not.
const ignored: [string, string][] = [
  ['names none of the unit\'s test files', 'bats test/other.bats'],
  ['filters by name only', 'bats --filter fix'],
]

// A Fix world with the test file already written; returns the git state, the tool result to mutate and a probe of the source gate.
async function started($: Engine, on: On, git: Checkout = { branch: 'fix', hashes: { ...hashes } }) {
  const toolRun = { ...passed }
  world(on, git, { ...diagnosed, verifyFile, toolRun })
  await $.tool.call(writeCall('test/fix.bats'))
  const run = async (command: string, result: typeof failed | typeof passed) => {
    Object.assign(toolRun, result)
    await $.tool.call(bashCall(command))
    Object.assign(toolRun, passed)
  }
  const isGated = async () => (await $.tool.call(writeCall('src/fix.sh'))).deny !== undefined
  return { git, run, isGated }
}

test('a test write alone does not open the Diagnose gate', async ($, on) => {
  const { isGated } = await started($, on)
  expect(await isGated()).toBe(true)
  expect((await $.tool.call(writeCall('test/more.bats'))).deny).toBeUndefined()
})

for (const [name, command] of reds) {
  test(`a failing run naming ${name} opens the gate`, async ($, on) => {
    const { run, isGated } = await started($, on)
    await run(command, failed)
    expect(await isGated()).toBe(false)
  })
}

for (const [name, command] of ignored) {
  test(`a failing command that ${name} is ignored`, async ($, on) => {
    const { run, isGated } = await started($, on)
    await run(command, failed)
    expect(await isGated()).toBe(true)
  })
}

test('a passing run of the test does not open the gate', async ($, on) => {
  const { run, isGated } = await started($, on)
  await run('bats test/fix.bats', passed)
  expect(await isGated()).toBe(true)
})

test('a failing run before the test was written is ignored', async ($, on) => {
  const toolRun = { ...failed }
  world(on, { branch: 'fix', hashes: { ...hashes } }, { ...diagnosed, toolRun })
  await $.tool.call(bashCall('bats test/fix.bats'))
  Object.assign(toolRun, passed)
  await $.tool.call(writeCall('test/fix.bats'))
  expect((await $.tool.call(writeCall('src/fix.sh'))).deny).toBeDefined()
})

test('a failing run with non-test changes since the unit started is ignored', async ($, on) => {
  const { git, run, isGated } = await started($, on)
  git.changed = ['test/fix.bats', 'src/fix.sh']
  await run('bats test/fix.bats', failed)
  expect(await isGated()).toBe(true)
})

test('a failing run with only test changes since the unit started counts', async ($, on) => {
  const { git, run, isGated } = await started($, on)
  git.changed = ['test/fix.bats']
  await run('bats test/fix.bats', failed)
  expect(await isGated()).toBe(false)
})

test('earlier commits on the branch before the unit started do not block the red', async ($, on) => {
  const { git, run, isGated } = await started($, on)
  git.before = ['src/old.sh']
  await run('bats test/fix.bats', failed)
  expect(await isGated()).toBe(false)
})

// herdr verify runs: the marker id and pane (unique to this file), the non-test paths in the tree at launch, the exit code the wait reports and whether the gate opens.
const herdr: [string, string, string, string[], number, boolean][] = [
  ['fails', 'd1', 'h9:p1', [], 1, true],
  ['passes', 'd2', 'h9:p2', [], 0, false],
  ['fails with a non-test change in the tree at launch', 'd3', 'h9:p3', ['src/x.sh'], 1, false],
]

for (const [name, id, pane, changed, code, opens] of herdr) {
  test(`a herdr run of the verify command that ${name} ${opens ? 'opens' : 'does not open'} the gate`, async ($, on) => {
    const toolRun: { isError?: true; result: unknown } = { result: { stdout: '' } }
    world(on, { branch: 'fix', hashes: { ...hashes }, changed }, { ...diagnosed, verifyFile, toolRun })
    await $.tool.call(writeCall('test/fix.bats'))
    await $.tool.call(bashCall(`herdr pane run ${pane} './test/run.sh; echo "__EXIT_${id}=$?__"'`))
    const line = JSON.stringify({ id: 'cli:pane:wait-output', result: { matched_line: `__EXIT_${id}=${code}__`, type: 'output_matched' } })
    Object.assign(toolRun, { result: { stdout: line } })
    await $.tool.call(bashCall(`herdr pane wait-output ${pane} --regex '__EXIT_${id}=[0-9]+__' --source recent-unwrapped --timeout 590000 --lines 80`))
    expect((await $.tool.call(writeCall('src/fix.sh'))).deny === undefined).toBe(opens)
  })
}

test('editing the test after its red reopens Diagnose until a new red', async ($, on) => {
  const { git, run, isGated } = await started($, on)
  await run('bats test/fix.bats', failed)
  expect(await isGated()).toBe(false)
  git.hashes = { 'test/fix.bats': 'h2' }
  expect(await isGated()).toBe(true)
  await run('bats test/fix.bats', failed)
  expect(await isGated()).toBe(false)
})

test('a new unrelated test file after the red does not reopen Diagnose', async ($, on) => {
  const { git, run, isGated } = await started($, on)
  await run('bats test/fix.bats', failed)
  git.hashes = { ...hashes, 'test/more.bats': 'h9' }
  await $.tool.call(writeCall('test/more.bats'))
  expect(await isGated()).toBe(false)
})

test('the Diagnose instruction names the next action', async ($, on) => {
  const { git, run } = await started($, on)
  expect(await promptContext($)).toContain('run the reproduction test directly by its path')
  await run('bats test/fix.bats', failed)
  expect(await currentStep($)).not.toBe('Diagnose')
  expect(await flowStatus($)).not.toContain(`${stepSymbol.current} Diagnose`)
  git.hashes = { 'test/fix.bats': 'h2' }
  const text = await promptContext($)
  expect(text).toContain('current step: Diagnose')
  expect(text).toContain('changed since it failed')
  expect(text).toContain('git stash push')
  expect(await flowStatus($)).toContain(`${stepSymbol.current} Diagnose`)
})

test('without a test file the instruction asks for the failing test', async ($, on) => {
  world(on, { branch: 'fix' }, diagnosed)
  expect(await promptContext($)).toContain('write the failing test')
})

test('a legacy unit record with tested: true waits for a red', async ($, on) => {
  world(on, { branch: 'fix' }, { ...diagnosed, unit: { ...diagnosed.unit, tested: true } })
  expect(await currentStep($)).toBe('Diagnose')
  expect(await promptContext($)).toContain('write the failing test')
})

test('overriding Diagnose opens the gate', async ($, on) => {
  const { isGated } = await started($, on)
  await flow($, 'override diagnose #1 no reproduction')
  expect(await isGated()).toBe(false)
})

test('a failing test run changes nothing outside the Fix flow', async ($, on) => {
  const toolRun = { ...passed }
  world(on, { branch: 'feat', hashes: { 'test/a.test.ts': 'h1' } }, { toolRun })
  await $.tool.call(writeCall('test/a.test.ts'))
  Object.assign(toolRun, failed)
  await $.tool.call(bashCall('bun test test/a.test.ts'))
  expect(await currentStep($)).toBe('Code')
  expect(await flowStatus($)).not.toContain('Diagnose')
})
