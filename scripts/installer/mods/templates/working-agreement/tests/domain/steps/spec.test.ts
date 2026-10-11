import { expect, test } from 'claude-code/testing'

import { buildBashCall, noFlow } from '../../support/builders'
import { declareFlow, endTurn, readCurrentStep, readFlowStatus, readPromptContext, startSkill } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Options } from '../../support/world'

// A Small feature session on the existing #1, grilled, whose spec lands on #1 itself; gh then reports #1 ready-for-agent.
const grilled = {
  session: { info: { 1: { title: 'feat', labels: ['needs-info'] } } }, unit: { skills: ['grilling'] },
  issueLabels: { 1: ['ready-for-agent'] }, toolRun: { result: { stdout: 'https://github.com/o/r/issues/1\n' } },
}

// A Small feature declared without an issue, grilled; /to-spec creates #7, which gh reports ready-for-agent.
const creating = {
  session: { issues: [], info: {} }, unit: { skills: ['grilling'] },
  issueLabels: { 7: ['ready-for-agent'] }, toolRun: { result: { stdout: 'https://github.com/o/r/issues/7\n' } },
}
const createIssue = 'gh issue create --title t --body-file spec.md'

// A Small feature on #1 whose Spec is done on the stored labels.
const specDone: Options = { unit: { skills: ['grilling', 'to-spec'] }, issueLabels: { 1: ['ready-for-agent'] } }

test('Spec stays current while /to-spec runs and ends when the issue is written', async ($, on) => {
  createWorld(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  expect(await readCurrentStep($)).toBe('Spec')
  await $.tool.call(buildBashCall('gh issue edit 1 --body-file spec.md --add-label ready-for-agent'))
  expect(await readCurrentStep($)).toBe('Code')
})

test('a spec lands on the declared issue after a nested skill starts inside /to-spec', async ($, on) => {
  createWorld(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  await startSkill($, 'domain-modeling')
  await $.tool.call(buildBashCall('gh issue edit 1 --body-file spec.md --add-label ready-for-agent'))
  expect(await readCurrentStep($)).toBe('Code')
})

test('Grill names /to-spec as the user\'s next step', async ($, on) => {
  createWorld(on, { branch: 'feat' }, grilled)
  const context = await readPromptContext($)
  expect(context).toContain('current step: Grill')
  expect(context).toContain('tell them to run /to-spec')
})

test('an issue /to-spec creates attaches to a Small feature declared without one', async ($, on) => {
  createWorld(on, { branch: 'feat' }, {
    session: { issues: [], info: {} }, toolRun: { result: { stdout: 'https://github.com/o/r/issues/7\n' } },
    issueLabels: { 7: ['ready-for-agent'] },
  })
  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  await $.tool.call(buildBashCall('gh issue create --title t --body-file spec.md'))
  expect(await readPromptContext($)).toContain('Small feature #7 — current step: Code')
})

test('a spec written in a later turn than the one /to-spec started in ends Spec', async ($, on) => {
  createWorld(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  await endTurn($)
  await $.tool.call(buildBashCall('gh issue edit 1 --body-file spec.md --add-label ready-for-agent'))
  expect(await readCurrentStep($)).toBe('Code')
})

test('gh issue create in a later turn than the one /to-spec started in is not asked, attaches the issue and ends Spec', async ($, on) => {
  createWorld(on, { branch: 'feat' }, creating)
  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  await endTurn($)
  expect((await $.tool.check({ tool: 'Bash', input: { command: createIssue } })).decision).not.toBe('ask')
  expect((await $.tool.call(buildBashCall(createIssue))).deny).toBeUndefined()
  expect(await readPromptContext($)).toContain('Small feature #7 — current step: Code')
})

test('gh issue create asks while the current step\'s skill has not started for the unit', async ($, on) => {
  createWorld(on, { branch: 'feat' }, creating)
  await endTurn($)
  expect((await $.tool.check({ tool: 'Bash', input: { command: createIssue } })).decision).toBe('ask')
})

test('a gh issue comment that leaves the issue without ready-for-agent keeps Spec current', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...grilled, issueLabels: { 1: ['needs-info'] } })
  await startSkill($, 'to-spec')
  await $.tool.call(buildBashCall('gh issue comment 1 --body "a question"'))
  expect(await readCurrentStep($)).toBe('Spec')
})

test('a ready-for-agent set on GitHub with no command ends Spec on the periodic refresh', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Code')
  expect(await readFlowStatus($)).toContain('✓ Spec')
})

// The ready-for-agent label on the issue ends Spec and skips Grill, which has no evidence of its own.
test('a ready-for-agent set on GitHub before /to-spec started moves the unit to Code', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat' }, { ...grilled, unit: { skills: [] } })
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Code')
})

test('Spec stays current from the labels alone once /grilling and /to-spec have run', async ($, on) => {
  createWorld(on, { branch: 'feat' }, {
    ...grilled, session: { info: {} }, unit: { skills: ['grilling', 'to-spec'] }, isLoggedOut: true,
  })
  expect(await readCurrentStep($)).toBe('Spec')
})

test('a ready-for-agent already on the declared issue marks Spec done before /to-spec starts', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...grilled, session: { info: { 1: { title: 'feat', labels: ['ready-for-agent'] } } }, unit: { skills: [] } })
  expect(await readFlowStatus($)).toContain('✓ Spec')
})

test('a ready-for-agent removed on GitHub reopens Spec on the periodic refresh', async ($, on) => {
  const options = { unit: { skills: ['grilling', 'to-spec'] }, issueLabels: { 1: ['ready-for-agent'] } }
  const { clock } = createWorld(on, { branch: 'feat' }, options)
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Code')
  options.issueLabels = { 1: [] }
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Spec')
})

test('a Small feature declared on a ready-for-agent issue starts at Code with Grill skipped and Spec done', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  expect(await readCurrentStep($)).toBe('Code')
  const status = await readFlowStatus($)
  expect(status).toContain('↷ Grill')
  expect(status).toContain('✓ Spec')
})

test('a Small feature declared on an issue without the label starts at Grill', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['needs-info'] } })
  await declareFlow($, 'small-feature', [1])
  expect(await readCurrentStep($)).toBe('Grill')
})

test('Spec, which rests on GitHub alone, never shows stale', async ($, on) => {
  createWorld(on, { branch: 'feat', isDirty: true }, grilled)
  await startSkill($, 'to-spec')
  await $.tool.call(buildBashCall('gh issue edit 1 --body-file spec.md --add-label ready-for-agent'))
  expect(await readFlowStatus($)).not.toContain('stale')
})

test('a failed read-back keeps the stored labels: Spec stays done while gh is logged out', async ($, on) => {
  const options: Options = { ...specDone }
  const { clock } = createWorld(on, { branch: 'feat' }, options)
  options.isLoggedOut = true
  options.issueLabels = { 1: [] }
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Code')
})

test('a failed read-back ticks nothing: Spec stays current while gh is logged out', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat' }, {
    ...specDone, session: { info: { 1: { title: 'feat', labels: ['needs-info'] } } }, isLoggedOut: true,
  })
  await startSkill($, 'to-spec')
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Spec')
})

test('a gh issue edit whose read-back fails does not end Spec', async ($, on) => {
  createWorld(on, { branch: 'feat' }, {
    ...specDone, session: { info: { 1: { title: 'feat', labels: ['needs-info'] } } }, isLoggedOut: true,
  })
  await startSkill($, 'to-spec')
  await $.tool.call(buildBashCall('gh issue edit 1 --body-file spec.md --add-label ready-for-agent'))
  expect(await readCurrentStep($)).toBe('Spec')
})
