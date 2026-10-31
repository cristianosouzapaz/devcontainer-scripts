import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { noFlow } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, startSkill } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Options } from '../support/world'

test('a Large feature starts at Map', async ($, on) => {
  const options: Options = {
    session: noFlow,
  }
  createWorld(on, { branch: 'feat' }, options)
  await declareFlow($, 'large-feature')
  expect(await readCurrentStep($)).toBe('Map')

  await startSkill($, 'wayfinder')
})

test('a Large feature without an issue starts at Map, the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  await declareFlow($, 'large-feature')
  expect(await readCurrentStep($)).toBe('Map')
  expect(await readFlowStatus($)).toContain('▸ Map\n')
})

test('a Large feature unit runs from Map to ready tickets', async ($, on) => {
  const options: Options = { session: noFlow }
  const { clock } = createWorld(on, { branch: 'feat' }, options)
  await declareFlow($, 'large-feature', [1])
  expect(await readCurrentStep($)).toBe('Map')
  await startSkill($, 'wayfinder')
  options.issueLabels = { 1: ['wayfinder:map'] }
  options.subIssues = { 1: [{ state: 'closed', labels: ['wayfinder:research'] }] }
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Tickets')
  await startSkill($, 'to-tickets')
  options.subIssues = { 1: [{ state: 'closed', labels: ['wayfinder:research'] }, { state: 'open', labels: ['ready-for-agent'] }] }
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBeUndefined()
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Map')
  expect(status).toContain('✓ Tickets')
  expect(status).toContain('2/2')
})
