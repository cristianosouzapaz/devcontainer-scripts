import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { buildParentGraph, buildParentPullRequest, noFlow, verifyFile } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, runFlowCommand } from '../support/helpers'
import { completeDelivery } from '../support/delivery'
import { buildChildEntry, buildRoundPullRequest, observedEndFile, parentCheckout, roundCloseOut, seedChildren, seedObservedEnd, withCommit, withoutBranch } from '../support/parallel-worktrees'
import { createWorld, linearGraph, root } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a Close out starts at Verify', async ($, on) => {
  const git: Checkout = { branch: 'feat', isDirty: true }
  const options: Options = { session: noFlow, verifyFile }
  createWorld(on, git, options)
  await declareFlow($, 'close-out', [1])
  expect(await readCurrentStep($)).toBe('Verify')

})

test('a Close out unit runs from Verify to a merged PR', async ($, on) => {
  const graph = linearGraph({ feat: 0 }, verifyFile, 1)
  const git: Checkout = { branch: 'feat', graph, isDirty: true }
  const options: Options = { session: noFlow, verifyFile }
  const { clock, views } = createWorld(on, git, options)
  expect((await declareFlow($, 'close-out', [1])).result).toContain('current step: Verify')
  await completeDelivery($, { git, options, clock, views })
})

test('a Close out on an integration branch requires a child merged later until its PR closes that issue too', async ($, on) => {
  const checkout = parentCheckout({ par: 'mpar', b: 'b2' })
  checkout.graph = withCommit(checkout.graph!, 'cc1', ['p2'], 'c')
  const options: Options = { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [1, 2, 3])] }
  const world = createWorld(on, checkout, options)
  await world.ready
  await seedChildren(world, [buildChildEntry('a', 2), buildChildEntry('b', 3), buildChildEntry('c', 4, { base: 'p2' })])
  expect(await readFlowStatus($)).toContain('✓ PR #10')
  checkout.graph = withCommit(checkout.graph, 'mc', ['mpar', 'cc1'], 'par')
  options.prs = [buildRoundPullRequest('mc', [1, 2, 3])]
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('▸ Update PR #10 · PR does not close #4')
  options.prs = [buildRoundPullRequest('mc', [1, 2, 3, 4])]
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #10')
})

test('a child deleted at an observed end its parent does not reach blocks the Close out until its issue is closed', async ($, on) => {
  const checkout = { ...parentCheckout(), graph: withoutBranch(buildParentGraph(), 'b') }
  const options: Options = { ...roundCloseOut, prs: [buildRoundPullRequest('p1', [1])] }
  const world = createWorld(on, checkout, options)
  await world.ready
  const child = buildChildEntry('b', 3)
  await seedChildren(world, [child])
  await seedObservedEnd(world, child.identity, 'dead', 'b1', child.generation!)
  expect(await readFlowStatus($)).toContain('▸ Update PR #10 · child #3: branch b deleted unmerged — restore it with git branch b b1')
  options.issues = { 3: 'CLOSED' }
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #10')
})

test('a Close out whose PR targets a non-default branch keeps its PR step, requires its children and closes through body keywords', async ($, on) => {
  const checkout = parentCheckout({ par: 'mpar', next: 'c0', 'origin/next': 'c0' })
  const pullRequest = (body: string): Record<string, unknown> =>
    buildParentPullRequest({ number: 10, state: 'OPEN', baseRefName: 'next', headRefOid: 'mpar', closingIssuesReferences: [], body })
  const options: Options = { session: noFlow, prs: [pullRequest('Closes #1\nCloses #3')] }
  const world = createWorld(on, checkout, options)
  await world.ready
  await seedChildren(world, [buildChildEntry('a', 2), buildChildEntry('b', 3)])
  await declareFlow($, 'close-out', [1])
  await runFlowCommand($, 'skip verify covered separately')
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Update PR #10 · PR does not close #2')
  expect(status).not.toContain('Integrate')
  options.prs = [pullRequest('Closes #1\nCloses #2\nCloses #3')]
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #10')
})

test('a Close out on a branch cut from a parent branch keeps its PR step', async ($, on) => {
  const checkout: Checkout = { branch: 'b', graph: buildParentGraph(), worktrees: { '/repo': { branch: 'b' } } }
  createWorld(on, checkout, { session: noFlow })
  await declareFlow($, 'close-out', [3])
  await runFlowCommand($, 'skip verify covered separately')
  const status = await readFlowStatus($)
  expect(status).toContain('▸ PR · no PR')
  expect(status).not.toContain('Integrate')
})

test("a child merged, observed once, then deleted is required by the Close out, concluded by its merged PR, then pruned with its observed ends", async ($, on) => {
  const checkout = parentCheckout({ par: 'mpar', b: 'b2' })
  const options: Options = { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [1])] }
  const world = createWorld(on, checkout, options)
  await world.ready
  const child = buildChildEntry('b', 3)
  const paths = await seedChildren(world, [child])
  expect(await readFlowStatus($)).toContain('▸ Update PR #10 · PR does not close #3')
  const end = await observedEndFile(child.identity, 'sid')
  expect(world.files.has(end)).toBe(true)
  checkout.graph = withoutBranch(checkout.graph!, 'b')
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('▸ Update PR #10 · PR does not close #3')
  options.prs = [buildParentPullRequest({ number: 10, headRefOid: 'mpar', closingIssuesReferences: [{ number: 1 }, { number: 3 }] })]
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  for (const path of [...paths, end]) expect(world.files.has(path)).toBe(false)
})

test('a child never observed before its branch was deleted blocks the Close out until its issue is closed, then retires with its records', async ($, on) => {
  const checkout = { ...parentCheckout(), graph: withoutBranch(parentCheckout({ par: 'mpar' }).graph!, 'b') }
  const options: Options = { ...roundCloseOut, prs: [buildRoundPullRequest('mpar', [1])] }
  const world = createWorld(on, checkout, options)
  await world.ready
  const paths = await seedChildren(world, [buildChildEntry('b', 3)])
  expect(await readFlowStatus($)).toContain('▸ Update PR #10 · child #3: end never observed (branch deleted)')
  options.issues = { 3: 'CLOSED' }
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #10')
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  for (const path of paths) expect(world.files.has(path)).toBe(false)
})
