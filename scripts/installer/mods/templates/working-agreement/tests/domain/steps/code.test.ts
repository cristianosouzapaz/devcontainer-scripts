import { expect, test } from 'claude-code/testing'

import type { ToolRun } from '../../../hooks/core/command-observation'
import { buildBashCall, verifyFile } from '../../support/builders'
import { readCurrentStep, readFlowStatus, runFlowCommand } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Checkout } from '../../support/world'

// Code and Verify are a loop: Code stays current until the change is handed to Verify, and reopens when the tree moves past that hand-off.
const unit = { start: 'c0' }
const green: ToolRun = { result: { stdout: '' } }
const red: ToolRun = { isError: true, result: { stdout: '' } }

function buildChanged(): Checkout {
  return { branch: 'feat', changed: ['src/a.ts'], isDirty: true, tree: 'one' }
}

test('a change whose tree was never verified leaves Code current', async ($, on) => {
  createWorld(on, buildChanged(), { verifyFile, unit })
  expect(await readFlowStatus($)).toContain('▸ Code')
  expect(await readCurrentStep($)).toBe('Code')
})

test('a verify run in flight on the changed tree shows Code done and Verify running', async ($, on) => {
  const seen = { status: '' }
  createWorld(on, buildChanged(), { verifyFile, unit, toolRun: async () => { seen.status = (await readFlowStatus($)) ?? ''; return green } })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(seen.status).toContain('✓ Code')
  expect(seen.status).toContain('▸ Verify — running')
})

test('a green verify run on the changed tree moves the unit to Commit', async ($, on) => {
  createWorld(on, buildChanged(), { verifyFile, unit, toolRun: green })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await readCurrentStep($)).toBe('Commit')
})

test('a failed verify run sends the unit back to Code', async ($, on) => {
  createWorld(on, buildChanged(), { verifyFile, unit, toolRun: red })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await readFlowStatus($)).toContain('▸ Code')
  expect(await readCurrentStep($)).toBe('Code')
})

test('an edit after a green verify run reopens Code and leaves Verify stale', async ($, on) => {
  const git = buildChanged()
  createWorld(on, git, { verifyFile, unit, toolRun: green })
  await $.tool.call(buildBashCall('./test/run.sh'))
  git.tree = 'two'
  const status = (await readFlowStatus($)) ?? ''
  expect(status).toContain('▸ Code')
  expect(status).toMatch(/Verify {2}stale/)
  expect(await readCurrentStep($)).toBe('Code')
})

test('an overridden Verify counts as the hand-off and moves the unit to Commit', async ($, on) => {
  createWorld(on, buildChanged(), { verifyFile, unit })
  await runFlowCommand($, 'override verify no test covers it')
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Commit')
})

test('work committed without a verify run shows Code done and Verify current', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { verifyFile, unit })
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Verify')
})

test('an edit after the PR is open reopens Code, though the PR head still matches HEAD', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1, isDirty: true, tree: 'two' }, {
    verifyFile, unit: { ...unit, verify: 'one', pr: { number: 5, state: 'OPEN' }, prHead: 'c1' },
  })
  expect(await readFlowStatus($)).toContain('▸ Code')
  expect(await readCurrentStep($)).toBe('Code')
})

test('without a verify command Code is done on the first change', async ($, on) => {
  createWorld(on, buildChanged(), { unit })
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Commit')
})
