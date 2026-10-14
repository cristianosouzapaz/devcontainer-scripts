import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ToolRun } from '../../../hooks/core/command-observation'
import { buildBackgroundedRun, buildBashCall, buildTaskNotification, noFlow, verifyFile } from '../../support/builders'
import { declareFlow, notifyTask, readFlowStatus, readPromptContext, runFlowCommand, setPermissionMode, stopTurn } from '../../support/helpers'
import { createWorld } from '../../support/world'

/** What the next tool call returns, swapped by a test while a verify run is in flight. */
interface Pending { run: ToolRun }

/** A verify file that cannot be used, and what is wrong with it. */
interface MalformedVerifyFile { reason: string; file: string }

/** A herdr verify run: the pane launched, the pane waited on, the marker id, the line wait-output matched, and whether Verify passes. */
interface HerdrVerifyRun { name: string; launchedPane: string; waitedPane: string; id: string; matchedLine: string; isPassed: boolean }

/** A herdr run whose command does not carry the verify marker the wait-output reads back. */
interface UnmarkedHerdrRun { name: string; command: string }

/** A way a background verify run's task notification can fail to end it. */
interface UnrelatedDelivery { name: string; deliver: ($: Engine) => Promise<unknown> }

/** A wait-output answer that does not end a herdr verify run. */
interface InconclusiveWait { name: string; answer: ToolRun }

const malformedFiles: MalformedVerifyFile[] = [
  { reason: 'invalid JSON', file: '{ verify' },
  { reason: 'not an object', file: '["./test/run.sh"]' },
  { reason: 'an empty verify', file: JSON.stringify({ verify: '  ' }) },
  { reason: 'a verify that is not a string', file: JSON.stringify({ verify: 3 }) },
]

const herdrRuns: HerdrVerifyRun[] = [
  { name: 'exit 0', launchedPane: 'h1:p1', waitedPane: 'h1:p1', id: 'a1', matchedLine: '__EXIT_a1=0__', isPassed: true },
  { name: 'exit 1', launchedPane: 'h2:p1', waitedPane: 'h2:p1', id: 'a2', matchedLine: '__EXIT_a2=1__', isPassed: false },
  { name: 'another pane', launchedPane: 'h3:p1', waitedPane: 'h3:p2', id: 'a3', matchedLine: '__EXIT_a3=0__', isPassed: false },
  { name: 'a stale marker with another id', launchedPane: 'h6:p1', waitedPane: 'h6:p1', id: 'a6', matchedLine: '__EXIT_old=0__', isPassed: false },
]

const unmarkedRuns: UnmarkedHerdrRun[] = [
  { name: 'no marker', command: './test/run.sh' },
  { name: 'another command', command: 'npm test; echo "__EXIT_a5=$?__"' },
  { name: 'an id-less marker', command: './test/run.sh; echo "__EXIT=$?__"' },
]

const unrelatedDeliveries: UnrelatedDelivery[] = [
  { name: 'a typed envelope', deliver: $ => $.prompt.submit({ text: buildTaskNotification('b10', 'completed'), wait: false, origin: { kind: 'composer' } }) },
  { name: 'a notification for another task', deliver: $ => notifyTask($, buildTaskNotification('other', 'completed')) },
  { name: 'a notification with no status', deliver: $ => notifyTask($, '<task-notification>\n<task-id>b10</task-id>\n</task-notification>') },
]

const inconclusiveWaits: InconclusiveWait[] = [
  { name: 'an errored wait-output', answer: { isError: true, result: { stdout: '' } } },
  { name: 'a wait-output without a matched line', answer: { result: { stdout: 'timed out' } } },
]

// A verify run in flight: the tool call is open and the test code observes the mod from inside it.
const changed = { branch: 'feat', ahead: 8, isDirty: true }
const green: ToolRun = { result: { stdout: '' } }

// A herdr pane run returns at once: only the marker line wait-output reads back says how the tests ended.
function buildPaneRunCommand(pane: string, inner: string): string {
  return `herdr pane run ${pane} '${inner}'`
}

function buildLaunchCommand(id: string): string {
  return `./test/run.sh; echo "__EXIT_${id}=$?__"`
}

function buildWaitCommand(pane: string, id: string): string {
  return `herdr pane wait-output ${pane} --regex '__EXIT_${id}=[0-9]+__' --source recent-unwrapped --timeout 590000 --lines 80`
}

function buildMatchedRun(line: string): ToolRun {
  return { result: { stdout: JSON.stringify({ id: 'cli:pane:wait-output', result: { matched_line: line, type: 'output_matched' } }) } }
}

function isRunning(status: string | undefined): boolean {
  return (status ?? '').includes('▸ Verify — running') && (status ?? '').includes('✓ Code')
}

// A run that ended without passing, or lapsed, hands the unit back to Code.
function isIdle(status: string | undefined): boolean {
  return (status ?? '').includes('▸ Code') && !(status ?? '').includes('running')
}

test('a passing verify command with nothing changed leaves Code current', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 8 }, { verifyFile, session: noFlow })
  await runFlowCommand($, 'trivial')
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await readPromptContext($)).toContain('current step: Code')
})

test('a passing verify command after a change ticks Code and Verify', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 8, isDirty: true }, { verifyFile, session: noFlow })
  await runFlowCommand($, 'trivial')
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await readPromptContext($)).toContain('current step: Commit')
})

test('an overridden Verify whose run still matches the tree is not stale', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 8, isDirty: true }, { verifyFile, session: noFlow })
  await runFlowCommand($, 'trivial')
  await $.tool.call(buildBashCall('./test/run.sh'))
  await runFlowCommand($, 'override verify test reason')
  const status = (await readFlowStatus($)) ?? ''
  expect(status).toContain('Verify')
  expect(status).not.toContain('stale')
})

test('an overridden Verify whose run no longer matches the tree is stale', async ($, on) => {
  const git = { branch: 'feat', ahead: 8, isDirty: true, tree: 'one' }
  createWorld(on, git, { verifyFile, session: noFlow })
  await runFlowCommand($, 'trivial')
  await $.tool.call(buildBashCall('./test/run.sh'))
  await runFlowCommand($, 'override verify test reason')
  git.tree = 'two'
  expect(await readFlowStatus($)).toMatch(/Verify {2}stale/)
})

test('a new session declaring an issue whose uncommitted code was verified is sent to Commit', async ($, on) => {
  createWorld(on, { branch: 'feat', isDirty: true, tree: 'done' }, {
    verifyFile, session: noFlow, unit: { start: 'c0', skills: ['grilling', 'to-spec'], verify: 'done' }, issueLabels: { 1: ['ready-for-agent'] },
  })
  await declareFlow($, 'small-feature', [1])
  expect(await readPromptContext($)).toContain('current step: Commit')
})

test('a repository without a verify file has no Verify step and no notice', async ($, on) => {
  createWorld(on, { branch: 'feat', isDirty: true }, { session: { flow: 'close-out' } })
  const text = await readPromptContext($)
  expect(text).toContain('current step: Commit')
  expect(text).not.toContain('working-agreement.json')
})

for (const { reason, file } of malformedFiles) {
  test(`a malformed verify file (${reason}) drops Verify and is named in the context`, async ($, on) => {
    createWorld(on, { branch: 'feat', isDirty: true }, { verifyFile: file, session: { flow: 'close-out' } })
    const text = await readPromptContext($)
    expect(text).toContain('current step: Commit')
    expect(text).toContain('[working-agreement] .agents/working-agreement.json ignored')
  })
}

test('a malformed verify file is named even with no flow declared', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { verifyFile: '{', session: noFlow })
  expect(await readPromptContext($)).toContain('.agents/working-agreement.json ignored')
})

for (const { name, launchedPane, waitedPane, id, matchedLine, isPassed } of herdrRuns) {
  test(`a herdr verify run reporting ${name} ${isPassed ? 'passes' : 'does not pass'} Verify`, async ($, on) => {
    const toolRun = buildMatchedRun(matchedLine)
    createWorld(on, { branch: 'feat', ahead: 8, isDirty: true }, { verifyFile, session: noFlow, toolRun })
    await runFlowCommand($, 'trivial')
    toolRun.result = { stdout: '' }
    await $.tool.call(buildBashCall(buildPaneRunCommand(launchedPane, buildLaunchCommand(id))))
    Object.assign(toolRun, buildMatchedRun(matchedLine))
    await $.tool.call(buildBashCall(buildWaitCommand(waitedPane, id)))
    const text = await readPromptContext($)
    if (isPassed) expect(text).toContain('current step: Commit')
    else expect(text).not.toContain('current step: Commit')
  })
}

test('a herdr verify run whose tree changed before wait-output does not pass Verify', async ($, on) => {
  const git = { branch: 'feat', ahead: 8, isDirty: true, tree: 'one' }
  const toolRun = { result: { stdout: '' } }
  createWorld(on, git, { verifyFile, session: noFlow, toolRun })
  await runFlowCommand($, 'trivial')
  await $.tool.call(buildBashCall(buildPaneRunCommand('h4:p1', buildLaunchCommand('a4'))))
  git.tree = 'two'
  Object.assign(toolRun, buildMatchedRun('__EXIT_a4=0__'))
  await $.tool.call(buildBashCall(buildWaitCommand('h4:p1', 'a4')))
  expect(await readPromptContext($)).toContain('current step: Code')
})

test('a herdr verify launch reusing an id already reported does not pass Verify', async ($, on) => {
  const toolRun = { result: { stdout: '' } }
  createWorld(on, { branch: 'feat', ahead: 8, isDirty: true }, { verifyFile, session: noFlow, toolRun })
  await runFlowCommand($, 'trivial')
  await $.tool.call(buildBashCall(buildPaneRunCommand('h7:p1', buildLaunchCommand('a7'))))
  Object.assign(toolRun, buildMatchedRun('__EXIT_a7=1__'))
  await $.tool.call(buildBashCall(buildWaitCommand('h7:p1', 'a7')))
  toolRun.result = { stdout: '' }
  await $.tool.call(buildBashCall(buildPaneRunCommand('h7:p2', buildLaunchCommand('a7'))))
  Object.assign(toolRun, buildMatchedRun('__EXIT_a7=0__'))
  await $.tool.call(buildBashCall(buildWaitCommand('h7:p2', 'a7')))
  expect(await readPromptContext($)).toContain('current step: Code')
})

for (const { name, command } of unmarkedRuns) {
  test(`a herdr run with ${name} does not pass Verify`, async ($, on) => {
    const toolRun = { result: { stdout: '' } }
    createWorld(on, { branch: 'feat', ahead: 8, isDirty: true }, { verifyFile, session: noFlow, toolRun })
    await runFlowCommand($, 'trivial')
    await $.tool.call(buildBashCall(buildPaneRunCommand('h5:p1', command)))
    Object.assign(toolRun, buildMatchedRun('__EXIT_a5=0__'))
    await $.tool.call(buildBashCall(buildWaitCommand('h5:p1', 'a5')))
    expect(await readPromptContext($)).toContain('current step: Code')
  })
}

test('a direct verify run in flight shows Code done and Verify running', async ($, on) => {
  const seen = { status: '' }
  createWorld(on, changed, { verifyFile, toolRun: async () => { seen.status = (await readFlowStatus($)) ?? ''; return green } })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(isRunning(seen.status)).toBe(true)
})

test('a direct verify run in flight tells the agent to wait instead of running it', async ($, on) => {
  const seen = { text: '' }
  createWorld(on, changed, { verifyFile, toolRun: async () => { seen.text = await readPromptContext($); return green } })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(seen.text).toContain('current step: Verify')
  expect(seen.text).toContain('wait')
  expect(seen.text).not.toContain('run ./test/run.sh')
})

test('a red direct verify run ends the run in flight', async ($, on) => {
  const seen = { status: '' }
  createWorld(on, changed, { verifyFile, toolRun: async () => { seen.status = (await readFlowStatus($)) ?? ''; return { isError: true, result: { stdout: '' } } } })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(isRunning(seen.status)).toBe(true)
  expect(isIdle(await readFlowStatus($))).toBe(true)
})

test('a tree change during a direct verify run ends the run in flight and Verify does not pass', async ($, on) => {
  const git = { ...changed, tree: 'one' }
  const seen = { status: '' }
  createWorld(on, git, {
    verifyFile,
    toolRun: async () => { git.tree = 'two'; seen.status = (await readFlowStatus($)) ?? ''; return green },
  })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(isRunning(seen.status)).toBe(false)
  expect(seen.status).not.toContain('running')
  expect(isIdle(await readFlowStatus($))).toBe(true)
  expect(await readPromptContext($)).toContain('current step: Code')
})

// Background runs: the call returns at once with a task id, and only the task notification says how the run ended.
test('a verify run moved to the background stays running and tells the agent to wait for its notification', async ($, on) => {
  createWorld(on, changed, { verifyFile, toolRun: buildBackgroundedRun('b1') })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(isRunning(await readFlowStatus($))).toBe(true)
  const text = await readPromptContext($)
  expect(text).toContain('current step: Verify')
  expect(text).toContain('task notification')
  expect(text).not.toContain('run ./test/run.sh')
})

test('a background verify run whose task completes passes Verify, already in the notification\'s own turn', async ($, on) => {
  createWorld(on, changed, { verifyFile, toolRun: buildBackgroundedRun('b2') })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await notifyTask($, buildTaskNotification('b2', 'completed'))).toContain('current step: Commit')
  expect(await readFlowStatus($)).not.toContain('running')
})

for (const status of ['failed', 'killed']) {
  test(`a background verify run whose task is ${status} leaves flight and sends the unit back to Code`, async ($, on) => {
    createWorld(on, changed, { verifyFile, toolRun: buildBackgroundedRun('b3') })
    await $.tool.call(buildBashCall('./test/run.sh'))
    await notifyTask($, buildTaskNotification('b3', status))
    expect(isIdle(await readFlowStatus($))).toBe(true)
    expect(await readPromptContext($)).toContain('current step: Code')
  })
}

test('a verify run launched with run_in_background is followed as a backgrounded one', async ($, on) => {
  createWorld(on, changed, { verifyFile, toolRun: { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b4' } } })
  await $.tool.call({ ...buildBashCall('./test/run.sh'), run_in_background: true })
  expect(isRunning(await readFlowStatus($))).toBe(true)
  await notifyTask($, buildTaskNotification('b4', 'completed'))
  expect(await readPromptContext($)).toContain('current step: Commit')
})

test('a background verify run stopped by TaskStop leaves flight and its later notification records nothing', async ($, on) => {
  const next: Pending = { run: buildBackgroundedRun('b5') }
  createWorld(on, changed, { verifyFile, toolRun: () => next.run })
  await $.tool.call(buildBashCall('./test/run.sh'))
  next.run = { result: { message: 'stopped' } }
  await $.tool.call({ tool: 'TaskStop', task_id: 'b5' })
  expect(isIdle(await readFlowStatus($))).toBe(true)
  await notifyTask($, buildTaskNotification('b5', 'completed'))
  expect(await readPromptContext($)).toContain('current step: Code')
})

test('a tree change lapses a background verify run, and the tree coming back does not revive it', async ($, on) => {
  const git = { ...changed, tree: 'one' }
  createWorld(on, git, { verifyFile, toolRun: buildBackgroundedRun('b6') })
  await $.tool.call(buildBashCall('./test/run.sh'))
  git.tree = 'two'
  expect(isIdle(await readFlowStatus($))).toBe(true)
  git.tree = 'one'
  expect(isIdle(await readFlowStatus($))).toBe(true)
  await notifyTask($, buildTaskNotification('b6', 'completed'))
  expect(await readPromptContext($)).toContain('current step: Code')
})

test('a background verify run whose task ended unnotified lapses at the second turn end that does not list it', async ($, on) => {
  createWorld(on, changed, { verifyFile, toolRun: buildBackgroundedRun('b7') })
  await $.tool.call(buildBashCall('./test/run.sh'))
  await stopTurn($, ['b7'])
  await stopTurn($, [])
  expect(isRunning(await readFlowStatus($))).toBe(true)
  await stopTurn($, [])
  expect(isIdle(await readFlowStatus($))).toBe(true)
})

test('a background verify run listed again at a turn end is not lapsed', async ($, on) => {
  createWorld(on, changed, { verifyFile, toolRun: buildBackgroundedRun('b8') })
  await $.tool.call(buildBashCall('./test/run.sh'))
  await stopTurn($, [])
  await stopTurn($, ['b8'])
  await stopTurn($, [])
  expect(isRunning(await readFlowStatus($))).toBe(true)
})

test('a backgrounded verify run that ends with its caller\'s final response is not followed', async ($, on) => {
  createWorld(on, changed, { verifyFile, toolRun: buildBackgroundedRun('b9', { backgroundEndsWithFinalResponse: true }) })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(isIdle(await readFlowStatus($))).toBe(true)
  await notifyTask($, buildTaskNotification('b9', 'completed'))
  expect(await readPromptContext($)).toContain('current step: Code')
})

for (const { name, deliver } of unrelatedDeliveries) {
  test(`${name} leaves a background verify run in flight`, async ($, on) => {
    createWorld(on, changed, { verifyFile, toolRun: buildBackgroundedRun('b10') })
    await $.tool.call(buildBashCall('./test/run.sh'))
    await deliver($)
    expect(isRunning(await readFlowStatus($))).toBe(true)
  })
}

test('the Verify instruction asks for the command without a pipe and no longer forbids the background', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { verifyFile, unit: { start: 'c0' } })
  const text = await readPromptContext($)
  expect(text).toContain('run ./test/run.sh exactly (no pipe)')
  expect(text).not.toContain('background')
})

test('a herdr verify launch with no wait-output yet is in flight', async ($, on) => {
  const toolRun = { result: { stdout: '' } }
  createWorld(on, changed, { verifyFile, toolRun })
  await setPermissionMode($, 'default')
  await $.tool.call(buildBashCall(buildPaneRunCommand('h10:p1', buildLaunchCommand('b10'))))
  expect(isRunning(await readFlowStatus($))).toBe(true)
  const text = await readPromptContext($)
  expect(text).toContain('herdr pane wait-output h10:p1')
  expect(text).not.toContain('run ./test/run.sh')
})

for (const { name, answer } of inconclusiveWaits) {
  test(`a herdr verify run stays in flight after ${name}`, async ($, on) => {
    const next: Pending = { run: { result: { stdout: '' } } }
    createWorld(on, changed, { verifyFile, toolRun: () => next.run })
    await $.tool.call(buildBashCall(buildPaneRunCommand('h11:p1', buildLaunchCommand('b11'))))
    next.run = answer
    await $.tool.call(buildBashCall(buildWaitCommand('h11:p1', 'b11')))
    expect(isRunning(await readFlowStatus($))).toBe(true)
  })
}

test('a herdr verify run reporting a non-zero marker ends the run in flight', async ($, on) => {
  const next: Pending = { run: { result: { stdout: '' } } }
  createWorld(on, changed, { verifyFile, toolRun: () => next.run })
  await $.tool.call(buildBashCall(buildPaneRunCommand('h12:p1', buildLaunchCommand('b12'))))
  expect(isRunning(await readFlowStatus($))).toBe(true)
  next.run = buildMatchedRun('__EXIT_b12=1__')
  await $.tool.call(buildBashCall(buildWaitCommand('h12:p1', 'b12')))
  expect(isIdle(await readFlowStatus($))).toBe(true)
})

test('a tree change ends a herdr verify run in flight, and a later green marker does not pass Verify', async ($, on) => {
  const git = { ...changed, tree: 'one' }
  const next: Pending = { run: { result: { stdout: '' } } }
  createWorld(on, git, { verifyFile, toolRun: () => next.run })
  await $.tool.call(buildBashCall(buildPaneRunCommand('h13:p1', buildLaunchCommand('b13'))))
  expect(isRunning(await readFlowStatus($))).toBe(true)
  git.tree = 'two'
  expect(isIdle(await readFlowStatus($))).toBe(true)
  next.run = buildMatchedRun('__EXIT_b13=0__')
  await $.tool.call(buildBashCall(buildWaitCommand('h13:p1', 'b13')))
  expect(isIdle(await readFlowStatus($))).toBe(true)
  expect(await readPromptContext($)).toContain('current step: Code')
})

test('a changed tree with no verify run in flight leaves Code current and names the verify command', async ($, on) => {
  createWorld(on, changed, { verifyFile })
  expect(isIdle(await readFlowStatus($))).toBe(true)
  expect(await readPromptContext($)).toContain('make the change, then run ./test/run.sh to pass Verify')
})

test('a green verify run on a tree that then changes is not in flight', async ($, on) => {
  const git = { ...changed, tree: 'one' }
  createWorld(on, git, { verifyFile })
  await $.tool.call(buildBashCall('./test/run.sh'))
  git.tree = 'two'
  expect(isIdle(await readFlowStatus($))).toBe(true)
})

test('a piped verify command is not a run in flight', async ($, on) => {
  const seen = { status: '' }
  createWorld(on, changed, { verifyFile, toolRun: async () => { seen.status = (await readFlowStatus($)) ?? ''; return green } })
  await $.tool.call(buildBashCall('./test/run.sh | tail'))
  expect(seen.status).not.toContain('running')
})
