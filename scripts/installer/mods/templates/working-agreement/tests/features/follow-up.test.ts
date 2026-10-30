import { expect } from 'claude-code/testing'

import type { UnitEntry } from '../../hooks/domain/records'
import { test } from '../support/kit'
import { buildParentGraph, buildParentPullRequest, noFlow } from '../support/builders'
import { declareFlow, readFlowStatus, readPromptContext, runFlowCommand } from '../support/helpers'
import { buildChildEntry, buildRoundPullRequest, parentCheckout, roundCloseOut, seedChildren, withCommit } from '../support/parallel-worktrees'
import { createWorld, records } from '../support/world'
import type { Checkout, Options } from '../support/world'

const closing = { number: 5, state: 'OPEN', headRefName: 'feature', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }

for (const state of ['OPEN', 'CLOSED']) {
  test(`Follow-up accepts a ${state.toLowerCase()} issue with an open closing PR on the checkout branch`, async ($, on) => {
    const { sessions } = createWorld(on, { branch: 'feature', ahead: 2 }, { session: noFlow, issues: { 1: state }, closingPrs: { 1: [closing] } })
    const reply = (await runFlowCommand($, 'follow-up #1')).text
    expect(reply).toContain('Flow declared: Follow-up')
    expect(reply).toContain('2 commits already on this branch are not counted for this unit')
    expect(sessions.get('sid')?.units[0]?.base).toBe('c2')
    expect(await readFlowStatus($)).not.toContain('Refs')
  })
}

for (const prs of [[], [{ ...closing, state: 'CLOSED' }], [{ ...closing, isCrossRepository: true }], [{ ...closing, baseRepository: { nameWithOwner: 'another/repo' } }]]) {
  test(`Follow-up without an eligible closing PR is refused: ${JSON.stringify(prs)}`, async ($, on) => {
    createWorld(on, { branch: 'feature' }, { session: noFlow, closingPrs: { 1: prs } })
    expect((await runFlowCommand($, 'follow-up #1')).text).toContain('declare its own flow')
  })
}

test('an open closing PR requires checkout of one of its head branches even if another PR merged', async ($, on) => {
  createWorld(on, { branch: 'elsewhere' }, { session: noFlow, closingPrs: { 1: [closing, { ...closing, state: 'MERGED', headRefName: 'elsewhere' }] } })
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('check out its head branch (feature)')
})

test('after merge a Follow-up may use a different branch and takes the declaration tip as base', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'new-branch', ahead: 3 }, { session: noFlow, issues: { 1: 'CLOSED' }, closingPrs: { 1: [{ ...closing, state: 'MERGED' }] } })
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('Flow declared')
  expect(sessions.get('sid')?.units[0]?.base).toBe('c3')
})

const intoNext = { ...closing, number: 158, baseRefName: 'next', body: 'Dashboard layout.\n\nCloses #149\nCloses #1' }

for (const state of ['OPEN', 'MERGED']) {
  test(`Follow-up accepts a ${state.toLowerCase()} PR into a non-default base whose body closes the issue, without a GitHub link`, async ($, on) => {
    createWorld(on, { branch: 'feature', ahead: 2 }, { session: noFlow, closingPrs: { 1: [] }, crossReferences: { 1: [{ ...intoNext, state }] } })
    expect((await runFlowCommand($, 'follow-up #1')).text).toContain('Flow declared: Follow-up')
  })
}

test('an open PR into a non-default base that closes the issue requires its head branch', async ($, on) => {
  createWorld(on, { branch: 'elsewhere' }, { session: noFlow, closingPrs: { 1: [] }, crossReferences: { 1: [intoNext] } })
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('check out its head branch (feature)')
})

for (const source of [{ ...intoNext, body: 'Mentions #1 only' }, { ...intoNext, baseRefName: 'main' }, { ...intoNext, state: 'CLOSED' },
  { ...intoNext, isCrossRepository: true }, { ...intoNext, baseRepository: { nameWithOwner: 'another/repo' } }]) {
  test(`a cross-referencing PR outside the closing rules is no closing PR: ${JSON.stringify(source)}`, async ($, on) => {
    createWorld(on, { branch: 'feature' }, { session: noFlow, closingPrs: { 1: [] }, crossReferences: { 1: [source] } })
    expect((await runFlowCommand($, 'follow-up #1')).text).toContain('declare its own flow')
  })
}

for (const extra of [{ isLoggedOut: true }, { failing: 'gh api graphql' }, { closingHasNextPage: true }, { timelineHasNextPage: true }]) {
  test(`an unreadable or partial Follow-up lookup is refused: ${JSON.stringify(extra)}`, async ($, on) => {
    createWorld(on, { branch: 'feature' }, { session: noFlow, closingPrs: { 1: [closing] }, ...extra })
    expect((await runFlowCommand($, 'follow-up #1')).text).toContain('GitHub unreachable — retry')
  })
}

test('a missing issue is still refused for Follow-up', async ($, on) => {
  createWorld(on, { branch: 'feature' }, { session: noFlow, missing: [1] })
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('check the number')
})

/**
 * Builds a same-repository closing PR from a branch.
 * @param headRefName - The PR's head branch.
 * @param state - The PR's state.
 * @returns A closing PR sample.
 */
const closingFrom = (headRefName: string, state = 'OPEN'): Record<string, unknown> => ({ ...closing, number: 363, state, headRefName })

/**
 * Checks out branch `b`, cut from parent branch `par` with `git switch -c b par`, with `par` held by `/par`.
 * @param created - The start point the reflog of `b` records.
 * @returns The checkout.
 */
const childCheckout = (created = 'par'): Checkout => {
  const graph = buildParentGraph()
  return { branch: 'b', graph: { ...graph, created: { b: created } }, worktrees: { '/repo': { branch: 'b' }, '/par': { branch: 'par' } } }
}

/** The units a PR head carrying two units leaves on its branch `par`: a first unit, then one declared at its tip. */
const exampleUnits = (): UnitEntry[] => [buildChildEntry('par', 362, { base: 'c0', baseBranch: 'main' }), buildChildEntry('par', 364, { base: 'p1', baseBranch: undefined })]

/**
 * Words the refusal's advice to cut a child branch from `par`, in the worktree that holds it.
 * @param root - The worktree that holds `par`.
 * @returns The advice.
 */
const cutFromPar = (root: string): string => `Cut a child branch from par's tip (git -C ${root} worktree add -b <child-branch> <path> par) and declare the Follow-up there.`

for (const issue of [362, 364]) {
  test(`Follow-up #${issue} on a PR head carrying several units is refused with its reasons and the command that cuts a child branch`, async ($, on) => {
    const world = createWorld(on, parentCheckout(), { session: noFlow, closingPrs: { 362: [closingFrom('par')], 364: [] } })
    await world.ready
    const paths = await seedChildren(world, exampleUnits())
    const records = paths.map(path => world.files.get(path))
    const reply = (await runFlowCommand($, `follow-up #${issue}`)).text ?? ''
    expect(reply).toContain('Follow-up is refused on par: ')
    expect(reply).toContain('other units on par')
    expect(reply.includes('the unit of #362 on par is frozen')).toBe(issue === 362)
    expect(reply).toContain(cutFromPar('/repo'))
    expect(paths.map(path => world.files.get(path))).toEqual(records)
    expect(world.sessions.get('sid')?.units).toEqual([])
  })
}

test('inside herdr the refused Follow-up names the spawn tool and the parent the child is cut from', async ($, on) => {
  const world = createWorld(on, parentCheckout(), { session: noFlow, closingPrs: { 362: [closingFrom('par')] }, herdrEnv: { HERDR_ENV: '1' } })
  await world.ready
  await seedChildren(world, exampleUnits())
  const reply = (await runFlowCommand($, 'follow-up #362')).text ?? ''
  expect(reply).toContain('spawn tool')
  expect(reply).toContain('cut from par')
})

test('on a child branch of the PR head, #362 enters through the closing PR of its base branch as a Follow-up child', async ($, on) => {
  const { sessions } = createWorld(on, childCheckout(), { session: noFlow, closingPrs: { 362: [closingFrom('par')] } })
  expect((await runFlowCommand($, 'follow-up #362')).text).toContain('Flow declared: Follow-up for #362, base from par (branch reflog).')
  expect(sessions.get('sid')?.units[0]).toMatchObject({ base: 'p1', baseBranch: 'par' })
  expect(await readFlowStatus($)).toContain('Integrate')
})

test('on a child branch of the PR head, #364 enters through the child route as a Follow-up child', async ($, on) => {
  const world = createWorld(on, childCheckout(), { session: noFlow, closingPrs: { 364: [] } })
  await world.ready
  await seedChildren(world, exampleUnits())
  expect((await runFlowCommand($, 'follow-up #364')).text).toContain('Flow declared: Follow-up for #364, base from par (branch reflog).')
  expect(world.sessions.get('sid')?.units[0]).toMatchObject({ base: 'p1', baseBranch: 'par' })
})

test("a stranded child's issue opens the child route", async ($, on) => {
  const checkout = childCheckout()
  checkout.graph = { ...checkout.graph!, refs: { ...checkout.graph!.refs, par: 'ma' } }
  const world = createWorld(on, checkout, { session: noFlow, closingPrs: { 2: [] }, prs: [buildParentPullRequest({ number: 9, headRefOid: 'b1' })] })
  await world.ready
  await seedChildren(world, [buildChildEntry('a', 2)])
  expect((await runFlowCommand($, 'follow-up #2')).text).toContain('Flow declared: Follow-up for #2, base from par (branch reflog).')
})

test("a child not yet merged into the parent keeps its issue: Follow-up is refused and sent back to that child's unit", async ($, on) => {
  const world = createWorld(on, childCheckout(), { session: noFlow, closingPrs: { 2: [] } })
  await world.ready
  await seedChildren(world, [buildChildEntry('a', 2)])
  expect((await runFlowCommand($, 'follow-up #2')).text).toContain('Issue #2 belongs to unit a, not yet merged into par — continue that unit on its own branch.')
})

test("once the parent's PR has merged with the child, the child route closes and only today's merged-PR rule applies", async ($, on) => {
  const checkout = childCheckout()
  checkout.graph = { ...checkout.graph!, refs: { ...checkout.graph!.refs, par: 'ma' } }
  const options: Options = { session: noFlow, closingPrs: { 2: [] }, prs: [buildParentPullRequest({ number: 9, headRefOid: 'ma' })] }
  const world = createWorld(on, checkout, options)
  await world.ready
  await seedChildren(world, [buildChildEntry('a', 2)])
  expect((await runFlowCommand($, 'follow-up #2')).text).toContain('Issue #2 has no open or merged closing PR — declare its own flow.')
  options.closingPrs = { 2: [{ ...closing, number: 9, state: 'MERGED', headRefName: 'par' }] }
  expect((await runFlowCommand($, 'follow-up #2')).text).toContain('Flow declared: Follow-up for #2, base at the declaration tip.')
  expect(world.sessions.get('sid')?.units[0]?.baseBranch).toBeUndefined()
})

test("a unit on the parent branch concluded by the parent's merged PR no longer opens the child route", async ($, on) => {
  const checkout = childCheckout()
  checkout.graph = { ...checkout.graph!, refs: { ...checkout.graph!.refs, par: 'ma' } }
  // why: An unreadable PR list of another branch keeps every record in the sweep, so only the entry judgement sees the conclusion.
  const options: Options = { session: noFlow, closingPrs: { 364: [] }, failing: 'gh api graphql -F owner={owner} -F name={repo} -f head=other ' }
  const world = createWorld(on, checkout, options)
  await world.ready
  await seedChildren(world, [buildChildEntry('par', 364, { base: 'p1', baseBranch: undefined }), buildChildEntry('other', 5, { base: 'c0', baseBranch: undefined })])
  options.prs = [buildParentPullRequest({ number: 9, headRefOid: 'ma' })]
  expect((await runFlowCommand($, 'follow-up #364')).text).toContain('Issue #364 has no open or merged closing PR')
})

test("a Follow-up on the Close out's own issue on an integration branch is refused and the Close out keeps its flow", async ($, on) => {
  const options: Options = { ...roundCloseOut, closingPrs: { 1: [closingFrom('par')] }, prs: [buildRoundPullRequest('ma', [1])] }
  const world = createWorld(on, parentCheckout({ par: 'ma' }), options)
  await world.ready
  await seedChildren(world, [buildChildEntry('a', 2)])
  const reply = (await runFlowCommand($, 'follow-up #1')).text
  expect(reply).toContain('par is an integration branch')
  expect(reply).toContain(cutFromPar('/repo'))
  const status = await readFlowStatus($)
  expect(status).toContain('Close out')
  expect(status).toContain('missing Closes #2')
})

test("an issue of a child unit of the branch is refused on the branch, with the command that cuts a child branch", async ($, on) => {
  const world = createWorld(on, parentCheckout(), { session: noFlow, closingPrs: { 2: [closingFrom('par')] } })
  await world.ready
  await seedChildren(world, [buildChildEntry('a', 2)])
  expect((await runFlowCommand($, 'follow-up #2')).text).toContain('Follow-up is refused on par: #2 belongs to child unit a.')
})

test('a single-unit PR head keeps continuing its unit', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'feature', ahead: 2 }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] }, closingPrs: { 1: [closing] } })
  await declareFlow($, 'small-feature', [1])
  const generation = sessions.get('sid')?.units[0]?.generation
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('Flow declared: Follow-up for #1')
  expect(sessions.get('sid')?.units).toHaveLength(1)
  expect(sessions.get('sid')?.units[0]?.generation).toBe(generation)
})

for (const created of ['HEAD', 'p1']) {
  test(`a branch cut from ${created} falls back to the default branch, so neither route through the parent accepts it`, async ($, on) => {
    const world = createWorld(on, childCheckout(created), { session: noFlow, closingPrs: { 362: [closingFrom('par')], 364: [] } })
    await world.ready
    await seedChildren(world, exampleUnits())
    expect((await runFlowCommand($, 'follow-up #362')).text).toContain('Issue #362 has an open PR — check out its head branch (par)')
    expect((await runFlowCommand($, 'follow-up #364')).text).toContain('Issue #364 has no open or merged closing PR')
  })
}

test("a Follow-up on a Close out's own issue is refused even with no child, and the Close out keeps its flow and requirement", async ($, on) => {
  createWorld(on, parentCheckout(), { session: noFlow, closingPrs: { 1: [closingFrom('par')] } })
  await declareFlow($, 'close-out', [1])
  const reply = (await runFlowCommand($, 'follow-up #1')).text
  expect(reply).toContain('Follow-up is refused on par: the unit of #1 on par is its Close out.')
  expect(reply).toContain(cutFromPar('/repo'))
  expect(await readPromptContext($)).toContain('Close out #1')
})

test("a second Follow-up on a Follow-up child's branch is refused and sent to a new child of the same parent", async ($, on) => {
  const checkout = childCheckout()
  const world = createWorld(on, checkout, { session: noFlow, closingPrs: { 362: [closingFrom('par')], 364: [] } })
  await world.ready
  await seedChildren(world, exampleUnits())
  expect((await runFlowCommand($, 'follow-up #364')).text).toContain('base from par (branch reflog)')
  checkout.graph = withCommit(checkout.graph!, 'b2x', ['b1'], 'b')
  const reply = (await runFlowCommand($, 'follow-up #362')).text
  expect(reply).toContain('Follow-up is refused on b: other units on b.')
  expect(reply).toContain(cutFromPar('/par'))
})

test('an unreadable session mirror refuses the Follow-up instead of dropping the units it holds', async ($, on) => {
  const world = createWorld(on, { branch: 'feature', ahead: 2 }, { session: noFlow, closingPrs: { 1: [closing] } })
  await world.ready
  world.files.set(`${records}/s/broken.json`, '{')
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('Cannot read the units of feature: unreadable session mirror broken.json — retry.')
})

test('a concluded unit the sweep kept never counts as another unit on the branch', async ($, on) => {
  // why: An unreadable PR list of another branch keeps every record in the sweep, so only the entry judgement sees the conclusion.
  const options: Options = { session: noFlow, closingPrs: { 362: [closingFrom('par', 'MERGED')] }, prs: [buildParentPullRequest({ number: 363, headRefOid: 'ma' })],
    failing: 'gh api graphql -F owner={owner} -F name={repo} -f head=other ' }
  const world = createWorld(on, parentCheckout({ par: 'ma' }), options)
  await world.ready
  await seedChildren(world, [buildChildEntry('par', 364, { base: 'p1', baseBranch: undefined }), buildChildEntry('other', 5, { base: 'c0', baseBranch: undefined })])
  expect((await runFlowCommand($, 'follow-up #362')).text).toContain('Flow declared: Follow-up for #362')
})

test('a parent branch name that holds shell characters is quoted in the cut command', async ($, on) => {
  const graph = buildParentGraph()
  const { par: _par, ...refs } = graph.refs
  const world = createWorld(on, { branch: 'p$(x)', graph: { ...graph, refs: { ...refs, 'p$(x)': 'p1' } }, worktrees: { '/repo': { branch: 'p$(x)' } } },
    { session: noFlow, closingPrs: { 2: [closingFrom('p$(x)')] } })
  await world.ready
  await seedChildren(world, [buildChildEntry('p$(x)', 2, { base: 'c0', baseBranch: 'main' }), buildChildEntry('p$(x)', 3, { base: 'p1', baseBranch: undefined })])
  expect((await runFlowCommand($, 'follow-up #2')).text).toContain("(git -C /repo worktree add -b <child-branch> <path> 'p$(x)')")
})

test("an unreadable slice of the declared unit refuses the Follow-up instead of reading the unit as live", async ($, on) => {
  const options: Options = { session: noFlow, issueLabels: { 1: ['ready-for-agent'] }, closingPrs: { 1: [closing] } }
  createWorld(on, { branch: 'feature', ahead: 2 }, options)
  await declareFlow($, 'small-feature', [1])
  options.failing = 'git worktree list --porcelain'
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('Cannot read the units of feature: unit slice unreadable — retry.')
})
