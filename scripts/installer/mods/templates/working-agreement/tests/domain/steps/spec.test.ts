import { expect } from 'claude-code/testing'

import { test } from '../../support/kit'
import { noFlow } from '../../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, readPromptContext, startSkill } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Options } from '../../support/world'

// A Small feature session on the existing #1, grilled, whose spec lands on #1 itself; gh then reports #1 ready-for-agent.
const grilled = {
  session: { info: { 1: { title: 'feat', labels: ['needs-info'] } } }, unit: { skills: ['grilling'] },
  issueLabels: { 1: ['ready-for-agent'] },
}

// A Small feature on #1 whose Spec is done on the stored labels.
const specDone: Options = { unit: { skills: ['grilling', 'to-spec'] }, issueLabels: { 1: ['ready-for-agent'] } }

test('Grill stays current while /to-spec runs without the GitHub label', async ($, on) => {
  createWorld(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  expect(await readCurrentStep($)).toBe('Grill')
})

test('Grill names /to-spec as the user\'s next step', async ($, on) => {
  createWorld(on, { branch: 'feat' }, grilled)
  const context = await readPromptContext($)
  expect(context).toContain('current step: Grill')
  expect(context).toContain('tell them to run /to-spec')
})

test('an issue without ready-for-agent keeps Grill current', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...grilled, issueLabels: { 1: ['needs-info'] } })
  await startSkill($, 'to-spec')
  expect(await readCurrentStep($)).toBe('Grill')
})

test('a ready-for-agent set on GitHub with no command ends Spec on the periodic refresh', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat' }, grilled)
  await startSkill($, 'to-spec')
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Code')
  expect(await readFlowStatus($)).toContain('✓ Spec')
})

test('a ready-for-agent set before /to-spec starts completes Grill and Spec', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat' }, { ...grilled, unit: { skills: [] } })
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Code')
})

test('Grill stays current from the labels alone once /grilling and /to-spec have run', async ($, on) => {
  createWorld(on, { branch: 'feat' }, {
    ...grilled, session: { info: {} }, unit: { skills: ['grilling', 'to-spec'] }, isLoggedOut: true,
  })
  expect(await readCurrentStep($)).toBe('Grill')
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
  expect(await readCurrentStep($)).toBe('Grill')
})

test('one unready issue keeps Spec and Grill open when two issues are declared', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: [] } })
  await declareFlow($, 'small-feature', [1, 2])
  expect(await readCurrentStep($)).toBe('Grill')
  expect(await readFlowStatus($)).toContain('▸ Grill')
})

test('a ready-for-agent declaration completes Grill with Spec', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  expect(await readCurrentStep($)).toBe('Code')
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Grill')
  expect(status).toContain('✓ Spec')
})

test('a Small feature declared on an issue without the label starts at Grill', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['needs-info'] } })
  await declareFlow($, 'small-feature', [1])
  expect(await readCurrentStep($)).toBe('Grill')
})


test('a failed read-back leaves Grill current while gh is logged out', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat' }, {
    ...specDone, session: { info: { 1: { title: 'feat', labels: ['needs-info'] } } }, isLoggedOut: true,
  })
  await startSkill($, 'to-spec')
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Grill')
})
