import { expect, test } from 'claude-code/testing'
import { diagnosed, diagnoseRuns, diagnosisComment } from '../support/builders'
import { readCurrentStep, readFlowStatus, runFlowCommand } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Options } from '../support/world'

const url = diagnosisComment.url
const options = (): Options => ({
  session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
  unit: { runs: [diagnoseRuns[0]!] }, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
})

test('composer approval reads comments fresh and completes the unit Diagnose row', async ($, on) => {
  const setup = options()
  setup.comments = { 1: [] }
  const { clock, sessions } = createWorld(on, { branch: 'fix' }, setup)
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('no comment after the red')
  setup.comments = { 1: [diagnosisComment] }
  expect((await runFlowCommand($, `approve ${url}`, { kind: 'composer' })).text).toContain('Diagnosis approved')
  expect(sessions.get('sid')?.units[0]?.approval).toBe(url)
  expect(await readCurrentStep($)).toBe('Code')
  expect(await readFlowStatus($)).toContain('✓ Diagnose')
})

test('approval belongs to the declared unit and cannot be submitted by another origin', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'fix' }, options())
  for (const origin of [{ kind: 'plugin', name: 'working-agreement' }, { kind: 'sdk' }] as const) {
    expect((await runFlowCommand($, `approve ${url}`, origin)).text).toContain("is the user's to run from the prompt")
    expect(sessions.get('sid')?.units[0]?.approval).toBeUndefined()
  }
})

for (const [name, overrides, args, reason] of [
  ['old syntax', {}, 'diagnose', 'Usage: /flow approve <comment-url>'],
  ['no Diagnose', { session: { flow: 'close-out' } }, url, 'no Diagnose step'],
  ['no unit', { session: { flow: null } }, url, 'no Diagnose step'],
  ['no red', { unit: { runs: [] } }, url, 'There is no red run yet: reproduce the bug through the run tool first.'],
  ['only a green', { unit: { runs: [diagnoseRuns[1]!] } }, url, 'There is no red run yet'],
  ['another issue', { comments: { 2: [diagnosisComment] } }, url, 'not a comment of the declared issue'],
  ['comment before the red', { comments: { 1: [{ ...diagnosisComment, createdAt: new Date(0).toISOString() }] } }, url, 'That comment was created before the red run; post a diagnosis comment after it.'],
  ['comment at the red', { comments: { 1: [{ ...diagnosisComment, createdAt: new Date(1).toISOString() }] } }, url, 'created before the red run'],
  ['comment before the earliest red', { unit: { runs: [{ ...diagnoseRuns[0]!, at: 5 }, { ...diagnoseRuns[0]!, runId: 'early', at: 4 }] } }, url, 'created before the red run'],
  ['read error', { comments: { 1: { error: 'comments failed' } } }, url, 'comments failed'],
] as [string, Options, string, string][]) {
  test(`approval refuses ${name} as a plain reason`, async ($, on) => {
    const { sessions } = createWorld(on, { branch: 'fix' }, { ...options(), ...overrides })
    expect((await runFlowCommand($, `approve ${args}`)).text).toContain(reason)
    expect(sessions.get('sid')?.units[0]?.approval).toBeUndefined()
  })
}

test('approval needs no green: a red and a later comment suffice', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'fix' }, options())
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain('Diagnosis approved')
  expect(sessions.get('sid')?.units[0]?.approval).toBe(url)
})

test('approval measures the comment against the earliest red, not a later failed attempt', async ($, on) => {
  const later = { ...diagnoseRuns[0]!, runId: 'later', tree: 'attempt', at: 9 }
  const { sessions } = createWorld(on, { branch: 'fix' }, { ...options(), unit: { runs: [later, diagnoseRuns[0]!] } })
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain('Diagnosis approved')
  expect(sessions.get('sid')?.units[0]?.approval).toBe(url)
})

test('live comment deletion reopens Diagnose and a newer comment preserves the named approval', async ($, on) => {
  const setup = { ...options(), unit: diagnosed }
  const { clock } = createWorld(on, { branch: 'fix' }, setup)
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Diagnose')
  setup.comments = { 1: [diagnosisComment, { ...diagnosisComment, url: `${url}0` }] }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Diagnose')
  setup.comments = { 1: [] }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('▸ Diagnose · approved comment deleted')
})
