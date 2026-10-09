import { expect, test } from 'claude-code/testing'

import { declareFlow, flow, twoIssueCloseOut, writeCall } from './helpers'
import { world } from './world'

const userOnly = ['override verify skipped', 'trivial', 'follow-up #1', 'handoff']
// A Fix on #1 and #2 with Diagnose still to do; with no prompt yet the permission mode is unknown, so its ask denies.
const twoIssueFix = { session: { ...twoIssueCloseOut.session, flow: 'fix' } }

test('the user-only /flow subcommands are refused unless typed at the prompt', async ($, on) => {
  world(on, { branch: 'feat' })
  for (const args of userOnly) {
    const r = await flow($, args, { kind: 'plugin', name: 'working-agreement' })
    expect(r.text, args).toContain("is the user's to run from the prompt")
  }
  expect((await flow($, 'override verify skipped')).text).toContain('Override: verify')
})

test('an override unblocks its step for the named issue only', async ($, on) => {
  world(on, { branch: 'feat' }, twoIssueFix)
  await flow($, 'override diagnose #1 no reproduction')
  expect((await $.tool.call(writeCall('src/a.ts'))).deny).toBeUndefined()
  await declareFlow($, 'fix', [2])
  expect((await $.tool.call(writeCall('src/a.ts'))).deny).toContain('Diagnose not done')
})
