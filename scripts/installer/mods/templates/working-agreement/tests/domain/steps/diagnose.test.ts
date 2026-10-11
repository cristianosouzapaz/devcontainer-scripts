import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ToolRun } from '../../../hooks/core/command-observation'
import { stepSymbol } from '../../../hooks/ui/theme'
import { buildBackgroundedRun, buildBashCall, buildTaskNotification, buildWriteCall, verifyFile } from '../../support/builders'
import { notifyTask, readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Checkout } from '../../support/world'

/** A failing command and what it names, as the case title reads. */
interface FailingCommand { name: string; command: string }

/**
 * A herdr verify run: the marker id and pane (unique to this file), the non-test paths in the tree at launch,
 * the exit code the wait reports and whether the gate opens.
 */
interface HerdrVerifyRun { name: string; id: string; pane: string; changed: string[]; exitCode: number; isOpened: boolean }

/**
 * A herdr run of a reproduction test that is not the verify command: the marker id and pane (unique to this file), the command,
 * the non-test paths in the tree at launch, the exit code the wait reports and whether Diagnose completes.
 */
interface HerdrReproductionRun { name: string; id: string; pane: string; command: string; changed: string[]; exitCode: number; isCompleted: boolean }

/** How a background run's task ends, and whether that completes Diagnose. */
interface BackgroundEnd { status: string; isCompleted: boolean }

// A Fix session on #1 whose unit has already run diagnosing-bugs.
const diagnosed = { session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } }, unit: { skills: ['diagnosing-bugs'], start: 'c0' } }
const failed = { isError: true as const, result: { stdout: '', stderr: '', interrupted: false } }
const passed = { isError: undefined, result: { stdout: '', stderr: '', interrupted: false } }
const hashes = { 'test/fix.bats': 'h1' }

// Failing commands that count as a red for the unit's test file, by what they name.
const reds: FailingCommand[] = [
  { name: 'the test file', command: 'bats test/fix.bats' },
  { name: 'a directory containing it', command: 'bats test/' },
  { name: 'the verify command', command: './test/run.sh' },
]

// Failing commands that do not.
const ignored: FailingCommand[] = [
  { name: 'names none of the unit\'s test files', command: 'bats test/other.bats' },
  { name: 'filters by name only', command: 'bats --filter fix' },
]

const herdrVerifyRuns: HerdrVerifyRun[] = [
  { name: 'fails', id: 'd1', pane: 'h9:p1', changed: [], exitCode: 1, isOpened: true },
  { name: 'passes', id: 'd2', pane: 'h9:p2', changed: [], exitCode: 0, isOpened: false },
  { name: 'fails with a non-test change in the tree at launch', id: 'd3', pane: 'h9:p3', changed: ['src/x.sh'], exitCode: 1, isOpened: false },
]

const herdrReproductionRuns: HerdrReproductionRun[] = [
  { name: 'a failing run of a named test file', id: 'e1', pane: 'h8:p1', command: 'bun test test/fix.bats', changed: [], exitCode: 1, isCompleted: true },
  { name: 'a failing run of a directory containing it', id: 'e2', pane: 'h8:p2', command: 'claude plugin test test/', changed: [], exitCode: 1, isCompleted: true },
  { name: 'a passing run', id: 'e3', pane: 'h8:p3', command: 'bun test test/fix.bats', changed: [], exitCode: 0, isCompleted: false },
  { name: 'a failing run with a non-test change in the tree at launch', id: 'e4', pane: 'h8:p4', command: 'bun test test/fix.bats', changed: ['src/x.sh'], exitCode: 1, isCompleted: false },
]

const backgroundEnds: BackgroundEnd[] = [
  { status: 'failed', isCompleted: true },
  { status: 'completed', isCompleted: false },
  { status: 'killed', isCompleted: false },
]

// A Fix world with the test file already written; returns the git state, the tool result to mutate and a probe of the source gate.
async function startDiagnosis($: Engine, on: On, git: Checkout = { branch: 'fix', hashes: { ...hashes } }) {
  const toolRun = { ...passed }
  createWorld(on, git, { ...diagnosed, verifyFile, toolRun })
  await $.tool.call(buildWriteCall('test/fix.bats'))
  const runCommand = async (command: string, result: typeof failed | typeof passed) => {
    Object.assign(toolRun, result)
    await $.tool.call(buildBashCall(command))
    Object.assign(toolRun, passed)
  }
  const isGated = async () => (await $.tool.call(buildWriteCall('src/fix.sh'))).deny !== undefined
  return { git, runCommand, isGated }
}

test('a test write alone does not open the Diagnose gate', async ($, on) => {
  const { isGated } = await startDiagnosis($, on)
  expect(await isGated()).toBe(true)
  expect((await $.tool.call(buildWriteCall('test/more.bats'))).deny).toBeUndefined()
})

for (const { name, command } of reds) {
  test(`a failing run naming ${name} opens the gate`, async ($, on) => {
    const { runCommand, isGated } = await startDiagnosis($, on)
    await runCommand(command, failed)
    expect(await isGated()).toBe(false)
  })
}

for (const { name, command } of ignored) {
  test(`a failing command that ${name} is ignored`, async ($, on) => {
    const { runCommand, isGated } = await startDiagnosis($, on)
    await runCommand(command, failed)
    expect(await isGated()).toBe(true)
  })
}

test('a passing run of the test does not open the gate', async ($, on) => {
  const { runCommand, isGated } = await startDiagnosis($, on)
  await runCommand('bats test/fix.bats', passed)
  expect(await isGated()).toBe(true)
})

test('a failing run before the test was written is ignored', async ($, on) => {
  const toolRun = { ...failed }
  createWorld(on, { branch: 'fix', hashes: { ...hashes } }, { ...diagnosed, toolRun })
  await $.tool.call(buildBashCall('bats test/fix.bats'))
  Object.assign(toolRun, passed)
  await $.tool.call(buildWriteCall('test/fix.bats'))
  expect((await $.tool.call(buildWriteCall('src/fix.sh'))).deny).toBeDefined()
})

test('a failing run with non-test changes since the unit started is ignored', async ($, on) => {
  const { git, runCommand, isGated } = await startDiagnosis($, on)
  git.changed = ['test/fix.bats', 'src/fix.sh']
  await runCommand('bats test/fix.bats', failed)
  expect(await isGated()).toBe(true)
})

test('a failing run with only test changes since the unit started counts', async ($, on) => {
  const { git, runCommand, isGated } = await startDiagnosis($, on)
  git.changed = ['test/fix.bats']
  await runCommand('bats test/fix.bats', failed)
  expect(await isGated()).toBe(false)
})

test('earlier commits on the branch before the unit started do not block the red', async ($, on) => {
  const { git, runCommand, isGated } = await startDiagnosis($, on)
  git.before = ['src/old.sh']
  await runCommand('bats test/fix.bats', failed)
  expect(await isGated()).toBe(false)
})

for (const { name, id, pane, changed, exitCode, isOpened } of herdrVerifyRuns) {
  test(`a herdr run of the verify command that ${name} ${isOpened ? 'opens' : 'does not open'} the gate`, async ($, on) => {
    const toolRun: { isError?: true; result: unknown } = { result: { stdout: '' } }
    createWorld(on, { branch: 'fix', hashes: { ...hashes }, changed }, { ...diagnosed, verifyFile, toolRun })
    await $.tool.call(buildWriteCall('test/fix.bats'))
    await $.tool.call(buildBashCall(`herdr pane run ${pane} './test/run.sh; echo "__EXIT_${id}=$?__"'`))
    const matchedLine = JSON.stringify({ id: 'cli:pane:wait-output', result: { matched_line: `__EXIT_${id}=${exitCode}__`, type: 'output_matched' } })
    Object.assign(toolRun, { result: { stdout: matchedLine } })
    await $.tool.call(buildBashCall(`herdr pane wait-output ${pane} --regex '__EXIT_${id}=[0-9]+__' --source recent-unwrapped --timeout 590000 --lines 80`))
    expect((await $.tool.call(buildWriteCall('src/fix.sh'))).deny === undefined).toBe(isOpened)
  })
}

test('editing the test after its red reopens Diagnose until a new red', async ($, on) => {
  const { git, runCommand, isGated } = await startDiagnosis($, on)
  await runCommand('bats test/fix.bats', failed)
  expect(await isGated()).toBe(false)
  git.hashes = { 'test/fix.bats': 'h2' }
  expect(await isGated()).toBe(true)
  await runCommand('bats test/fix.bats', failed)
  expect(await isGated()).toBe(false)
})

test('Diagnose shows stale once the test changes after its red, and not before any red', async ($, on) => {
  const { git, runCommand } = await startDiagnosis($, on)
  expect(await readFlowStatus($)).not.toContain('stale')
  await runCommand('bats test/fix.bats', failed)
  expect(await readFlowStatus($)).not.toContain('stale')
  git.hashes = { 'test/fix.bats': 'h2' }
  expect(await readFlowStatus($)).toMatch(/Diagnose {2}stale/)
})

test('a new unrelated test file after the red does not reopen Diagnose', async ($, on) => {
  const { git, runCommand, isGated } = await startDiagnosis($, on)
  await runCommand('bats test/fix.bats', failed)
  git.hashes = { ...hashes, 'test/more.bats': 'h9' }
  await $.tool.call(buildWriteCall('test/more.bats'))
  expect(await isGated()).toBe(false)
})

test('the Diagnose instruction names the next action', async ($, on) => {
  const { git, runCommand } = await startDiagnosis($, on)
  expect(await readPromptContext($)).toContain('run the reproduction test directly by its path')
  await runCommand('bats test/fix.bats', failed)
  expect(await readCurrentStep($)).not.toBe('Diagnose')
  expect(await readFlowStatus($)).not.toContain(`${stepSymbol.current} Diagnose`)
  git.hashes = { 'test/fix.bats': 'h2' }
  const text = await readPromptContext($)
  expect(text).toContain('current step: Diagnose')
  expect(text).toContain('changed since it failed')
  expect(text).toContain('git stash push')
  expect(await readFlowStatus($)).toContain(`${stepSymbol.current} Diagnose`)
})

test('without a test file the instruction asks for the failing test', async ($, on) => {
  createWorld(on, { branch: 'fix' }, diagnosed)
  expect(await readPromptContext($)).toContain('write the failing test')
})

test('a legacy unit record with tested: true waits for a red', async ($, on) => {
  createWorld(on, { branch: 'fix' }, { ...diagnosed, unit: { ...diagnosed.unit, tested: true } })
  expect(await readCurrentStep($)).toBe('Diagnose')
  expect(await readPromptContext($)).toContain('write the failing test')
})

test('overriding Diagnose opens the gate', async ($, on) => {
  const { isGated } = await startDiagnosis($, on)
  await runFlowCommand($, 'override diagnose #1 no reproduction')
  expect(await isGated()).toBe(false)
})

test('a failing test run changes nothing outside the Fix flow', async ($, on) => {
  const toolRun = { ...passed }
  createWorld(on, { branch: 'feat', hashes: { 'test/a.test.ts': 'h1' } }, { toolRun })
  await $.tool.call(buildWriteCall('test/a.test.ts'))
  Object.assign(toolRun, failed)
  await $.tool.call(buildBashCall('bun test test/a.test.ts'))
  expect(await readCurrentStep($)).toBe('Code')
  expect(await readFlowStatus($)).not.toContain('Diagnose')
})

for (const { name, id, pane, command, changed, exitCode, isCompleted } of herdrReproductionRuns) {
  test(`a herdr launch of the reproduction test with ${name} ${isCompleted ? 'completes' : 'does not complete'} Diagnose`, async ($, on) => {
    const toolRun: ToolRun = { result: { stdout: '' } }
    createWorld(on, { branch: 'fix', hashes: { ...hashes }, changed }, { ...diagnosed, verifyFile, toolRun })
    await $.tool.call(buildWriteCall('test/fix.bats'))
    await $.tool.call(buildBashCall(`herdr pane run ${pane} '${command}; echo "__EXIT_${id}=$?__"'`))
    expect((await readFlowStatus($)) ?? '').toContain('▸ Diagnose — running')
    expect(await readPromptContext($)).toContain(`herdr pane wait-output ${pane}`)
    const matchedLine = JSON.stringify({ id: 'cli:pane:wait-output', result: { matched_line: `__EXIT_${id}=${exitCode}__`, type: 'output_matched' } })
    Object.assign(toolRun, { result: { stdout: matchedLine } })
    await $.tool.call(buildBashCall(`herdr pane wait-output ${pane} --regex '__EXIT_${id}=[0-9]+__' --source recent-unwrapped --timeout 590000 --lines 80`))
    const text = await readPromptContext($)
    expect(text.includes('current step: Code')).toBe(isCompleted)
    expect(text.includes('current step: Diagnose')).toBe(!isCompleted)
    expect(text).not.toContain('current step: Commit')
    expect((await readFlowStatus($)) ?? '').not.toContain('running')
  })
}

for (const { status, isCompleted } of backgroundEnds) {
  test(`a background run of the reproduction test whose task is ${status} ${isCompleted ? 'completes' : 'does not complete'} Diagnose`, async ($, on) => {
    const toolRun: ToolRun = { result: { stdout: '' } }
    createWorld(on, { branch: 'fix', hashes: { ...hashes } }, { ...diagnosed, verifyFile, toolRun })
    await $.tool.call(buildWriteCall('test/fix.bats'))
    Object.assign(toolRun, buildBackgroundedRun('d1'))
    await $.tool.call(buildBashCall('bats test/fix.bats'))
    expect((await readFlowStatus($)) ?? '').toContain('▸ Diagnose — running')
    await notifyTask($, buildTaskNotification('d1', status))
    expect(await readCurrentStep($)).toBe(isCompleted ? 'Code' : 'Diagnose')
    expect((await readFlowStatus($)) ?? '').not.toContain('running')
  })
}
