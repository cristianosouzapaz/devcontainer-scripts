import { expect, test } from 'claude-code/testing'

import { buildBashCall, noFlow } from '../../support/builders'
import { declareFlow, endTurn, readCurrentStep, readFlowStatus, startSkill } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Options } from '../../support/world'

const createIssue = buildBashCall('gh issue create --title t --body b')

// A Fix without an issue: /triage creates #7, which gh reports with these labels.
function buildTriagingOptions(labels: string[]): Options {
  return {
    session: { flow: 'fix', issues: [], info: {} }, issueLabels: { 7: labels },
    toolRun: { result: { stdout: 'https://github.com/o/r/issues/7\n' } },
  }
}

// A Large feature without an issue: /wayfinder creates #7, which gh reports with these labels.
function buildMappingOptions(labels: string[]): Options {
  return {
    session: { flow: 'large-feature', issues: [], info: {} }, issueLabels: { 7: labels },
    toolRun: { result: { stdout: 'https://github.com/o/r/issues/7\n' } },
  }
}

for (const label of ['ready-for-agent', 'ready-for-human', 'needs-info', 'wontfix']) {
  test(`Triage ends once the issue carries ${label}`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, buildTriagingOptions([label]))
    await startSkill($, 'triage')
    await $.tool.call(createIssue)
    expect(await readFlowStatus($)).toContain('✓ Triage')
  })
}

test('Triage stays current while the issue carries only needs-triage', async ($, on) => {
  createWorld(on, { branch: 'feat' }, buildTriagingOptions(['needs-triage']))
  await startSkill($, 'triage')
  await $.tool.call(createIssue)
  expect(await readFlowStatus($)).toContain('▸ Triage')
})

test('gh issue create in a later turn than the one /triage started in is not asked and attaches the issue', async ($, on) => {
  createWorld(on, { branch: 'feat' }, buildTriagingOptions(['needs-info']))
  await startSkill($, 'triage')
  await endTurn($)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'gh issue create --title t' } })).decision).not.toBe('ask')
  await $.tool.call(createIssue)
  expect(await readFlowStatus($)).toContain('✓ Triage')
})

test('Map ends once the issue carries wayfinder:map', async ($, on) => {
  createWorld(on, { branch: 'feat' }, buildMappingOptions(['wayfinder:map']))
  await startSkill($, 'wayfinder')
  await $.tool.call(createIssue)
  expect(await readFlowStatus($)).toContain('✓ Map')
})

test('Map stays current while the issue lacks wayfinder:map', async ($, on) => {
  createWorld(on, { branch: 'feat' }, buildMappingOptions(['needs-triage']))
  await startSkill($, 'wayfinder')
  await $.tool.call(createIssue)
  expect(await readFlowStatus($)).toContain('▸ Map')
})

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

test('a Large feature declared on a wayfinder:map issue shows Map done', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['wayfinder:map'] } })
  await declareFlow($, 'large-feature', [1])
  expect(await readFlowStatus($)).toContain('✓ Map')
})
