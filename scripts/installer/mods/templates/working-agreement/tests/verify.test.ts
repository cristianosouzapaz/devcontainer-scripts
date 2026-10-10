import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { bashCall, declareFlow, flow, flowStatus, noFlow, promptContext, setPermissionMode, verifyFile } from './helpers'
import type { ToolRun } from '../hooks/outcome'
import { world } from './world'

/** What the next tool call returns, swapped by a test while a verify run is in flight. */
interface Pending { run: ToolRun }

// Malformed verify files, by what is wrong with them.
const malformed: [string, string][] = [
  ['invalid JSON', '{ verify'],
  ['not an object', '["./test/run.sh"]'],
  ['an empty verify', JSON.stringify({ verify: '  ' })],
  ['a verify that is not a string', JSON.stringify({ verify: 3 })],
]
// herdr verify runs: the pane launched, the pane waited on, the marker id, the line wait-output matched, and whether Verify passes.
const herdr: [string, string, string, string, string, boolean][] = [
  ['exit 0', 'h1:p1', 'h1:p1', 'a1', '__EXIT_a1=0__', true],
  ['exit 1', 'h2:p1', 'h2:p1', 'a2', '__EXIT_a2=1__', false],
  ['another pane', 'h3:p1', 'h3:p2', 'a3', '__EXIT_a3=0__', false],
  ['a stale marker with another id', 'h6:p1', 'h6:p1', 'a6', '__EXIT_old=0__', false],
]

const commit = ($: Engine) => $.tool.check({ tool: 'Bash', input: { command: 'git commit -m x' } })
// A herdr pane run returns at once: only the marker line wait-output reads back says how the tests ended.
const run = (pane: string, inner: string) => `herdr pane run ${pane} '${inner}'`
const launch = (id: string) => `./test/run.sh; echo "__EXIT_${id}=$?__"`
const wait = (pane: string, id: string) => `herdr pane wait-output ${pane} --regex '__EXIT_${id}=[0-9]+__' --source recent-unwrapped --timeout 590000 --lines 80`
const matched = (line: string) => ({ result: { stdout: JSON.stringify({ id: 'cli:pane:wait-output', result: { matched_line: line, type: 'output_matched' } }) } })

test('a commit asks until the verify command passes, and again once the tree changes', async ($, on) => {
  const git = { branch: 'feat', tree: 'one' }
  world(on, git, { verifyFile, session: { flow: 'close-out' } })
  await setPermissionMode($, 'default')
  expect((await commit($)).decision).toBe('ask')
  await $.tool.call(bashCall('./test/run.sh'))
  expect((await commit($)).decision).toBe('allow')
  git.tree = 'two'
  const stale = await commit($)
  expect(stale.decision).toBe('ask')
  expect(stale.decision === 'ask' && stale.reason).toContain('Verify is stale')
})

test('a passing verify command with nothing changed leaves Change current', async ($, on) => {
  world(on, { branch: 'feat', ahead: 8 }, { verifyFile, session: noFlow })
  await flow($, 'trivial')
  await $.tool.call(bashCall('./test/run.sh'))
  expect(await promptContext($)).toContain('current step: Change')
})

test('a passing verify command after a change ticks Change and Verify', async ($, on) => {
  world(on, { branch: 'feat', ahead: 8, isDirty: true }, { verifyFile, session: noFlow })
  await flow($, 'trivial')
  await $.tool.call(bashCall('./test/run.sh'))
  expect(await promptContext($)).toContain('current step: Commit')
})

test('an overridden Verify whose run still matches the tree is not stale', async ($, on) => {
  world(on, { branch: 'feat', ahead: 8, isDirty: true }, { verifyFile, session: noFlow })
  await flow($, 'trivial')
  await $.tool.call(bashCall('./test/run.sh'))
  await flow($, 'override verify test reason')
  const status = (await flowStatus($)) ?? ''
  expect(status).toContain('Verify')
  expect(status).not.toContain('stale')
})

test('an overridden Verify whose run no longer matches the tree is stale', async ($, on) => {
  const git = { branch: 'feat', ahead: 8, isDirty: true, tree: 'one' }
  world(on, git, { verifyFile, session: noFlow })
  await flow($, 'trivial')
  await $.tool.call(bashCall('./test/run.sh'))
  await flow($, 'override verify test reason')
  git.tree = 'two'
  expect(await flowStatus($)).toMatch(/Verify {2}stale/)
})

test('a new session declaring an issue whose uncommitted code was verified is sent to Commit', async ($, on) => {
  world(on, { branch: 'feat', isDirty: true, tree: 'done' }, {
    verifyFile, session: noFlow, unit: { start: 'c0', skills: ['grilling', 'to-spec'], produced: ['to-spec'], verify: 'done' }, issueLabels: { 1: ['ready-for-agent'] },
  })
  await declareFlow($, 'small-feature', [1])
  expect(await promptContext($)).toContain('current step: Commit')
})

test('a repository without a verify file has no Verify step and no notice', async ($, on) => {
  world(on, { branch: 'feat', isDirty: true }, { session: { flow: 'close-out' } })
  const text = await promptContext($)
  expect(text).toContain('current step: Commit')
  expect(text).not.toContain('working-agreement.json')
})

for (const [why, file] of malformed) {
  test(`a malformed verify file (${why}) drops Verify and is named in the context`, async ($, on) => {
    world(on, { branch: 'feat', isDirty: true }, { verifyFile: file, session: { flow: 'close-out' } })
    const text = await promptContext($)
    expect(text).toContain('current step: Commit')
    expect(text).toContain('[working-agreement] .agents/working-agreement.json ignored')
  })
}

test('a malformed verify file is named even with no flow declared', async ($, on) => {
  world(on, { branch: 'feat' }, { verifyFile: '{', session: noFlow })
  expect(await promptContext($)).toContain('.agents/working-agreement.json ignored')
})

for (const [name, from, on_, id, line, isPassed] of herdr) {
  test(`a herdr verify run reporting ${name} ${isPassed ? 'passes' : 'does not pass'} Verify`, async ($, on) => {
    const toolRun = matched(line)
    world(on, { branch: 'feat', ahead: 8, isDirty: true }, { verifyFile, session: noFlow, toolRun })
    await flow($, 'trivial')
    toolRun.result = { stdout: '' }
    await $.tool.call(bashCall(run(from, launch(id))))
    Object.assign(toolRun, matched(line))
    await $.tool.call(bashCall(wait(on_, id)))
    const text = await promptContext($)
    if (isPassed) expect(text).toContain('current step: Commit')
    else expect(text).not.toContain('current step: Commit')
  })
}

test('a herdr verify run whose tree changed before wait-output does not pass Verify', async ($, on) => {
  const git = { branch: 'feat', ahead: 8, isDirty: true, tree: 'one' }
  const toolRun = { result: { stdout: '' } }
  world(on, git, { verifyFile, session: noFlow, toolRun })
  await flow($, 'trivial')
  await $.tool.call(bashCall(run('h4:p1', launch('a4'))))
  git.tree = 'two'
  Object.assign(toolRun, matched('__EXIT_a4=0__'))
  await $.tool.call(bashCall(wait('h4:p1', 'a4')))
  expect(await promptContext($)).toContain('current step: Change')
})

test('a herdr verify launch reusing an id already reported does not pass Verify', async ($, on) => {
  const toolRun = { result: { stdout: '' } }
  world(on, { branch: 'feat', ahead: 8, isDirty: true }, { verifyFile, session: noFlow, toolRun })
  await flow($, 'trivial')
  await $.tool.call(bashCall(run('h7:p1', launch('a7'))))
  Object.assign(toolRun, matched('__EXIT_a7=1__'))
  await $.tool.call(bashCall(wait('h7:p1', 'a7')))
  toolRun.result = { stdout: '' }
  await $.tool.call(bashCall(run('h7:p2', launch('a7'))))
  Object.assign(toolRun, matched('__EXIT_a7=0__'))
  await $.tool.call(bashCall(wait('h7:p2', 'a7')))
  expect(await promptContext($)).toContain('current step: Change')
})

for (const [name, inner] of [['no marker', './test/run.sh'], ['another command', 'npm test; echo "__EXIT_a5=$?__"'], ['an id-less marker', './test/run.sh; echo "__EXIT=$?__"']] as const) {
  test(`a herdr run with ${name} does not pass Verify`, async ($, on) => {
    const toolRun = { result: { stdout: '' } }
    world(on, { branch: 'feat', ahead: 8, isDirty: true }, { verifyFile, session: noFlow, toolRun })
    await flow($, 'trivial')
    await $.tool.call(bashCall(run('h5:p1', inner)))
    Object.assign(toolRun, matched('__EXIT_a5=0__'))
    await $.tool.call(bashCall(wait('h5:p1', 'a5')))
    expect(await promptContext($)).toContain('current step: Change')
  })
}

// A verify run in flight: the tool call is open and the test code observes the mod from inside it.
const changed = { branch: 'feat', ahead: 8, isDirty: true }
const green: ToolRun = { result: { stdout: '' } }
const isRunning = (status: string | undefined) => (status ?? '').includes('▸ Verify — running') && (status ?? '').includes('✓ Code')
const isIdle = (status: string | undefined) => (status ?? '').includes('▸ Code') && (status ?? '').includes('○ Verify') && !(status ?? '').includes('running')
// The steps of the last view written to the pane's store, which a read of the pane would refresh.
const watchView = (on: On) => {
  const seen = { steps: '' }
  on('state.set', { plugin: 'working-agreement', key: 'view' }, (_$, e, next) => {
    seen.steps = JSON.stringify(e.value?.steps ?? [])
    return next(e)
  })
  return seen
}

test('a direct verify run refreshes the pane before the command executes', async ($, on) => {
  const view = watchView(on)
  const seen = { steps: '' }
  world(on, changed, { verifyFile, toolRun: () => { seen.steps = view.steps; return green } })
  await $.tool.call(bashCall('./test/run.sh'))
  expect(seen.steps).toContain('running')
  expect(seen.steps).toContain('Verify')
})

test('a direct verify run in flight shows Code done and Verify running', async ($, on) => {
  const seen = { status: '' }
  world(on, changed, { verifyFile, toolRun: async () => { seen.status = (await flowStatus($)) ?? ''; return green } })
  await $.tool.call(bashCall('./test/run.sh'))
  expect(isRunning(seen.status)).toBe(true)
})

test('a direct verify run in flight tells the agent to wait instead of running it', async ($, on) => {
  const seen = { text: '' }
  world(on, changed, { verifyFile, toolRun: async () => { seen.text = await promptContext($); return green } })
  await $.tool.call(bashCall('./test/run.sh'))
  expect(seen.text).toContain('current step: Verify')
  expect(seen.text).toContain('wait')
  expect(seen.text).not.toContain('run ./test/run.sh')
})

test('a commit asks while a direct verify run is in flight', async ($, on) => {
  const seen = { verdict: '' }
  world(on, changed, {
    verifyFile,
    toolRun: async () => {
      const v = await commit($)
      seen.verdict = v.decision === 'ask' ? v.reason : v.decision
      return green
    },
  })
  await setPermissionMode($, 'default')
  await $.tool.call(bashCall('./test/run.sh'))
  expect(seen.verdict).toContain('Verify is running — wait for it')
})

test('a red direct verify run ends the run in flight', async ($, on) => {
  const seen = { status: '' }
  world(on, changed, { verifyFile, toolRun: async () => { seen.status = (await flowStatus($)) ?? ''; return { isError: true, result: { stdout: '' } } } })
  await $.tool.call(bashCall('./test/run.sh'))
  expect(isRunning(seen.status)).toBe(true)
  expect(isIdle(await flowStatus($))).toBe(true)
})

test('a tree change during a direct verify run ends the run in flight and Verify does not pass', async ($, on) => {
  const git = { ...changed, tree: 'one' }
  const seen = { status: '' }
  world(on, git, {
    verifyFile,
    toolRun: async () => { git.tree = 'two'; seen.status = (await flowStatus($)) ?? ''; return green },
  })
  await $.tool.call(bashCall('./test/run.sh'))
  expect(isRunning(seen.status)).toBe(false)
  expect(seen.status).not.toContain('running')
  expect(isIdle(await flowStatus($))).toBe(true)
  expect(await promptContext($)).toContain('current step: Code')
})

test('a direct verify run launched in the background does not stay in flight or pass Verify', async ($, on) => {
  world(on, changed, { verifyFile, toolRun: { result: { backgroundTaskId: 'b1' } } })
  await $.tool.call(bashCall('./test/run.sh'))
  expect(isIdle(await flowStatus($))).toBe(true)
  expect(await promptContext($)).toContain('current step: Code')
})

test('a herdr verify launch with no wait-output yet is in flight', async ($, on) => {
  const toolRun = { result: { stdout: '' } }
  world(on, changed, { verifyFile, toolRun })
  await setPermissionMode($, 'default')
  await $.tool.call(bashCall(run('h10:p1', launch('b10'))))
  expect(isRunning(await flowStatus($))).toBe(true)
  const text = await promptContext($)
  expect(text).toContain('herdr pane wait-output h10:p1')
  expect(text).not.toContain('run ./test/run.sh')
  const verdict = await commit($)
  expect(verdict.decision === 'ask' && verdict.reason).toContain('Verify is running — wait for it')
})

for (const [name, answer] of [['an errored wait-output', { isError: true, result: { stdout: '' } }], ['a wait-output without a matched line', { result: { stdout: 'timed out' } }]] as const) {
  test(`a herdr verify run stays in flight after ${name}`, async ($, on) => {
    const next: Pending = { run: { result: { stdout: '' } } }
    world(on, changed, { verifyFile, toolRun: () => next.run })
    await $.tool.call(bashCall(run('h11:p1', launch('b11'))))
    next.run = answer
    await $.tool.call(bashCall(wait('h11:p1', 'b11')))
    expect(isRunning(await flowStatus($))).toBe(true)
  })
}

test('a herdr verify run reporting a non-zero marker ends the run in flight', async ($, on) => {
  const next: Pending = { run: { result: { stdout: '' } } }
  world(on, changed, { verifyFile, toolRun: () => next.run })
  await $.tool.call(bashCall(run('h12:p1', launch('b12'))))
  expect(isRunning(await flowStatus($))).toBe(true)
  next.run = matched('__EXIT_b12=1__')
  await $.tool.call(bashCall(wait('h12:p1', 'b12')))
  expect(isIdle(await flowStatus($))).toBe(true)
})

test('a tree change ends a herdr verify run in flight, and a later green marker does not pass Verify', async ($, on) => {
  const git = { ...changed, tree: 'one' }
  const next: Pending = { run: { result: { stdout: '' } } }
  world(on, git, { verifyFile, toolRun: () => next.run })
  await $.tool.call(bashCall(run('h13:p1', launch('b13'))))
  expect(isRunning(await flowStatus($))).toBe(true)
  git.tree = 'two'
  expect(isIdle(await flowStatus($))).toBe(true)
  next.run = matched('__EXIT_b13=0__')
  await $.tool.call(bashCall(wait('h13:p1', 'b13')))
  expect(isIdle(await flowStatus($))).toBe(true)
  expect(await promptContext($)).toContain('current step: Code')
})

test('a changed tree with no verify run in flight shows Code current and Verify pending', async ($, on) => {
  world(on, changed, { verifyFile })
  expect(isIdle(await flowStatus($))).toBe(true)
  expect(await promptContext($)).toContain('run ./test/run.sh')
})

test('a green verify run on a tree that then changes is not in flight', async ($, on) => {
  const git = { ...changed, tree: 'one' }
  world(on, git, { verifyFile })
  await $.tool.call(bashCall('./test/run.sh'))
  git.tree = 'two'
  expect(isIdle(await flowStatus($))).toBe(true)
})

test('a piped verify command is not a run in flight', async ($, on) => {
  const seen = { status: '' }
  world(on, changed, { verifyFile, toolRun: async () => { seen.status = (await flowStatus($)) ?? ''; return green } })
  await $.tool.call(bashCall('./test/run.sh | tail'))
  expect(seen.status).not.toContain('running')
})
