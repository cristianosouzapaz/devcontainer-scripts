import { expect, test } from 'claude-code/testing'

import { buildBashCall, noFlow, verifyFile } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, startSkill } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a Close out runs from Verify through Commit to a PR that finishes the unit', async ($, on) => {
  const git: Checkout = { branch: 'feat', isDirty: true }
  const options: Options = { session: noFlow, verifyFile, toolRun: { result: { stdout: '' } } }
  createWorld(on, git, options)
  await declareFlow($, 'close-out', [1])
  expect(await readCurrentStep($)).toBe('Verify')

  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await readCurrentStep($)).toBe('Commit')

  await startSkill($, 'generate-commit')
  git.isDirty = false
  git.ahead = 1
  expect(await readCurrentStep($)).toBe('PR')

  await startSkill($, 'create-pr')
  options.prView = { body: 'Closes #1', headRefOid: 'c1' }
  options.toolRun = { result: { stdout: 'https://github.com/o/r/pull/5\n', gitOperation: { pr: { number: 5, action: 'created' } } } }
  await $.tool.call(buildBashCall('gh pr create --title t --body "Closes #1"'))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})
