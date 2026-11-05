import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { coordinator, noFlow } from '../support/builders'
import { callModTool, declareFlow, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { childCheckout, coveredSkips, delegationCheckout, gatedCheckout, gateOptions, readDelegated, seedDelegatedChild, seedUnit } from '../support/parallel-worktrees'
import { buildScope, createWorld, delegatedFile, placedFile, scopeFile, seedDelegation } from '../support/world'
import type { Checkout, Graph, Options, World } from '../support/world'

/** A gated checkout with two finished children, and the world options whose gate command fails on chosen trees. */
interface TwoChildren { live: Checkout; options: Options }

/**
 * Moves `par` onto a new commit cut from `p1`.
 * @param files - The new commit's files.
 * @returns The history change.
 */
const advancePar = (files: Record<string, string>) => (git: Graph): Graph =>
  ({ ...git, commits: { ...git.commits, p3: { parents: ['p1'], files } }, refs: { ...git.refs, par: 'p3' } })

/**
 * Declares a flow on issue 2, a Fix unless told otherwise, in the session's worktree, delegated by the coordinator `coord`.
 * @param $ - The test engine.
 * @param on - The hook registrar.
 * @param live - The checkout.
 * @param flow - The flow the child declares.
 * @returns The world.
 */
async function arrangeChild($: Engine, on: On, live: Checkout, flow = 'fix'): Promise<World> {
  const world = createWorld(on, live, { session: noFlow })
  seedDelegation(world, 'coord', [2])
  await declareFlow($, flow, [2])
  return world
}

test('a finished child fast-forwards its unmoved parent, and the signing commands sign the parent that carries it', async ($, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged).toEqual({ text: expect.stringContaining('Merged a into par (fast-forward), recorded as delegated'), isError: false })
  expect(merged.text).toMatch(/Verify \S+ passed on tree/)
  expect(live.graph?.refs.par).toBe('a2')
  expect(world.files.has(placedFile('par', 'a2'))).toBe(true)
  expect(world.sessions.get('sid')?.violations ?? []).toEqual([])
  const status = (await runFlowCommand($, 'status')).text ?? ''
  expect(status).toContain('To sign  par\n  Commits      3 above origin/main (3 unsigned, 0 signed)\n  Child refs   1 move with it (a)')
  expect(status.split('\n').filter(line => /^ {2}\d\. /.test(line)).map(line => line.trim())).toEqual([
    expect.stringMatching(/^1\. bash \S+\/sign\/par\.sh --dry-run/), expect.stringMatching(/^2\. bash \S+\/sign\/par\.sh$/), '3. git -C /par push -u origin par',
  ])
})

test('a finished child fast-forwards the unit branch of a delegated parent issue that no session declared a unit on', async ($, on) => {
  const round = 'chore/1-round'
  const live = gatedCheckout(git => ({ ...git, refs: { ...git.refs, [round]: 'p1' }, created: { a: round } }))
  live.worktrees = { '/repo': { branch: 'main' }, '/round': { branch: round }, '/a': { branch: 'a' } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await world.ready
  await seedUnit(world, 'child', { branch: 'a', issues: [2] }, { skips: coveredSkips(), base: 'p1', baseBranch: round })
  world.files.set(scopeFile('sid'), buildScope('sid', [1, 2]))
  for (const sha of ['a1', 'a2']) world.files.set(delegatedFile(sha), JSON.stringify({ v: 1, key: sha, sha, branch: 'a' }))
  expect((await callModTool($, 'merge_child', { child: 'a' })).text).toContain(`Merged a into ${round} (fast-forward), recorded as delegated`)
  expect(live.graph?.refs[round]).toBe('a2')
})

test('a finished child merges into a moved parent by a merge commit Verify passed in a temporary worktree, recorded as delegated on the parent', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a' })).text).toContain('Merged a into par (merge merge-a2), recorded as delegated')
  expect(live.graph?.commits['merge-a2']?.parents).toEqual(['p3', 'a2'])
  expect(world.runs.some(run => run.startsWith('git worktree add ') && run.endsWith(' merge-a2'))).toBe(true)
  expect(live.worktrees?.['/par.verify']).toBeUndefined()
  expect(world.files.has(placedFile('par', 'merge-a2'))).toBe(true)
  const delegated = readDelegated(world)
  expect(delegated).toContainEqual(expect.objectContaining({ sha: 'merge-a2', branch: 'par' }))
})

test('the merge commit a gating Verify checks out on a detached HEAD is recorded as placed by the mod while that Verify runs', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const during = { isPlaced: false }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: () => {
    during.isPlaced = live.worktrees?.['/par.verify']?.head === 'merge-a2' && world.files.has(placedFile('/par.verify', 'merge-a2'))
  } })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a' })).isError).toBe(false)
  expect(during.isPlaced).toBe(true)
})

test('a branch outside the pair that moves while the merged tree is verified leaves the merge recorded as delegated', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const moveOther = () => { live.graph = { ...live.graph!, commits: { ...live.graph!.commits, o1: { parents: ['p1'], files: live.graph!.commits.p1!.files } }, refs: { ...live.graph!.refs, other: 'o1' } } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: moveOther })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a' })).text).toContain('Merged a into par (merge merge-a2), recorded as delegated')
  expect(readDelegated(world)).toContainEqual(expect.objectContaining({ sha: 'merge-a2', branch: 'par' }))
})

test('a child that moves while the merged tree is verified leaves the merge standing but not recorded as delegated', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const moveChild = () => { live.graph = { ...live.graph!, commits: { ...live.graph!.commits, a3: { parents: ['a2'], files: live.graph!.commits.a2!.files } }, refs: { ...live.graph!.refs, a: 'a3' } } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: moveChild })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('not recorded as delegated')
  expect(live.graph?.refs.par).toBe('merge-a2')
  expect(readDelegated(world)).not.toContainEqual(expect.objectContaining({ sha: 'merge-a2' }))
})

test('a child whose merge into the moved parent fails Verify leaves the parent tip where it was, naming the command, its output and its log', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, spawnCode: 1, spawnOutput: 'check: 1 failing' })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(live.graph?.refs.par).toBe('p3')
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('Verify failed on tree')
  expect(merged.text).toContain('["./check"]')
  expect(merged.text).toContain('check: 1 failing')
  expect(merged.text).toMatch(/see \S+\.log/)
  expect(merged.text).toContain('par stays at p3')
  expect(live.worktrees?.['/par.verify']).toBeUndefined()
})

test('a merged tree Verify already passed on moves the parent without another run', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const spawns = { count: 0 }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: () => { spawns.count += 1 } })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a' })).isError).toBe(false)
  live.graph = { ...live.graph!, refs: { ...live.graph!.refs, par: 'p3' } }
  const again = await callModTool($, 'merge_child', { child: 'a' })
  expect(again.text).toMatch(/Verify \S+ already passed on tree/)
  expect(live.graph?.refs.par).toBe('merge-a2')
  expect(spawns.count).toBe(1)
})

test('a parent tip that moves while the merged tree is verified stays where it moved, and merge_child is to be run again', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const moveTip = () => { live.graph = { ...live.graph!, commits: { ...live.graph!.commits, p4: { parents: ['p3'], files: live.graph!.commits.p3!.files } }, refs: { ...live.graph!.refs, par: 'p4' } } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: moveTip })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('run merge_child again')
  expect(live.graph?.refs.par).toBe('p4')
})

test('a finished child that merged its parent\'s tip merges with --no-ff, so the parent\'s first-parent line keeps its earlier integrations', async ($, on) => {
  const live = gatedCheckout(git => {
    const moved = advancePar({ 'src/par.ts': 'p3' })(git)
    return { ...moved, commits: { ...moved.commits, am: { parents: ['a2', 'p3'], files: { 'src/par.ts': 'p3', 'src/a.ts': 'a2' } } }, refs: { ...moved.refs, a: 'am' } }
  })
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a' })).text).toContain('Merged a into par (merge merge-am), recorded as delegated')
  expect(live.graph?.commits['merge-am']?.parents).toEqual(['p3', 'am'])
})

test('a conflicting child is handed back naming the conflicting paths, leaving the parent where it was', async ($, on) => {
  const live = delegationCheckout(advancePar({ 'src/par.ts': 'p1', 'src/a.ts': 'theirs' }))
  const world = createWorld(on, live, { session: coordinator })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('conflicts in src/a.ts')
  expect(merged.text).toContain('merging it is the user\'s: git -C /par merge --no-ff a')
  expect(live.graph?.refs.par).toBe('p3')
})

test('a delegated child brings its moved parent\'s tip in with merge_parent, recorded as delegated', async ($, on) => {
  const live = childCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const world = await arrangeChild($, on, live)
  const merged = await callModTool($, 'merge_parent', {})
  expect(merged).toEqual({ text: expect.stringContaining('Merged par into a'), isError: false })
  expect(live.graph?.refs.a).toBe('merge-p3')
  expect(live.graph?.commits['merge-p3']?.parents).toEqual(['a2', 'p3'])
  expect(readDelegated(world)).toContainEqual(expect.objectContaining({ sha: 'merge-p3', branch: 'a' }))
  expect(world.sessions.get('sid')?.violations ?? []).toEqual([])
})

test('a conflicting parent tip stops merge_parent for the unit to resolve, and the commit tool concludes the merge as delegated', async ($, on) => {
  const live = childCheckout(advancePar({ 'src/par.ts': 'p1', 'src/a.ts': 'theirs' }))
  const world = await arrangeChild($, on, live, 'small-feature')
  const merged = await callModTool($, 'merge_parent', {})
  expect(merged.isError).toBe(false)
  expect(merged.text).toContain('conflicts in src/a.ts')
  expect(live.graph?.refs.a).toBe('a2')
  live.worktrees!['/repo']!.staged = { 'src/a.ts': 'resolved' }
  expect((await callModTool($, 'commit', { message: 'chore: bring par in' })).isError).toBe(false)
  expect(live.graph?.commits['commit-a2']).toEqual(expect.objectContaining({ parents: ['a2', 'p3'], files: { 'src/par.ts': 'p1', 'src/a.ts': 'resolved' } }))
  expect(readDelegated(world)).toContainEqual(expect.objectContaining({ sha: 'commit-a2', branch: 'a' }))
  expect(world.sessions.get('sid')?.violations ?? []).toEqual([])
})

test('a delegated child whose branch conflicts with its parent\'s tip is refused Verify, naming the paths', async ($, on) => {
  const live = childCheckout(advancePar({ 'src/par.ts': 'p1', 'src/a.ts': 'theirs' }))
  await arrangeChild($, on, live)
  const verified = await callModTool($, 'verify', {})
  expect(verified.text).toContain('conflicts in src/a.ts')
  expect(verified.text).toContain('merge_parent')
})

test('merge_parent is refused outside a delegated unit', async ($, on) => {
  const live = childCheckout(advancePar({ 'src/par.ts': 'p3' }))
  createWorld(on, live, { session: noFlow })
  await declareFlow($, 'fix', [2])
  expect((await callModTool($, 'merge_parent', {})).isError).toBe(true)
  expect(live.graph?.refs.a).toBe('a2')
})

for (const [name, change, issues, worktrees, refusal] of [
  ['a child cut from the default branch', (git: Graph) => ({ ...git, created: { a: 'main' } }), [1, 2], {}, 'a merge into main is always the user\'s'],
  ['a child with no known start point', (git: Graph) => ({ ...git, created: {} }), [1, 2], {}, 'no parent branch the mod knows'],
  ['a pair outside the scope', (git: Graph) => git, [2], {}, 'no delegated child/parent pair the mod knows'],
  ['an unfinished child', (git: Graph) => git, [1, 2], { '/a': { branch: 'a', isDirty: true } }, 'a is not finished'],
] as const) {
  test(`${name} is refused and no ref moves`, async ($, on) => {
    const live = delegationCheckout(change)
    live.worktrees = { ...live.worktrees, ...worktrees }
    const world = createWorld(on, live, { session: coordinator })
    await seedDelegatedChild(world, [...issues])
    const merged = await callModTool($, 'merge_child', { child: 'a' })
    expect(merged.isError).toBe(true)
    expect(merged.text).toContain(refusal)
    expect(live.graph?.refs.par).toBe('p1')
  })
}

/**
 * Builds the gated delegation workflow with a second finished child, `b` (issue 3, cut from `par` at `p1`), in its own worktree.
 * @param redAt - The commits whose tree fails the gate's command when a gating Verify checks them out.
 * @returns The checkout, and the world options whose command fails on those trees.
 */
function twoChildren(redAt: string[] = []): TwoChildren {
  const live = gatedCheckout()
  live.worktrees = { ...live.worktrees, '/b': { branch: 'b' } }
  const spawnCode = () => redAt.includes(live.worktrees?.['/par.verify']?.head ?? '') ? 1 : 0
  return { live, options: { session: coordinator, ...gateOptions, spawnCode, spawnOutput: 'check: 1 failing' } }
}

/**
 * Seeds both children of the two-children workflow as finished delegated units in this coordinator's scope.
 * @param world - The world.
 */
async function seedTwoChildren(world: World): Promise<void> {
  await seedDelegatedChild(world, [1, 2, 3])
  await seedUnit(world, 'child-b', { branch: 'b', issues: [3] }, { skips: coveredSkips(), base: 'p1', baseBranch: 'par' })
  world.files.set(delegatedFile('b1'), JSON.stringify({ v: 1, key: 'b1', sha: 'b1', branch: 'b' }))
}

test('children stacked in one call move the parent to the top of the stack after one Verify of that tree', async ($, on) => {
  const { live, options } = twoChildren()
  const spawns = { count: 0 }
  const world = createWorld(on, live, { ...options, afterSpawn: () => { spawns.count += 1 } })
  await seedTwoChildren(world)
  const merged = await callModTool($, 'merge_child', { children: ['a', 'b'] })
  expect(merged).toEqual({ text: expect.stringContaining('Merged a (fast-forward), b (merge merge-b1) into par, recorded as delegated'), isError: false })
  expect(live.graph?.refs.par).toBe('merge-b1')
  expect(live.graph?.commits['merge-b1']?.parents).toEqual(['a2', 'b1'])
  expect(spawns.count).toBe(1)
  expect(readDelegated(world)).toContainEqual(expect.objectContaining({ sha: 'merge-b1', branch: 'par' }))
})

test('a red stack is bisected by prefix: the parent moves to the green prefix and the child that broke it is named', async ($, on) => {
  const { live, options } = twoChildren(['merge-b1'])
  const world = createWorld(on, live, options)
  await seedTwoChildren(world)
  const merged = await callModTool($, 'merge_child', { children: ['a', 'b'] })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('check: 1 failing')
  expect(merged.text).toContain('Bisected: Verify passed with the children before b and failed once it was added')
  expect(merged.text).toContain('Merged a into par (fast-forward), recorded as delegated')
  expect(merged.text).toContain('Send this to b\'s unit')
  expect(live.graph?.refs.par).toBe('a2')
})

test('a stack red from its first child moves nothing and hands the later children back for another call', async ($, on) => {
  const { live, options } = twoChildren(['a2', 'merge-b1'])
  const world = createWorld(on, live, options)
  await seedTwoChildren(world)
  const merged = await callModTool($, 'merge_child', { children: ['a', 'b'] })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('Bisected: Verify failed with only a')
  expect(merged.text).toContain('par stays at p1')
  expect(merged.text).toContain('Send this to a\'s unit')
  expect(merged.text).toContain('b was not merged: run merge_child for it again')
  expect(live.graph?.refs.par).toBe('p1')
})

for (const [name, input] of [
  ['both child and children', { child: 'a', children: ['b'] }],
  ['neither child nor children', {}],
  ['a repeated child', { children: ['a', 'a'] }],
  ['more than three children', { children: ['a', 'b', 'c', 'd'] }],
] as const) {
  test(`merge_child with ${name} is refused and no ref moves`, async ($, on) => {
    const { live, options } = twoChildren()
    const world = createWorld(on, live, options)
    await seedTwoChildren(world)
    expect((await callModTool($, 'merge_child', input)).isError).toBe(true)
    expect(live.graph?.refs.par).toBe('p1')
  })
}

test('a session that is not the coordinator cannot merge a child', async ($, on) => {
  const live = delegationCheckout()
  const world = createWorld(on, live, { session: noFlow })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a' })).text).toContain('only a coordinator merges a child into its parent')
  expect(live.graph?.refs.par).toBe('p1')
})
