import { expect } from 'claude-code/testing'

import { coordinator, noFlow } from '../support/builders'
import { callModTool, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { delegationCheckout, seedDelegatedChild, readDelegated } from '../support/parallel-worktrees'
import { createWorld } from '../support/world'
import type { Graph } from '../support/world'

/**
 * Moves `par` onto a new commit cut from `p1`.
 * @param files - The new commit's files.
 * @returns The history change.
 */
const advancePar = (files: Record<string, string>) => (git: Graph): Graph =>
  ({ ...git, commits: { ...git.commits, p3: { parents: ['p1'], files } }, refs: { ...git.refs, par: 'p3' } })

test('a finished child fast-forwards its unmoved parent, and the signing commands sign the parent that carries it', async ($, on) => {
  const live = delegationCheckout()
  const world = createWorld(on, live, { session: coordinator })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged).toEqual({ text: expect.stringContaining('Merged a into par (fast-forward), recorded as delegated'), isError: false })
  expect(live.graph?.refs.par).toBe('a2')
  expect(world.sessions.get('sid')?.violations ?? []).toEqual([])
  const status = (await runFlowCommand($, 'status')).text ?? ''
  expect(status.split('\n').filter(line => line.startsWith('  git')).map(line => line.trim())).toEqual([
    'git -C /a switch --detach',
    'git -C /par rebase --keep-base --rebase-merges --update-refs --force-rebase --gpg-sign origin/main par',
    'git -C /par log --format=\'%G? %h %s\' origin/main..par',
    'git -C /par push -u origin par',
  ])
})

test('a finished child merges into a moved parent with --no-ff, and the merge commit is recorded as delegated on the parent', async ($, on) => {
  const live = delegationCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const world = createWorld(on, live, { session: coordinator })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a' })).text).toContain('Merged a into par (merge merge-a2), recorded as delegated')
  expect(live.graph?.commits['merge-a2']?.parents).toEqual(['p3', 'a2'])
  const delegated = readDelegated(world)
  expect(delegated).toContainEqual(expect.objectContaining({ sha: 'merge-a2', branch: 'par' }))
})

test('a conflicting merge is aborted and handed to the user, leaving the parent where it was', async ($, on) => {
  const live = delegationCheckout(advancePar({ 'src/par.ts': 'p1', 'src/a.ts': 'theirs' }))
  const world = createWorld(on, live, { session: coordinator })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('the merge was aborted; merging it is the user\'s: git -C /par merge --no-ff a')
  expect(live.graph?.refs.par).toBe('p3')
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
