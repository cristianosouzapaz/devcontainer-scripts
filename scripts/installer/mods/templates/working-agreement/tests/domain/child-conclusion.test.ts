import { expect } from 'claude-code/testing'

import type { UnitEntry } from '../../hooks/domain/records'
import { test } from '../support/kit'
import { buildParentGraph, buildParentPullRequest, buildPullRequest, noFlow } from '../support/builders'
import { declareFlow, readFlowStatus, readPromptContext } from '../support/helpers'
import { buildChildEntry, parChild, readObservedEndFile, seedChildren, seedObservedEnd, withCommit, withoutBranch } from '../support/parallel-worktrees'
import { createWorld, root } from '../support/world'
import type { Checkout } from '../support/world'


/**
 * Checks out child `a` after its `--no-ff` merge into `par` (`ma`), with `par` held by `/par`.
 * @param refs - Refs that replace the graph's defaults.
 * @returns The checkout.
 */
const integratedCheckout = (refs: Record<string, string> = {}): Checkout => {
  const graph = buildParentGraph()
  return { branch: 'a', graph: { ...graph, refs: { ...graph.refs, par: 'ma', ...refs } }, worktrees: { '/repo': { branch: 'a' }, '/par': { branch: 'par' } } }
}

for (const [method, commit] of [['merge', { parents: ['c0', 'ma'] }], ['squash', { parents: ['c0'] }], ['rebase', { parents: ['c0'] }]] as const) {
  test(`a parent PR merged by ${method} with the slice end in its head concludes the child`, async ($, on) => {
    const checkout = integratedCheckout()
    checkout.graph = withCommit(checkout.graph!, 'delivered', [...commit.parents], 'main')
    createWorld(on, checkout, { ...parChild(), prs: [buildParentPullRequest({ number: 9, headRefOid: 'ma' })] })
    const status = await readFlowStatus($)
    expect(status).toContain('✓ Integrate · merged #9')
    expect(status).toContain('Start new session: /clear')
  })
}

test("a merged child PR into its parent alone never concludes the child, even once fetched", async ($, on) => {
  createWorld(on, integratedCheckout({ par: 'p1', 'origin/par': 'ma' }), { ...parChild(), prs: [buildPullRequest({ number: 7, state: 'MERGED', headRefName: 'a', baseRefName: 'par', headRefOid: 'a2' })] })
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
})

test("a merged child PR into the default branch whose head contains the slice end concludes the child", async ($, on) => {
  createWorld(on, integratedCheckout(), { ...parChild(), prs: [buildPullRequest({ number: 7, state: 'MERGED', headRefName: 'a', baseRefName: 'main', headRefOid: 'a2' })] })
  expect(await readFlowStatus($)).toContain('✓ Integrate · merged #7')
})

test('a parent PR into another branch than the default never concludes the child', async ($, on) => {
  createWorld(on, integratedCheckout(), { ...parChild(), prs: [buildParentPullRequest({ number: 9, baseRefName: 'release', headRefOid: 'ma' })] })
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
})

test("an unreadable list of the parent's PRs never reads as done: Integrate is unreadable and the agent retries", async ($, on) => {
  createWorld(on, integratedCheckout(), { ...parChild(), prs: [buildParentPullRequest({ number: 9, headRefOid: 'ma' })], failing: 'gh api graphql -F owner={owner} -F name={repo} -f head=par ' })
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Integrate · integration unreadable')
  expect(status).not.toContain('Start new session')
  expect(await readPromptContext($)).toContain('Next action: retry; if it keeps failing, stop and tell the user.')
})

test("a failed comparison against the parent's PRs never reads as done", async ($, on) => {
  createWorld(on, integratedCheckout(), { ...parChild(), prs: [buildParentPullRequest({ number: 9, headRefOid: 'p2' })], failing: 'gh api repos/{owner}/{repo}/compare/a2...p2' })
  expect(await readFlowStatus($)).toContain('▸ Integrate · integration unreadable')
})

test('a re-declaration of a child concluded through its parent starts a new lifetime from GitHub alone', async ($, on) => {
  const { sessions } = createWorld(on, integratedCheckout(), { ...parChild(), unit: { ...parChild().unit, approval: 'old' }, issueLabels: { 1: ['ready-for-agent'] },
    prs: [buildParentPullRequest({ number: 9, headRefOid: 'ma' })] })
  const generation = sessions.get('sid')?.units[0]?.generation
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  const fresh = sessions.get('sid')?.units[0]
  expect(fresh?.generation).not.toBe(generation)
  expect(fresh?.approval).toBeUndefined()
  expect(fresh?.skips).toBeUndefined()
})

test('a sweep prunes a concluded child, reading the parent branch once for all its siblings', async ($, on) => {
  const world = createWorld(on, integratedCheckout({ par: 'mpar', b: 'b2' }), { session: noFlow, prs: [buildParentPullRequest({ number: 9, headRefOid: 'mpar' })] })
  await world.ready
  const paths = await seedChildren(world, [buildChildEntry('a', 2), buildChildEntry('b', 3)])
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  for (const path of paths) expect(world.files.has(path)).toBe(false)
  expect(world.runs.filter(run => run.includes(' head=par '))).toHaveLength(1)
})

test('a sweep never prunes a stranded child', async ($, on) => {
  const checkout = integratedCheckout()
  const world = createWorld(on, checkout, { session: noFlow, prs: [buildParentPullRequest({ number: 9, headRefOid: 'p2' })] })
  checkout.graph = withCommit(checkout.graph!, 'a3', ['a2'], 'a')
  checkout.graph = withCommit(checkout.graph, 'ma3', ['p2', 'a3'], 'par')
  await world.ready
  const paths = await seedChildren(world, [buildChildEntry('a', 2)])
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  for (const path of paths) expect(world.files.has(path)).toBe(true)
})

test('a sweep keeps a child whose branch was deleted before its end was observed', async ($, on) => {
  const { a: _a, ...refs } = integratedCheckout().graph!.refs
  const world = createWorld(on, { ...integratedCheckout(), graph: { ...buildParentGraph(), refs } }, { session: noFlow, prs: [buildParentPullRequest({ number: 9, headRefOid: 'ma' })] })
  await world.ready
  const paths = await seedChildren(world, [buildChildEntry('a', 2)])
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  for (const path of paths) expect(world.files.has(path)).toBe(true)
})

test('a sweep concludes a deleted child on the end another session observed, and removes its observed ends with it', async ($, on) => {
  const world = createWorld(on, { ...integratedCheckout(), graph: withoutBranch(buildParentGraph(), 'a') }, { session: noFlow, prs: [buildParentPullRequest({ number: 9, headRefOid: 'ma' })] })
  await world.ready
  const child = buildChildEntry('a', 2)
  const paths = await seedChildren(world, [child])
  const end = await seedObservedEnd(world, child.identity, 'dead', 'a2', child.generation!)
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  for (const path of [...paths, end]) expect(world.files.has(path)).toBe(false)
})

test("a sweep caches the end of a child it judges while the child's branch is readable", async ($, on) => {
  const world = createWorld(on, integratedCheckout(), { session: noFlow })
  await world.ready
  const child = buildChildEntry('a', 2)
  await seedChildren(world, [child])
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect(await readObservedEndFile(world, child.identity, 'sid')).toBe('a2')
})

test('the orphan sweep removes the observed ends of a unit whose declaration is gone, and leaves a write in flight', async ($, on) => {
  const world = createWorld(on, integratedCheckout(), { session: noFlow })
  await world.ready
  const kept = buildChildEntry('a', 2)
  await seedChildren(world, [kept])
  const live = await seedObservedEnd(world, kept.identity, 'dead', 'a2', kept.generation!)
  const orphan = { branch: 'gone', issues: [5] }
  const ends = [await seedObservedEnd(world, orphan, 'dead', 'a2', 'dead:gone:1'), await seedObservedEnd(world, orphan, 'other', 'a1', 'dead:gone:1')]
  const temporary = ends[0]!.replace(/dead\.json$/, '.tmp-live-1')
  world.files.set(temporary, '{}')
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  for (const path of ends) expect(world.files.has(path)).toBe(false)
  expect(world.files.has(temporary)).toBe(true)
  expect(world.files.has(live)).toBe(true)
})

test("a failed read of the parent's PRs prunes nothing, not even a concluded unit of another branch", async ($, on) => {
  const prs = [buildParentPullRequest({ number: 9, headRefOid: 'ma' }), buildPullRequest({ number: 6, state: 'MERGED', headRefName: 'other', headRefOid: 'p1' })]
  const world = createWorld(on, integratedCheckout(), { session: noFlow, prs, failing: 'gh api graphql -F owner={owner} -F name={repo} -f head=par ' })
  await world.ready
  const other: UnitEntry = { identity: { branch: 'other', issues: [4] }, base: 'c0', skills: [], verifyRuns: [], runs: [], generation: 'dead:other:1' }
  const paths = await seedChildren(world, [buildChildEntry('a', 2), other])
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  for (const path of paths) expect(world.files.has(path)).toBe(true)
})

test("with the child's own PRs unreadable, a merged parent PR that carries its slice end shows it delivered, never stranded", async ($, on) => {
  createWorld(on, integratedCheckout(), { ...parChild(), prs: [buildParentPullRequest({ number: 9, headRefOid: 'ma' })], failing: 'gh api graphql -F owner={owner} -F name={repo} -f head=a ' })
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Integrate · merged #9')
  expect(status).toContain('Start new session: /clear')
})
