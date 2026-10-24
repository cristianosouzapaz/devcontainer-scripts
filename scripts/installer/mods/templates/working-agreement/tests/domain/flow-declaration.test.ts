import { expect, test } from 'claude-code/testing'

import { noFlow } from '../support/builders'
import { declareFlow } from '../support/helpers'
import { createWorld, root } from '../support/world'

test('run, verify and declare_flow register in front of ToolSearch', async ($, on) => {
  const { registeredTools } = createWorld(on, { branch: 'feat' }, { session: noFlow })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect(registeredTools).toEqual([
    { name: 'run', isDeferred: false }, { name: 'verify', isDeferred: false }, { name: 'declare_flow', isDeferred: false },
  ])
})

test('the agent cannot declare a flow that only the user declares', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  for (const flow of ['trivial', 'follow-up']) {
    expect((await declareFlow($, flow)).deny, flow).toContain('declared only by the user')
  }
})

test('every named issue must exist and be open', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issues: { 7: 'CLOSED' }, missing: [9] })
  expect((await declareFlow($, 'fix', [9])).deny).toContain('check the number')
  expect((await declareFlow($, 'close-out', [7])).deny).toContain('is closed')
  expect((await declareFlow($, 'fix', [7])).deny).toContain('is closed')
  expect((await declareFlow($, 'fix', [3])).deny).toBeUndefined()
})

test('a flow-step skill is denied until a flow is declared', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  const grilling = { tool: 'Skill' as const, skill: 'grilling' }
  expect((await $.tool.call(grilling)).deny).toContain('no flow is declared')
  await declareFlow($, 'small-feature')
  expect((await $.tool.call(grilling)).deny).toBeUndefined()
})

test('a subagent cannot declare a flow', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  expect((await declareFlow($, 'fix', [], 'agent-1')).deny).toContain('Subagents')
})

test('a no-issue declaration is allowed on the default branch without GitHub', async ($, on) => {
  createWorld(on, { branch: 'main' }, { session: noFlow, failing: 'gh' })
  expect((await declareFlow($, 'close-out')).deny).toBeUndefined()
})
