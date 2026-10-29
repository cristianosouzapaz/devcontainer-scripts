import { expect } from 'claude-code/testing'
import { test } from '../../support/kit'
import { conformanceGraph } from '../../support/graph-fixture'
import { declareFlow, readFlowStatus, readPromptContext, readStepStates, runFlowCommand } from '../../support/helpers'
import { buildParentGraph, buildPullRequest, noFlow } from '../../support/builders'
import { parseSession } from '../../../hooks/domain/records'
import { common, createWorld } from '../../support/world'
import type { Checkout, Graph, Options } from '../../support/world'

function branch(): Checkout {
  return { branch: 'feat', graph: structuredClone(conformanceGraph) }
}

test('switching branches preserves done Code and Commit and names the checkout in pane and prompt', async ($, on) => {
  const checkout = branch()
  const world = createWorld(on, checkout, { session: { flow: 'trivial' } })
  expect((await readStepStates(world)).Commit).toBe('done')
  checkout.branch = 'other'
  checkout.dirty = { 'src/elsewhere.ts': 'uncommitted' }
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Code')
  expect((await readStepStates(world)).Commit).toBe('done')
  expect(status).toContain("other, not this unit's branch")
  expect(await readPromptContext($)).toContain("checked out: other (not this unit's branch)")
})

test('only the linked worktree holding the unit branch contributes dirty content', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'm1'
  checkout.worktrees = { '/repo': { branch: 'other', dirty: { 'foreign': 'x' } }, '/linked': { branch: 'feat' } }
  const world = createWorld(on, checkout, { session: { flow: 'trivial' } })
  checkout.branch = 'other'
  expect(await readFlowStatus($)).toContain('▸ Code · no change from the base')
  checkout.worktrees['/linked']!.dirty = { 'src/new.ts': 'new' }
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readFlowStatus($)).toContain('▸ Verify · no verify command configured')
  checkout.worktrees['/repo']!.dirty = { 'foreign': 'another edit' }
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect((await readStepStates(world)).Commit).not.toBe('done')
})

test('two units use separate slices and the earlier unit freezes at the later base', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const world = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  const { chat, sessions } = world
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  expect((await declareFlow($, 'small-feature', [2])).deny).toBeUndefined()
  expect(sessions.get('second')?.units[0]?.base).toBe('f1')
  expect(await readFlowStatus($)).toContain('▸ Code · no change from the base')
  chat.id = 'empty-third'
  expect((await declareFlow($, 'small-feature', [3])).deny).toContain('empty slice')
  chat.id = 'second'
  checkout.graph!.refs.feat = 'f2'
  expect((await readStepStates(world)).Commit).toBe('done')
  checkout.dirty = { 'src/a.ts': 'a0' }
  expect(await readFlowStatus($)).toContain('▸ Verify · no verify command configured')
  chat.id = 'sid'
  const first = await readFlowStatus($)
  expect(first).toContain('feat · frozen')
  expect((await readStepStates(world)).Commit).toBe('done')
  expect((await declareFlow($, 'small-feature', [1])).deny).toContain('declare on a new branch')
})

test('frozen Code reads the end tree even when later commits restore the base tree', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const { chat } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await runFlowCommand($, 'trivial')
  chat.id = 'second'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.commits.revert = { parents: ['f1'], files: { 'src/a.ts': 'a0' } }
  checkout.graph!.refs.feat = 'revert'
  chat.id = 'sid'
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readFlowStatus($)).toContain('feat · frozen')
})

test('an empty latest slice refuses another unit, including one declared from another chat', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'm1'
  const { chat, sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  expect((await declareFlow($, 'small-feature', [2])).deny).toContain('empty slice')
  expect(sessions.get('second')?.unit).toBeNull()
})

test('re-declaring a rewritten first unit restores its slice from the live merge-base', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'm2'
  const world = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  const { sessions } = world
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(sessions.get('sid')?.units[0]?.base).toBe('m2')
  checkout.graph!.commits.c = { parents: ['m2'], files: { 'src/a.ts': 'a1', 'src/m.ts': 'm2' } }
  checkout.graph!.refs.feat = 'c'
  expect((await readStepStates(world)).Commit).toBe('done')
  checkout.graph!.commits.rebased = { parents: ['m1'], files: { 'src/a.ts': 'a1' } }
  checkout.graph!.refs.feat = 'rebased'
  expect(await readFlowStatus($)).toContain('feat · rewritten')
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(sessions.get('sid')?.units[0]?.base).toBe('m1')
  const repaired = await readFlowStatus($)
  expect(repaired).not.toContain('rewritten')
  expect(repaired).toContain('✓ Code')
  expect((await readStepStates(world)).Commit).toBe('done')
})

test('re-declaring a rewritten later unit still takes the tip as its base', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const world = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  const { chat, sessions } = world
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.refs.feat = 'o1'
  const status = await readFlowStatus($)
  expect(status).toContain('?/7')
  expect(status).toContain('feat · rewritten')
  expect(status).toContain('? Commit')
  expect(status).toContain('? PR')
  expect(await readPromptContext($)).toContain('branch history rewritten since this unit was declared — re-declare')
  expect((await declareFlow($, 'small-feature', [2])).deny).toBeUndefined()
  expect(sessions.get('second')?.units[0]?.base).toBe('o1')
  expect(await readFlowStatus($)).not.toContain('rewritten')
  expect(await readFlowStatus($)).toContain('▸ Code · no change from the base')
  expect((await readStepStates(world)).Commit).not.toBe('done')
})

test('a continuation in a separate chat preserves an inherited base and advances only after a rewrite', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const world = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  const { chat, sessions } = world
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.refs.feat = 'f2'
  chat.id = 'third'
  await declareFlow($, 'small-feature', [2])
  expect(sessions.get('third')?.units[0]?.base).toBe('f1')
  expect((await readStepStates(world)).Commit).toBe('done')
})

test('known limit: a fast-forward of the unit into its base branch moves the fork point to its tip and empties the slice', async ($, on) => {
  const checkout = branch()
  const { sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await runFlowCommand($, 'trivial')
  expect(sessions.get('sid')?.units[0]).toMatchObject({ base: 'm1', baseBranch: 'main' })
  expect(await readFlowStatus($)).toContain('✓ Code')
  checkout.graph!.refs.main = 'f2'
  checkout.graph!.refs['origin/main'] = 'f2'
  const status = await readFlowStatus($)
  expect(status).toContain('Slice     f2..f2 · empty')
  expect(status).toContain('▸ Code · no change from the base')
})

for (const [name, baseBranch, base, advanced] of [['a child unit', 'par', 'p1', 'p2'], ['a default-branch unit', 'main', 'm1', 'm2']] as const) {
  test(`${name} rebased onto its advanced base branch keeps only its own commit in the slice`, async ($, on) => {
    const graph: Graph = {
      commits: { m0: { parents: [], files: {} }, m1: { parents: ['m0'], files: { m: '1' } }, m2: { parents: ['m1'], files: { m: '2' } },
        p1: { parents: ['m0'], files: { p: '1' } }, p2: { parents: ['p1'], files: { p: '2' } },
        r1: { parents: [advanced], files: { ...(baseBranch === 'par' ? { p: '2' } : { m: '2' }), u: '1' } } },
      refs: { main: baseBranch === 'main' ? 'm2' : 'm0', 'origin/main': baseBranch === 'main' ? 'm2' : 'm0', par: 'p2', feat: 'r1' },
    }
    createWorld(on, { branch: 'feat', graph }, { session: { flow: 'trivial' }, unit: { base, baseBranch } })
    expect(await readFlowStatus($)).toContain(`Slice     ${advanced}..r1\n`)
  })
}

test('a unit declared on the default branch has no Code or Commit evidence', async ($, on) => {
  const checkout = { ...branch(), branch: 'main', dirty: { 'src/new': 'new' } }
  const world = createWorld(on, checkout, { session: { flow: 'trivial' } })
  const status = await readFlowStatus($)
  expect(status).toContain("▸ Code · re-declare on the unit's branch")
  expect(status).toContain('○ Commit\n')
  expect(status).not.toContain('✓ Code')
  expect((await readStepStates(world)).Commit).not.toBe('done')
})

test('default-branch declarations neither acquire bases nor freeze or block other units', async ($, on) => {
  const checkout = { ...branch(), branch: 'main' }
  const { chat, sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect((await declareFlow($, 'small-feature', [2])).deny).toBeUndefined()
  expect(sessions.get('sid')?.units.map(entry => entry.base)).toEqual([undefined, undefined])
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  chat.id = 'another-default-chat'
  expect((await declareFlow($, 'small-feature', [3])).deny).toBeUndefined()
  expect(sessions.get(chat.id)?.units[0]?.base).toBeUndefined()
  chat.id = 'sid'
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(await readFlowStatus($)).not.toContain('frozen')
  expect(await readFlowStatus($)).not.toContain('rewritten')
})

test('continuing a default-branch unit discards an inherited base without judging its history', async ($, on) => {
  const checkout = { ...branch(), branch: 'main' }
  const { sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] }, unit: { base: 'f1' } })
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(sessions.get('sid')?.units[0]?.base).toBeUndefined()
  expect(await readFlowStatus($)).not.toContain('rewritten')
})

test('known limit: detached HEAD at main is not on the default branch', async ($, on) => {
  const checkout = { ...branch(), branch: 'feat', dirty: { new: 'new' } }
  checkout.graph!.refs.feat = checkout.graph!.refs.main!
  createWorld(on, checkout, { session: { flow: 'trivial' } })
  checkout.branch = 'HEAD'
  checkout.graph!.refs.HEAD = checkout.graph!.refs.main!
  const prompt = await readPromptContext($)
  expect(prompt).not.toContain('create a branch')
  expect(prompt).not.toContain("re-declare on the unit's branch")
  expect(prompt).toContain("checked out: HEAD (not this unit's branch)")
})

test('Code compares trees rather than the number of commits and only the current step displays a fact', async ($, on) => {
  const checkout = branch()
  checkout.graph!.commits.empty = { parents: ['m1'], files: { 'src/a.ts': 'a0' } }
  checkout.graph!.refs.feat = 'empty'
  const world = createWorld(on, checkout, { session: { flow: 'trivial' } })
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Code · no change from the base')
  expect((await readStepStates(world)).Commit).toBe('done')
  expect(status).not.toContain('no verify command configured')
  expect(status).not.toContain('uncommitted changes')
})

test('skip unions across session records and done wins over a recorded skip', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'm1'
  const { chat, files } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await runFlowCommand($, 'trivial')
  expect((await runFlowCommand($, 'skip CoDe reviewed elsewhere')).text).toContain('Skipped Code')
  expect(await readFlowStatus($)).toContain('↷ Code · reviewed elsewhere')
  expect(await readFlowStatus($)).toContain('▸ Verify · no verify command configured')
  chat.id = 'second'
  await runFlowCommand($, 'trivial')
  expect(await readFlowStatus($)).toContain('↷ Code · reviewed elsewhere')
  const saved = parseSession(JSON.parse(files.get(`${common}/working-agreement/s/sid.json`) ?? 'null'))
  expect(saved?.units[0]?.skips).toEqual([{ step: 'code', reason: 'reviewed elsewhere' }])
  checkout.graph!.refs.feat = 'f1'
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readFlowStatus($)).not.toContain('reviewed elsewhere')
})

test('skip refuses absent flow, unknown step, empty reason, and every non-composer origin', async ($, on) => {
  createWorld(on, branch(), { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  expect((await runFlowCommand($, 'skip code why')).text).toContain('No flow declared')
  await runFlowCommand($, 'trivial')
  expect((await runFlowCommand($, 'skip absent why')).text).toContain('Unknown step')
  expect((await runFlowCommand($, 'skip code')).text).toContain('non-empty reason')
  expect((await runFlowCommand($, 'skip code why', { kind: 'plugin', name: 'working-agreement' })).text).toContain("user's to run")
})

test('base ancestry orders three slices independently of session filename order', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const world = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  const { chat } = world
  await declareFlow($, 'small-feature', [1])
  chat.id = 'z-last-filename'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.refs.feat = 'f2'
  chat.id = 'a-first-filename'
  await declareFlow($, 'small-feature', [3])
  expect(await readFlowStatus($)).toContain('no change from the base')
  chat.id = 'z-last-filename'
  expect(await readFlowStatus($)).toContain('feat · frozen')
  expect((await readStepStates(world)).Commit).toBe('done')
  chat.id = 'sid'
  expect(await readFlowStatus($)).toContain('feat · frozen')
  expect((await readStepStates(world)).Commit).toBe('done')
})

test('a base repaired in another chat replaces the inherited rewritten base for every chat', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const { chat } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.refs.feat = 'o1'
  chat.id = 'repair'
  await declareFlow($, 'small-feature', [2])
  chat.id = 'second'
  expect(await readFlowStatus($)).not.toContain('rewritten')
  expect(await readFlowStatus($)).toContain('no change from the base')
})

/**
 * Builds a branch cut from an integration branch that is ahead of the default branch.
 * @returns The graph: main at c0, next at n1, feat at f1 on top of n1.
 */
function cutFromNext(): Graph {
  return {
    commits: { c0: { parents: [], files: {} }, n1: { parents: ['c0'], files: { 'src/next.ts': 'n' } }, f1: { parents: ['n1'], files: { 'src/next.ts': 'n', 'src/a.ts': 'a' } } },
    refs: { main: 'c0', 'origin/main': 'c0', next: 'n1', 'origin/next': 'n1', feat: 'f1', 'origin/feat': 'f1' }, upstreams: { feat: 'origin/feat' },
  }
}

for (const [label, prs, base] of [['a PR into next', [buildPullRequest({ baseRefName: 'next', headRefOid: 'f1' })], 'n1'], ['no PR', [], 'c0']] as const) {
  test(`a unit on a branch cut from next with ${label} starts its slice at the merge-base with ${base === 'n1' ? 'next' : 'the default branch'}`, async ($, on) => {
    const { sessions } = createWorld(on, { branch: 'feat', graph: cutFromNext() }, { session: noFlow, prs: [...prs] })
    expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
    expect(sessions.get('sid')?.units[0]?.base).toBe(base)
    expect(await readFlowStatus($)).toContain(`Slice     ${base}..f1`)
  })
}

test('a PR into another base than the unit base came from is a mismatch until re-declaration makes the unit a child of the PR\'s base', async ($, on) => {
  const options: Options = { session: noFlow, prs: [], issueLabels: { 1: ['ready-for-agent'] } }
  const { clock, sessions } = createWorld(on, { branch: 'feat', graph: cutFromNext() }, options)
  await declareFlow($, 'small-feature', [1])
  await runFlowCommand($, 'skip verify covered separately')
  options.prs = [buildPullRequest({ baseRefName: 'next', headRefOid: 'f1' })]
  await clock.advance(61000)
  const status = await readFlowStatus($)
  expect(status).toContain("▸ PR #5 · PR #5 targets next, but the unit's base was taken from main")
  expect(status).toContain('Slice     c0..f1 · base from main, PR into next')
  expect(await readPromptContext($)).toContain("call declare_flow again with the same flow and issues, so the unit's base is taken from next")
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(sessions.get('sid')?.units[0]).toMatchObject({ base: 'n1', baseBranch: 'next' })
  const redeclared = await readFlowStatus($)
  expect(redeclared).toContain('Slice     n1..f1')
  expect(redeclared).toContain('▸ Integrate · PR #5 into next open — merge it')
})

test('a PR base that is not fetched refuses the declaration with the fetch to run', async ($, on) => {
  const graph = cutFromNext()
  const { next: _next, 'origin/next': _origin, ...refs } = graph.refs
  createWorld(on, { branch: 'feat', graph: { ...graph, refs } }, { session: noFlow, prs: [buildPullRequest({ baseRefName: 'next', headRefOid: 'f1' })] })
  expect((await declareFlow($, 'small-feature', [1])).deny).toContain('next is not fetched — run git fetch origin next')
})

test('a child unit\'s slice starts at its fork point on the parent branch through sibling merges, parent advances and merges both ways', async ($, on) => {
  const graph = buildParentGraph()
  // The parent was pushed at the cut and never since, so only the local branch knows where it went.
  graph.refs['origin/par'] = 'p1'
  createWorld(on, { branch: 'b', graph }, { session: noFlow })
  await declareFlow($, 'small-feature', [1])
  expect(await readFlowStatus($)).toContain('Slice     p1..b1\n')
  graph.refs.par = 'ma'
  expect(await readFlowStatus($), 'a sibling integrated with --no-ff').toContain('Slice     p1..b1\n')
  graph.refs.par = 'p2'
  expect(await readFlowStatus($), 'the parent advanced').toContain('Slice     p1..b1\n')
  graph.refs.b = 'b2'
  // The merged parent tip carries the sibling's and the parent's files, so the slice diff holds only src/b.ts.
  expect(await readFlowStatus($), 'the parent merged into the child').toContain('Slice     p2..b2\n')
  graph.refs.par = 'mpar'
  expect(await readFlowStatus($), 'the child integrated with --no-ff').toContain('Slice     p2..b2\n')
})

test('merging the default branch into a unit after declaring keeps its commits out of the slice, even from a stale local default branch', async ($, on) => {
  const graph: Graph = {
    commits: { c0: { parents: [], files: {} }, f1: { parents: ['c0'], files: { 'src/a.ts': 'a' } }, m2: { parents: ['c0'], files: { 'src/m.ts': 'm' } },
      mf: { parents: ['f1', 'm2'], files: { 'src/a.ts': 'a', 'src/m.ts': 'm' } } },
    refs: { main: 'c0', 'origin/main': 'c0', feat: 'f1' },
  }
  createWorld(on, { branch: 'feat', graph }, { session: noFlow })
  await declareFlow($, 'small-feature', [1])
  graph.refs['origin/main'] = 'm2'
  graph.refs.feat = 'mf'
  expect(await readFlowStatus($), 'origin/main fetched and merged, local main left behind').toContain('Slice     m2..mf\n')
  graph.refs.main = 'm2'
  expect(await readFlowStatus($)).toContain('Slice     m2..mf\n')
})

test('a deleted parent branch takes the fork point from its origin copy, then the recorded base, never an unknown slice', async ($, on) => {
  const graph = buildParentGraph()
  createWorld(on, { branch: 'b', graph }, { session: noFlow })
  await declareFlow($, 'small-feature', [1])
  graph.refs.b = 'b2'
  const { par: _par, ...withoutLocal } = graph.refs
  graph.refs = { ...withoutLocal, 'origin/par': 'p2' }
  expect(await readFlowStatus($)).toContain('Slice     p2..b2\n')
  const { 'origin/par': _origin, ...withoutEither } = graph.refs
  graph.refs = withoutEither
  expect(await readFlowStatus($)).toContain('Slice     p1..b2\n')
})

test('a frozen unit measures its fork point from its slice end, so a parent merged in after the next unit stays out of it', async ($, on) => {
  const graph = buildParentGraph()
  const { chat } = createWorld(on, { branch: 'b', graph }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  await declareFlow($, 'small-feature', [2])
  graph.refs = { ...graph.refs, par: 'p2', b: 'b2' }
  chat.id = 'sid'
  expect(await readFlowStatus($)).toContain('Slice     p1..b1\n')
})

test('a child retargeted to the default branch after its parent was merged there takes the merge-base, so the parent\'s delivered commits stay out', async ($, on) => {
  const graph = buildParentGraph()
  graph.commits.mm = { parents: ['c0', 'p2'], files: { 'src/par.ts': 'p2', 'src/a.ts': 'a2' } }
  const options: Options = { session: noFlow, prs: [] }
  const { sessions } = createWorld(on, { branch: 'b', graph }, options)
  await declareFlow($, 'small-feature', [1])
  graph.refs = { ...graph.refs, main: 'mm', 'origin/main': 'mm' }
  options.prs = [buildPullRequest({ headRefName: 'b', headRefOid: 'b1' })]
  expect((await declareFlow($, 'small-feature', [1])).result).toContain('base from main (PR #5).')
  expect(sessions.get('sid')?.units[0]).toMatchObject({ base: 'p1', baseBranch: 'main' })
  expect(await readFlowStatus($)).toContain('Slice     p1..b1\n')
})
