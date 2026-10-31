import { expect } from 'claude-code/testing'

import { test } from '../../support/kit'
import { noFlow } from '../../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus } from '../../support/helpers'
import { createWorld } from '../../support/world'

test('a Fix declared on an issue with a triage label starts at Diagnose with Triage done', async ($, on) => {
  createWorld(on, { branch: 'fix' }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  await declareFlow($, 'fix', [1])
  expect(await readCurrentStep($)).toBe('Diagnose')
  expect(await readFlowStatus($)).toContain('✓ Triage')
})

test('a Fix declared on an issue carrying only needs-triage starts at Triage', async ($, on) => {
  createWorld(on, { branch: 'fix' }, { session: noFlow, issueLabels: { 1: ['needs-triage'] } })
  await declareFlow($, 'fix', [1])
  expect(await readCurrentStep($)).toBe('Triage')
})

test('a Fix declared on an issue with no label starts at Triage, not skipped', async ($, on) => {
  createWorld(on, { branch: 'fix' }, { session: noFlow })
  await declareFlow($, 'fix', [1])
  expect(await readCurrentStep($)).toBe('Triage')
  expect(await readFlowStatus($)).not.toContain('↷')
})

test('needs-info and wontfix keep Triage current with their label as its fact', async ($, on) => {
  createWorld(on, { branch: 'fix' }, { session: noFlow, issueLabels: { 1: ['needs-info'] } })
  await declareFlow($, 'fix', [1])
  expect(await readFlowStatus($)).toContain('▸ Triage · needs-info')
})

test('wontfix keeps Triage current with its label as its fact', async ($, on) => {
  createWorld(on, { branch: 'fix' }, { session: noFlow, issueLabels: { 1: ['wontfix'] } })
  await declareFlow($, 'fix', [1])
  expect(await readFlowStatus($)).toContain('▸ Triage · wontfix')
})

test('Map without its wayfinder:map label shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, subIssues: { 1: [{ state: 'closed', labels: ['wayfinder:map'] }] } })
  await declareFlow($, 'large-feature', [1])
  expect(await readFlowStatus($)).toContain('▸ Map\n')
})

test('Map without a wayfinder sub-issue shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['wayfinder:map'] } })
  await declareFlow($, 'large-feature', [1])
  expect(await readFlowStatus($)).toContain('▸ Map\n')
})

test('Map with open wayfinder sub-issues shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['wayfinder:map'] }, subIssues: { 1: [{ state: 'open', labels: ['wayfinder:map'] }] } })
  await declareFlow($, 'large-feature', [1])
  expect(await readFlowStatus($)).toContain('▸ Map\n')
})

test('a sub-issue read failure leaves Map current with its error', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['wayfinder:map'] }, failing: 'gh api repos/' })
  await declareFlow($, 'large-feature', [1])
  expect(await readFlowStatus($)).toContain('▸ Map · gh could not run:')
  expect(await readFlowStatus($)).toContain('wayfinder:map')
})

test('a Large feature with a closed wayfinder sub-issue shows Map done', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['wayfinder:map'] }, subIssues: { 1: [{ state: 'closed', labels: ['wayfinder:map'] }] } })
  await declareFlow($, 'large-feature', [1])
  expect(await readFlowStatus($)).toContain('✓ Map')
})
