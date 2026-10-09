import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { bashCall, declareFlow, flow, flowStatus, noFlow, promptContext, setPermissionMode, verifyFile } from './helpers'
import { world } from './world'

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
    verifyFile, session: noFlow, unit: { start: 'c0', skills: ['grilling', 'to-spec'], produced: ['to-spec'], verify: 'done' },
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
    expect(await promptContext($)).toContain(isPassed ? 'current step: Commit' : 'current step: Change')
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
