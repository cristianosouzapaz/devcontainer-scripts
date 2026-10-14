import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ToolRun } from '../../../hooks/core/command-observation'
import { buildBackgroundedRun, buildBashCall, buildTaskNotification, buildWriteCall, verifyFile } from '../../support/builders'
import { endTurn, notifyTask, readFlowStatus, readPromptContext, runFlowCommand, setPermissionMode } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Checkout, Options } from '../../support/world'

/** A Bash call to come: the tree its program leaves, unchanged when omitted, and what the call returns. */
interface PendingRun { tree?: Record<string, string>; result: ToolRun }

/** A call that leaves a writer running after it returns: its name, its command and what it returns. */
interface LeftWriter { name: string; command: string; result: ToolRun }

// A Fix session at Diagnose on #1, and a Small feature one at Code.
const atDiagnose: Options = { session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } }, unit: { skills: ['diagnosing-bugs'], start: 'c0' } }
const atCode: Options = { unit: { skills: ['grilling', 'to-spec'] } }
const passed: ToolRun = { result: { stdout: '', stderr: '', interrupted: false } }
const failed: ToolRun = { isError: true, result: { stdout: '', stderr: '', interrupted: false } }
const held = 'changed outside Edit or Write'

// The ways a call leaves a writer behind it: the engine moving it to the background, a process detached with `&`, and a
// herdr pane run, each with what the call returns.
const leftWriters: LeftWriter[] = [
  { name: 'a run_in_background call', command: 'python3 scripts/patch.py', result: buildBackgroundedRun('t1') },
  { name: 'a call detaching a process with &', command: 'python3 scripts/patch.py &', result: passed },
  { name: 'a herdr pane run', command: `herdr pane run p1 'python3 scripts/patch.py; echo "__EXIT_h1=$?__"'`, result: passed },
]

// Builds a world whose Bash calls run programs that change the tree behind the parser's back; `run` makes the next call
// leave the tree as given, `write` probes the gate with a test-file write, which Diagnose lets through, and `git` and
// `world` are the checkout and options the world reads at each call, so a test can change the tree between calls.
function startWorld($: Engine, on: On, options: Options, checkout: Checkout = { branch: 'fix', dirty: {} }) {
  const git: Checkout = { ...checkout }
  const pending: PendingRun = { result: passed }
  const world: Options = {
    ...options, verifyFile, toolRun: () => {
      if (pending.tree) git.dirty = pending.tree
      return pending.result
    },
  }
  createWorld(on, git, world)
  const run = async (command: string, tree?: Record<string, string>, result: ToolRun = passed) => {
    Object.assign(pending, { tree, result })
    await $.tool.call(buildBashCall(command))
    Object.assign(pending, { tree: undefined, result: passed })
  }
  const write = async (path = 'test/more.bats') => (await $.tool.call(buildWriteCall(path))).deny
  return { run, write, git, world }
}

test('a program that changes a non-test file at Diagnose holds every later write back, and shows in the pane, until the file is restored', async ($, on) => {
  const { run, write } = startWorld($, on, atDiagnose)
  await run('python3 scripts/patch.py', { 'src/app.ts': 'h2' })
  expect(await write()).toContain(`src/app.ts ${held}`)
  expect(await write()).toContain('never work around a blocked write')
  expect(await readFlowStatus($)).toContain('src/app.ts changed outside Edit or Write')
  await run('git restore src/app.ts', {})
  expect(await write()).toBeUndefined()
  expect(await readFlowStatus($)).not.toContain('Unexplained')
})

test('a file dirty before the call and changed again is caught, and is restored by bringing back what it held before', async ($, on) => {
  const { run, write } = startWorld($, on, atDiagnose, { branch: 'fix', dirty: { 'src/app.ts': 'h1' } })
  await run('python3 scripts/patch.py', { 'src/app.ts': 'h2' })
  expect(await write()).toContain(`src/app.ts ${held}`)
  await run('git restore src/app.ts', {})
  expect(await write()).toContain(`src/app.ts ${held}`)
  await run('git checkout stash@{0} -- src/app.ts', { 'src/app.ts': 'h1' })
  expect(await write()).toBeUndefined()
})

test('a file a program created is restored by deleting it', async ($, on) => {
  const { run, write } = startWorld($, on, atDiagnose)
  await run('make generate', { 'src/generated.ts': 'h3' })
  expect(await write()).toContain(`src/generated.ts ${held}`)
  await run('rm src/generated.ts', {})
  expect(await write()).toBeUndefined()
})

test('/flow override writes accepts the unexplained writes and lets writes through again', async ($, on) => {
  const { run, write } = startWorld($, on, atDiagnose)
  await run('python3 scripts/patch.py', { 'src/app.ts': 'h2' })
  expect((await runFlowCommand($, 'override writes the patch was intended')).text).toContain('Override logged')
  expect(await write()).toBeUndefined()
})

test('a test file a program changes joins the unit\'s test files, so its failing run records the red', async ($, on) => {
  const { run, write } = startWorld($, on, atDiagnose, { branch: 'fix', dirty: {}, changed: ['test/fix.bats'], hashes: { 'test/fix.bats': 'h1' } })
  await run('python3 scripts/gen_test.py', { 'test/fix.bats': 'h1' })
  await run('bats test/fix.bats', undefined, failed)
  expect(await write('src/fix.sh')).toBeUndefined()
})

test('a program that changes a non-test file at Code holds nothing back', async ($, on) => {
  const { run, write } = startWorld($, on, atCode, { branch: 'feat', dirty: {} })
  await run('python3 scripts/patch.py', { 'src/app.ts': 'h2' })
  expect(await write('src/b.ts')).toBeUndefined()
  expect(await readFlowStatus($)).not.toContain('Unexplained')
})

test('a tree git cannot read around a call holds writes back while a step does, until the user overrides once git reads it again', async ($, on) => {
  const { run, write, world } = startWorld($, on, { ...atDiagnose, failing: 'git -C /repo status --porcelain -z' })
  await run('python3 scripts/patch.py')
  expect(await write()).toContain('could not be read')
  world.failing = undefined
  expect((await runFlowCommand($, 'override writes checked the tree')).text).toContain('Override logged')
  expect(await write()).toBeUndefined()
})

test('a tree git cannot read around a call holds nothing back at Code', async ($, on) => {
  const { run, write } = startWorld($, on, { ...atCode, failing: 'git -C /repo status --porcelain -z' }, { branch: 'feat', dirty: {} })
  await run('python3 scripts/patch.py')
  expect(await write('src/b.ts')).toBeUndefined()
})

test('a call the user approved records no unexplained write', async ($, on) => {
  const { run, write } = startWorld($, on, atDiagnose)
  await setPermissionMode($, 'default')
  await run("python3 -c 'patch()'", { 'src/app.ts': 'h2' })
  await setPermissionMode($, 'auto')
  expect(await write()).toBeUndefined()
})

for (const writer of leftWriters) {
  test(`a non-test change landing after ${writer.name} returned holds the very next write back, a non-test one included`, async ($, on) => {
    const { run, write, git } = startWorld($, on, atDiagnose)
    await run(writer.command, undefined, writer.result)
    git.dirty = { 'src/app.ts': 'h2' }
    expect(await write('src/b.ts')).toContain(`src/app.ts ${held}`)
    expect(await write()).toContain(`src/app.ts ${held}`)
    expect(await readFlowStatus($)).toContain('src/app.ts changed outside Edit or Write')
  })
}

test('a change landing between calls holds a Bash write back before the call runs', async ($, on) => {
  const { run, git } = startWorld($, on, atDiagnose)
  await run('ls')
  git.dirty = { 'src/app.ts': 'h2' }
  expect((await $.tool.call(buildBashCall('echo x > test/more.bats'))).deny).toContain(`src/app.ts ${held}`)
})

test('a change between the last call and the turn end is recorded at the turn end, before the user\'s prompt can absorb it', async ($, on) => {
  const { run, write, git } = startWorld($, on, atDiagnose)
  await run('ls')
  git.dirty = { 'src/app.ts': 'h2' }
  await endTurn($)
  await readPromptContext($)
  expect(await write()).toContain(`src/app.ts ${held}`)
})

test('a change between turns with no detached run in flight is the user\'s and is absorbed at their prompt', async ($, on) => {
  const { run, write, git } = startWorld($, on, atDiagnose)
  await run('ls')
  await endTurn($)
  git.dirty = { 'src/app.ts': 'h2' }
  await readPromptContext($)
  expect(await write()).toBeUndefined()
  expect(await readFlowStatus($)).not.toContain('Unexplained')
})

test('a change between turns while a background task is in flight is not absorbed at the user\'s prompt', async ($, on) => {
  const { run, write, git } = startWorld($, on, atDiagnose)
  await run('sleep 100', undefined, buildBackgroundedRun('t1'))
  await endTurn($)
  git.dirty = { 'src/app.ts': 'h2' }
  await readPromptContext($)
  expect(await write()).toContain(`src/app.ts ${held}`)
})

test('a change between turns is absorbed again once the background task\'s end is notified', async ($, on) => {
  const { run, write, git } = startWorld($, on, atDiagnose)
  await run('sleep 100', undefined, buildBackgroundedRun('t1'))
  await notifyTask($, buildTaskNotification('t1', 'completed'))
  await endTurn($)
  git.dirty = { 'src/app.ts': 'h2' }
  await readPromptContext($)
  expect(await write()).toBeUndefined()
})

test('a task notification absorbs nothing', async ($, on) => {
  const { run, write, git } = startWorld($, on, atDiagnose)
  await run('ls')
  await endTurn($)
  git.dirty = { 'src/app.ts': 'h2' }
  await notifyTask($, buildTaskNotification('t9', 'completed'))
  expect(await write()).toContain(`src/app.ts ${held}`)
})

test('a test file changed between calls joins the unit\'s test files, so its failing run records the red', async ($, on) => {
  const { run, write, git } = startWorld($, on, atDiagnose, { branch: 'fix', dirty: {}, changed: ['test/fix.bats'], hashes: { 'test/fix.bats': 'h1' } })
  await run('ls')
  git.dirty = { 'test/fix.bats': 'h1' }
  await run('bats test/fix.bats', undefined, failed)
  expect(await write('src/fix.sh')).toBeUndefined()
})

test('a change between calls at Code holds nothing back', async ($, on) => {
  const { run, write, git } = startWorld($, on, atCode, { branch: 'feat', dirty: {} })
  await run('ls')
  git.dirty = { 'src/app.ts': 'h2' }
  expect(await write('src/b.ts')).toBeUndefined()
  expect(await readFlowStatus($)).not.toContain('Unexplained')
})

test('a tree git cannot read at a boundary holds writes back while a step does', async ($, on) => {
  const { run, write, world } = startWorld($, on, atDiagnose)
  await run('ls')
  world.failing = 'git -C /repo status --porcelain -z'
  expect(await write()).toContain('could not be read')
})

test('a tree git cannot read at a boundary holds nothing back at Code', async ($, on) => {
  const { run, write, world } = startWorld($, on, atCode, { branch: 'feat', dirty: {} })
  await run('ls')
  world.failing = 'git -C /repo status --porcelain -z'
  expect(await write('src/b.ts')).toBeUndefined()
})

test('restoring a file changed between calls lets writes through again', async ($, on) => {
  const { run, write, git } = startWorld($, on, atDiagnose)
  await run('ls')
  git.dirty = { 'src/app.ts': 'h2' }
  expect(await write()).toContain(`src/app.ts ${held}`)
  git.dirty = {}
  expect(await write()).toBeUndefined()
})

test('/flow override writes accepts a change made between calls', async ($, on) => {
  const { run, write, git } = startWorld($, on, atDiagnose)
  await run('ls')
  git.dirty = { 'src/app.ts': 'h2' }
  expect(await write()).toContain(`src/app.ts ${held}`)
  expect((await runFlowCommand($, 'override writes the patch was intended')).text).toContain('Override logged')
  expect(await write()).toBeUndefined()
})

test('a call the user approved does not cover a change found before it', async ($, on) => {
  const { run, write, git } = startWorld($, on, atDiagnose)
  await run('ls')
  git.dirty = { 'src/app.ts': 'h2' }
  await setPermissionMode($, 'default')
  await run("python3 -c 'patch()'")
  await setPermissionMode($, 'auto')
  expect(await write()).toContain(`src/app.ts ${held}`)
})

test('a change between turns while a marked herdr pane run is unreported is not absorbed at the user\'s prompt', async ($, on) => {
  const { run, write, git } = startWorld($, on, atDiagnose)
  await run(`herdr pane run p1 'sleep 100; echo "__EXIT_h2=$?__"'`)
  await endTurn($)
  git.dirty = { 'src/app.ts': 'h2' }
  await readPromptContext($)
  expect(await write()).toContain(`src/app.ts ${held}`)
})

test('a background task left running never shows as a run in flight', async ($, on) => {
  const { run } = startWorld($, on, atDiagnose)
  await run('sleep 100', undefined, buildBackgroundedRun('t1'))
  expect(await readFlowStatus($)).not.toContain('running')
})
