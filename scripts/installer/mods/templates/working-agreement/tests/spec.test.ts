import { expect, test } from 'claude-code/testing'

import { bashCall, currentStep, endTurn, flowStatus, promptContext, startSkill } from './helpers'
import { world } from './world'

// A Small feature session on the existing #1, grilled, whose spec lands on #1 itself; gh then reports #1 ready-for-agent.
const grilled = {
  session: { info: { 1: { title: 'feat', labels: ['needs-info'] } } }, unit: { skills: ['grilling'] },
  issueLabels: { 1: ['ready-for-agent'] }, toolRun: { result: { stdout: 'https://github.com/o/r/issues/1\n' } },
}

test('Spec stays current while /to-spec runs and ends when the issue is written', async ($, on) => {
  world(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  expect(await currentStep($)).toBe('Spec')
  await $.tool.call(bashCall('gh issue edit 1 --body-file spec.md --add-label ready-for-agent'))
  expect(await currentStep($)).toBe('Code')
})

test('a spec lands on the declared issue after a nested skill starts inside /to-spec', async ($, on) => {
  world(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  await startSkill($, 'domain-modeling')
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
    issueLabels: { 7: ['ready-for-agent'] },
  })
  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  await $.tool.call(bashCall('gh issue create --title t --body-file spec.md'))
  const ctx = await promptContext($)
  expect(ctx).toContain('Small feature #7 — current step: Code')
})

// A Small feature declared without an issue, grilled; /to-spec creates #7, which gh reports ready-for-agent.
const creating = {
  session: { issues: [], hadIssue: false, info: {} }, unit: { skills: ['grilling'] },
  issueLabels: { 7: ['ready-for-agent'] }, toolRun: { result: { stdout: 'https://github.com/o/r/issues/7\n' } },
}
const create = 'gh issue create --title t --body-file spec.md'

test('a spec written in a later turn than the one /to-spec started in ends Spec', async ($, on) => {
  world(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  await endTurn($)
  await $.tool.call(bashCall('gh issue edit 1 --body-file spec.md --add-label ready-for-agent'))
  expect(await currentStep($)).toBe('Code')
})

test('gh issue create in a later turn than the one /to-spec started in is not asked, attaches the issue and ends Spec', async ($, on) => {
  world(on, { branch: 'feat' }, creating)
  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  await endTurn($)
  expect((await $.tool.check({ tool: 'Bash', input: { command: create } })).decision).not.toBe('ask')
  expect((await $.tool.call(bashCall(create))).deny).toBeUndefined()
  expect(await promptContext($)).toContain('Small feature #7 — current step: Code')
})

test('gh issue create asks while the current step\'s skill has not started for the unit', async ($, on) => {
  world(on, { branch: 'feat' }, creating)
  await endTurn($)
  expect((await $.tool.check({ tool: 'Bash', input: { command: create } })).decision).toBe('ask')
})

test('a gh issue comment that leaves the issue without ready-for-agent keeps Spec current', async ($, on) => {
  world(on, { branch: 'feat' }, { ...grilled, issueLabels: { 1: ['needs-info'] } })
  await startSkill($, 'to-spec')
  await $.tool.call(bashCall('gh issue comment 1 --body "a question"'))
  expect(await currentStep($)).toBe('Spec')
})

test('a ready-for-agent set on GitHub with no command ends Spec on the periodic refresh', async ($, on) => {
  const { clock } = world(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  await clock.advance(61000)
  expect(await currentStep($)).toBe('Code')
  expect(await flowStatus($)).toContain('✓ Spec')
})

// Pins the skipTo path: the ready-for-agent label skips Grill and Spec, not Spec being done.
test('a ready-for-agent set on GitHub before /to-spec started moves the unit to Code', async ($, on) => {
  const { clock } = world(on, { branch: 'feat' }, { ...grilled, unit: { skills: [] } })
  await clock.advance(61000)
  expect(await currentStep($)).toBe('Code')
})

test('a unit stored with produced by an older version still reads Spec done', async ($, on) => {
  world(on, { branch: 'feat' }, {
    ...grilled, session: { info: {} }, unit: { skills: ['grilling', 'to-spec'], produced: ['to-spec'] },
  })
  expect(await currentStep($)).toBe('Code')
})

test('a ready-for-agent removed on GitHub reopens Spec on the periodic refresh', async ($, on) => {
  const options = { unit: { skills: ['grilling', 'to-spec'] }, issueLabels: { 1: ['ready-for-agent'] } }
  const { clock } = world(on, { branch: 'feat' }, options)
  await clock.advance(61000)
  expect(await currentStep($)).toBe('Code')
  options.issueLabels = { 1: [] }
  await clock.advance(61000)
  expect(await currentStep($)).toBe('Spec')
})
