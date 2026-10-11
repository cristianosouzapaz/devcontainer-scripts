import { expect, test } from 'claude-code/testing'

import { buildBashCall, buildWriteCall, noFlow, verifyFile } from '../support/builders'
import { readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a Trivial change runs from Code through Verify and Commit to a PR opened without its skills, which finishes the unit', async ($, on) => {
  const git: Checkout = { branch: 'feat' }
  const options: Options = { session: noFlow, verifyFile, toolRun: { result: { stdout: '' } } }
  createWorld(on, git, options)
  await runFlowCommand($, 'trivial')
  expect(await readCurrentStep($)).toBe('Code')

  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
  git.isDirty = true
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await readCurrentStep($)).toBe('Commit')

  // The user commits; until they push, the PR waits for the push and gh pr create is denied.
  git.isDirty = false
  git.ahead = 1
  git.isPushed = false
  expect(await readCurrentStep($)).toBe('PR')
  expect(await readPromptContext($)).toContain('stop and ask the user to push the branch, then open the PR with gh pr create')
  expect((await $.tool.call(buildBashCall('gh pr create --title t --body "b"'))).deny).toContain('the branch is not pushed')

  git.isPushed = true
  options.prView = { body: '', headRefOid: 'c1' }
  options.toolRun = { result: { stdout: 'https://github.com/o/r/pull/5\n', gitOperation: { pr: { number: 5, action: 'created' } } } }
  await $.tool.call(buildBashCall('gh pr create --title t --body "b"'))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a Trivial gh pr create whose read-back head is not HEAD leaves PR current', async ($, on) => {
  const created = { result: { stdout: 'https://github.com/o/r/pull/5\n', gitOperation: { pr: { number: 5, action: 'created' } } } }
  createWorld(on, { branch: 'feat', ahead: 1, isPushed: true }, { session: { flow: 'trivial', issues: [], info: {} }, prView: { body: '', headRefOid: 'c0' }, toolRun: created })
  await $.tool.call(buildBashCall('gh pr create --title t --body "b"'))
  expect(await readFlowStatus($)).not.toContain('Unit finished.')
  expect(await readCurrentStep($)).toBe('PR')
})
