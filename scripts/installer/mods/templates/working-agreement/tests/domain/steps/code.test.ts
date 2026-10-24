import { expect, test } from 'claude-code/testing'
import { buildPullRequest, diagnosed, diagnosisComment, fixed, verifyFile } from '../../support/builders'
import { readCurrentStep, readFlowStatus, readPromptContext } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Checkout, Options } from '../../support/world'

function buildChanged(): Checkout {
  return { branch: 'feat', changed: ['src/a.ts'], isDirty: true, tree: 'one' }
}

test('a change completes Code before Verify has run', async ($, on) => {
  createWorld(on, buildChanged(), { verifyFile })
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Verify')
})

test('work committed without a verify run shows Code done and Verify current', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { verifyFile })
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Verify')
})

test('an edit after the PR is open keeps Code done while Verify reopens', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1, isDirty: true, tree: 'two' }, {
    verifyFile, prs: [buildPullRequest()],
  })
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Verify')
})

test('without a verify command Code is done on the first change', async ($, on) => {
  createWorld(on, buildChanged(), {})
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Verify')
})

const fixOptions = (unit: Options['unit']): Options => ({
  session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'], comments: [diagnosisComment] } } },
  unit, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
})

test('in a Fix a change without a green after the approval leaves Code current', async ($, on) => {
  createWorld(on, buildChanged(), fixOptions(diagnosed))
  expect(await readFlowStatus($)).toContain('▸ Code · no green after the approval')
  expect(await readCurrentStep($)).toBe('Code')
})

test('in a Fix the green after the approval, with a change, completes Code', async ($, on) => {
  createWorld(on, buildChanged(), fixOptions(fixed))
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Verify')
})

test('in a Fix the green after the approval without a change leaves Code current', async ($, on) => {
  createWorld(on, { branch: 'feat' }, fixOptions(fixed))
  expect(await readCurrentStep($)).toBe('Code')
})

test('in a Fix with Diagnose skipped, Code is done by the change alone', async ($, on) => {
  createWorld(on, buildChanged(), fixOptions({ skips: [{ step: 'diagnose', reason: 'no command reproduces it' }] }))
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Verify')
})

test('in a Fix the Code instruction resumes the diagnosis skill at its regression test, fix, green and cleanup', async ($, on) => {
  createWorld(on, { branch: 'feat' }, fixOptions(diagnosed))
  const instruction = await readPromptContext($)
  expect(instruction).toContain('resume the diagnosing-bugs skill at Phase 5')
  expect(instruction).toContain('write the regression test if the red is not already one')
  expect(instruction).toContain('apply the approved fix')
  expect(instruction).toContain("rerun the red command's argv through the run tool until it passes")
  expect(instruction).toContain('do the Phase 6 cleanup')
  expect(instruction).toContain('call the verify tool')
})

test('with Diagnose skipped the Code instruction stays a plain change', async ($, on) => {
  createWorld(on, { branch: 'feat' }, fixOptions({ skips: [{ step: 'diagnose', reason: 'no command reproduces it' }] }))
  const instruction = await readPromptContext($)
  expect(instruction).toContain('make the change, then call the verify tool')
  expect(instruction).not.toContain('approved fix')
})
