import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

import { test } from '../../support/kit'
import { locatePosition } from '../../../hooks/core/position'
import { readSession } from '../../../hooks/core/record-store'
import { composeInstruction } from '../../../hooks/domain/instruction'
import { buildParentGraph, buildParentPullRequest, buildPullRequest } from '../../support/builders'
import { readFlowStatus, readPromptContext, runFlowCommand } from '../../support/helpers'
import { readObservedEndFile, seedGeneration, seedObservedEnd, withCommit, withoutBranch } from '../../support/parallel-worktrees'
import { createTestPort, createWorld } from '../../support/world'
import type { Checkout, Options, World } from '../../support/world'

/** Child `a`, cut from `par`, past Commit: its base and base branch as the declaration caches them, with Code and Verify skipped. */
const child: Options = { unit: { base: 'p1', baseBranch: 'par', skips: [{ step: 'code', reason: 'covered' }, { step: 'verify', reason: 'covered' }] } }

/**
 * Checks out child `a` in the session's worktree, with `par` held by `/par` unless the parent is checked out nowhere.
 * @param refs - Refs that replace the graph's defaults.
 * @param isParentHeld - Whether a worktree holds `par`.
 * @returns The checkout.
 */
const childCheckout = (refs: Record<string, string> = {}, isParentHeld = true): Checkout => {
  const graph = buildParentGraph()
  return { branch: 'a', graph: { ...graph, refs: { ...graph.refs, ...refs } },
    worktrees: { '/repo': { branch: 'a' }, ...(isParentHeld ? { '/par': { branch: 'par' } } : {}) } }
}

/**
 * Writes the agent's flow line for the session's unit, which a finished unit's prompts no longer carry.
 * @param world - The test world.
 * @returns The instruction.
 */
async function readInstruction(world: World): Promise<string> {
  const port = createTestPort(world)
  const session = await readSession(port)
  const position = await locatePosition(port, session, true)
  return position ? composeInstruction(position, session) : ''
}

test('a child after Commit has Integrate current in place of PR, with the merge in the worktree that holds the parent', async ($, on) => {
  createWorld(on, childCheckout(), child)
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Integrate · not merged into par')
  expect(status).toContain('Merge')
  expect(status).toContain('git -C /par merge --no-ff a')
  expect(status).not.toMatch(/ PR\b/)
  const context = await readPromptContext($)
  expect(context).toContain('current step: Integrate. not merged into par. Next action: the user\'s step: stop and ask them to run git -C /par merge --no-ff a to merge this unit into par (never merge yourself).')
})

test('a parent checked out in no worktree gets a merge naming both branches, never a path', async ($, on) => {
  createWorld(on, childCheckout({}, false), child)
  expect(await readFlowStatus($)).toContain('git switch par && git merge --no-ff a')
  expect(await readPromptContext($)).toContain('run git switch par && git merge --no-ff a to merge this unit into par')
})

test('a worktree path with a space is quoted in the merge command', async ($, on) => {
  createWorld(on, { ...childCheckout(), worktrees: { '/repo': { branch: 'a' }, '/my par': { branch: 'par' } } }, child)
  expect(await readPromptContext($)).toContain("run git -C '/my par' merge --no-ff a")
})

test('after a --no-ff merge into the parent the child is integrated: every step done and the unit finished', async ($, on) => {
  const world = createWorld(on, childCheckout({ par: 'ma' }), child)
  const status = await readFlowStatus($)
  expect(status).toContain("✓ Integrate · awaiting par's PR")
  expect(status).not.toContain('▸')
  expect(status).not.toContain('Merge')
  expect(status).toContain('Start new session: /clear')
  expect(await readPromptContext($)).not.toContain('current step')
  expect(await readInstruction(world)).toBe('Small feature #1 — integrated into par; delivered by the Close out on par.')
})

test('known limit: a fast-forward of the parent onto the child empties the slice, so Commit and Integrate stay current', async ($, on) => {
  createWorld(on, childCheckout({ par: 'a2' }), child)
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Commit · no commit in the slice')
  expect(status).not.toContain('✓ Integrate')
})

test("an open parent PR into the default branch that contains the slice end names Integrate's delivery", async ($, on) => {
  createWorld(on, childCheckout({ par: 'ma' }), { ...child, prs: [buildPullRequest({ number: 9, headRefName: 'par', baseRefName: 'main', headRefOid: 'ma' })] })
  expect(await readFlowStatus($)).toContain('✓ Integrate · in PR #9')
})

test('a parent PR whose head does not contain the slice end leaves Integrate awaiting the parent\'s PR', async ($, on) => {
  createWorld(on, childCheckout({ par: 'ma' }), { ...child, prs: [buildPullRequest({ number: 9, headRefName: 'par', baseRefName: 'main', headRefOid: 'p1' })] })
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
})

test('a merged child PR into the parent counts only once the user has fetched origin/par', async ($, on) => {
  const checkout = childCheckout({ 'origin/par': 'p1' })
  createWorld(on, checkout, { ...child, prs: [buildPullRequest({ number: 7, state: 'MERGED', headRefName: 'a', baseRefName: 'par', headRefOid: 'a2' })] })
  expect(await readFlowStatus($)).toContain('▸ Integrate · not merged into par')
  checkout.graph = { ...checkout.graph!, refs: { ...checkout.graph!.refs, 'origin/par': 'ma' } }
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
})

test('an open child PR into the parent only enriches the fact; the verdict stays ancestry', async ($, on) => {
  createWorld(on, childCheckout(), { ...child, prs: [buildPullRequest({ number: 7, headRefName: 'a', baseRefName: 'par', headRefOid: 'a2' })] })
  expect(await readFlowStatus($)).toContain('▸ Integrate · PR #7 into par open — merge it')
  expect(await readPromptContext($)).toContain('stop and ask them to merge PR #7 and fetch, or run git -C /par merge --no-ff a')
})

test('a new commit on the child after integration makes Integrate current again', async ($, on) => {
  const checkout = childCheckout({ par: 'ma' })
  createWorld(on, checkout, child)
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
  checkout.graph = withCommit(checkout.graph!, 'a3', ['a2'], 'a')
  expect(await readFlowStatus($)).toContain('▸ Integrate · not merged into par')
})

test('Integrate depends on Commit as PR does: uncommitted changes on an integrated child make Commit current', async ($, on) => {
  createWorld(on, { ...childCheckout({ par: 'ma' }), worktrees: { '/repo': { branch: 'a', isDirty: true }, '/par': { branch: 'par' } } }, child)
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Commit · uncommitted changes')
  expect(status).toContain('○ Integrate\n')
  expect(await readPromptContext($)).toContain('current step: Commit')
})

test('an empty slice is never integrated, although the parent tip reaches its end', async ($, on) => {
  const skips = [...child.unit!.skips as unknown[], { step: 'commit', reason: 'nothing to commit' }]
  createWorld(on, childCheckout({ a: 'p1' }), { unit: { ...child.unit, skips } })
  expect(await readFlowStatus($)).toContain('▸ Integrate · not merged into par')
})

test('a unit whose base branch is the default branch keeps its PR step', async ($, on) => {
  createWorld(on, childCheckout(), { unit: { ...child.unit, base: 'p1', baseBranch: 'main' } })
  const status = await readFlowStatus($)
  expect(status).toContain('▸ PR · no PR')
  expect(status).not.toContain('Integrate')
})

for (const [name, unit, kept] of [
  ['a skip on pr once the unit is a child', { baseBranch: 'par' }, '▸ Integrate'],
  ['a skip on integrate once the unit is no child', { baseBranch: 'main' }, '▸ PR'],
] as const) {
  test(`${name} is ignored without a parse error`, async ($, on) => {
    const skips = [...child.unit!.skips as unknown[], { step: unit.baseBranch === 'par' ? 'pr' : 'integrate', reason: 'old flow' }]
    createWorld(on, childCheckout(), { unit: { ...child.unit, ...unit, skips } })
    const status = await readFlowStatus($)
    expect(status).toContain(kept)
    expect(status).not.toContain('old flow')
  })
}

test('the user skips Integrate by its id, and PR is no step of a child', async ($, on) => {
  createWorld(on, childCheckout(), child)
  expect((await runFlowCommand($, 'skip pr not needed')).text).toBe('Unknown step — use a step id or label from this flow.')
  expect((await runFlowCommand($, 'skip integrate merged by hand')).text).toBe('Skipped Integrate: merged by hand')
  expect(await readFlowStatus($)).toContain('↷ Integrate · merged by hand')
})

/**
 * Leaves the session in child `a`'s worktree after the user deleted the branch, as a merged PR's cleanup does.
 * @returns The checkout, whose graph holds no `a` ref.
 */
const deletedCheckout = (): Checkout => {
  const checkout = childCheckout({ par: 'ma' })
  return { ...checkout, graph: withoutBranch(checkout.graph!, 'a'), worktrees: { '/repo': { branch: 'a', head: 'a2' }, '/par': { branch: 'par' } } }
}

/** The lifetime child `a`'s observations are written in. */
const generation = 'sid:1:1'

/**
 * Creates child `a`'s world with a declared lifetime, so its judgements cache their observed slice end.
 * @param on - The engine hooks.
 * @param checkout - The checkout.
 * @param options - Options that replace the child's.
 * @returns The world, ready.
 */
async function createChildWorld(on: On, checkout: Checkout, options: Options = {}): Promise<World> {
  const world = createWorld(on, checkout, { ...child, ...options, unit: { ...child.unit, generation, ...options.unit } })
  await seedGeneration(world, identity, generation)
  return world
}

/** Child `a`'s identity. */
const identity = { branch: 'a', issues: [1] }

test('a child deleted before its end was observed is a definite fact: Integrate is current and the agent is told to stop', async ($, on) => {
  const world = await createChildWorld(on, deletedCheckout())
  const status = await readFlowStatus($)
  expect(status).toContain('Branch    a · deleted')
  expect(status).toContain('▸ Integrate · branch deleted before its end was observed')
  // why: Nothing proves the work before Integrate, so it is set aside, never shown done.
  expect(status).toContain('↷ Commit · branch deleted')
  expect(status).not.toContain('slice unavailable')
  expect(await readInstruction(world)).toBe('Small feature #1 — branch deleted before its end was observed; stop and tell the user.')
  expect(await readPromptContext($)).not.toContain('Next action')
})

test('a child observed before its branch was deleted stays judged on its observed end, with every step before Integrate behind it', async ($, on) => {
  const checkout = { ...childCheckout({ par: 'ma' }), worktrees: { '/repo': { branch: 'a', head: 'a2' }, '/par': { branch: 'par' } } }
  const world = await createChildWorld(on, checkout)
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
  expect(await readObservedEndFile(world, identity, 'sid')).toBe('a2')
  checkout.graph = withoutBranch(checkout.graph!, 'a')
  const status = await readFlowStatus($)
  expect(status).toContain("✓ Integrate · awaiting par's PR")
  expect(status).toContain('✓ Commit\n')
  expect(status).not.toContain('▸')
  expect(await readInstruction(world)).toBe('Small feature #1 — integrated into par; delivered by the Close out on par.')
})

test('a child observed before its branch was deleted unmerged is told to restore the branch, never to merge a branch that is gone', async ($, on) => {
  const checkout = { ...childCheckout(), worktrees: { '/repo': { branch: 'a', head: 'a2' }, '/par': { branch: 'par' } } }
  const world = await createChildWorld(on, checkout)
  expect(await readFlowStatus($)).toContain('▸ Integrate · not merged into par')
  checkout.graph = withoutBranch(checkout.graph!, 'a')
  await world.clock.settle()
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Integrate · branch a deleted unmerged at a2 — restore it with git branch a a2')
  expect(status).not.toContain('Merge ')
  expect(await readPromptContext($)).toContain("Next action: the user's step: stop and ask them to run git branch a a2 to restore the branch, then merge this unit into par (never do either yourself).")
})

test("observations from an earlier lifetime of the unit are never its observed end", async ($, on) => {
  const world = await createChildWorld(on, deletedCheckout())
  await seedObservedEnd(world, identity, 'other', 'a2', 'other:1:1')
  expect(await readFlowStatus($)).toContain('▸ Integrate · branch deleted before its end was observed')
})

test('an unreadable observed end file counts as absent', async ($, on) => {
  const world = await createChildWorld(on, deletedCheckout())
  const path = await seedObservedEnd(world, identity, 'other', 'a2', generation)
  world.files.set(path, JSON.stringify({ v: 1, identity, generation, end: 'a2', at: 1 }))
  expect(await readFlowStatus($)).toContain('▸ Integrate · branch deleted before its end was observed')
})

test('of the ends observed by several sessions, the one every other precedes is used', async ($, on) => {
  const world = await createChildWorld(on, deletedCheckout())
  await seedObservedEnd(world, identity, 'x', 'a1', generation)
  await seedObservedEnd(world, identity, 'y', 'a2', generation)
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
})

test("divergent ends are ambiguous unless the parent's tip reaches one, and never resolved by time", async ($, on) => {
  const checkout = deletedCheckout()
  checkout.graph = withCommit(withCommit(checkout.graph!, 'ax', ['a2']), 'ay', ['a2'])
  const world = await createChildWorld(on, checkout)
  await seedObservedEnd(world, identity, 'x', 'ax', generation)
  await world.clock.advance(1000)
  await seedObservedEnd(world, identity, 'y', 'ay', generation)
  expect(await readFlowStatus($)).toContain('▸ Integrate · end ambiguous')
  expect(await readInstruction(world)).toBe('Small feature #1 — end ambiguous; stop and tell the user.')
  checkout.graph = withCommit(checkout.graph, 'max', ['ma', 'ax'], 'par')
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
  checkout.graph = withCommit(checkout.graph, 'may', ['max', 'ay'], 'par')
  expect(await readFlowStatus($)).toContain('▸ Integrate · end ambiguous')
})

test("the parent's fetched origin copy decides divergent ends as its local tip does", async ($, on) => {
  const checkout = deletedCheckout()
  checkout.graph = withCommit(withCommit(withCommit(checkout.graph!, 'ax', ['a2']), 'ay', ['a2']), 'max', ['ma', 'ax'])
  checkout.graph = { ...checkout.graph, refs: { ...checkout.graph.refs, 'origin/par': 'max' } }
  const world = await createChildWorld(on, checkout)
  await seedObservedEnd(world, identity, 'x', 'ax', generation)
  await seedObservedEnd(world, identity, 'y', 'ay', generation)
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
})

test('an unreadable branch listing is no deleted branch: Integrate is unreadable and the agent retries', async ($, on) => {
  const skips = [...child.unit!.skips as unknown[], { step: 'commit', reason: 'covered' }]
  createWorld(on, deletedCheckout(), { unit: { ...child.unit, skips }, failing: 'git for-each-ref' })
  expect(await readFlowStatus($)).toContain('▸ Integrate · integration unreadable')
  const context = await readPromptContext($)
  expect(context).toContain('Next action: retry; if it keeps failing, stop and tell the user.')
  expect(context).not.toContain('deleted')
})

/**
 * Checks out child `a` after `par` advanced to `pp` without it, then merged it with `--no-ff` (`mpp`): a parent PR whose
 * head is `pp` was cut after the child and lacks its slice end.
 * @param refs - Refs that replace the defaults, which put `par` at `mpp`.
 * @returns The checkout.
 */
const strandedCheckout = (refs: Record<string, string> = {}): Checkout => {
  const checkout = childCheckout({ par: 'mpp', ...refs })
  const commits = { ...checkout.graph!.commits, pp: { parents: ['p1'], files: { 'src/par.ts': 'pp' } },
    mpp: { parents: ['pp', 'a2'], files: { 'src/par.ts': 'pp', 'src/a.ts': 'a2' } } }
  return { ...checkout, graph: { ...checkout.graph!, commits } }
}

/** The parent's PR #9 into the default branch, merged at `pp`, without child `a`'s commits. */
const strandingPullRequest = buildParentPullRequest({ number: 9, headRefOid: 'pp' })

test("a parent PR merged without the child's commits strands it: Integrate is current, sending the user to a Close out on the parent", async ($, on) => {
  createWorld(on, strandedCheckout(), { ...child, prs: [strandingPullRequest] })
  expect(await readFlowStatus($)).toContain("✗ Integrate · parent PR #9 merged without this unit's commits — deliver it with another PR")
  const instruction = await readPromptContext($)
  expect(instruction).toContain('current step: Integrate.')
  expect(instruction).toContain('Next action: the user\'s step: stop and ask them to run a Close out on par that opens a new PR containing this unit (nothing to do in this worktree).')
  expect(instruction).not.toContain('merge --no-ff')
})

test('a new open parent PR containing the slice end makes a stranded Integrate done, and its merge concludes the child', async ($, on) => {
  const options: Options = { ...child, prs: [strandingPullRequest, buildPullRequest({ number: 10, headRefName: 'par', baseRefName: 'main', headRefOid: 'mpp' })] }
  const world = createWorld(on, strandedCheckout(), options)
  expect(await readFlowStatus($)).toContain('✓ Integrate · in PR #10')
  options.prs = [strandingPullRequest, buildPullRequest({ number: 10, state: 'MERGED', headRefName: 'par', baseRefName: 'main', headRefOid: 'mpp' })]
  await world.clock.advance(61000)
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Integrate · merged #10')
  expect(status).toContain('Start new session: /clear')
})

test('an open parent PR whose head lacks the slice end leaves the child stranded', async ($, on) => {
  createWorld(on, strandedCheckout(), { ...child, prs: [strandingPullRequest, buildPullRequest({ number: 10, headRefName: 'par', baseRefName: 'main', headRefOid: 'pp' })] })
  expect(await readFlowStatus($)).toContain('✗ Integrate · parent PR #9 merged')
})

test('a parent PR merged before the child was cut never strands it', async ($, on) => {
  createWorld(on, childCheckout({ par: 'ma' }), { ...child, prs: [buildPullRequest({ number: 4, state: 'MERGED', headRefName: 'par', baseRefName: 'main', headRefOid: 'c0' })] })
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
})

test('a stranded child that is not integrated yet shows the merge first: no step leaves the gap silent', async ($, on) => {
  const checkout = strandedCheckout({ par: 'pp' })
  const world = createWorld(on, checkout, { ...child, prs: [strandingPullRequest] })
  expect(await readFlowStatus($)).toContain('▸ Integrate · not merged into par')
  checkout.graph = { ...checkout.graph!, refs: { ...checkout.graph!.refs, par: 'mpp' } }
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✗ Integrate · parent PR #9 merged')
})

test("in one session, a concluded child that gets a new commit is current again, then stranded once re-integrated", async ($, on) => {
  const checkout = childCheckout({ par: 'ma' })
  const world = createWorld(on, checkout, { ...child, prs: [buildParentPullRequest({ number: 9, headRefOid: 'ma' })] })
  expect(await readFlowStatus($)).toContain('✓ Integrate · merged #9')
  checkout.graph = withCommit(checkout.graph!, 'a3', ['a2'], 'a')
  expect(await readFlowStatus($)).toContain('▸ Integrate · not merged into par')
  checkout.graph = withCommit(checkout.graph!, 'ma3', ['ma', 'a3'], 'par')
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain("✗ Integrate · parent PR #9 merged without this unit's commits")
})

test("a new commit on the child after its parent's PR merged: Integrate is current before re-integration and stranded after it", async ($, on) => {
  const checkout = childCheckout({ par: 'ma' })
  checkout.graph = withCommit(checkout.graph!, 'a3', ['a2'], 'a')
  const world = createWorld(on, checkout, { ...child, prs: [buildPullRequest({ number: 9, state: 'MERGED', headRefName: 'par', baseRefName: 'main', headRefOid: 'ma' })] })
  expect(await readFlowStatus($)).toContain('▸ Integrate · not merged into par')
  checkout.graph = withCommit(checkout.graph!, 'ma3', ['ma', 'a3'], 'par')
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toContain("✗ Integrate · parent PR #9 merged without this unit's commits")
})

test('branch names that hold shell characters are quoted in the merge command', async ($, on) => {
  const graph = buildParentGraph()
  const { a: _a, par: _par, ...refs } = graph.refs
  const checkout: Checkout = { branch: 'a;x', graph: { ...graph, refs: { ...refs, 'a;x': 'a2', 'p$(x)': 'p1' } }, worktrees: { '/repo': { branch: 'a;x' } } }
  createWorld(on, checkout, { unit: { ...child.unit, baseBranch: 'p$(x)' } })
  expect(await readPromptContext($)).toContain("run git switch 'p$(x)' && git merge --no-ff 'a;x' to merge this unit")
  checkout.worktrees = { '/repo': { branch: 'a;x' }, '/par': { branch: 'p$(x)' } }
  expect(await readPromptContext($)).toContain("run git -C /par merge --no-ff 'a;x' to merge this unit")
})
