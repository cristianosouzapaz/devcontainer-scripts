import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { test } from '../support/kit'
import { noFlow } from '../support/builders'
import { readFlowStatus } from '../support/helpers'
import { childUnit, parallelCheckout, withCommit } from '../support/parallel-worktrees'
import { common, createWorld } from '../support/world'
import type { Checkout, Options, World } from '../support/world'

interface Scenario { name: string; isJudged: boolean; checkout: Checkout; change: (checkout: Checkout) => void; options?: Options }
interface Arranged extends World { call: () => Promise<string> }

const scenarios: Scenario[] = [
  { name: "the user's sibling commit and its merge into parent, both held by other worktrees (the live example)", isJudged: false,
    checkout: parallelCheckout({ '/detached': { branch: 'HEAD', head: 'p0' } }), change: checkout => {
      checkout.graph = withCommit(checkout.graph!, 's1', ['p0'], 'sibling')
      checkout.graph = withCommit(checkout.graph!, 's2', ['s1'], 'sibling')
      checkout.graph = withCommit(checkout.graph!, 'pm', ['p0', 's2'], 'parent')
    } },
  { name: "(a) a commit on the session's own worktree", isJudged: true, checkout: parallelCheckout(), change: checkout => checkout.graph = withCommit(checkout.graph!, 'c2', ['c1'], 'child') },
  { name: "(a) a commit on the session's own detached HEAD", isJudged: true, checkout: parallelCheckout({ '/repo': { branch: 'HEAD', head: 'c1' } }),
    change: checkout => { checkout.graph = withCommit(checkout.graph!, 'c2', ['c1']); checkout.worktrees!['/repo']!.head = 'c2' } },
  { name: "(a) a commit on the own worktree's branch, also checked out by force in another worktree", isJudged: true, options: { session: noFlow },
    checkout: parallelCheckout({ '/repo': { branch: 'sibling' } }), change: checkout => checkout.graph = withCommit(checkout.graph!, 's1', ['p0'], 'sibling') },
  { name: "(b) a commit on the unit's branch checked out in another worktree", isJudged: true,
    checkout: parallelCheckout({ '/repo': { branch: 'scratch' }, '/elsewhere': { branch: 'child' } }, { scratch: 'p0' }), change: checkout => checkout.graph = withCommit(checkout.graph!, 'c2', ['c1'], 'child') },
  { name: "(b) a commit on the unit's branch checked out in another worktree, with a rewritten slice", isJudged: true,
    options: { unit: { base: 'm0x', baseBranch: 'parent' } }, checkout: (() => {
      const checkout = parallelCheckout({ '/repo': { branch: 'scratch' }, '/elsewhere': { branch: 'child' } }, { scratch: 'p0' })
      checkout.graph!.commits.m0x = { parents: [], files: {} }
      return checkout
    })(), change: checkout => checkout.graph = withCommit(checkout.graph!, 'c2', ['c1'], 'child') },
  { name: '(c) a commit on the default branch checked out in another worktree', isJudged: true,
    checkout: parallelCheckout({ '/default': { branch: 'main' } }), change: checkout => checkout.graph = withCommit(checkout.graph!, 'm1', ['m0'], 'main') },
  { name: '(d) update-ref of a branch no worktree holds onto a new commit', isJudged: true,
    checkout: parallelCheckout({}, { loose: 'p0' }), change: checkout => checkout.graph = withCommit(checkout.graph!, 'l1', ['p0'], 'loose') },
  { name: '(d) branch -f of a new branch onto a new commit', isJudged: true,
    checkout: parallelCheckout(), change: checkout => checkout.graph = withCommit(checkout.graph!, 'n1', ['p0'], 'created') },
  { name: '(e) merge --no-ff of the child into parent in the main worktree', isJudged: true,
    checkout: parallelCheckout(), change: checkout => checkout.graph = withCommit(checkout.graph!, 'pm', ['p0', 'c1'], 'parent') },
  { name: '(e) a sibling commit that carries the slice into a held sibling', isJudged: true,
    checkout: parallelCheckout(), change: checkout => checkout.graph = withCommit(checkout.graph!, 'sm', ['p0', 'c1'], 'sibling') },
  { name: 'a commit in a worktree added during the call', isJudged: true, checkout: parallelCheckout(), change: checkout => {
    checkout.worktrees!['/added'] = { branch: 'added' }
    checkout.graph = withCommit(checkout.graph!, 'a1', ['p0'], 'added')
  } },
  { name: 'a worktree added during the call on an existing commit, with no commit', isJudged: false, checkout: parallelCheckout(), change: checkout => {
    checkout.graph = { ...checkout.graph!, refs: { ...checkout.graph!.refs, added: 'p0' } }
    checkout.worktrees!['/added'] = { branch: 'added' }
  } },
  { name: "a commit on the branch of a worktree removed during the call", isJudged: true, checkout: parallelCheckout(), change: checkout => {
    delete checkout.worktrees!['/sibling']
    checkout.graph = withCommit(checkout.graph!, 's1', ['p0'], 'sibling')
  } },
  { name: 'a commit in a worktree switched to another branch during the call', isJudged: true, checkout: parallelCheckout({}, { other: 'p0' }), change: checkout => {
    checkout.worktrees!['/sibling'] = { branch: 'other' }
    checkout.graph = withCommit(checkout.graph!, 'o1', ['p0'], 'other')
  } },
  { name: 'a commit on a detached HEAD in another worktree that moves during the call', isJudged: true,
    checkout: parallelCheckout({ '/detached': { branch: 'HEAD', head: 'p0' } }), change: checkout => {
      checkout.graph = withCommit(checkout.graph!, 'd1', ['p0'])
      checkout.worktrees!['/detached']!.head = 'd1'
    } },
  { name: 'a session with no declared unit, on a held sibling', isJudged: false, options: { session: noFlow },
    checkout: parallelCheckout(), change: checkout => checkout.graph = withCommit(checkout.graph!, 'sm', ['p0', 'c1'], 'sibling') },
  { name: 'a session with no declared unit, on its own worktree', isJudged: true, options: { session: noFlow },
    checkout: parallelCheckout(), change: checkout => checkout.graph = withCommit(checkout.graph!, 'c2', ['c1'], 'child') },
  { name: 'a unit on the default branch, on a held parent', isJudged: false, options: { unit: {} },
    checkout: { ...parallelCheckout({ '/repo': { branch: 'main' } }), branch: 'main' }, change: checkout => checkout.graph = withCommit(checkout.graph!, 'pm', ['p0', 'c1'], 'parent') },
]

const pushes: Scenario[] = [
  { name: "the session's own branch", isJudged: true, checkout: parallelCheckout({}, { 'origin/child': 'p0' }),
    change: checkout => { checkout.graph!.refs['origin/child'] = 'c1' } },
  { name: "the unit's branch checked out in another worktree", isJudged: true,
    checkout: parallelCheckout({ '/repo': { branch: 'scratch' }, '/elsewhere': { branch: 'child' } }, { scratch: 'p0' }),
    change: checkout => { checkout.graph!.refs['origin/child'] = 'c1' } },
  { name: 'the default branch checked out in another worktree', isJudged: true, checkout: (() => {
    const checkout = parallelCheckout({ '/default': { branch: 'main' } })
    checkout.graph = withCommit(checkout.graph!, 'm1', ['m0'], 'main')
    return checkout
  })(), change: checkout => { checkout.graph!.refs['origin/main'] = 'm1' } },
  { name: 'a branch no worktree holds', isJudged: true, checkout: parallelCheckout({}, { loose: 'c1' }), change: checkout => { checkout.graph!.refs['origin/loose'] = 'c1' } },
  { name: 'HEAD:new, a branch that does not exist locally', isJudged: true, checkout: parallelCheckout(), change: checkout => { checkout.graph!.refs['origin/new'] = 'c1' } },
  { name: 'a sibling held by another worktree that carries the slice', isJudged: false, checkout: (() => {
    const checkout = parallelCheckout()
    checkout.graph = withCommit(checkout.graph!, 'sm', ['p0', 'c1'], 'sibling')
    return checkout
  })(), change: checkout => { checkout.graph!.refs['origin/sibling'] = 'sm' } },
]

/**
 * Builds a child session's world whose next Bash call applies the scenario's change.
 * @param $ - The engine.
 * @param on - The hook registrar.
 * @param scenario - The checkout, change and options.
 * @returns The world and a call that returns the agent context it carried.
 */
function arrange($: Engine, on: On, scenario: Scenario): Arranged {
  const world = createWorld(on, scenario.checkout, { ...childUnit, ...scenario.options, afterTool: () => scenario.change(scenario.checkout) })
  return { ...world, call: async () => (await $.tool.call({ tool: 'Bash', command: 'opaque' })).context?.join('\n') ?? '' }
}

/**
 * Reads the transition-log lines that record a violation.
 * @param files - The world's files.
 * @returns The recorded-violation lines.
 */
const violationLines = (files: Map<string, string>): string[] => [...files.entries()].filter(([path]) => path.startsWith(`${common}/working-agreement/log/`))
  .flatMap(([, text]) => text.split('\n').filter(line => line.includes('"event":"violation"')))

for (const scenario of scenarios) {
  test(`territory: ${scenario.name} is ${scenario.isJudged ? 'a violation' : 'not observed'}`, async ($, on) => {
    const world = arrange($, on, scenario)
    const context = await world.call()
    await world.clock.settle()
    const records = world.sessions.get('sid')?.violations ?? []
    if (scenario.isJudged) {
      // Moving a default-branch checkout also changes its tree, a separate fact.
      expect(records.filter(record => record.kind === 'commit')).toHaveLength(1)
      expect(context).toContain('a commit appeared')
      // The transition log is the unit's, so a session without one logs nowhere.
      if (scenario.options?.session !== noFlow) expect(violationLines(world.files).filter(line => line.includes('"kind":"commit"'))).toHaveLength(1)
      return
    }
    expect(records).toEqual([])
    expect(context).toBe('')
    expect(world.views.at(-1)?.violations ?? []).toEqual([])
    expect((await readFlowStatus($))?.split('\n').filter(line => line.startsWith('Violation')) ?? []).toEqual([])
    expect(violationLines(world.files)).toEqual([])
  })
}

test('territory: a merge into a held parent keeps the wording of a commit in another worktree', async ($, on) => {
  const checkout = parallelCheckout()
  const world = arrange($, on, { name: 'merge', isJudged: true, checkout, change: next => next.graph = withCommit(next.graph!, 'pm', ['p0', 'c1'], 'parent') })
  expect(await world.call()).toContain("a commit appeared on parent, checked out in another worktree, during your call (it may be the user's or another session's)")
  expect(world.sessions.get('sid')?.violations?.[0]?.fact).toEqual({ shas: ['pm'] })
})

test('territory: only the in-territory commits of a call are recorded', async ($, on) => {
  const world = arrange($, on, { name: 'mixed', isJudged: true, checkout: parallelCheckout(), change: checkout => {
    checkout.graph = withCommit(checkout.graph!, 's1', ['p0'], 'sibling')
    checkout.graph = withCommit(checkout.graph!, 'c2', ['c1'], 'child')
  } })
  await world.call()
  expect(world.sessions.get('sid')?.violations?.map(({ kind, fact }) => ({ kind, fact }))).toEqual([{ kind: 'commit', fact: { shas: ['c2'] } }])
})

test('territory: a moved detached HEAD in another worktree is judged beside an out-of-territory sibling commit', async ($, on) => {
  const world = arrange($, on, { name: 'detached', isJudged: true, checkout: parallelCheckout({ '/detached': { branch: 'HEAD', head: 'p0' } }), change: checkout => {
    checkout.graph = withCommit(checkout.graph!, 's1', ['p0'], 'sibling')
    checkout.graph = withCommit(checkout.graph!, 'd1', ['p0'])
    checkout.worktrees!['/detached']!.head = 'd1'
  } })
  await world.call()
  expect(world.sessions.get('sid')?.violations?.map(({ kind, fact }) => ({ kind, fact }))).toEqual([{ kind: 'commit', fact: { shas: ['d1'] } }])
})

for (const [label, unit] of [['a rewritten base', { base: 'm0x', baseBranch: 'parent' }], ['a fork point not computable', { baseBranch: 'island' }]] as const) {
  test(`territory: a slice not computable (${label}) leaves slice-only commits unchecked and still judges the rest`, async ($, on) => {
    const checkout = parallelCheckout({}, { island: 'm0x' })
    checkout.graph!.commits.m0x = { parents: [], files: {} }
    const world = arrange($, on, { name: label, isJudged: false, checkout, options: { unit }, change: next => {
      next.graph = withCommit(next.graph!, 'pm', ['p0', 'c1'], 'parent')
      next.graph = withCommit(next.graph!, 'l1', ['p0'], 'loose')
    } })
    const context = await world.call()
    const records = world.sessions.get('sid')?.violations ?? []
    expect(records.map(({ kind, fact }) => ({ kind, ...(kind === 'commit' ? { fact } : {}) }))).toEqual([{ kind: 'commit', fact: { shas: ['l1'] } }, { kind: 'unchecked' }])
    expect(context).not.toContain('unchecked')
    expect(context.split('\n').filter(Boolean)).toHaveLength(1)
    expect(world.views.at(-1)?.violations?.find(note => note.tone === 'warn')?.text).toMatch(/^unchecked: guarantee snapshots unavailable for 1 call, /)
  })
}

test('territory: a unit branch deleted during the call has no slice, so a merge into a held parent is neither judged nor unchecked', async ($, on) => {
  const checkout = parallelCheckout({ '/repo': { branch: 'HEAD', head: 'c1' } })
  const world = arrange($, on, { name: 'deleted', isJudged: false, checkout, change: next => {
    next.graph = withCommit(next.graph!, 'pm', ['p0', 'c1'], 'parent')
    next.graph = withCommit(next.graph!, 'l1', ['p0'], 'loose')
    next.graph = { ...next.graph, refs: Object.fromEntries(Object.entries(next.graph.refs).filter(([ref]) => ref !== 'child')) }
  } })
  expect((await world.call()).split('\n').filter(Boolean)).toHaveLength(1)
  expect(world.sessions.get('sid')?.violations?.map(({ kind, fact }) => ({ kind, fact }))).toEqual([{ kind: 'commit', fact: { shas: ['l1'] } }])
})

// The first prefix fails the unit-branch read that scopes a held tip; the second fails the slice-reachability read of the merge.
for (const failing of ['git rev-parse --verify --quiet refs/heads/child', 'git rev-list pm --not p0']) {
  test(`territory: an unreadable placement (${failing}) leaves only that tip's commits unchecked`, async ($, on) => {
    const checkout = parallelCheckout()
    const options: Options = { ...childUnit, afterTool: () => {
      options.failing = failing
      checkout.graph = withCommit(checkout.graph!, 'pm', ['p0', 'c1'], 'parent')
      checkout.graph = withCommit(checkout.graph!, 'l1', ['p0'], 'loose')
    } }
    const world = createWorld(on, checkout, options)
    await $.tool.call({ tool: 'Bash', command: 'opaque' })
    expect(world.sessions.get('sid')?.violations?.map(({ kind, fact }) => ({ kind, ...(kind === 'commit' ? { fact } : {}) })))
      .toEqual([{ kind: 'commit', fact: { shas: ['l1'] } }, { kind: 'unchecked' }])
  })
}

test("territory: an unreadable session root gives no verdict rather than reading the session's own worktree as another's", async ($, on) => {
  const checkout = parallelCheckout()
  const options: Options = { session: noFlow, afterTool: () => {
    options.failing = 'git rev-parse --show-toplevel'
    checkout.graph = withCommit(checkout.graph!, 'c2', ['c1'], 'child')
  } }
  const world = createWorld(on, checkout, options)
  const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  expect(result.context ?? []).toEqual([])
  expect(world.sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['unchecked'])
})

for (const side of ['before', 'after']) {
  test(`territory: a worktree list unreadable ${side} the call gives no verdict and leaves the call unchecked`, async ($, on) => {
    const checkout = parallelCheckout()
    const options: Options = { ...childUnit, failing: side === 'before' ? 'git worktree list' : undefined }
    options.afterTool = () => { options.failing = side === 'after' ? 'git worktree list' : undefined; checkout.graph = withCommit(checkout.graph!, 'c2', ['c1'], 'child') }
    const world = createWorld(on, checkout, options)
    const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
    expect(result.context ?? []).toEqual([])
    expect(world.sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['unchecked'])
  })
}

for (const scenario of pushes) {
  test(`territory: a push of local-only commits on ${scenario.name} is ${scenario.isJudged ? 'a violation' : 'not observed'}`, async ($, on) => {
    const world = arrange($, on, scenario)
    const context = await world.call()
    const records = world.sessions.get('sid')?.violations ?? []
    expect(records.map(record => record.kind)).toEqual(scenario.isJudged ? ['push'] : [])
    expect(context.includes('a push appeared')).toBe(scenario.isJudged)
  })
}

test('territory: unreadable remotes leave a push next to a held worktree unchecked', async ($, on) => {
  const checkout = parallelCheckout()
  const options: Options = { ...childUnit, afterTool: () => { options.failing = 'git remote'; checkout.graph!.refs['origin/new'] = 'c1' } }
  const world = createWorld(on, checkout, options)
  const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  expect(result.context ?? []).toEqual([])
  expect(world.sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['unchecked'])
})
