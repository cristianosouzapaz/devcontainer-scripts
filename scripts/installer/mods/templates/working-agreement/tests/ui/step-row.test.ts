import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { buildChanged, buildParentGraph, diagnosed, diagnoseRuns, diagnosisComment, noFlow, twoIssueCloseOut, verifyFile } from '../support/builders'
import { approveVerify, declareFlow, readFlowStatus, releaseVerifyHolder, seedVerifyHolder } from '../support/helpers'
import { parChild } from '../support/parallel-worktrees'
import { createWorld } from '../support/world'
import type { Engine } from 'claude-code/testing'
import type { Options } from '../support/world'

const fixIssue: Options = { session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } }, issueLabels: { 1: ['ready-for-agent'] } }

/**
 * Reads the status row of a step by its mark.
 * @param $ - The test's engine.
 * @param mark - The step's mark, `▸` for the current step.
 * @returns The row, trimmed.
 */
const readStepRow = async ($: Engine, mark: string): Promise<string | undefined> =>
  (await readFlowStatus($))?.split('\n').map(line => line.trim()).find(line => line.startsWith(`${mark} `))

// Each test puts a step in its normal state: the unit is on the normal path, so the row names the step alone.

test('Grill before its issue is ready shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['needs-triage'] } })
  await declareFlow($, 'small-feature', [1])
  expect(await readStepRow($, '▸')).toBe('▸ Grill')
})

test('Triage before its label shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'fix' }, { session: noFlow, issueLabels: { 1: [] } })
  await declareFlow($, 'fix', [1])
  expect(await readStepRow($, '▸')).toBe('▸ Triage')
})

test('Map with no issue yet shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  await declareFlow($, 'large-feature')
  expect(await readStepRow($, '▸')).toBe('▸ Map')
})

test('Map before its label shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, subIssues: { 1: [{ state: 'closed', labels: ['wayfinder:map'] }] } })
  await declareFlow($, 'large-feature', [1])
  expect(await readStepRow($, '▸')).toBe('▸ Map')
})

test('Map with its mapped sub-issues open shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['wayfinder:map'] }, subIssues: { 1: [{ state: 'open', labels: ['wayfinder:map'] }] } })
  await declareFlow($, 'large-feature', [1])
  expect(await readStepRow($, '▸')).toBe('▸ Map')
})

test('Tickets before a ready sub-issue shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['wayfinder:map'] }, subIssues: { 1: [{ state: 'closed', labels: ['wayfinder:map'] }] } })
  await declareFlow($, 'large-feature', [1])
  expect(await readStepRow($, '▸')).toBe('▸ Tickets')
})

test('an optional step left unrun shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { info: { 1: { title: 'feat', labels: ['ready-for-agent'] } } }, unit: { skills: ['grilling', 'to-spec'] }, issueLabels: { 1: ['ready-for-agent'] } })
  expect(await readStepRow($, '↷')).toBe('↷ Tickets')
})

test('Diagnose before a red and before its comment shows the step alone', async ($, on) => {
  const options: Options = { ...fixIssue, comments: { 1: [] } }
  createWorld(on, { branch: 'fix' }, options)
  expect(await readStepRow($, '▸')).toBe('▸ Diagnose')
  options.unit = { runs: [diagnoseRuns[0]!] }
  expect(await readStepRow($, '▸')).toBe('▸ Diagnose')
})

test('Code before a change shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { verifyFile, approvedConfig: verifyFile })
  expect(await readStepRow($, '▸')).toBe('▸ Code')
})

test('Code with a change and no Verify run yet shows the step alone', async ($, on) => {
  createWorld(on, buildChanged(), { verifyFile, approvedConfig: verifyFile })
  expect(await readStepRow($, '▸')).toBe('▸ Code')
})

test('Code in a Fix before the fix passes shows the step alone', async ($, on) => {
  createWorld(on, buildChanged(), { ...fixIssue, unit: diagnosed, comments: { 1: [diagnosisComment] }, verifyFile, approvedConfig: verifyFile })
  expect(await readStepRow($, '▸')).toBe('▸ Code')
})

test('Verify on an approved config before its run shows the step alone', async ($, on) => {
  createWorld(on, buildChanged(), { verifyFile })
  await approveVerify($)
  expect(await readStepRow($, '▸')).toBe('▸ Verify')
})

test('Commit before the first commit shows the step alone', async ($, on) => {
  createWorld(on, buildChanged(), { verifyFile, approvedConfig: verifyFile })
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(await readStepRow($, '▸')).toBe('▸ Commit')
})

test('PR before a PR is opened shows the step alone', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skips: [{ step: 'verify', reason: 'covered separately' }], skills: ['generate-commit'] } })
  expect(await readStepRow($, '▸')).toBe('▸ PR')
})

test('Integrate before the merge into the parent shows the step alone', async ($, on) => {
  const graph = buildParentGraph()
  createWorld(on, { branch: 'a', graph, worktrees: { '/repo': { branch: 'a' }, '/par': { branch: 'par' } } }, parChild())
  expect(await readStepRow($, '▸')).toBe('▸ Integrate')
})

test('a Verify waiting its turn in the queue keeps its waiting fact while the step row stays alone', async ($, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile, approvedConfig: verifyFile })
  seedVerifyHolder(world)
  const run = $.tool.call({ tool: 'mcp__working-agreement__verify' })
  await world.clock.settle()
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Verify', value: 'queued, 2nd of 2', tone: 'warn' })
  expect(await readStepRow($, '▸')).toBe('▸ Code')
  expect(await readFlowStatus($)).toContain('queued, 2nd of 2')
  releaseVerifyHolder(world)
  await world.clock.advance(1000)
  await run
})
