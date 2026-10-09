import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { bashCall, promptContext, startSkill } from './helpers'
import { world } from './world'

// A Small feature session on the existing #1, grilled, whose spec lands on #1 itself; gh then reports #1 ready-for-agent.
const grilled = {
  session: { info: { 1: { title: 'feat', labels: ['needs-info'] } } }, unit: { skills: ['grilling'] },
  issueLabels: { 1: ['ready-for-agent'] }, toolRun: { result: { stdout: 'https://github.com/o/r/issues/1\n' } },
}

// The name of the step the prompt context calls current.
const currentStep = async ($: Engine) => (await promptContext($)).match(/current step: (\w+)/)?.[1]

test('Spec stays current while /to-spec runs and ends when the issue is written', async ($, on) => {
  world(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  expect(await currentStep($)).toBe('Spec')
  await $.tool.call(bashCall('gh issue edit 1 --body-file spec.md --add-label ready-for-agent'))
  expect(await currentStep($)).toBe('Code')
})

test('Grill names /to-spec as the user\'s next step', async ($, on) => {
  world(on, { branch: 'feat' }, grilled)
  const ctx = await promptContext($)
  expect(ctx).toContain('current step: Grill')
  expect(ctx).toContain('tell them to run /to-spec')
})

test('an issue /to-spec creates attaches to a Small feature declared without one', async ($, on) => {
  world(on, { branch: 'feat' }, {
    session: { issues: [], hadIssue: false, info: {} }, toolRun: { result: { stdout: 'https://github.com/o/r/issues/7\n' } },
  })
  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  await $.tool.call(bashCall('gh issue create --title t --body-file spec.md'))
  const ctx = await promptContext($)
  expect(ctx).toContain('Small feature #7 — current step: Code')
})
