import { expect, test } from 'claude-code/testing'

import { bashCall, currentStep, endTurn, flowStatus, startSkill } from './helpers'
import { world } from './world'
import type { Options } from './world'

// A Fix without an issue: /triage creates #7, which gh reports with these labels.
const triaging = (labels: string[]): Options => ({
  session: { flow: 'fix', issues: [], hadIssue: false, info: {} }, issueLabels: { 7: labels },
  toolRun: { result: { stdout: 'https://github.com/o/r/issues/7\n' } },
})
// A Large feature without an issue: /wayfinder creates #7, which gh reports with these labels.
const mapping = (labels: string[]): Options => ({
  session: { flow: 'large-feature', issues: [], hadIssue: false, info: {} }, issueLabels: { 7: labels },
  toolRun: { result: { stdout: 'https://github.com/o/r/issues/7\n' } },
})
const create = bashCall('gh issue create --title t --body b')

for (const label of ['ready-for-agent', 'ready-for-human', 'needs-info', 'wontfix']) {
  test(`Triage ends once the issue carries ${label}`, async ($, on) => {
    world(on, { branch: 'feat' }, triaging([label]))
    await startSkill($, 'triage')
    await $.tool.call(create)
    expect(await flowStatus($)).toContain('✓ Triage')
  })
}

test('Triage stays current while the issue carries only needs-triage', async ($, on) => {
  world(on, { branch: 'feat' }, triaging(['needs-triage']))
  await startSkill($, 'triage')
  await $.tool.call(create)
  expect(await flowStatus($)).toContain('▸ Triage')
})

test('gh issue create in a later turn than the one /triage started in is not asked and attaches the issue', async ($, on) => {
  world(on, { branch: 'feat' }, triaging(['needs-info']))
  await startSkill($, 'triage')
  await endTurn($)
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'gh issue create --title t' } })).decision).not.toBe('ask')
  await $.tool.call(create)
  expect(await flowStatus($)).toContain('✓ Triage')
})

test('Map ends once the issue carries wayfinder:map', async ($, on) => {
  world(on, { branch: 'feat' }, mapping(['wayfinder:map']))
  await startSkill($, 'wayfinder')
  await $.tool.call(create)
  expect(await flowStatus($)).toContain('✓ Map')
})

test('Map stays current while the issue lacks wayfinder:map', async ($, on) => {
  world(on, { branch: 'feat' }, mapping(['needs-triage']))
  await startSkill($, 'wayfinder')
  await $.tool.call(create)
  expect(await flowStatus($)).toContain('▸ Map')
})

// A Small feature on #1 whose Spec is done on the stored labels.
const specDone: Options = { unit: { skills: ['grilling', 'to-spec'] }, issueLabels: { 1: ['ready-for-agent'] } }

test('a failed read-back keeps the stored labels: Spec stays done while gh is logged out', async ($, on) => {
  const options: Options = { ...specDone }
  const { clock } = world(on, { branch: 'feat' }, options)
  options.isLoggedOut = true
  options.issueLabels = { 1: [] }
  await clock.advance(61000)
  expect(await currentStep($)).toBe('Code')
})

test('a failed read-back ticks nothing: Spec stays current while gh is logged out', async ($, on) => {
  const { clock } = world(on, { branch: 'feat' }, {
    ...specDone, session: { info: { 1: { title: 'feat', labels: ['needs-info'] } } }, isLoggedOut: true,
  })
  await startSkill($, 'to-spec')
  await clock.advance(61000)
  expect(await currentStep($)).toBe('Spec')
})

test('a gh issue edit whose read-back fails does not end Spec', async ($, on) => {
  world(on, { branch: 'feat' }, {
    ...specDone, session: { info: { 1: { title: 'feat', labels: ['needs-info'] } } }, isLoggedOut: true,
  })
  await startSkill($, 'to-spec')
  await $.tool.call(bashCall('gh issue edit 1 --body-file spec.md --add-label ready-for-agent'))
  expect(await currentStep($)).toBe('Spec')
})
