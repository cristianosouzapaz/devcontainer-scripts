import { expect, test } from 'claude-code/testing'

import { noFlow, verifyFile } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, startSkill } from '../support/helpers'
import { completeDelivery } from '../support/delivery'
import { createWorld, linearGraph } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a Small feature keeps Grill current until GitHub marks its issue ready', async ($, on) => {
  const git: Checkout = { branch: 'feat' }
  const options: Options = { session: noFlow, verifyFile, issueLabels: { 1: ['needs-triage'] } }
  createWorld(on, git, options)
  await declareFlow($, 'small-feature', [1])
  expect(await readCurrentStep($)).toBe('Grill')

  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  expect(await readCurrentStep($)).toBe('Grill')
})

test('a Small feature unit runs from Grill to a merged PR', async ($, on) => {
  const graph = linearGraph({ feat: 0 }, verifyFile, 1)
  const git: Checkout = { branch: 'feat', graph }
  const options: Options = { session: noFlow, verifyFile, issueLabels: { 1: ['needs-triage'] } }
  const { clock, views } = createWorld(on, git, options)
  expect((await declareFlow($, 'small-feature', [1])).result).toContain('current step: Grill')
  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  options.issueLabels = { 1: ['ready-for-agent'] }
  await clock.advance(61000)
  const specified = await readFlowStatus($)
  expect(specified).toContain('✓ Grill')
  expect(specified).toContain('✓ Spec')
  expect(specified).toContain('↷ Tickets · optional')
  expect(await readCurrentStep($)).toBe('Code')
  git.isDirty = true
  git.changed = ['src/a.ts']
  git.tree = 'tree'
  expect(await readCurrentStep($)).toBe('Verify')
  await completeDelivery($, { git, options, clock, views })
})
