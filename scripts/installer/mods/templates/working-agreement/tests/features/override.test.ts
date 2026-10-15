import { expect, test } from 'claude-code/testing'

import { buildWriteCall, noFlow, twoIssueCloseOut } from '../support/builders'
import { declareFlow, readFlowStatus, runFlowCommand } from '../support/helpers'
import { createWorld } from '../support/world'

const userOnly = ['override verify skipped', 'trivial', 'follow-up #1', 'handoff']
const approvedDiagnosis = { diagnosis: 'https://github.com/o/r/issues/1#issuecomment-1', approval: 'https://github.com/o/r/issues/1#issuecomment-1' }
// A Fix on #1 and #2 with Diagnose still to do, its diagnosis comment approved so only the red and the green are left; with no prompt yet the permission mode is unknown, so its ask denies.
const twoIssueFix = {
  unit: approvedDiagnosis,
  units: { 2: approvedDiagnosis },
  session: {
    ...twoIssueCloseOut.session, flow: 'fix',
    info: { 1: { title: 'a', labels: ['ready-for-agent'] }, 2: { title: 'b', labels: ['ready-for-agent'] } },
  },
  issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'] },
}

test('the user-only /flow subcommands are refused unless typed at the prompt', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  for (const args of userOnly) {
    const result = await runFlowCommand($, args, { kind: 'plugin', name: 'working-agreement' })
    expect(result.text, args).toContain("is the user's to run from the prompt")
  }
  expect((await runFlowCommand($, 'override verify skipped')).text).toContain('Override logged for verify')
})

test('an override unblocks its step for the named issue only', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueFix)
  expect((await runFlowCommand($, 'override diagnose #1 no reproduction')).text).toContain('only')
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toContain('Diagnose not done')
  await declareFlow($, 'fix', [1])
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
  await declareFlow($, 'fix', [2])
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toContain('Diagnose not done')
  await runFlowCommand($, 'override diagnose #2 no reproduction')
  await declareFlow($, 'fix', [1, 2])
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
})

test('an override naming an undeclared issue is refused and changes nothing', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueFix)
  expect((await runFlowCommand($, 'override diagnose #9 x')).text).toContain('not a declared issue')
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toContain('Diagnose not done')
})

for (const step of ['branch', 'reclassify']) {
  test(`an override of ${step} naming an undeclared issue is refused`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, twoIssueFix)
    expect((await runFlowCommand($, `override ${step} #9 x`)).text).toContain('not a declared issue')
  })
}

test('an override naming no issue applies to every declared issue', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueFix)
  expect((await runFlowCommand($, 'override diagnose no reproduction')).text).toContain('on #1, #2')
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
})

test('an override on a single-issue session unblocks its step', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueFix)
  await declareFlow($, 'fix', [1])
  expect((await runFlowCommand($, 'override diagnose #1 no reproduction')).text).toContain('Override logged for diagnose on #1 — "no reproduction".')
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
})

test('an override on Code is accepted in a Trivial change', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { ...noFlow, flow: 'trivial', followUp: true } })
  expect((await runFlowCommand($, 'override code no tests needed')).text).toContain('Override logged for code')
  expect(await readFlowStatus($)).toContain('⚑ Code')
})

test('an override stored on the earlier Change step reads as one on Code in a Trivial change', async ($, on) => {
  createWorld(on, { branch: 'feat' }, {
    session: { ...noFlow, flow: 'trivial', followUp: true },
    unit: { overrides: [{ step: 'change', reason: 'stored by an earlier version' }] },
  })
  expect(await readFlowStatus($)).toContain('⚑ Code')
})
