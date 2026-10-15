import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { buildBashCall, buildDiagnosis, verifyFile } from '../../support/builders'
import { readCurrentStep, readFlowStatus, readPromptContext } from '../../support/helpers'
import { createWorld, root } from '../../support/world'
import type { Checkout, Options, Worktree } from '../../support/world'

/** A way to miss one of Code's four conditions, and what Code does then. */
interface MissingCase { name: string; checkout?: Partial<Checkout>; worktree?: Partial<Worktree>; options?: Partial<Options> }

const reproduction = 'bats test/fix.bats'
const worktreeRoot = `${root}/.claude/worktrees/diagnose-1`
const failed = { isError: true as const, result: { stdout: '', stderr: '', interrupted: false } }
const passed = { isError: undefined, result: { stdout: '', stderr: '', interrupted: false } }

const missingCases: MissingCase[] = [
  { name: 'no change at all', checkout: { changed: [] } },
  { name: 'a red file not yet in the main checkout', checkout: { hashes: {} } },
  { name: 'the worktree still listed', worktree: { isRemoved: false } },
  { name: 'the worktree\'s branch still there', worktree: { isBranchDeleted: false } },
  { name: 'the change not handed to Verify', options: { verifyFile } },
]

// A Fix whose Diagnose is approved, with the red file transferred to the main checkout, a fix beside it and the worktree gone:
// every one of Code's four conditions holds, and each test breaks what it needs.
function buildFix(on: On, over: { checkout?: Partial<Checkout>; worktree?: Partial<Worktree>; options?: Partial<Options> } = {}) {
  const checkout: Checkout = { branch: 'fix', isDirty: true, changed: ['test/fix.bats', 'src/fix.sh'], hashes: { 'test/fix.bats': 'h1' }, dirty: { 'src/fix.sh': 'h9' }, ...over.checkout }
  const worktree: Worktree = { name: 'diagnose-1', base: 'c0', isRemoved: true, isBranchDeleted: true, ...over.worktree }
  const options: Options = {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
    unit: {
      skills: ['diagnosing-bugs'], start: 'c0', worktree: { name: 'diagnose-1', path: worktreeRoot },
      red: { command: reproduction, fingerprints: { 'test/fix.bats': 'h1' } }, green: reproduction, diagnosis: 'https://github.com/o/r/issues/1#issuecomment-1', approval: 'https://github.com/o/r/issues/1#issuecomment-1',
    },
    issueComments: { 1: [{ url: 'https://github.com/o/r/issues/1#issuecomment-1', body: buildDiagnosis(reproduction) }] }, issueLabels: { 1: ['ready-for-agent'] },
    worktree, cwd: root, toolRun: passed, ...over.options,
  }
  createWorld(on, checkout, options)
  return { checkout, worktree, options }
}

test('Code is done once there is a change, every red file is in main as proved, the worktree and its branch are gone and the change is handed over', async ($, on) => {
  buildFix(on)
  expect(await readCurrentStep($)).toBe('Commit')
})

for (const { name, checkout, worktree, options } of missingCases) {
  test(`Code is not done with ${name}`, async ($, on) => {
    buildFix(on, { checkout, worktree, options })
    expect(await readCurrentStep($)).toBe('Code')
  })
}

test('a transferred red file edited in the main checkout reopens Diagnose with Red and Green stale, keeping the diagnosis and its approval', async ($, on) => {
  const { checkout } = buildFix(on)
  checkout.hashes = { 'test/fix.bats': 'h2' }
  expect(await readCurrentStep($)).toBe('Diagnose')
  expect(await readFlowStatus($)).toMatch(/▸ Diagnose\n {4}▸ Red {2}stale\n {4}○ Green {2}stale\n {4}✓ Diagnosis\n {4}✓ Approval/)
})

for (const { name, hashes, atStart } of [
  { name: 'absent from the main checkout', hashes: {}, atStart: {} },
  { name: 'still as it was at the start', hashes: { 'test/fix.bats': 'h0' }, atStart: { 'test/fix.bats': 'h0' } },
  { name: 'deleted from the main checkout', hashes: {}, atStart: { 'test/fix.bats': 'h0' } },
]) {
  test(`a red file ${name} is not stale, and keeps Code open`, async ($, on) => {
    buildFix(on, { checkout: { hashes, atStart } })
    expect(await readCurrentStep($)).toBe('Code')
    expect(await readFlowStatus($)).not.toContain('stale')
  })
}

test('the re-proof instruction for an existing worktree names the stale files and the stash, red and green sequence', async ($, on) => {
  const { checkout } = buildFix(on, { worktree: { isRemoved: false, isBranchDeleted: false } })
  checkout.hashes = { 'test/fix.bats': 'h2' }
  const context = await readPromptContext($)
  for (const text of [`test/fix.bats changed in the main checkout`, `call EnterWorktree with path ${worktreeRoot}`, 'copy each changed file from the main checkout into the worktree',
    'git stash push --', `run exactly ${reproduction} and see it fail (red)`, 'git stash pop', 'see it pass (green)']) expect(context).toContain(text)
})

test('the re-proof instruction for a removed worktree creates a new one from the start and brings the main checkout\'s changes in', async ($, on) => {
  const { checkout } = buildFix(on)
  checkout.hashes = { 'test/fix.bats': 'h2' }
  const context = await readPromptContext($)
  for (const text of ['the worktree is gone: call EnterWorktree to create a new one', `git -C ${root} add -N . && git -C ${root} diff --binary c0 | git apply`, 'git stash push --', 'git stash pop']) expect(context).toContain(text)
})

test('proving again in the worktree refreshes the red on a failing run and completes Diagnose on a passing one, the approval kept', async ($, on) => {
  const { checkout, worktree, options } = buildFix(on, { worktree: { isRemoved: false, isBranchDeleted: false }, options: { cwd: worktreeRoot } })
  checkout.hashes = { 'test/fix.bats': 'h2' }
  Object.assign(worktree, { changed: ['test/fix.bats'], hashes: { 'test/fix.bats': 'h2' } })
  options.toolRun = failed
  await $.tool.call(buildBashCall(reproduction))
  expect(await readFlowStatus($)).toContain('▸ Diagnose\n    ✓ Red\n    ▸ Green')
  options.toolRun = passed
  await $.tool.call(buildBashCall(reproduction))
  expect(await readFlowStatus($)).toContain('✓ Diagnose\n▸ Code')
  expect(await readCurrentStep($)).toBe('Code')
  expect(await readFlowStatus($)).toContain('✓ Diagnose\n▸ Code')
})

test('the Code instruction lists the open steps in order: leave the worktree, transfer, remove it and its branch, then change', async ($, on) => {
  buildFix(on, { checkout: { hashes: {}, changed: ['test/fix.bats'] }, worktree: { isRemoved: false, isBranchDeleted: false }, options: { cwd: worktreeRoot } })
  expect(await readPromptContext($)).toContain(
    'call ExitWorktree with action keep, then remove the [DEBUG-…] instrumentation in the worktree, then ' +
    `transfer everything at once with git -C ${worktreeRoot} add -N . && git -C ${worktreeRoot} diff --binary c0 | git apply, then ` +
    `git worktree remove --force ${worktreeRoot}, then git branch -D worktree-diagnose-1, then make the change (the fix may be refined after the transfer)`)
})

test('the Code instruction skips the transfer once the red files and the fix are in the main checkout', async ($, on) => {
  buildFix(on, { worktree: { isRemoved: false, isBranchDeleted: false } })
  const context = await readPromptContext($)
  expect(context).not.toContain('transfer everything')
  expect(context).toContain(`git worktree remove --force ${worktreeRoot}, then git branch -D worktree-diagnose-1, then make the change`)
})

test('the Code instruction names the red files a removed worktree left out of the main checkout', async ($, on) => {
  buildFix(on, { checkout: { hashes: {} } })
  expect(await readPromptContext($)).toContain('add the red files not yet in the main checkout (test/fix.bats), then make the change')
})

test('the Worktree row shows while the worktree exists, turns warn when it alone holds Code back, and is gone with it', async ($, on) => {
  const { worktree, checkout } = buildFix(on, { checkout: { hashes: {} }, worktree: { isRemoved: false, isBranchDeleted: false } })
  expect(await readFlowStatus($)).toMatch(/Worktree {2}diagnose-1\n/)
  checkout.hashes = { 'test/fix.bats': 'h1' }
  expect(await readFlowStatus($)).toContain('Worktree  diagnose-1 — remove it to finish Code')
  Object.assign(worktree, { isRemoved: true, isBranchDeleted: true })
  expect(await readFlowStatus($)).not.toContain('Worktree')
})

for (const command of [
  `git -C ${worktreeRoot} add -N . && git -C ${worktreeRoot} diff --binary c0 | git apply`,
  `git worktree remove --force ${worktreeRoot}`,
  'git branch -D worktree-diagnose-1',
]) {
  test(`during Code the instructed command is not denied: ${command}`, async ($, on) => {
    buildFix(on, { checkout: { hashes: {} }, worktree: { isRemoved: false, isBranchDeleted: false } })
    expect((await $.tool.call(buildBashCall(command))).deny).toBeUndefined()
  })
}

test('proving again with another command is a new loop: the green, the diagnosis and the approval go, and a new diagnosis comment is asked for', async ($, on) => {
  const other = 'bats test/other.bats'
  const { checkout, worktree, options } = buildFix(on, { worktree: { isRemoved: false, isBranchDeleted: false }, options: { cwd: worktreeRoot } })
  checkout.hashes = { 'test/fix.bats': 'h2' }
  Object.assign(worktree, { changed: ['test/other.bats'], hashes: { 'test/other.bats': 'h3' } })
  options.toolRun = failed
  await $.tool.call(buildBashCall(other))
  options.toolRun = passed
  await $.tool.call(buildBashCall(other))
  expect(await readCurrentStep($)).toBe('Diagnose')
  expect(await readFlowStatus($)).toMatch(/▸ Diagnose\n {4}✓ Red\n {4}✓ Green\n {4}▸ Diagnosis\n {4}○ Approval/)
  const context = await readPromptContext($)
  expect(context).toContain(`quote the red command (${other})`)
  expect(context).toContain('every red file (test/other.bats)')
})
