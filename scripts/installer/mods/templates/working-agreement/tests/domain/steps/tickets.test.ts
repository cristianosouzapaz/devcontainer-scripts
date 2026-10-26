import { expect } from 'claude-code/testing'

import { test } from '../../support/kit'
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
  expect(await readFlowStatus($)).toContain('↷ Tickets · optional')
  expect(await readCurrentStep($)).toBe('Code')
})

test('optional Tickets stays skipped when to-tickets starts', async ($, on) => {
  createWorld(on, { branch: 'feat' }, buildSpecDoneOptions())
  await startSkill($, 'to-tickets')
  expect(await readCurrentStep($)).toBe('Code')
})

test('Tickets is done only with a ready-for-agent sub-issue, and falls back when it is gone', async ($, on) => {
  const options = buildSpecDoneOptions()
  const { clock } = createWorld(on, { branch: 'feat' }, options)
  await startSkill($, 'to-tickets')
  options.subIssues = { 1: [{ state: 'open', labels: ['wayfinder:map'] }, { state: 'closed', labels: ['ready-for-agent'] }] }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Tickets')
  expect(await readCurrentStep($)).toBe('Code')
  options.subIssues = { 1: [{ state: 'closed', labels: ['wayfinder:map'] }] }
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Code')
})

test('an errored optional Tickets read is skipped with the error as its reason', async ($, on) => {
  const options = buildSpecDoneOptions()
  const { clock } = createWorld(on, { branch: 'feat' }, options)
  await startSkill($, 'to-tickets')
  options.subIssues = { 1: [{ state: 'open', labels: ['ready-for-agent'] }] }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Tickets')
  options.failing = 'gh api repos/'
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Grill')
  expect(await readFlowStatus($)).toContain('✓ Spec')
  expect(await readFlowStatus($)).toContain('↷ Tickets · gh could not run:')
  expect(await readCurrentStep($)).toBe('Code')
})

test('a started Tickets with no sub-issues is skipped, not current, once Code has a change', async ($, on) => {
  createWorld(on, { branch: 'feat', changed: ['src/a.ts'] }, { ...buildSpecDoneOptions(), unit: { skills: ['grilling', 'to-spec', 'to-tickets'], } })
  expect(await readFlowStatus($)).toContain('↷ Tickets · optional')
  expect(await readCurrentStep($)).not.toBe('Code')
})

test('a repository write while optional Tickets is skipped is allowed', async ($, on) => {
  createWorld(on, { branch: 'feat' }, buildSpecDoneOptions())
  await startSkill($, 'to-tickets')
  expect(await readCurrentStep($)).toBe('Code')
  const verdict = await $.tool.call(buildWriteCall('src/a.ts'))
  expect(verdict.deny).toBeUndefined()
  expect(JSON.stringify(verdict)).not.toContain('Tickets')
})
