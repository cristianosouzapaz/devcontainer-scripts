import { expect, test } from 'claude-code/testing'

import { diagnosisComment, noFlow } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand, startSkill } from '../support/helpers'
import { createWorld, root } from '../support/world'
import type { Checkout, Options } from '../support/world'

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

test('declaring the produced issue attaches it to the issue-less unit on the same branch', async ($, on) => {
  const options: Options = { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } }
  createWorld(on, { branch: 'feat' }, options)
  expect((await declareFlow($, 'small-feature')).deny).toBeUndefined()
  expect(await readFlowStatus($)).toContain('issue not yet created')
  const attached = await declareFlow($, 'small-feature', [1])
  expect(attached.deny).toBeUndefined()
  expect(await readCurrentStep($)).toBe('Code')
  expect(await readFlowStatus($)).not.toContain('issue not yet created')
})

test('an attached issue keeps the skips recorded before it existed', async ($, on) => {
  createWorld(on, { branch: 'main' }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  await declareFlow($, 'fix')
  await runFlowCommand($, 'skip diagnose reproduced elsewhere')
  expect((await declareFlow($, 'fix', [1])).deny).toBeUndefined()
  expect(await readFlowStatus($)).toContain('reproduced elsewhere')
})

test('only an issue-less unit of the same flow takes the produced issue', async ($, on) => {
  const options: Options = { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'] } }
  createWorld(on, { branch: 'feat' }, options)
  await declareFlow($, 'small-feature')
  expect((await declareFlow($, 'large-feature', [1])).deny).toContain('empty slice')
  await declareFlow($, 'small-feature', [1])
  expect((await declareFlow($, 'small-feature', [1, 2])).deny).toContain('empty slice')
})

test('the unit branch takes over the skips recorded for its issues on the default branch', async ($, on) => {
  const git: Checkout = { branch: 'main' }
  createWorld(on, git, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  await declareFlow($, 'fix', [1])
  await runFlowCommand($, 'skip diagnose reproduced elsewhere')
  git.branch = 'fix'
  expect((await declareFlow($, 'fix', [1])).result).toContain('current step: Code')
  expect(await readFlowStatus($)).toContain('reproduced elsewhere')
  expect(await readPromptContext($)).not.toContain('no green after the approval')
})

test('the unit branch takes over the approval and red run recorded on the default branch', async ($, on) => {
  const git: Checkout = { branch: 'main' }
  const options: Options = { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } }
  const { clock } = createWorld(on, git, options)
  await declareFlow($, 'fix', [1])
  await startSkill($, 'diagnosing-bugs')
  git.dirty = { 'src/a.ts': 'red' }
  options.spawnCode = 1
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./check'] })).result).toContain('red recorded')
  await clock.advance(1)
  options.comments = { 1: [{ ...diagnosisComment, createdAt: new Date(clock.now() + 1).toISOString() }] }
  expect((await runFlowCommand($, `approve ${diagnosisComment.url}`)).text).toContain('Diagnosis approved')
  git.branch = 'fix'
  git.dirty = { 'src/a.ts': 'fix' }
  expect((await declareFlow($, 'fix', [1])).result).toContain('current step: Code')
  expect(await readPromptContext($)).toContain('no green after the approval')
})

test('a branch takes over nothing from a different flow or issue set on the default branch', async ($, on) => {
  const git: Checkout = { branch: 'main' }
  createWorld(on, git, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'] } })
  await declareFlow($, 'fix', [1])
  await runFlowCommand($, 'skip diagnose reproduced elsewhere')
  git.branch = 'fix'
  await declareFlow($, 'fix', [1, 2])
  expect(await readFlowStatus($)).not.toContain('reproduced elsewhere')
  git.branch = 'other'
  await declareFlow($, 'small-feature', [1])
  expect(await readFlowStatus($)).not.toContain('reproduced elsewhere')
})

test('an issue-less unit on the default branch passes nothing to a branch', async ($, on) => {
  const git: Checkout = { branch: 'main' }
  createWorld(on, git, { session: noFlow })
  await declareFlow($, 'fix')
  await runFlowCommand($, 'skip triage reported by the user')
  git.branch = 'fix'
  await declareFlow($, 'fix')
  expect(await readFlowStatus($)).not.toContain('reported by the user')
})

test('a Fix declared without its issue on the default branch ends with every fact on the unit branch', async ($, on) => {
  const git: Checkout = { branch: 'main' }
  createWorld(on, git, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  await declareFlow($, 'fix')
  await runFlowCommand($, 'skip diagnose reproduced elsewhere')
  await declareFlow($, 'fix', [1])
  git.branch = 'fix'
  expect((await declareFlow($, 'fix', [1])).result).toContain('current step: Code')
  expect(await readFlowStatus($)).toContain('reproduced elsewhere')
})
