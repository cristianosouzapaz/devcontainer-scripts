import { expect, test } from 'claude-code/testing'

import { buildBashCall, buildWriteCall, noFlow, verifyFile } from '../support/builders'
import { readCurrentStep, readFlowStatus, runFlowCommand, startSkill } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Options } from '../support/world'

const buildPr = (state: string) => ({ number: 5, state, headRefName: 'feat-1', headRefOid: 'c0', body: 'Closes #1' })

test('a Follow-up on an open PR runs from Code through Verify and Commit to an update of that PR that finishes the unit', async ($, on) => {
  const git: Checkout = { branch: 'feat-1' }
  const options: Options = { session: noFlow, verifyFile, prs: [buildPr('OPEN')], toolRun: { result: { stdout: '' } } }
  createWorld(on, git, options)
  await runFlowCommand($, 'follow-up #1')
  expect(await readCurrentStep($)).toBe('Code')

  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
  git.isDirty = true
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await readCurrentStep($)).toBe('Commit')

  await startSkill($, 'generate-commit')
  git.isDirty = false
  git.ahead = 1
  expect(await readFlowStatus($)).toContain('Update PR #5')

  await startSkill($, 'create-pr')
  options.prView = { body: 'Refs #1', headRefOid: 'c1' }
  await $.tool.call(buildBashCall('gh pr edit 5 --body "Refs #1"'))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a Follow-up on a merged PR runs from Code through Verify and Commit to a new PR with a Refs line that finishes the unit', async ($, on) => {
  const git: Checkout = { branch: 'feat-2' }
  const options: Options = { session: noFlow, verifyFile, prs: [buildPr('MERGED')], toolRun: { result: { stdout: '' } } }
  createWorld(on, git, options)
  await runFlowCommand($, 'follow-up #1')
  expect(await readCurrentStep($)).toBe('Code')

  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
  git.isDirty = true
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await readCurrentStep($)).toBe('Commit')

  await startSkill($, 'generate-commit')
  git.isDirty = false
  git.ahead = 1
  expect(await readCurrentStep($)).toBe('PR')

  await startSkill($, 'create-pr')
  options.prView = { body: 'Refs #1', headRefOid: 'c1' }
  options.toolRun = { result: { stdout: 'https://github.com/o/r/pull/6\n', gitOperation: { pr: { number: 6, action: 'created' } } } }
  await $.tool.call(buildBashCall('gh pr create --title t --body "Refs #1"'))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})
