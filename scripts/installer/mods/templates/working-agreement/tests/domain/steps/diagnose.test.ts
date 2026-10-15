import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ToolRun } from '../../../hooks/core/command-observation'
import { buildBackgroundedRun, buildBashCall, buildDiagnosis, buildTaskNotification, buildWriteCall, noFlow, verifyFile } from '../../support/builders'
import { notifyTask, postComment, readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand, setPermissionMode } from '../../support/helpers'
import { createWorld, excludePath, root } from '../../support/world'
import type { Checkout, IssueComment, Options, Worktree } from '../../support/world'

/** An `EnterWorktree` call: one that names a new worktree, or one that enters an existing worktree by its path; whether it resets a worktree at another commit. */
interface EnterCase { name: string; worktree: Worktree; isByPath: boolean; isReset: boolean }

/** A run after the red, and whether it is the green. */
interface GreenCase { name: string; command: string; isPassed: boolean; isGreen: boolean }

/** A bug whose red files test-path classification used to misjudge. */
interface RedFilesCase { name: string; files: string[] }

/** How a background run's task ends, and whether that records the red. */
interface BackgroundEnd { status: string; isRed: boolean }

const failed = { isError: true as const, result: { stdout: '', stderr: '', interrupted: false } }
const passed = { isError: undefined, result: { stdout: '', stderr: '', interrupted: false } }
const worktreeRoot = `${root}/.claude/worktrees/diagnose-1`
const reproduction = 'bats test/fix.bats'

const enterCases: EnterCase[] = [
  { name: 'a new clean worktree at another commit', worktree: { name: 'diagnose-1', base: 'c5' }, isByPath: false, isReset: true },
  { name: 'a new worktree holding changes', worktree: { name: 'diagnose-1', base: 'c5', changed: ['src/a.ts'] }, isByPath: false, isReset: false },
  { name: 'a clean worktree entered by its path', worktree: { name: 'diagnose-1', base: 'c5' }, isByPath: true, isReset: false },
]

const greenCases: GreenCase[] = [
  { name: 'a pass of the identical command', command: reproduction, isPassed: true, isGreen: true },
  { name: 'a pass of another command', command: 'bats test/', isPassed: true, isGreen: false },
  { name: 'a pass of the same command written differently', command: 'bats  test/fix.bats', isPassed: true, isGreen: false },
  { name: 'another failure of the identical command', command: reproduction, isPassed: false, isGreen: false },
]

const redFilesCases: RedFilesCase[] = [
  { name: 'a Cypress spec', files: ['src/cart.cy.ts'] },
  { name: 'a function exported for its test', files: ['src/cart.ts', 'src/cart.test.ts'] },
  { name: 'a bug in the test harness', files: ['test/helper.bash'] },
]

const backgroundEnds: BackgroundEnd[] = [
  { status: 'failed', isRed: true },
  { status: 'completed', isRed: false },
  { status: 'killed', isRed: false },
]

// A Fix session on #1 at Diagnose, started at c0, in the main checkout until it enters the worktree.
function atDiagnose(worktree: Worktree, toolRun: ToolRun = passed): Options {
  return {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
    unit: { skills: ['diagnosing-bugs'], start: 'c0' }, issueLabels: { 1: ['ready-for-agent'] }, worktree, cwd: root, verifyFile, toolRun,
  }
}

// Posts a diagnosis comment for the reproduction and approves it, as the agent and the user do after the green.
async function approveDiagnosis($: Engine, comments: Record<number, IssueComment[]>, files = ['test/fix.bats']): Promise<void> {
  await postComment($, comments, buildDiagnosis(reproduction, files))
  await runFlowCommand($, 'approve diagnose')
}

// Enters the worktree and returns a runner of Bash calls with a given outcome, the checkout and the tool result to mutate.
async function enterDiagnosis($: Engine, on: On, worktree: Worktree = { name: 'diagnose-1', base: 'c0', changed: ['test/fix.bats'], hashes: { 'test/fix.bats': 'h1' } }) {
  const git: Checkout = { branch: 'fix', dirty: {} }
  const toolRun: ToolRun = { ...passed }
  const comments: Record<number, IssueComment[]> = {}
  const world = createWorld(on, git, { ...atDiagnose(worktree, toolRun), issueComments: comments })
  await $.tool.call({ tool: 'EnterWorktree', name: worktree.name })
  const run = async (command: string, result: ToolRun = failed) => {
    Object.assign(toolRun, result)
    await $.tool.call(buildBashCall(command))
    Object.assign(toolRun, passed)
  }
  return { git, worktree, world, run, comments }
}

test('EnterWorktree adds the worktrees to info/exclude once, keeping what the file held', async ($, on) => {
  const { files } = createWorld(on, { branch: 'fix' }, { ...atDiagnose({ name: 'diagnose-1', base: 'c0' }), files: { [excludePath]: '# exclude\n*.log' } })
  await $.tool.call({ tool: 'EnterWorktree', name: 'diagnose-1' })
  await $.tool.call({ tool: 'EnterWorktree', path: worktreeRoot })
  expect(files[excludePath]).toBe('# exclude\n*.log\n.claude/worktrees/\n')
})

test('EnterWorktree creates info/exclude when it is missing, with no flow declared', async ($, on) => {
  const { files } = createWorld(on, { branch: 'main' }, { session: noFlow, worktree: { name: 'diagnose-1', base: 'c0' }, cwd: root })
  await $.tool.call({ tool: 'EnterWorktree', name: 'diagnose-1' })
  expect(files[excludePath]).toBe('.claude/worktrees/\n')
})

for (const { name, worktree, isByPath, isReset } of enterCases) {
  test(`EnterWorktree ${isReset ? 'brings' : 'leaves'} ${name} ${isReset ? 'to' : 'off'} the unit's start`, async ($, on) => {
    const { readWorktreeHead } = createWorld(on, { branch: 'fix' }, atDiagnose(worktree))
    await $.tool.call(isByPath ? { tool: 'EnterWorktree', path: worktreeRoot } : { tool: 'EnterWorktree', name: worktree.name })
    expect(readWorktreeHead()).toBe(isReset ? 'c0' : 'c5')
  })
}

test('EnterWorktree resets no worktree outside a flow with Diagnose', async ($, on) => {
  const { readWorktreeHead } = createWorld(on, { branch: 'feat' }, { unit: { start: 'c0' }, worktree: { name: 'diagnose-1', base: 'c5' }, cwd: root })
  await $.tool.call({ tool: 'EnterWorktree', name: 'diagnose-1' })
  expect(readWorktreeHead()).toBe('c5')
})

test('before the worktree, the instruction says to enter it', async ($, on) => {
  createWorld(on, { branch: 'fix' }, atDiagnose({ name: 'diagnose-1', base: 'c0' }))
  expect(await readPromptContext($)).toContain('call EnterWorktree and diagnose there')
})

for (const path of ['test/fix.bats', 'src/cart.cy.ts', 'src/fix.sh']) {
  test(`during Diagnose a write of ${path} to the main checkout is denied, even where an ask could be answered`, async ($, on) => {
    await enterDiagnosis($, on)
    await setPermissionMode($, 'default')
    expect((await $.tool.call(buildWriteCall(`${root}/${path}`))).deny).toContain('main checkout is read-only')
  })
}

test('during Diagnose a write in the worktree goes through', async ($, on) => {
  await enterDiagnosis($, on)
  expect((await $.tool.call(buildWriteCall(`${worktreeRoot}/src/fix.sh`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall('echo fix > src/fix.sh'))).deny).toBeUndefined()
})

test('during Diagnose a shell write into the main checkout is denied', async ($, on) => {
  await enterDiagnosis($, on)
  expect((await $.tool.call(buildBashCall(`cp src/fix.sh ${root}/src/fix.sh`))).deny).toContain('main checkout is read-only')
})

test('during Diagnose a write to the main checkout no command names is caught as an unexplained write', async ($, on) => {
  const { git, run } = await enterDiagnosis($, on)
  await run('python3 scripts/patch.py', { result: { stdout: '' } })
  git.dirty = { 'src/app.ts': 'h9' }
  await run('true', passed)
  expect(await readFlowStatus($)).toContain('src/app.ts changed outside Edit or Write')
})

test('a failing command in the worktree is the red, and the instruction asks for the same command to pass', async ($, on) => {
  const { run } = await enterDiagnosis($, on)
  expect(await readFlowStatus($)).toContain('▸ Diagnose\n    ▸ Red\n    ○ Green')
  await run(reproduction)
  expect(await readFlowStatus($)).toContain('▸ Diagnose\n    ✓ Red\n    ▸ Green')
  expect(await readPromptContext($)).toContain(`re-run exactly: ${reproduction} — it must pass`)
})

test('a failing command in the main checkout before the worktree is no red', async ($, on) => {
  const toolRun: ToolRun = { ...failed }
  createWorld(on, { branch: 'fix' }, atDiagnose({ name: 'diagnose-1', base: 'c0' }, toolRun))
  await $.tool.call(buildBashCall(reproduction))
  expect(await readFlowStatus($)).toContain('    ▸ Red')
})

test('a red from a worktree not at the unit\'s start is refused, naming the start commit', async ($, on) => {
  const toolRun: ToolRun = { ...passed }
  createWorld(on, { branch: 'fix' }, atDiagnose({ name: 'diagnose-1', base: 'c5' }, toolRun))
  await $.tool.call({ tool: 'EnterWorktree', path: worktreeRoot })
  Object.assign(toolRun, failed)
  await $.tool.call(buildBashCall(reproduction))
  expect(await readFlowStatus($)).toContain('    ▸ Red')
  expect(await readPromptContext($)).toContain('git reset --hard c0')
})

for (const { name, command, isPassed, isGreen } of greenCases) {
  test(`after the red, ${name} ${isGreen ? 'is' : 'is not'} the green`, async ($, on) => {
    const { run } = await enterDiagnosis($, on)
    await run(reproduction)
    await run(command, isPassed ? passed : failed)
    expect(await readFlowStatus($)).toContain(isGreen ? '✓ Green\n    ▸ Diagnosis' : '▸ Green')
  })
}

test('a pass before any red is no green', async ($, on) => {
  const { run } = await enterDiagnosis($, on)
  await run(reproduction, passed)
  expect(await readFlowStatus($)).toContain('    ▸ Red')
})

test('until the green, a failing run of another command replaces the red', async ($, on) => {
  const { run } = await enterDiagnosis($, on)
  await run('bats test/a.bats')
  await run('bats test/b.bats')
  await run('bats test/a.bats', passed)
  expect(await readFlowStatus($)).toContain('▸ Green')
  await run('bats test/b.bats', passed)
  expect(await readFlowStatus($)).toContain('✓ Green')
})

test('once Diagnose is approved its sub-steps collapse, and Code says to leave the worktree first', async ($, on) => {
  const { run, comments } = await enterDiagnosis($, on)
  await run(reproduction)
  await run(reproduction, passed)
  await approveDiagnosis($, comments)
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Diagnose\n▸ Code')
  expect(status).not.toContain('Red')
  expect(await readPromptContext($)).toContain('call ExitWorktree with action keep, then remove the [DEBUG-…] instrumentation in the worktree, then transfer everything at once')
})

for (const { name, files } of redFilesCases) {
  test(`${name} goes through without an override`, async ($, on) => {
    const hashes = Object.fromEntries(files.map(file => [file, 'h1']))
    const { git, run, comments, worktree } = await enterDiagnosis($, on, { name: 'diagnose-1', base: 'c0', changed: files, hashes })
    await run(reproduction)
    await run(reproduction, passed)
    await approveDiagnosis($, comments, files)
    await $.tool.call({ tool: 'ExitWorktree', action: 'keep' })
    expect((await $.tool.call(buildWriteCall(files[0] ?? ''))).deny).toBeUndefined()
    Object.assign(git, { isDirty: true, changed: files, hashes })
    Object.assign(worktree, { isRemoved: true, isBranchDeleted: true })
    await run('./test/run.sh', passed)
    expect(await readCurrentStep($)).toBe('Commit')
  })
}

test('a red file edited in the main checkout after the transfer reopens Diagnose, and the re-proof covers a file that also holds the fix', async ($, on) => {
  const files = ['src/cart.ts', 'src/cart.test.ts']
  const { git, run, comments, worktree } = await enterDiagnosis($, on, { name: 'diagnose-1', base: 'c0', changed: files, hashes: { 'src/cart.ts': 'h1', 'src/cart.test.ts': 'h1' } })
  await run(reproduction)
  Object.assign(worktree, { hashes: { ...worktree.hashes, 'src/cart.ts': 'h2' } })
  await run(reproduction, passed)
  await approveDiagnosis($, comments, files)
  await $.tool.call({ tool: 'ExitWorktree', action: 'keep' })
  Object.assign(git, { isDirty: true, changed: files, hashes: { 'src/cart.ts': 'h3', 'src/cart.test.ts': 'h1' }, atStart: { 'src/cart.ts': 'h0' } })
  Object.assign(worktree, { isRemoved: true, isBranchDeleted: true })
  await run('./test/run.sh', passed)
  expect(await readCurrentStep($)).toBe('Diagnose')
  expect(await readFlowStatus($)).toContain('stale')
  expect(await readPromptContext($)).toContain('git apply -R')
})

test('a repro file created after the failing red is adopted when the same command fails again, so the diagnosis must name it', async ($, on) => {
  const { run, comments, worktree } = await enterDiagnosis($, on, { name: 'diagnose-1', base: 'c0', changed: [], hashes: {} })
  await run(reproduction)
  Object.assign(worktree, { changed: ['test/fix.bats'], hashes: { 'test/fix.bats': 'h1' } })
  await run(reproduction)
  await run(reproduction, passed)
  expect(await readPromptContext($)).toContain('every red file (test/fix.bats)')
  await approveDiagnosis($, comments)
  expect(await readFlowStatus($)).toContain('✓ Diagnose')
})

test('with Diagnose overridden a stale red file does not hold Code back', async ($, on) => {
  const { git, run, comments, worktree } = await enterDiagnosis($, on)
  await run(reproduction)
  await runFlowCommand($, 'override diagnose #1 no reproduction')
  await postComment($, comments, buildDiagnosis(reproduction, ['test/fix.bats']))
  await runFlowCommand($, 'approve diagnose')
  await $.tool.call({ tool: 'ExitWorktree', action: 'keep' })
  Object.assign(git, { isDirty: true, changed: ['test/fix.bats', 'src/fix.sh'], hashes: { 'test/fix.bats': 'h2' }, dirty: { 'src/fix.sh': 'h9' } })
  Object.assign(worktree, { isRemoved: true, isBranchDeleted: true })
  await run('./test/run.sh', passed)
  expect(await readCurrentStep($)).toBe('Commit')
})

test('a fix made in a red file goes through without an override, and the fixed red file is the change Code needs', async ($, on) => {
  const files = ['src/cart.ts', 'src/cart.test.ts']
  const { git, run, comments, worktree } = await enterDiagnosis($, on, { name: 'diagnose-1', base: 'c0', changed: files, hashes: { 'src/cart.ts': 'h1', 'src/cart.test.ts': 'h1' } })
  await run(reproduction)
  Object.assign(worktree, { hashes: { ...worktree.hashes, 'src/cart.ts': 'h2' } })
  await run(reproduction, passed)
  await approveDiagnosis($, comments, files)
  await $.tool.call({ tool: 'ExitWorktree', action: 'keep' })
  Object.assign(git, { isDirty: true, changed: files, hashes: { 'src/cart.ts': 'h2', 'src/cart.test.ts': 'h1' }, atStart: { 'src/cart.ts': 'h0' } })
  Object.assign(worktree, { isRemoved: true, isBranchDeleted: true })
  await run('./test/run.sh', passed)
  expect(await readCurrentStep($)).toBe('Commit')
  expect(await readFlowStatus($)).not.toContain('stale')
})

test('the verify command run in the worktree is not Verify', async ($, on) => {
  const { git, run, comments } = await enterDiagnosis($, on)
  await run(reproduction)
  await run(reproduction, passed)
  await approveDiagnosis($, comments)
  Object.assign(git, { isDirty: true, changed: ['test/fix.bats', 'src/fix.sh'] })
  await run('./test/run.sh', passed)
  expect(await readCurrentStep($)).toBe('Code')
})

test('a herdr run in the worktree shows Red running, its failing exit is the red, and a passing relaunch the green', async ($, on) => {
  const { run, comments } = await enterDiagnosis($, on)
  await run(`herdr pane run h8:p1 '${reproduction}; echo "__EXIT_r1=$?__"'`, passed)
  expect(await readFlowStatus($)).toContain('    ▸ Red — running')
  expect(await readPromptContext($)).toContain('herdr pane wait-output h8:p1')
  const matchedLine = JSON.stringify({ id: 'cli:pane:wait-output', result: { matched_line: '__EXIT_r1=1__', type: 'output_matched' } })
  await run('herdr pane wait-output h8:p1 --regex \'__EXIT_r1=[0-9]+__\' --source recent-unwrapped --timeout 590000 --lines 80', { result: { stdout: matchedLine } })
  expect(await readFlowStatus($)).toContain('    ✓ Red\n    ▸ Green')
  await run(`herdr pane run h8:p1 '${reproduction}; echo "__EXIT_r2=$?__"'`, passed)
  const passing = JSON.stringify({ id: 'cli:pane:wait-output', result: { matched_line: '__EXIT_r2=0__', type: 'output_matched' } })
  await run('herdr pane wait-output h8:p1 --regex \'__EXIT_r2=[0-9]+__\' --source recent-unwrapped --timeout 590000 --lines 80', { result: { stdout: passing } })
  expect(await readFlowStatus($)).toContain('✓ Green')
  await approveDiagnosis($, comments)
  expect(await readCurrentStep($)).toBe('Code')
})

for (const { status, isRed } of backgroundEnds) {
  test(`a background run in the worktree whose task is ${status} ${isRed ? 'is' : 'is not'} the red`, async ($, on) => {
    const { run } = await enterDiagnosis($, on)
    await run(reproduction, buildBackgroundedRun('d1'))
    expect(await readFlowStatus($)).toContain('    ▸ Red — running')
    await notifyTask($, buildTaskNotification('d1', status))
    const text = await readFlowStatus($)
    expect(text).toContain(isRed ? '    ✓ Red' : '    ▸ Red')
    expect(text).not.toContain('running')
  })
}

test('overriding Diagnose skips Red and Green, and the diagnosis and its approval still keep the main checkout read-only', async ($, on) => {
  const { comments } = await enterDiagnosis($, on)
  await runFlowCommand($, 'override diagnose #1 no reproduction')
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Diagnose\n    ⚑ Red\n    ⚑ Green\n    ▸ Diagnosis\n    ○ Approval')
  expect((await $.tool.call(buildWriteCall('src/fix.sh'))).deny).toContain('main checkout is read-only')
  await postComment($, comments, buildDiagnosis(reproduction, []).replace(`${reproduction} fails.`, 'No command reproduces it.'))
  await runFlowCommand($, 'approve diagnose')
  expect((await $.tool.call(buildWriteCall('src/fix.sh'))).deny).toBeUndefined()
  expect(await readFlowStatus($)).toContain('Diagnose — "no reproduction"')
})

test('a red stored before reds named their command reads as none', async ($, on) => {
  createWorld(on, { branch: 'fix' }, { ...atDiagnose({ name: 'diagnose-1', base: 'c0' }), unit: { start: 'c0', red: { fingerprints: { 'test/fix.bats': 'h1' } } } })
  expect(await readFlowStatus($)).toContain('    ▸ Red')
})

test('a failing command in a worktree changes nothing outside the Fix flow', async ($, on) => {
  const toolRun: ToolRun = { ...passed }
  createWorld(on, { branch: 'feat' }, { unit: { start: 'c0' }, worktree: { name: 'diagnose-1', base: 'c0' }, cwd: root, toolRun })
  await $.tool.call({ tool: 'EnterWorktree', name: 'diagnose-1' })
  Object.assign(toolRun, failed)
  await $.tool.call(buildBashCall(reproduction))
  expect(await readCurrentStep($)).toBe('Code')
  expect(await readFlowStatus($)).not.toContain('Red')
})
