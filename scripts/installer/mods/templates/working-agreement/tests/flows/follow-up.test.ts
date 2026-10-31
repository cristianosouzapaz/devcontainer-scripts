import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { buildParentGraph, buildParentPullRequest, buildWriteCall, noFlow, verifyFile } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, runFlowCommand } from '../support/helpers'
import { completeDelivery } from '../support/delivery'
import { buildRoundPullRequest, withCommit } from '../support/parallel-worktrees'
import { createWorld, linearGraph } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a user-declared Follow-up starts at Code and permits file writes', async ($, on) => {
  const git: Checkout = { branch: 'feat-1' }
  const options: Options = { session: noFlow, verifyFile, closingPrs: { 1: [{ number: 5, state: 'OPEN', headRefName: 'feat-1', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }] } }
  createWorld(on, git, options)
  await runFlowCommand($, 'follow-up #1')
  expect(await readCurrentStep($)).toBe('Code')

  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
})

test('a Follow-up unit runs from Code to a merged PR', async ($, on) => {
  const graph = linearGraph({ feat: 0 }, verifyFile, 1)
  const git: Checkout = { branch: 'feat', graph }
  const options: Options = { session: noFlow, verifyFile, closingPrs: { 1: [{ number: 5, state: 'OPEN', headRefName: 'feat', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }] } }
  const { clock, views } = createWorld(on, git, options)
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('current step: Code')
  git.isDirty = true
  git.changed = ['src/a.ts']
  git.tree = 'tree'
  expect(await readCurrentStep($)).toBe('Verify')
  await completeDelivery($, { git, options, clock, views })
})

/** The open PR of parent branch `par` that closes #1. */
const parentClosing = { number: 10, state: 'OPEN', headRefName: 'par', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }

/**
 * Checks out `b`, cut from `par` with `git switch -c b par`, in `/repo`, with `par` held by `/par`.
 * @param graph - The history.
 * @returns The checkout.
 */
const followUpChildCheckout = (graph = buildParentGraph()): Checkout => ({ branch: 'b', graph, worktrees: { '/repo': { branch: 'b' }, '/par': { branch: 'par' } } })

test("a Follow-up child is integrated by the user's merge and its issue is required by the parent's Close out", async ($, on) => {
  const checkout = followUpChildCheckout()
  const options: Options = { session: noFlow, closingPrs: { 1: [parentClosing] } }
  const world = createWorld(on, checkout, options)
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('base from par (branch reflog)')
  await runFlowCommand($, 'skip verify covered by the parent')
  expect(await readFlowStatus($)).toContain('▸ Integrate\n')
  checkout.graph = withCommit(checkout.graph!, 'mpb', ['p1', 'b1'], 'par')
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")

  world.chat.id = 'second'
  checkout.branch = 'par'
  checkout.worktrees = { '/repo': { branch: 'par' } }
  options.prs = [buildRoundPullRequest('mpb', [7])]
  await declareFlow($, 'close-out', [7])
  await runFlowCommand($, 'skip verify covered by the children')
  expect(await readFlowStatus($)).toContain('missing Closes #1')
})

test("a Follow-up child is concluded by its parent's merged PR", async ($, on) => {
  const checkout = followUpChildCheckout()
  const options: Options = { session: noFlow, closingPrs: { 1: [parentClosing] } }
  const world = createWorld(on, checkout, options)
  await runFlowCommand($, 'follow-up #1')
  await runFlowCommand($, 'skip verify covered by the parent')
  checkout.graph = withCommit(checkout.graph!, 'mpb', ['p1', 'b1'], 'par')
  options.prs = [buildParentPullRequest({ number: 10, headRefOid: 'mpb' })]
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Integrate · merged #10')
})
