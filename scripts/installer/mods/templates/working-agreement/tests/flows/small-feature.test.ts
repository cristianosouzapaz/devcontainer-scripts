import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { buildPullRequest, noFlow, verifyFile } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, runFlowCommand, startSkill } from '../support/helpers'
import { completeDelivery } from '../support/delivery'
import { configBlob, createWorld, linearGraph } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a Small feature keeps Grill current until GitHub marks its issue ready', async ($, on) => {
  const git: Checkout = { branch: 'feat' }
  const options: Options = { session: noFlow, verifyFile, issueLabels: { 1: ['needs-triage'] } }
  createWorld(on, git, options)
  await declareFlow($, 'small-feature', [1])
  expect(await readCurrentStep($)).toBe('Grill')

  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  expect(await readCurrentStep($)).toBe('Grill')
})

test('new work after a green PR shows the PR step pending until Verify, Commit and PR are reached again', async ($, on) => {
  const graph = linearGraph({ feat: 0 }, verifyFile, 1)
  const git: Checkout = { branch: 'feat', graph, isDirty: true, changed: ['src/a.ts'], tree: 'tree' }
  const options: Options = { session: noFlow, verifyFile, issueLabels: { 1: ['ready-for-agent'] } }
  const { clock } = createWorld(on, git, options)
  await declareFlow($, 'small-feature', [1])
  await runFlowCommand($, `approve verify ${configBlob(verifyFile).slice(0, 12)}`)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  Object.assign(git, { graph: { ...graph, refs: { ...graph.refs, feat: 'c1' } }, isDirty: false, changed: [], tree: undefined })
  Object.assign(options, { prs: [buildPullRequest()], statuses: { c1: [{ context: 'test', state: 'success' }] } })
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBeUndefined()
  Object.assign(git, { isDirty: true, changed: ['src/b.ts'], tree: 'tree2' })
  expect(await readCurrentStep($)).toBe('Verify')
  const status = await readFlowStatus($)
  expect(status).toContain('Small feature  4/7')
  expect(status).toContain('○ PR #5')
  expect(status).not.toContain('✓ PR #5')
  const reply = (await declareFlow($, 'small-feature', [1])).result
  expect(reply).toContain('○ PR #5 (')
  expect(reply).not.toContain('✓ PR #5')
})

test('a Small feature unit runs from Grill to a merged PR', async ($, on) => {
  const graph = linearGraph({ feat: 0 }, verifyFile, 1)
  const git: Checkout = { branch: 'feat', graph }
  const options: Options = { session: noFlow, verifyFile, issueLabels: { 1: ['needs-triage'] } }
  const { clock, views } = createWorld(on, git, options)
  expect((await declareFlow($, 'small-feature', [1])).result).toContain('current step: Grill')
  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  options.issueLabels = { 1: ['ready-for-agent'] }
  await clock.advance(61000)
  const specified = await readFlowStatus($)
  expect(specified).toContain('✓ Grill')
  expect(specified).toContain('✓ Spec')
  expect(specified).toContain('↷ Tickets · optional')
  expect(await readCurrentStep($)).toBe('Code')
  git.isDirty = true
  git.changed = ['src/a.ts']
  git.tree = 'tree'
  expect(await readCurrentStep($)).toBe('Verify')
  await completeDelivery($, { git, options, clock, views })
})
