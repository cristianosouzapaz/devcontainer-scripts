import { expect, test } from 'claude-code/testing'

import { buildBashCall, buildWriteCall, noFlow, verifyFile } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, startSkill } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a Small feature runs from Grill through Spec, Code, Verify and Commit to a PR that finishes the unit', async ($, on) => {
  const git: Checkout = { branch: 'feat' }
  const options: Options = { session: noFlow, verifyFile, issueLabels: { 1: ['needs-triage'] } }
  createWorld(on, git, options)
  await declareFlow($, 'small-feature', [1])
  expect(await readCurrentStep($)).toBe('Grill')
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeDefined()

  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  expect(await readCurrentStep($)).toBe('Spec')
  options.issueLabels = { 1: ['ready-for-agent'] }
  options.toolRun = { result: { stdout: 'https://github.com/o/r/issues/1\n' } }
  await $.tool.call(buildBashCall('gh issue edit 1 --body-file spec.md --add-label ready-for-agent'))
  expect(await readCurrentStep($)).toBe('Code')

  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
  git.isDirty = true
  options.toolRun = { result: { stdout: '' } }
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
