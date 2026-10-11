import { expect, test } from 'claude-code/testing'

import { buildWriteCall } from '../../support/builders'
import { readCurrentStep, readFlowStatus, startSkill } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Options } from '../../support/world'

// A Small feature on #1 whose Spec is done on the stored labels.
const buildSpecDoneOptions = (): Options => ({
  session: { info: { 1: { title: 'feat', labels: ['ready-for-agent'] } } },
  unit: { skills: ['grilling', 'to-spec'] }, issueLabels: { 1: ['ready-for-agent'] },
})

test('a Small feature that never runs to-tickets shows Tickets skipped and reaches Code', async ($, on) => {
  createWorld(on, { branch: 'feat' }, buildSpecDoneOptions())
  expect(await readFlowStatus($)).toContain('↷ Tickets')
  expect(await readCurrentStep($)).toBe('Code')
})

test('Tickets is current once to-tickets starts', async ($, on) => {
  createWorld(on, { branch: 'feat' }, buildSpecDoneOptions())
  await startSkill($, 'to-tickets')
  expect(await readCurrentStep($)).toBe('Tickets')
})

test('Tickets is done once the issue has sub-issues, and falls back when they are gone', async ($, on) => {
  const options = buildSpecDoneOptions()
  const { clock } = createWorld(on, { branch: 'feat' }, options)
  await startSkill($, 'to-tickets')
  options.subIssues = { 1: 2 }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Tickets')
  expect(await readCurrentStep($)).toBe('Code')
  options.subIssues = { 1: 0 }
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Tickets')
})

test('Tickets stays done when GitHub cannot count the sub-issues on a later read', async ($, on) => {
  const options = buildSpecDoneOptions()
  const { clock } = createWorld(on, { branch: 'feat' }, options)
  await startSkill($, 'to-tickets')
  options.subIssues = { 1: 2 }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Tickets')
  options.failing = 'gh api repos/'
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Tickets')
  expect(await readCurrentStep($)).toBe('Code')
})

test('a started Tickets with no sub-issues is skipped, not current, once Code has a change', async ($, on) => {
  createWorld(on, { branch: 'feat', changed: ['src/a.ts'] }, { ...buildSpecDoneOptions(), unit: { skills: ['grilling', 'to-spec', 'to-tickets'], start: 'c0' } })
  expect(await readFlowStatus($)).toContain('↷ Tickets')
  expect(await readCurrentStep($)).not.toBe('Tickets')
})

test('a repository write while Tickets is current is not stopped because of Tickets', async ($, on) => {
  createWorld(on, { branch: 'feat' }, buildSpecDoneOptions())
  await startSkill($, 'to-tickets')
  expect(await readCurrentStep($)).toBe('Tickets')
  const verdict = await $.tool.call(buildWriteCall('src/a.ts'))
  expect(verdict.deny).toBeUndefined()
  expect(JSON.stringify(verdict)).not.toContain('Tickets')
})
