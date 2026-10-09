import { expect, test } from 'claude-code/testing'

import { bashCall, declareFlow, flow, noFlow } from './helpers'
import { world } from './world'

test('the agent cannot declare a flow that only the user declares', async ($, on) => {
  world(on, { branch: 'feat' }, { session: noFlow })
  for (const flow of ['trivial', 'follow-up-open', 'follow-up-merged']) {
    expect((await declareFlow($, flow)).deny, flow).toContain('declared only by the user')
  }
})

test('a flow that requires an issue needs one, and it must exist and be open', async ($, on) => {
  world(on, { branch: 'feat' }, { session: noFlow, issues: { 7: 'CLOSED' }, missing: [9] })
  expect((await declareFlow($, 'close-out')).deny).toContain('needs an issue')
  expect((await declareFlow($, 'fix', [9])).deny).toContain('check the number')
  expect((await declareFlow($, 'close-out', [7])).deny).toContain('is closed')
  expect((await declareFlow($, 'fix', [7])).deny).toContain('is closed')
  expect((await declareFlow($, 'fix', [3])).deny).toBeUndefined()
})

test('no flow is declared after a PR was created in the session', async ($, on) => {
  world(on, { branch: 'feat' }, { session: { ...noFlow, prCreated: true } })
  expect((await declareFlow($, 'fix')).deny).toContain('PR was already created')
})

test('a flow is reclassified until a commit produces output, then only when the user overrides it', async ($, on) => {
  world(on, { branch: 'feat' }, { toolRun: { result: { gitOperation: { commit: { sha: 'c1', kind: 'committed' } } } } })
  expect((await declareFlow($, 'fix')).deny).toBeUndefined()
  await $.tool.call(bashCall('git commit -m x'))
  expect((await declareFlow($, 'fix')).deny).toContain('already produced output')
  await flow($, 'override reclassify scope changed')
  expect((await declareFlow($, 'fix')).deny).toBeUndefined()
})

test('a flow-step skill is denied until a flow is declared', async ($, on) => {
  world(on, { branch: 'feat' }, { session: noFlow })
  const grilling = { tool: 'Skill' as const, skill: 'grilling' }
  expect((await $.tool.call(grilling)).deny).toContain('no flow is declared')
  await declareFlow($, 'small-feature')
  expect((await $.tool.call(grilling)).deny).toBeUndefined()
})

test('a subagent cannot declare a flow', async ($, on) => {
  world(on, { branch: 'feat' }, { session: noFlow })
  expect((await declareFlow($, 'fix', [], 'agent-1')).deny).toContain('subagents')
})
