import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { buildParentGraph, buildPullRequest, diagnosisComment, noFlow } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand, startSkill } from '../support/helpers'
import { createWorld, root } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('run, verify, declare_flow, the suggestion tools, the issue tools and the unit tools register in front of ToolSearch', async ($, on) => {
  const { registeredTools } = createWorld(on, { branch: 'feat' }, { session: noFlow })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect(registeredTools).toEqual([
    { name: 'run', isDeferred: false }, { name: 'verify', isDeferred: false }, { name: 'declare_flow', isDeferred: false },
    { name: 'suggest_coordinate', isDeferred: false }, { name: 'suggest_delegate', isDeferred: false }, { name: 'merge_child', isDeferred: false }, { name: 'issue_create', isDeferred: false }, { name: 'issue_edit', isDeferred: false },
    { name: 'issue_close', isDeferred: false }, { name: 'issue_comment', isDeferred: false }, { name: 'spawn', isDeferred: false },
    { name: 'unit_prompt', isDeferred: false }, { name: 'unit_read', isDeferred: false },
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
  expect(await readPromptContext($)).not.toContain('run the fix: no green since approval')
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
  expect(await readPromptContext($)).toContain('run the fix: no green since approval')
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

test('a branch cut from another local branch takes it from the reflog as its base branch and says so', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'b', graph: buildParentGraph() }, { session: noFlow })
  expect((await declareFlow($, 'small-feature', [1])).result).toContain('Flow declared: Small feature for #1, base from par (branch reflog).')
  expect(sessions.get('sid')?.units[0]).toMatchObject({ base: 'p1', baseBranch: 'par' })
})

for (const [label, created] of [['HEAD', 'HEAD'], ['a commit', 'p1'], ['a revision', 'par~1'], ['the branch itself', 'b'], ['the default branch', 'main'],
  ['a missing branch', 'gone'], ['a remote-tracking branch', 'origin/par'], ['nothing, as with no reflog', undefined]] as const) {
  test(`a reflog that names ${label} as the start point falls back to the default branch and says so`, async ($, on) => {
    const graph = buildParentGraph()
    graph.created = created ? { b: created } : {}
    const { sessions } = createWorld(on, { branch: 'b', graph }, { session: noFlow })
    expect((await declareFlow($, 'small-feature', [1])).result).toContain('Flow declared: Small feature for #1, base from main.')
    expect(sessions.get('sid')?.units[0]).toMatchObject({ base: 'c0', baseBranch: 'main' })
  })
}

test("the unit's PR base wins over the reflog's parent branch", async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'b', graph: buildParentGraph() }, { session: noFlow, prs: [buildPullRequest({ headRefName: 'b', headRefOid: 'b1' })] })
  expect((await declareFlow($, 'small-feature', [1])).result).toContain('base from main (PR #5).')
  expect(sessions.get('sid')?.units[0]).toMatchObject({ base: 'c0', baseBranch: 'main' })
})

test('a later unit on a shared branch is based at the declaration tip, records no base branch and says so', async ($, on) => {
  const { chat, sessions } = createWorld(on, { branch: 'b', graph: buildParentGraph() }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  expect((await declareFlow($, 'small-feature', [2])).result).toContain('Flow declared: Small feature for #2, base at the declaration tip.')
  expect(sessions.get('second')?.units[0]?.base).toBe('b1')
  expect(sessions.get('second')?.units[0]?.baseBranch).toBeUndefined()
})

test('a Follow-up child records its parent as base branch and the fork point as base, never the declaration tip', async ($, on) => {
  const graph = buildParentGraph()
  const closing = { number: 10, state: 'OPEN', headRefName: 'par', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }
  const { sessions } = createWorld(on, { branch: 'b', graph: { ...graph, refs: { ...graph.refs, par: 'p2', b: 'b2' } } }, { session: noFlow, closingPrs: { 1: [closing] } })
  const reply = (await runFlowCommand($, 'follow-up #1')).text
  expect(reply).toContain('Flow declared: Follow-up for #1, base from par (branch reflog).')
  expect(reply).not.toContain('not counted for this unit')
  expect(sessions.get('sid')?.units[0]).toMatchObject({ base: 'p2', baseBranch: 'par' })
})
