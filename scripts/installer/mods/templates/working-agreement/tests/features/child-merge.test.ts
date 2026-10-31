import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { coordinator, noFlow } from '../support/builders'
import { callModTool, declareFlow, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { childCheckout, delegationCheckout, readDelegated, seedDelegatedChild } from '../support/parallel-worktrees'
import { createWorld, placedFile, seedDelegation } from '../support/world'
import type { Checkout, Graph, World } from '../support/world'

/**
 * Moves `par` onto a new commit cut from `p1`.
 * @param files - The new commit's files.
 * @returns The history change.
 */
const advancePar = (files: Record<string, string>) => (git: Graph): Graph =>
  ({ ...git, commits: { ...git.commits, p3: { parents: ['p1'], files } }, refs: { ...git.refs, par: 'p3' } })

/**
 * Declares a Fix on #2 in the session's worktree, delegated by the coordinator `coord`.
 * @param $ - The test engine.
 * @param on - The hook registrar.
 * @param live - The checkout.
 * @returns The world.
 */
async function arrangeChild($: Engine, on: On, live: Checkout): Promise<World> {
  const world = createWorld(on, live, { session: noFlow })
  seedDelegation(world, 'coord', [2])
  await declareFlow($, 'fix', [2])
  return world
}

test('a finished child fast-forwards its unmoved parent, and the signing commands sign the parent that carries it', async ($, on) => {
  const live = delegationCheckout()
  const world = createWorld(on, live, { session: coordinator })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged).toEqual({ text: expect.stringContaining('Merged a into par (fast-forward), recorded as delegated'), isError: false })
  expect(live.graph?.refs.par).toBe('a2')
  expect(world.files.has(placedFile('par', 'a2'))).toBe(true)
  expect(world.sessions.get('sid')?.violations ?? []).toEqual([])
  const status = (await runFlowCommand($, 'status')).text ?? ''
  expect(status.split('\n').filter(line => /^ {2}(git|bash) /.test(line)).map(line => line.trim().replace(/'[^']*'/, '<re-sign>'))).toEqual([
    'bash -c <re-sign> resign /par origin/main par a',
    'git -C /par push -u origin par',
  ])
})

test('a finished child merges into a moved parent with --no-ff, and the merge commit is recorded as delegated on the parent', async ($, on) => {
  const live = delegationCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const world = createWorld(on, live, { session: coordinator })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a' })).text).toContain('Merged a into par (merge merge-a2), recorded as delegated')
  expect(live.graph?.commits['merge-a2']?.parents).toEqual(['p3', 'a2'])
  expect(world.files.has(placedFile('par', 'merge-a2'))).toBe(true)
  const delegated = readDelegated(world)
  expect(delegated).toContainEqual(expect.objectContaining({ sha: 'merge-a2', branch: 'par' }))
})

test('a finished child that merged its parent\'s tip merges with --no-ff, so the parent\'s first-parent line keeps its earlier integrations', async ($, on) => {
  const live = delegationCheckout(git => {
    const moved = advancePar({ 'src/par.ts': 'p3' })(git)
    return { ...moved, commits: { ...moved.commits, am: { parents: ['a2', 'p3'], files: { 'src/par.ts': 'p3', 'src/a.ts': 'a2' } } }, refs: { ...moved.refs, a: 'am' } }
  })
  const world = createWorld(on, live, { session: coordinator })
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
  const world = await arrangeChild($, on, live)
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

test('a session that is not the coordinator cannot merge a child', async ($, on) => {
  const live = delegationCheckout()
  const world = createWorld(on, live, { session: noFlow })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a' })).text).toContain('only a coordinator merges a child into its parent')
  expect(live.graph?.refs.par).toBe('p1')
})
