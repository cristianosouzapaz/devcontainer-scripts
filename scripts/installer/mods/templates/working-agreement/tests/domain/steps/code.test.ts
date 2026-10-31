import { expect } from 'claude-code/testing'
import { test } from '../../support/kit'
import { buildChanged, buildChangedCheckout, buildPullRequest, buildVerifyRun, diagnosed, diagnosisComment, fixed, verifyFile, verifyId } from '../../support/builders'
import { endTurn, inside, readCurrentStep, readFlowStatus, readPaneCurrentStep, readPromptContext } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Options } from '../../support/world'

const fixOptions = (unit: Options['unit']): Options => ({
  session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'], comments: [diagnosisComment] } } },
  unit, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] }, verifyFile, approvedConfig: verifyFile,
})

test('a change with no Verify run on its tree leaves Code current in every display and Verify pending', async ($, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile, approvedConfig: verifyFile, herdrEnv: inside })
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Code\n')
  expect(status).toContain('○ Verify')
  const context = await readPromptContext($)
  expect(context).toContain('current step: Code. Next action:')
  expect(context).toContain('Next action: call the verify tool on this tree (finish any change still in progress first)')
  await endTurn($)
  expect(readPaneCurrentStep(world.views)).toBe('Code')
  expect(world.views.at(-1)?.steps.find(step => step.label === 'Code')?.detail).toBeUndefined()
  expect(world.views.at(-1)?.steps.find(step => step.label === 'Verify')?.state).toBe('pending')
  expect(world.runs.at(-1)).toContain('--token flow_step=▸ Code --token')
})

test('work committed without a Verify run on its tree leaves Code current', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { verifyFile, approvedConfig: verifyFile })
  expect(await readFlowStatus($)).toContain('▸ Code\n')
  expect(await readCurrentStep($)).toBe('Code')
})

test('an edit after the PR is open makes Code current again', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1, isDirty: true, tree: 'two' }, {
    verifyFile, approvedConfig: verifyFile, prs: [buildPullRequest()],
  })
  expect(await readCurrentStep($)).toBe('Code')
})

for (const [outcome, overrides, fact] of [
  ['a pass', {}, '✓ Verify'],
  ['a failure', { spawnCode: 1 }, '✗ Verify · failed, exit 1'],
] as [string, Options, string][]) {
  test(`${outcome} of Verify completes Code, and a later edit makes Code current again`, async ($, on) => {
    const checkout = buildChanged()
    createWorld(on, checkout, { verifyFile, approvedConfig: verifyFile, ...overrides })
    await $.tool.call({ tool: 'mcp__working-agreement__verify' })
    const status = await readFlowStatus($)
    expect(status).toContain('✓ Code')
    expect(status).toContain(fact)
    expect(await readCurrentStep($)).toBe(outcome === 'a pass' ? 'Commit' : 'Verify')
    checkout.tree = 'two'
    // The fact names what the tree changed after, so a commit right after a pass explains why Commit is empty.
    expect(await readFlowStatus($)).toContain(outcome === 'a pass' ? '▸ Code · changed after Verify' : '▸ Code · changed after Verify failed')
    expect(await readPromptContext($)).toContain('Next action: call the verify tool on this tree')
  })
}

test('a Verify run on the tree under another base leaves Code current with the base move as its fact when its commands miss the selection', async ($, on) => {
  const run = buildVerifyRun({ commands: [['partial']] })
  createWorld(on, buildChangedCheckout(), { verifyFile, approvedConfig: verifyFile, unit: { verifyRuns: [run], base: 'c1' } })
  expect(await readFlowStatus($)).toContain('▸ Code · parent branch moved')
})

test('a passing Verify run on the tree under another base still verifies when its commands cover the selection', async ($, on) => {
  const run = buildVerifyRun()
  createWorld(on, buildChangedCheckout(), { verifyFile, approvedConfig: verifyFile, unit: { verifyRuns: [run], base: 'c1' } })
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Code')
  expect(status).toContain('✓ Verify')
})

test('a timed-out Verify completes Code', async ($, on) => {
  const file = JSON.stringify({ always: [['slow']], timeoutMinutes: 0.01 })
  const world = createWorld(on, buildChanged(), { verifyFile: file, approvedConfig: file, spawnGate: new Promise(() => {}) })
  const run = $.tool.call({ tool: 'mcp__working-agreement__verify' })
  await world.clock.settle()
  await world.clock.advance(600)
  await run
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Code')
  expect(status).toContain('✗ Verify · timed out after 0.01 min')
})

test('a Verify run on the tree and base completes Code whatever its config', async ($, on) => {
  const run = buildVerifyRun({ configBlob: 'other', commands: [['partial']] })
  createWorld(on, buildChangedCheckout(), { verifyFile, approvedConfig: verifyFile, unit: { verifyRuns: [run] } })
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Verify')
})

test('without a verify command Code is done on the first change and Verify shows the missing config', async ($, on) => {
  createWorld(on, buildChanged(), {})
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Code')
  expect(status).toContain('no verify command configured')
  expect(await readCurrentStep($)).toBe('Verify')
})

test('an invalid verify config completes Code and Verify shows its JSON path', async ($, on) => {
  createWorld(on, buildChanged(), { verifyFile: '{"verify":[]}', approvedConfig: '{"verify":[]}' })
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Code')
  expect(status).toContain('verify:')
  expect(await readCurrentStep($)).toBe('Verify')
})

test('an unapproved verify config completes Code and Verify waits on its approval command', async ($, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Code')
  expect(status).toContain('/flow approve verify')
  expect(await readCurrentStep($)).toBe('Verify')
  await endTurn($)
  expect(world.suggestions.at(-1)).toBe(`/flow approve verify ${verifyId()}`)
})

test('in a Fix a change without a green after the approval leaves Code current', async ($, on) => {
  createWorld(on, buildChanged(), fixOptions(diagnosed))
  expect(await readFlowStatus($)).toContain('▸ Code\n')
  expect(await readCurrentStep($)).toBe('Code')
})

test('in a Fix the green after the approval alone leaves Code current until a Verify run', async ($, on) => {
  createWorld(on, buildChanged(), fixOptions(fixed))
  expect(await readFlowStatus($)).toContain('▸ Code\n')
  const instruction = await readPromptContext($)
  expect(instruction).toContain('Next action: call the verify tool on this tree')
  expect(instruction).not.toContain('apply the approved fix')
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readCurrentStep($)).toBe('Commit')
})

test('in a Fix a Verify run without the green leaves Code current', async ($, on) => {
  createWorld(on, buildChanged(), fixOptions(diagnosed))
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(await readFlowStatus($)).toContain('▸ Code\n')
})

test('in a Fix the green after the approval without a change leaves Code current', async ($, on) => {
  createWorld(on, { branch: 'feat' }, fixOptions(fixed))
  expect(await readCurrentStep($)).toBe('Code')
})

test('in a Fix with Diagnose skipped, Code is done by the change and a Verify run', async ($, on) => {
  createWorld(on, buildChanged(), fixOptions({ skips: [{ step: 'diagnose', reason: 'no command reproduces it' }] }))
  expect(await readCurrentStep($)).toBe('Code')
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(await readFlowStatus($)).toContain('✓ Code')
})

test('in a Fix the Code instruction resumes the diagnosis skill at its regression test, fix, green and cleanup', async ($, on) => {
  createWorld(on, { branch: 'feat' }, fixOptions(diagnosed))
  const instruction = await readPromptContext($)
  expect(instruction).toContain('resume the diagnosing-bugs skill at Phase 5')
  expect(instruction).toContain('write the regression test if the red is not already one')
  expect(instruction).toContain('apply the approved fix')
  expect(instruction).toContain("rerun the red command's argv through the run tool until it passes")
  expect(instruction).toContain('do the Phase 6 cleanup')
  expect(instruction).toContain('call the verify tool')
})

test('with Diagnose skipped the Code instruction stays a plain change', async ($, on) => {
  createWorld(on, { branch: 'feat' }, fixOptions({ skips: [{ step: 'diagnose', reason: 'no command reproduces it' }] }))
  const instruction = await readPromptContext($)
  expect(instruction).toContain('make the change, then call the verify tool')
  expect(instruction).not.toContain('approved fix')
})
