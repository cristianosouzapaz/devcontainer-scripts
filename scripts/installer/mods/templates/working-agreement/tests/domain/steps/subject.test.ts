import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildWriteCall, noFlow, verifyFile } from '../../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, readPromptContext, setPermissionMode } from '../../support/helpers'
import { createWorld, root } from '../../support/world'
import type { Checkout, Commit, Graph } from '../../support/world'

/** How a PR was merged into main: the commit main's tip moved to, and whether the unit's branch is still there locally. */
interface MergeCase { name: string; tip: Commit; isBranchKept: boolean }

const base: Commit = { parents: [], files: { 'src/a.ts': 'a0' } }
const done: Commit = { parents: ['m1'], files: { 'src/a.ts': 'a1' } }
// The tree key of `done`'s files, as Verify recorded it.
const doneTree = 'tree:src/a.ts=a1'

const mergeCases: MergeCase[] = [false, true].flatMap(isBranchKept => [
  { name: 'squash', tip: { parents: ['m1'], files: done.files }, isBranchKept },
  { name: 'merge commit', tip: { parents: ['m1', 'f1'], files: done.files }, isBranchKept },
  { name: 'rebase', tip: { parents: ['m1'], files: done.files }, isBranchKept },
])

// A finished Small feature on `feat`, judged and committed at `f1`, whose PR #7 GitHub reports in this state at `f1`.
function arrangeFinishedUnit(git: Checkout, state: string) {
  return {
    verifyFile, prs: [{ number: 7, state, headRefName: 'feat' }],
    unit: { start: 'm1', branch: 'feat', skills: ['generate-commit', 'create-pr'], verify: doneTree, pr: { number: 7, state, isCreated: true }, prHead: 'f1', anchor: 'f1' },
  }
}

// The pane's step rows, the rest of it left out.
async function readStepRows($: Engine): Promise<string[]> {
  return ((await readFlowStatus($)) ?? '').split('\n').filter(line => /^[✓▸○↷⚑] /.test(line))
}

for (const dirty of [{}, { 'src/c.ts': 'c1' }]) {
  test(`a finished unit stays finished after a switch to main${Object.keys(dirty).length ? ' with uncommitted changes' : ''}, and reads as before once back`, async ($, on) => {
    const git: Checkout = { branch: 'feat', graph: { commits: { m1: base, f1: done }, refs: { main: 'm1', 'origin/main': 'm1', feat: 'f1' } } }
    createWorld(on, git, arrangeFinishedUnit(git, 'OPEN'))
    const before = await readFlowStatus($)
    const rows = await readStepRows($)
    Object.assign(git, { branch: 'main', dirty })
    expect(await readStepRows($)).toEqual(rows)
    expect(await readFlowStatus($)).toContain('Unit finished.')
    expect(await readPromptContext($)).toBe('')
    Object.assign(git, { branch: 'feat', dirty: {} })
    expect(await readFlowStatus($)).toBe(before)
  })
}

for (const { name, tip, isBranchKept } of mergeCases) {
  test(`a unit whose PR GitHub reports merged by ${name} is finished on main, its branch ${isBranchKept ? 'kept' : 'deleted'}`, async ($, on) => {
    const refs: Record<string, string> = { main: 'm2', 'origin/main': 'm2', ...(isBranchKept ? { feat: 'f1' } : {}) }
    const git: Checkout = { branch: 'main', graph: { commits: { m1: base, f1: done, m2: tip }, refs } }
    createWorld(on, git, arrangeFinishedUnit(git, 'MERGED'))
    expect(await readFlowStatus($)).toContain('Unit finished.')
    expect(await readPromptContext($)).toBe('')
  })
}

test('a unit whose branch is gone locally, with its PR open, is judged on the confirmed PR head', async ($, on) => {
  const git: Checkout = { branch: 'main', graph: { commits: { m1: base, f1: done }, refs: { main: 'm1', 'origin/main': 'm1' } } }
  createWorld(on, git, arrangeFinishedUnit(git, 'OPEN'))
  expect(await readFlowStatus($)).toContain('Unit finished.')
  expect(await readFlowStatus($)).toContain('unit judged on feat')
})

test('a unit whose branch is gone locally, with no PR head or anchor of it here, reads as unknown and asks the user', async ($, on) => {
  const git: Checkout = { branch: 'main', graph: { commits: { m1: base }, refs: { main: 'm1', 'origin/main': 'm1' } } }
  createWorld(on, git, { verifyFile, unit: { start: 'm1', branch: 'feat', prHead: 'f1', anchor: 'f1' } })
  expect(await readFlowStatus($)).toContain('state unknown')
  const context = await readPromptContext($)
  expect(context).toContain('state unknown')
  expect(context).not.toContain('git switch -c')
})

test('a PR closed without merge, whose head is HEAD, keeps the PR step current and the unit unfinished', async ($, on) => {
  const git: Checkout = { branch: 'feat', graph: { commits: { m1: base, f1: done }, refs: { main: 'm1', 'origin/main': 'm1', feat: 'f1' } } }
  createWorld(on, git, arrangeFinishedUnit(git, 'CLOSED'))
  const text = await readFlowStatus($)
  expect(text).not.toContain('Unit finished.')
  expect(text).toContain('closed')
  expect(await readCurrentStep($)).toBe('PR')
})

test('a unit mid-Code, on a branch that diverged with its own commits, is judged on its own branch and sends the agent back to it', async ($, on) => {
  const other: Commit = { parents: ['m1'], files: { 'src/a.ts': 'a0', 'src/b.ts': 'b1' } }
  const git: Checkout = { branch: 'feat', graph: { commits: { m1: base, o1: other }, refs: { main: 'm1', 'origin/main': 'm1', feat: 'm1', other: 'o1' } } }
  createWorld(on, git, { verifyFile, unit: { start: 'm1', branch: 'feat' } })
  const rows = await readStepRows($)
  git.branch = 'other'
  expect(await readStepRows($)).toEqual(rows)
  expect(await readFlowStatus($)).toContain('unit judged on feat')
  const context = await readPromptContext($)
  expect(context).toContain('current step: Code')
  expect(context).toContain('git switch feat')
})

for (const move of ['a switch to a branch that changed a red file', 'a git stash of the transferred red file']) {
  test(`a Fix whose Diagnose was approved and transferred keeps Diagnose done after ${move}`, async ($, on) => {
    const fixed: Commit = { parents: ['m1'], files: { 'src/a.ts': 'a0', 'test/fix.bats': 'r1' } }
    const other: Commit = { parents: ['m1'], files: { 'src/a.ts': 'a0', 'test/fix.bats': 'x1' } }
    const git: Checkout = { branch: 'fix', dirty: { 'src/a.ts': 'a1' }, graph: { commits: { m1: base, x1: fixed, o1: other }, refs: { main: 'm1', 'origin/main': 'm1', fix: 'x1', other: 'o1' } } }
    const url = 'https://github.com/o/r/issues/1#issuecomment-1'
    createWorld(on, git, {
      verifyFile,
      session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
      unit: { start: 'm1', branch: 'fix', skills: ['diagnosing-bugs'], red: { command: 'bats test/fix.bats', fingerprints: { 'test/fix.bats': 'r1' } }, green: 'bats test/fix.bats', diagnosis: url, approval: url },
    })
    expect(await readStepRows($)).toContain('✓ Diagnose')
    if (move.includes('stash')) Object.assign(git, { dirty: { 'test/fix.bats': '' } })
    else Object.assign(git, { branch: 'other', dirty: {} })
    expect(await readStepRows($)).toContain('✓ Diagnose')
  })
}

test('a Close out off its branch counts its commits from where its branch left main', async ($, on) => {
  const graph: Graph = {
    commits: { m1: base, f1: done, f2: { parents: ['f1'], files: { 'src/a.ts': 'a2' } }, m2: { parents: ['m1'], files: { 'src/a.ts': 'a0', 'src/m.ts': 'm2' } } },
    refs: { main: 'm2', 'origin/main': 'm2', feat: 'f2' },
  }
  createWorld(on, { branch: 'main', graph }, { session: { flow: 'close-out' }, unit: { branch: 'feat' } })
  expect(await readStepRows($)).toContain('✓ Commit')
})

test('a first write on a detached HEAD records no branch, so the unit can still be worked on its branch', async ($, on) => {
  const git: Checkout = { branch: 'HEAD', head: 'm1', graph: { commits: { m1: base }, refs: { main: 'm1', 'origin/main': 'm1', feat: 'm1' } } }
  createWorld(on, git, { unit: { start: 'm1' } })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(buildWriteCall(`${root}/src/a.ts`))).deny).toBeUndefined()
  Object.assign(git, { branch: 'feat', head: undefined })
  expect((await $.tool.call(buildWriteCall(`${root}/src/a.ts`))).deny).toBeUndefined()
})

test('a flow declared on a feature branch ties the unit to it before any write', async ($, on) => {
  const git: Checkout = { branch: 'feat', graph: { commits: { m1: base }, refs: { main: 'm1', 'origin/main': 'm1', feat: 'm1', other: 'm1' } } }
  createWorld(on, git, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  await setPermissionMode($, 'auto')
  await declareFlow($, 'small-feature', [1])
  git.branch = 'other'
  expect((await $.tool.call(buildWriteCall(`${root}/src/a.ts`))).deny).toContain('work is on feat')
})
