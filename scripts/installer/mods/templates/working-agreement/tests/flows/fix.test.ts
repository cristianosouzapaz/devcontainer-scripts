import { expect, test } from 'claude-code/testing'

import { buildBashCall, buildWriteCall, noFlow, verifyFile } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, startSkill } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a Fix on a triaged issue finds Triage done and runs from Diagnose through Code, Verify and Commit to a PR that finishes the unit', async ($, on) => {
  const git: Checkout = { branch: 'fix', hashes: { 'test/fix.bats': 'h1' } }
  const options: Options = { session: noFlow, verifyFile, toolRun: { result: { stdout: '' } }, issueLabels: { 1: ['ready-for-agent'] } }
  createWorld(on, git, options)
  await declareFlow($, 'fix', [1])
  expect(await readCurrentStep($)).toBe('Diagnose')
  expect(await readFlowStatus($)).toContain('✓ Triage')

  await startSkill($, 'diagnosing-bugs')
  expect((await $.tool.call(buildWriteCall('test/fix.bats'))).deny).toBeUndefined()
  expect((await $.tool.call(buildWriteCall('src/fix.sh'))).deny).toBeDefined()
  options.toolRun = { isError: true, result: { stdout: '', stderr: '', interrupted: false } }
  await $.tool.call(buildBashCall('bats test/fix.bats'))
  options.toolRun = { result: { stdout: '' } }
  expect(await readCurrentStep($)).toBe('Code')

  expect((await $.tool.call(buildWriteCall('src/fix.sh'))).deny).toBeUndefined()
  git.isDirty = true
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
