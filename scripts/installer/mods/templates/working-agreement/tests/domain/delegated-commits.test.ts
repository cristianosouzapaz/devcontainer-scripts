import { expect } from 'claude-code/testing'

import { readUnitSlice } from '../../hooks/core/unit-slice'
import { findDeniedWord } from '../../hooks/domain/bash-guards'
import { composeSigningCommands } from '../../hooks/domain/delegated-commits'
import { hashObject } from '../../hooks/lib/git'
import type { SigningBranch } from '../../hooks/domain/delegated-commits'
import { coordinator, guarded, noFlow } from '../support/builders'
import { callModTool, declareFlow, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { readDelegated } from '../support/parallel-worktrees'
import { buildScope, createTestPort, createWorld, delegatedFile, scopeFile } from '../support/world'
import type { Checkout, Graph, Options, World } from '../support/world'

/** Holds the history change the next opaque Bash call makes. */
interface PendingChange { change?: (git: Graph) => Graph }

/** A delegation test's world, its live checkout and the change slot the next Bash call applies. */
interface Arranged { world: World; checkout: Checkout; pending: PendingChange }


/**
 * Builds a repository whose unit branch `feat` and side branch `other` start at the default branch, with the git alias `pu`.
 * @returns The history.
 */
const graph = (): Graph => ({
  commits: { a: { parents: [], files: { f: 'a' } } }, refs: { main: 'a', 'origin/main': 'a', feat: 'a', other: 'a' }, aliases: { pu: 'push' },
})

/**
 * Adds a commit on a branch without altering the input graph.
 * @param git - The history before the commit.
 * @param branch - The branch the commit lands on.
 * @param isSigned - Whether the commit carries a signature.
 * @returns The history with the branch advanced to `b`.
 */
const commitOn = (git: Graph, branch: string, isSigned = false): Graph => ({
  ...git, commits: { ...git.commits, b: { parents: [git.refs[branch] ?? ''], files: { f: 'b' }, isSigned } }, refs: { ...git.refs, [branch]: 'b' },
})

/**
 * Arranges a unit session on `feat` for issue #3, delegated by the coordinator `coord` unless told otherwise.
 * @param on - The hook registrar.
 * @param isDelegated - Whether a scope delegates #3.
 * @param options - Further world options.
 * @returns The world, the live checkout and the change slot the next Bash call applies.
 */
function arrange(on: Parameters<typeof createWorld>[0], isDelegated = true, options: Options = {}): Arranged {
  const checkout: Checkout = { branch: 'feat', graph: graph() }
  const pending: PendingChange = {}
  const world = createWorld(on, checkout, { session: noFlow, ...options, afterTool: () => {
    if (pending.change) checkout.graph = pending.change(checkout.graph!)
    delete pending.change
  } })
  if (isDelegated) world.files.set(scopeFile('coord'), buildScope('coord', [3]))
  return { world, checkout, pending }
}

test('a delegated unit\'s unsigned commit on its own branch is recorded as delegated, not as a violation', async ($, on) => {
  const { world, pending } = arrange(on)
  await declareFlow($, 'fix', [3])
  pending.change = git => commitOn(git, 'feat')
  const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  expect(result.context?.join('') ?? '').not.toContain('a commit appeared')
  expect(world.sessions.get('sid')?.violations ?? []).toEqual([])
  expect(readDelegated(world)).toEqual([expect.objectContaining({ v: 1, sha: 'b', branch: 'feat' })])
})

for (const [name, isDelegated, branch, isSigned] of [
  ['a commit on another branch', true, 'other', false],
  ['a signed commit', true, 'feat', true],
  ['a commit without delegation', false, 'feat', false],
] as const) {
  test(`${name} stays a violation`, async ($, on) => {
    const { world, pending } = arrange(on, isDelegated)
    await declareFlow($, 'fix', [3])
    pending.change = git => commitOn(git, branch, isSigned)
    const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
    expect(result.context?.join('')).toContain('a commit appeared')
    expect(world.sessions.get('sid')?.violations?.[0]?.kind).toBe('commit')
    expect(readDelegated(world)).toEqual([])
  })
}

for (const command of ['git push origin feat', 'git rebase main', 'git branch -D other', 'gh pr create --fill', 'gh api repos/o/r/pulls -f title=x', 'gh api repos/o/r/pulls -ftitle=x', 'git pu']) {
  test(`a delegated unit's ${command} is refused before it runs`, async ($, on) => {
    arrange(on)
    await declareFlow($, 'fix', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('Under delegation this command is refused')
  })
}

for (const command of ['git commit -F msg', 'git -c commit.gpgsign=false commit -F msg', 'git -C . commit -m x']) {
  test(`a delegated unit's ${command} is refused for the commit tool`, async ($, on) => {
    arrange(on)
    await declareFlow($, 'fix', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('commit tool')
  })
}

test('a delegated unit\'s commit tool commits its staged work unsigned on its own branch and records it as delegated', async ($, on) => {
  const { world, checkout } = arrange(on)
  await declareFlow($, 'fix', [3])
  checkout.staged = { f: 'b' }
  const result = await callModTool($, 'commit', { message: 'fix: change' })
  expect(result.isError).toBe(false)
  expect(checkout.graph?.refs.feat).toBe('commit-a')
  expect(readDelegated(world)).toEqual([expect.objectContaining({ v: 1, sha: 'commit-a', branch: 'feat' })])
  expect(world.sessions.get('sid')?.violations ?? []).toEqual([])
})

for (const [name, isDelegated, branch] of [['without delegation', false, 'feat'], ['on another branch', true, 'other']] as const) {
  test(`the commit tool is refused ${name}`, async ($, on) => {
    const { world, checkout } = arrange(on, isDelegated)
    await declareFlow($, 'fix', [3])
    checkout.branch = branch
    checkout.staged = { f: 'b' }
    expect((await callModTool($, 'commit', { message: 'fix: change' })).isError).toBe(true)
    expect(checkout.graph?.refs[branch]).toBe('a')
    expect(readDelegated(world)).toEqual([])
  })
}

for (const [command, isDelegated] of [['gh pr view 3', true], ['gh pr diff 3', true], ['gh api -X GET repos/o/r/pulls -f state=open', true], ['git merge-base main feat', true], ['git push origin feat', false]] as const) {
  test(`${command} runs ${isDelegated ? 'under' : 'without'} delegation`, async ($, on) => {
    arrange(on, isDelegated)
    await declareFlow($, 'fix', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  })
}

test('the word guard refuses git when the aliases are unreadable', () => {
  expect(findDeniedWord('git status', null)).toBeDefined()
  expect(findDeniedWord('ls st', ['st'])).toBeUndefined()
  expect(findDeniedWord('GIT_DIR=/x git log', [])).toBe('GIT_DIR')
  expect(findDeniedWord('bash -c "git log"', [])).toBe('bash -c')
})

test('the signing commands rebase each parent chain in place, detaching its merged children first', () => {
  const branch = (name: string, parent: string | null, isMerged = false, root: string | null = null): SigningBranch => ({ branch: name, root, parent, isMerged })
  expect(composeSigningCommands([branch('child', 'feat'), branch('done', 'feat', true, '/done'), branch('feat', null, false, '/feat')], 'main')).toEqual([
    'git rebase --keep-base --rebase-merges --update-refs --force-rebase --gpg-sign origin/main child',
    'git log --format=\'%G? %h %s\' origin/main..child',
    'git push -u origin child',
    'git -C /done switch --detach',
    'git -C /feat rebase --keep-base --rebase-merges --update-refs --force-rebase --gpg-sign origin/main feat',
    'git -C /feat log --format=\'%G? %h %s\' origin/main..feat',
    'git -C /feat push -u origin feat',
  ])
})

test('/flow delegate stop gives the signing rebase and push commands per branch chain', async ($, on) => {
  const git: Graph = {
    commits: { a: { parents: [], files: { f: 'a' } }, b: { parents: ['a'], files: { f: 'b' } }, c: { parents: ['b'], files: { f: 'c' } } },
    refs: { main: 'a', 'origin/main': 'a', feat: 'b', child: 'c' }, created: { child: 'feat' },
  }
  const world = createWorld(on, { branch: 'main', graph: git, worktrees: { '/repo': { branch: 'main' }, '/feat': { branch: 'feat' } } }, { session: coordinator })
  world.files.set(scopeFile('sid'), buildScope('sid', [3]))
  world.files.set(delegatedFile('k1'), JSON.stringify({ v: 1, key: 'k1', sha: 'b', branch: 'feat' }))
  world.files.set(delegatedFile('k2'), JSON.stringify({ v: 1, key: 'k2', sha: 'c', branch: 'child' }))
  const text = (await runFlowCommand($, 'delegate stop')).text ?? ''
  expect(text).toContain('sign and push them, in this order')
  expect(text.split('\n').filter(line => line.startsWith('  git')).map(line => line.trim())).toEqual([
    'git rebase --keep-base --rebase-merges --update-refs --force-rebase --gpg-sign origin/main child',
    'git log --format=\'%G? %h %s\' origin/main..child',
    'git push -u origin child',
    'git -C /feat rebase --keep-base --rebase-merges --update-refs --force-rebase --gpg-sign origin/main feat',
    'git -C /feat log --format=\'%G? %h %s\' origin/main..feat',
    'git -C /feat push -u origin feat',
  ])
})

for (const [name, options, isUnguarded] of [
  ['without', {}, true],
  ['with', guarded(), false],
] as [string, Options, boolean][]) {
  test(`/flow delegate ${name} a signed-commit ruleset ${isUnguarded ? 'shows' : 'does not show'} its absence`, async ($, on) => {
    const world = createWorld(on, { branch: 'feat' }, { session: coordinator, ...options })
    await runFlowCommand($, 'delegate #3')
    const row = world.views.at(-1)?.meta.find(entry => entry.key === 'Delegating')
    expect(row?.value).toBe(isUnguarded ? '#3 · no signed-commit ruleset' : '#3')
  })
}

test('a base naming a delegated commit follows the signing rebase instead of reading as rewritten', async (_$, on) => {
  const checkout: Checkout = { branch: 'feat', graph: {
    commits: {
      a: { parents: [], files: { f: 'a' } }, b: { parents: ['a'], files: { f: 'b' } },
      signed: { parents: ['a'], files: { f: 'b' }, isSigned: true }, c: { parents: ['signed'], files: { f: 'c' }, isSigned: true },
    },
    refs: { main: 'a', 'origin/main': 'a', feat: 'c' },
  } }
  const world = createWorld(on, checkout, { session: noFlow })
  const port = createTestPort(world)
  const diff = await port.processes.run(['git', 'diff-tree', '-r', '--no-commit-id', '-m', 'b'], { timeoutMs: 5000 })
  const key = (await hashObject(port.processes, diff.stdout.trim())).stdout.trim()
  world.files.set(delegatedFile(key), JSON.stringify({ v: 1, key, sha: 'b', branch: 'parent' }))
  const identity = { branch: 'feat', issues: [3] }
  const git = { root: '/repo', branch: 'feat', head: 'c', base: 'main', isUpToDate: true }
  const unit = { base: 'b', skills: [], verifyRuns: [], runs: [] }
  expect(await readUnitSlice(port, identity, unit, git, false)).toEqual(expect.objectContaining({ base: 'signed', isRewritten: false, commits: 1 }))
  world.files.delete(delegatedFile(key))
  expect((await readUnitSlice(port, identity, unit, git, false))?.isRewritten).toBe(true)
})
