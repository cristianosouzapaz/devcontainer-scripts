import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { coordinator, noFlow } from '../support/builders'
import { callModTool, declareFlow, runFlowCommand } from '../support/helpers'
import { answerParents } from '../support/issue-github'
import { test } from '../support/kit'
import { childCheckout, coveredSkips, delegationCheckout, gatedCheckout, gateOptions, readDelegated, readObservedEndFile, seedDelegatedChild, seedGeneration, seedTwoChildren,
  seedUnit, tipA, tipB, twoChildren } from '../support/parallel-worktrees'
import { buildScope, createTestPort, createWorld, delegatedFile, placedFile, records, scopeFile, seedDelegation } from '../support/world'
import type { Checkout, Graph, World } from '../support/world'
import type { VerifyEvidence } from '../../types'
import { writeVerifyEvidence } from '../../hooks/core/verify'
import { mergeChildren } from '../../hooks/core/child-merge'

/** The merge commit of child `a` the modelled merge names after its tip. */
const mergeA = `merge-${tipA}`

/** The merge commit of child `b` the modelled merge names after its tip. */
const mergeB = `merge-${tipB}`

/** Children `a` and `b`, stacked in that order, each at its tip. */
const bothChildren = [{ branch: 'a', tip: tipA }, { branch: 'b', tip: tipB }]

/** The usage merge_child answers a call without a full tip for each of 1 to 3 distinct children. */
const usage = '[working-agreement] give child with tip, or children as 1 to 3 { branch, tip } entries; tip is the full 40-hex SHA from the review\'s GO, '
  + 'never an abbreviation or a branch name.'

/** The commit the reviewers' GO named on child `a`, one commit above `a2`. */
const goTip = `a3${'0'.repeat(38)}`

/** A commit child `a` made after the GO, on top of it. */
const laterTip = `a4${'0'.repeat(38)}`

/**
 * Moves child `a` past the GO: `goTip` above `a2`, then `laterTip` above it, the branch at `laterTip`.
 * @param git - The history before the call.
 * @returns The history with both commits.
 */
const commitAfterGo = (git: Graph): Graph => ({ ...git,
  commits: { ...git.commits, [goTip]: { parents: ['a2'], files: { 'src/par.ts': 'p1', 'src/a.ts': 'go' } },
    [laterTip]: { parents: [goTip], files: { 'src/par.ts': 'p1', 'src/a.ts': 'later' } } },
  refs: { ...git.refs, a: laterTip } })

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
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged).toEqual({ text: expect.stringContaining('Merged a into par (fast-forward), recorded as delegated'), isError: false })
  expect(merged.text).toMatch(/Verify \S+ passed on tree/)
  expect(live.graph?.refs.par).toBe(tipA)
  expect(world.files.has(placedFile('par', tipA))).toBe(true)
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
  for (const sha of ['a1', tipA]) world.files.set(delegatedFile(sha), JSON.stringify({ v: 1, key: sha, sha, branch: 'a' }))
  expect((await callModTool($, 'merge_child', { child: 'a', tip: tipA })).text).toContain(`Merged a into ${round} (fast-forward), recorded as delegated`)
  expect(live.graph?.refs[round]).toBe(tipA)
})

// contract: a child whose unit declares its delegated group and the group's native sub-issues is a known merge_child pair
test('a finished child that declares its delegated group and the group\'s sub-issues is merged', async ($, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, gh: answerParents({ 21: 2 }) })
  await world.ready
  await seedUnit(world, 'child', { branch: 'a', issues: [2, 21] }, { skips: coveredSkips(), base: 'p1', baseBranch: 'par' })
  await seedUnit(world, 'parent', { branch: 'par', issues: [1] }, { skips: coveredSkips() })
  world.files.set(scopeFile('sid'), buildScope('sid', [1, 2]))
  for (const sha of ['a1', tipA]) world.files.set(delegatedFile(sha), JSON.stringify({ v: 1, key: sha, sha, branch: 'a' }))
  expect((await callModTool($, 'merge_child', { child: 'a', tip: tipA })).text).toContain('Merged a into par (fast-forward), recorded as delegated')
  expect(live.graph?.refs.par).toBe(tipA)
})

test('a finished child merges into a moved parent by a merge commit Verify passed in a temporary worktree, recorded as delegated on the parent', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a', tip: tipA })).text).toContain(`Merged a into par (merge ${mergeA}), recorded as delegated`)
  expect(live.graph?.commits[mergeA]?.parents).toEqual(['p3', tipA])
  expect(world.runs.some(run => run.startsWith('git worktree add ') && run.endsWith(` ${mergeA}`))).toBe(true)
  expect(live.worktrees?.['/par.verify']).toBeUndefined()
  expect(world.files.has(placedFile('par', mergeA))).toBe(true)
  const delegated = readDelegated(world)
  expect(delegated).toContainEqual(expect.objectContaining({ sha: mergeA, branch: 'par' }))
})

// contract: a merge_child whose record write fails after the parent moved answers stopped, naming the merged tip, never that it could not run
test('a merge whose record write fails after the parent moved answers stopped, naming the merged tip', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const failures = { left: 2 }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, failRun: argv => {
    if (argv[0] !== 'mv' || !(argv.at(-1) ?? '').includes('/delegated/') || live.graph?.refs.par !== mergeA || failures.left <= 0) return undefined
    failures.left -= 1
    return { exitCode: 1, stderr: 'disk full' }
  } })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.text).toContain(`merge_child stopped: a was merged into par at ${mergeA}, but its record was not written (disk full)`)
  expect(merged.text).not.toContain('could not run')
  expect(live.graph?.refs.par).toBe(mergeA)
})

test('the merge commit a gating Verify checks out on a detached HEAD is recorded as placed by the mod while that Verify runs', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const during = { isPlaced: false }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: () => {
    during.isPlaced = live.worktrees?.['/par.verify']?.head === mergeA && world.files.has(placedFile('/par.verify', mergeA))
  } })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a', tip: tipA })).isError).toBe(false)
  expect(during.isPlaced).toBe(true)
})

test('a branch outside the pair that moves while the merged tree is verified leaves the merge recorded as delegated', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const moveOther = () => { live.graph = { ...live.graph!, commits: { ...live.graph!.commits, o1: { parents: ['p1'], files: live.graph!.commits.p1!.files } }, refs: { ...live.graph!.refs, other: 'o1' } } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: moveOther })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a', tip: tipA })).text).toContain(`Merged a into par (merge ${mergeA}), recorded as delegated`)
  expect(readDelegated(world)).toContainEqual(expect.objectContaining({ sha: mergeA, branch: 'par' }))
})

test('a child that moves while the merged tree is verified leaves the merge standing but not recorded as delegated', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const moveChild = () => { live.graph = { ...live.graph!, commits: { ...live.graph!.commits, a3: { parents: [tipA], files: live.graph!.commits[tipA]!.files } }, refs: { ...live.graph!.refs, a: 'a3' } } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: moveChild })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('merge_child stopped: ')
  expect(merged.text).toContain('not recorded as delegated')
  expect(live.graph?.refs.par).toBe(mergeA)
  expect(readDelegated(world)).not.toContainEqual(expect.objectContaining({ sha: mergeA }))
})

test('a child whose merge into the moved parent fails Verify leaves the parent tip where it was, naming the command, its output and its log', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, spawnCode: 1, spawnOutput: 'check: 1 failing' })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(live.graph?.refs.par).toBe('p3')
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('Verify failed on tree')
  expect(merged.text).toContain('["./check"]')
  expect(merged.text).toContain('check: 1 failing')
  expect(merged.text).toMatch(/see \S+\.log/)
  expect(merged.text).toContain('this call did not move par')
  expect(merged.text).not.toContain('stays at')
  expect(live.worktrees?.['/par.verify']).toBeUndefined()
})

test('a merged tree Verify already passed on moves the parent without another run', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const spawns = { count: 0 }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: () => { spawns.count += 1 } })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a', tip: tipA })).isError).toBe(false)
  live.graph = { ...live.graph!, refs: { ...live.graph!.refs, par: 'p3' } }
  const again = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(again.text).toMatch(/Verify \S+ already passed on tree/)
  expect(live.graph?.refs.par).toBe(mergeA)
  expect(spawns.count).toBe(1)
})

test('a unit-stage pass on the merged tree does not let the gate skip its Verify', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const spawns = { count: 0 }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: () => { spawns.count += 1 } })
  await seedDelegatedChild(world)
  await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  const [path, text] = [...world.files].find(([file]) => file.startsWith(`${records}/v/`))!
  const gatePass = JSON.parse(text) as VerifyEvidence
  world.files.delete(path)
  await writeVerifyEvidence(createTestPort(world), { ...gatePass.run, stage: 'unit' }, gatePass.origin)
  live.graph = { ...live.graph!, refs: { ...live.graph!.refs, par: 'p3' } }
  const again = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(again.text).not.toContain('already passed')
  expect(spawns.count).toBe(2)
})

test('the gate runs the gate and both rules and names the unit-only rules it leaves out', async ($, on) => {
  const config = JSON.stringify({ always: [['./check']], rules: [{ paths: ['src/**'], run: ['./unit-only'], stage: 'unit' },
    { paths: ['src/**'], run: ['./gate-only'], stage: 'gate' }, { paths: ['src/**'], run: ['./default'] }] })
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }), config)
  const world = createWorld(on, live, { session: coordinator, verifyFile: config, approvedConfig: config })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.text).toContain('Selection: rules src/** · gate stage · left out as unit-only: ./unit-only')
  const stored = [...world.files].filter(([file]) => file.startsWith(`${records}/v/`)).map(([, json]) => (JSON.parse(json) as VerifyEvidence).run)
  expect(stored).toEqual([expect.objectContaining({ commands: [['./check'], ['./gate-only'], ['./default']], stage: 'gate' })])
})

// contract: a final fast-forward refused because the parent moved during the gate reads the parent back and answers unknown, naming where it is
test('a parent tip that moves while the merged tree is verified stays where it moved, and whether the child was merged is unknown', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const moveTip = () => { live.graph = { ...live.graph!, commits: { ...live.graph!.commits, p4: { parents: ['p3'], files: live.graph!.commits.p3!.files } }, refs: { ...live.graph!.refs, par: 'p4' } } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: moveTip })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain(`par is at p4, neither p3 nor the verified ${mergeA}, so whether a was merged is unknown`)
  expect(merged.text).toContain('check git log -1 par and plan')
  expect(merged.text).not.toContain('tip moved')
  expect(live.graph?.refs.par).toBe('p4')
  expect(world.files.has(placedFile('par', mergeA))).toBe(false)
})

test('a finished child that merged its parent\'s tip merges with --no-ff, so the parent\'s first-parent line keeps its earlier integrations', async ($, on) => {
  const bridged = `ab${'0'.repeat(38)}`
  const live = gatedCheckout(git => {
    const moved = advancePar({ 'src/par.ts': 'p3' })(git)
    return { ...moved, commits: { ...moved.commits, [bridged]: { parents: ['a2', 'p3'], files: { 'src/par.ts': 'p3', 'src/a.ts': 'a2' } } }, refs: { ...moved.refs, a: bridged } }
  })
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a', tip: bridged })).text).toContain(`Merged a into par (merge merge-${bridged}), recorded as delegated`)
  expect(live.graph?.commits[`merge-${bridged}`]?.parents).toEqual(['p3', bridged])
})

// contract: a conflicting child is handed over as a merge of the commit the call bound, under its branch's message, never of the branch
test('a conflicting child is handed back naming the conflicting paths, leaving the parent where it was', async ($, on) => {
  const live = delegationCheckout(advancePar({ 'src/par.ts': 'p1', 'src/a.ts': 'theirs' }))
  const world = createWorld(on, live, { session: coordinator })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('conflicts in src/a.ts')
  expect(merged.text).toContain(`merging it is the user's: git -C /par merge --no-ff -m "Merge branch 'a' into par" ${tipA}`)
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
  // why: a merge is logged as delegated-merge alone: the record it writes, and the call's window that finds it in place, log no delegated-commit.
  await world.clock.settle()
  const events = [...world.files].filter(([path]) => path.startsWith(`${records}/log/`))
    .flatMap(([, text]) => text.split('\n').filter(Boolean).map(line => (JSON.parse(line) as { event: string }).event))
  expect(events).toContain('delegated-merge')
  expect(events).not.toContain('delegated-commit')
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
    const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
    expect(merged.isError).toBe(true)
    expect(merged.text).toContain(refusal)
    expect(live.graph?.refs.par).toBe('p1')
  })
}

for (const [name, change, child] of [
  ['a child with no reflog start point', (git: Graph) => ({ ...git, created: {} }), 'a'],
  ['a child whose parent branch was deleted', (git: Graph) => ({ ...git, created: { a: 'gone' } }), 'a'],
  ['a missing child', (git: Graph) => git, 'nope'],
] as const) {
  test(`${name} is refused without calling it a merge into main`, async ($, on) => {
    const live = delegationCheckout(change)
    const world = createWorld(on, live, { session: coordinator })
    await seedDelegatedChild(world)
    const merged = await callModTool($, 'merge_child', { child, tip: tipA })
    expect(merged.isError).toBe(true)
    expect(merged.text).not.toContain('merge into main')
    expect(live.graph?.refs.par).toBe('p1')
  })
}

test('a missing child is named as no branch, listing the delegated units\' real branches', async ($, on) => {
  const live = delegationCheckout(git => ({ ...git, refs: { ...git.refs, 'fix/2-the-child': 'a2' } }))
  const world = createWorld(on, live, { session: coordinator })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'fix/2-the-chld', tip: tipA })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('no branch named fix/2-the-chld')
  expect(merged.text).toContain('fix/2-the-child')
})

test('children stacked in one call move the parent to the top of the stack after one Verify of that tree', async ($, on) => {
  const { live, options } = twoChildren()
  const spawns = { count: 0 }
  const world = createWorld(on, live, { ...options, afterSpawn: () => { spawns.count += 1 } })
  await seedTwoChildren(world)
  const merged = await callModTool($, 'merge_child', { children: bothChildren })
  expect(merged).toEqual({ text: expect.stringContaining(`Merged a (fast-forward), b (merge ${mergeB}) into par, recorded as delegated`), isError: false })
  expect(live.graph?.refs.par).toBe(mergeB)
  expect(live.graph?.commits[mergeB]?.parents).toEqual([tipA, tipB])
  expect(spawns.count).toBe(1)
  expect(readDelegated(world)).toContainEqual(expect.objectContaining({ sha: mergeB, branch: 'par' }))
})

test('a red stack is bisected by prefix: the parent moves to the green prefix and the child that broke it is named', async ($, on) => {
  const { live, options } = twoChildren([mergeB])
  const world = createWorld(on, live, options)
  await seedTwoChildren(world)
  const merged = await callModTool($, 'merge_child', { children: bothChildren })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('check: 1 failing')
  expect(merged.text).toContain('merge_child stopped: ')
  expect(merged.text).toContain('Bisected: Verify passed with the children before b and failed once it was added')
  expect(merged.text).toContain('Merged a into par (fast-forward), recorded as delegated')
  expect(merged.text).toContain('Send this to b\'s unit')
  expect(live.graph?.refs.par).toBe(tipA)
})

test('a stack red from its first child moves nothing and hands the later children back for another call', async ($, on) => {
  const { live, options } = twoChildren([tipA, mergeB])
  const world = createWorld(on, live, options)
  await seedTwoChildren(world)
  const merged = await callModTool($, 'merge_child', { children: bothChildren })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('merge_child stopped: ')
  expect(merged.text).toContain('Bisected: Verify failed with only a')
  expect(merged.text).toContain('this call did not move par')
  expect(merged.text).not.toContain('stays at')
  expect(merged.text).toContain('Send this to a\'s unit')
  expect(merged.text).toContain('b was not merged: run merge_child for it again')
  expect(live.graph?.refs.par).toBe('p1')
})

for (const [name, parentWorktree, handOver] of [
  ['no worktree holds the parent', null, `git switch par && git merge --no-ff -m "Merge branch 'a' into par" ${tipA} && git merge --no-ff -m "Merge branch 'b' into par" ${tipB}`],
  ['the parent\'s worktree has uncommitted changes', { branch: 'par', isDirty: true },
    `git -C /par merge --no-ff -m "Merge branch 'a' into par" ${tipA} && git -C /par merge --no-ff -m "Merge branch 'b' into par" ${tipB}`],
] as const) {
  // contract: a stack the mod cannot merge hands the user one valid merge command per child, in stack order, each merging the commit the call bound.
  test(`children stacked in one call when ${name} are handed over as one merge per child, in stack order`, async ($, on) => {
    const { live, options } = twoChildren()
    const others = Object.fromEntries(Object.entries(live.worktrees ?? {}).filter(([path]) => path !== '/par'))
    live.worktrees = parentWorktree ? { ...others, '/par': parentWorktree } : others
    const world = createWorld(on, live, options)
    await seedTwoChildren(world)
    const merged = await callModTool($, 'merge_child', { children: bothChildren })
    expect(merged.isError).toBe(true)
    expect(merged.text).toContain(`merging it is the user's: ${handOver}. Run it as one line: a conflict stops it at that child, and the children after it are not merged.`)
    expect(live.graph?.refs.par).toBe('p1')
  })
}

for (const [name, input] of [
  ['both child and children', { child: 'a', tip: tipA, children: [{ branch: 'b', tip: tipB }] }],
  ['neither child nor children', {}],
  ['a repeated child', { children: [{ branch: 'a', tip: tipA }, { branch: 'a', tip: tipA }] }],
  ['more than three children', { children: [...bothChildren, { branch: 'c', tip: tipA }, { branch: 'd', tip: tipB }] }],
  ['no children', { children: [] }],
] as const) {
  // contract: a malformed batch gets merge_child's usage from the handler before dispatch, so no read the merge makes can answer it
  test(`merge_child with ${name} is refused with its usage before dispatch and no ref moves`, async ($, on) => {
    const { live, options } = twoChildren()
    const world = createWorld(on, live, options)
    await seedTwoChildren(world)
    const merged = await callModTool($, 'merge_child', input)
    expect(merged).toEqual({ text: usage, isError: true })
    expect(live.graph?.refs.par).toBe('p1')
  })
}

test('a session that is not the coordinator cannot merge a child', async ($, on) => {
  const live = delegationCheckout()
  const world = createWorld(on, live, { session: noFlow })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a', tip: tipA })).text).toContain('only a coordinator merges a child into its parent')
  expect(live.graph?.refs.par).toBe('p1')
})

/**
 * Builds the tip-differs refusal merge_child answers for a child whose branch moved.
 * @param child - The child branch.
 * @param live - The tip its branch holds.
 * @param given - The tip given.
 * @returns The refusal's text.
 */
const tipDiffers = (child: string, live: string, given: string): string => `merge_child refused: ${child}'s tip is ${live}, not the tip given, ${given}, `
  + `so nothing was merged and no ref moved. Check what changed with git log --oneline ${given}...${live} before calling merge_child with another tip.`

/**
 * Gives child `a`'s unit a lifetime, in its declaration and its session's mirror, so a slice read of it would cache its observed end,
 * and lets the writes the seeding started settle.
 * @param world - The world, seeded with the delegated child.
 */
async function giveLifetime(world: World): Promise<void> {
  await seedGeneration(world, { branch: 'a', issues: [2] }, 'child:a:1')
  const mirror = `${records}/s/child.json`
  const seeded = JSON.parse(world.files.get(mirror)!) as { units: object[] }
  world.files.set(mirror, JSON.stringify({ ...seeded, units: seeded.units.map(entry => ({ ...entry, generation: 'child:a:1' })) }))
  await world.clock.settle()
}

/**
 * Lists the placed-ref records naming a place.
 * @param world - The world.
 * @param place - The branch.
 * @returns The records' paths.
 */
const placedRecords = (world: World, place: string): string[] => [...world.files.keys()].filter(path => path.startsWith(`${records}/placed/${place}@`))

// contract: merge_child refuses a child whose branch is not at the tip given, before any Verify, ref write or record
test('a finished child that committed after the GO is refused for the GO\'s tip, naming both commits, and nothing moves', async ($, on) => {
  const live = gatedCheckout(commitAfterGo)
  const spawns = { count: 0 }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: () => { spawns.count += 1 } })
  await seedDelegatedChild(world)
  for (const sha of [goTip, laterTip]) world.files.set(delegatedFile(sha), JSON.stringify({ v: 1, key: sha, sha, branch: 'a' }))
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: goTip })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain(tipDiffers('a', laterTip, goTip))
  expect(live.graph?.refs.par).toBe('p1')
  expect(placedRecords(world, 'par')).toEqual([])
  expect(spawns.count).toBe(0)
  expect(readDelegated(world)).not.toContainEqual(expect.objectContaining({ branch: 'par' }))
})

// contract: a stack whose later child is not at its tip is refused whole: no earlier child merges and no gate runs
test('a stack whose second child moved is refused whole, the first child unmerged and no gate run', async ($, on) => {
  const { live, options } = twoChildren()
  const spawns = { count: 0 }
  const world = createWorld(on, live, { ...options, afterSpawn: () => { spawns.count += 1 } })
  await seedTwoChildren(world)
  const merged = await callModTool($, 'merge_child', { children: [{ branch: 'a', tip: tipA }, { branch: 'b', tip: goTip }] })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain(tipDiffers('b', tipB, goTip))
  expect(live.graph?.refs.par).toBe('p1')
  expect(spawns.count).toBe(0)
  expect(placedRecords(world, 'par')).toEqual([])
})

for (const [name, input] of [
  ['a child without tip', { child: 'a' }],
  ['a children entry without tip', { children: [{ branch: 'a' }] }],
  ['an abbreviated tip', { child: 'a', tip: tipA.slice(0, 12) }],
  ['a branch name as tip', { child: 'a', tip: 'a' }],
  ['children as branch names', { children: ['a'] }],
] as const) {
  // contract: merge_child without a full 40-hex tip for every child is refused with its usage before any git read
  test(`merge_child with ${name} is refused with its usage before any git read`, async ($, on) => {
    const live = gatedCheckout()
    const world = createWorld(on, live, { session: coordinator, ...gateOptions })
    await seedDelegatedChild(world)
    const merged = await callModTool($, 'merge_child', input)
    expect(merged).toEqual({ text: usage, isError: true })
    expect(live.graph?.refs.par).toBe('p1')
    expect(placedRecords(world, 'par')).toEqual([])
  })
}

// contract: a well-formed tip no branch points at is a tip that differs, and nothing changes
test('a full SHA that matches no branch tip is refused as a tip that differs', async ($, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: 'f'.repeat(40) })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain(tipDiffers('a', tipA, 'f'.repeat(40)))
  expect(live.graph?.refs.par).toBe('p1')
  expect(placedRecords(world, 'par')).toEqual([])
})

// contract: a moved tip is refused before the uncommitted-changes hand-over, so no hand-over names a commit nobody reviewed
test('a moved tip with a dirty parent worktree is refused as a tip that differs, not handed over', async ($, on) => {
  const live = gatedCheckout(commitAfterGo)
  live.worktrees = { ...live.worktrees, '/par': { branch: 'par', isDirty: true } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await seedDelegatedChild(world)
  for (const sha of [goTip, laterTip]) world.files.set(delegatedFile(sha), JSON.stringify({ v: 1, key: sha, sha, branch: 'a' }))
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: goTip })
  expect(merged.text).toContain(tipDiffers('a', laterTip, goTip))
  expect(merged.text).not.toContain('uncommitted changes')
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a child its parent already holds is reported integrated whatever its tip, and the ready child after it merges
test('an integrated child with a moved tip is reported integrated and the ready child after it merges', async ($, on) => {
  const { live, options } = twoChildren()
  live.graph = { ...live.graph!, refs: { ...live.graph!.refs, par: tipA } }
  const world = createWorld(on, live, options)
  await seedTwoChildren(world)
  const merged = await callModTool($, 'merge_child', { children: [{ branch: 'a', tip: goTip }, { branch: 'b', tip: tipB }] })
  expect(merged.isError).toBe(false)
  expect(merged.text).toContain('a is already integrated into par.')
  expect(merged.text).toContain(`Merged b into par (merge ${mergeB}), recorded as delegated`)
  expect(live.graph?.refs.par).toBe(mergeB)
})

// contract: merge_child reads a failed ref listing as unknown, never as a missing branch
test('a ref listing that fails is named as unknown tips, never as no branch', async ($, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions,
    failRun: argv => argv.includes('for-each-ref') || argv.includes('show-ref') ? { exitCode: 128, stderr: 'fatal: bad object' } : undefined })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('the local branch tips could not be read, so whether a exists and where it points is unknown and nothing was merged; '
    + 'check with git for-each-ref refs/heads, then call merge_child again.')
  expect(merged.text).not.toContain('no branch named')
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a child is judged at the tip merge_child read, so a branch reset before its position is read never passes as already integrated
test('a child reset onto its parent\'s tip after the tips are read is judged at the tip read, never as already integrated', async (_$, on) => {
  const live = gatedCheckout(git => ({ ...git, refs: { ...git.refs, par: 'a1' } }))
  const reset = { isArmed: false, isDone: false }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions,
    beforeRun: argv => {
      if (reset.isArmed && !reset.isDone) {
        reset.isDone = true
        live.graph = { ...live.graph!, refs: { ...live.graph!.refs, a: 'a1' } }
      }
      if (argv.includes('for-each-ref')) reset.isArmed = true
    } })
  await seedDelegatedChild(world)
  const merged = await mergeChildren(createTestPort(world), [{ branch: 'a', tip: tipA }], new AbortController().signal)
  const text = merged.isOk ? merged.value : merged.error
  expect(text).not.toContain('already integrated')
  expect(reset.isDone).toBe(true)
  expect(live.graph?.refs.par).toBe(tipA)
})

// contract: a refused merge_child writes no record, even the slice end a unit with a lifetime would otherwise cache
test('a tip-mismatch refusal of a unit with a lifetime leaves every record unchanged', async (_$, on) => {
  const live = gatedCheckout(commitAfterGo)
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await seedDelegatedChild(world)
  for (const sha of [goTip, laterTip]) world.files.set(delegatedFile(sha), JSON.stringify({ v: 1, key: sha, sha, branch: 'a' }))
  await giveLifetime(world)
  const before = new Map(world.files)
  const merged = await mergeChildren(createTestPort(world), [{ branch: 'a', tip: goTip }], new AbortController().signal)
  await world.clock.settle()
  expect(merged.isOk ? merged.value : merged.error).toContain(`a's tip is ${laterTip}, not the tip given, ${goTip}`)
  expect(await readObservedEndFile(world, { branch: 'a', issues: [2] }, 'sid')).toBeUndefined()
  expect(new Map(world.files)).toEqual(before)
})

// contract: a refusal because the children have different parents writes no record, even the slice ends their checks saw
test('a refusal for children of different parents leaves every record unchanged', async (_$, on) => {
  const { live, options } = twoChildren()
  live.graph = { ...live.graph!, refs: { ...live.graph!.refs, par2: 'p1' }, created: { ...live.graph!.created, b: 'par2' } }
  const world = createWorld(on, live, options)
  await seedDelegatedChild(world, [1, 2, 3, 4])
  await seedUnit(world, 'child-b', { branch: 'b', issues: [3] }, { skips: coveredSkips(), base: 'p1', baseBranch: 'par2' })
  await seedUnit(world, 'parent-2', { branch: 'par2', issues: [4] }, { skips: coveredSkips() })
  world.files.set(delegatedFile(tipB), JSON.stringify({ v: 1, key: tipB, sha: tipB, branch: 'b' }))
  await giveLifetime(world)
  const before = new Map(world.files)
  const merged = await mergeChildren(createTestPort(world), bothChildren, new AbortController().signal)
  await world.clock.settle()
  expect(merged.isOk ? merged.value : merged.error).toContain('the children of one merge_child call share one parent branch: a → par, b → par2.')
  expect(new Map(world.files)).toEqual(before)
})

// contract: a refusal for the parent's uncommitted changes writes no record, even the slice end its check saw
test('a refusal for a dirty parent worktree leaves every record unchanged', async (_$, on) => {
  const live = gatedCheckout()
  live.worktrees = { ...live.worktrees, '/par': { branch: 'par', isDirty: true } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await seedDelegatedChild(world)
  await giveLifetime(world)
  const before = new Map(world.files)
  const merged = await mergeChildren(createTestPort(world), [{ branch: 'a', tip: tipA }], new AbortController().signal)
  await world.clock.settle()
  expect(merged.isOk ? merged.value : merged.error).toContain('/par has uncommitted changes')
  expect(new Map(world.files)).toEqual(before)
})

// contract: a merge that goes through caches the slice end its check saw for a unit with a lifetime
test('a merged child with a lifetime has its slice end cached', async (_$, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions })
  await seedDelegatedChild(world)
  await giveLifetime(world)
  const merged = await mergeChildren(createTestPort(world), [{ branch: 'a', tip: tipA }], new AbortController().signal)
  await world.clock.settle()
  expect(merged.isOk).toBe(true)
  expect(await readObservedEndFile(world, { branch: 'a', issues: [2] }, 'sid')).toBe(tipA)
})

// contract: a parent worktree status that cannot be read is named as unknown, never as uncommitted changes
test('the parent worktree\'s status that cannot be read is named as unknown, never as uncommitted changes', async ($, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions,
    failRun: argv => argv.join(' ').includes('-C /par status') ? { exitCode: 128, stderr: 'fatal: unreadable' } : undefined })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain('the status of /par could not be read, so whether it has uncommitted changes is unknown and nothing was merged; '
    + 'check with git -C /par status, then call merge_child again.')
  expect(merged.text).not.toContain('/par has uncommitted changes')
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a worktree list that cannot be read is named as unknown, never as no worktree holding the parent
test('a worktree list that cannot be read is named as unknown, never as no worktree holding the parent', async (_$, on) => {
  const live = gatedCheckout()
  live.worktrees = { ...live.worktrees, '/par': { branch: 'par', isDirty: true } }
  const failing = { at: -1, seen: 0 }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, failRun: argv => {
    if (argv.join(' ').includes('worktree list') && (failing.seen += 1) === failing.at) return { exitCode: 128, stderr: 'fatal: unreadable' }
    return undefined
  } })
  await seedDelegatedChild(world)
  const port = createTestPort(world)
  const start = world.runs.length
  // why: the unit's own position reads the list too, so a refused pass counts the reads up to merge_child's own, the last before the parent's status.
  expect((await mergeChildren(port, [{ branch: 'a', tip: tipA }], new AbortController().signal)).isOk).toBe(false)
  const window = world.runs.slice(start, world.runs.findIndex((run, index) => index >= start && run.includes('-C /par status')))
  live.worktrees = { ...live.worktrees, '/par': { branch: 'par' } }
  failing.at = failing.seen + window.filter(run => run.includes('worktree list')).length
  const merged = await mergeChildren(port, [{ branch: 'a', tip: tipA }], new AbortController().signal)
  const text = merged.isOk ? merged.value : merged.error
  expect(text).toBe('the worktree list could not be read, so which worktree holds par is unknown and nothing was merged; '
    + 'check with git worktree list --porcelain, then call merge_child again.')
  expect(live.graph?.refs.par).toBe('p1')
})

/**
 * Fails the final fast-forward of `par` with a lock error, optionally moving `par` or dirtying `/par` first, as git updates the worktree
 * before the ref; optionally it fails the placed record's removal, or every ref listing after the failure.
 * @param live - The checkout.
 * @param moveTo - The commit `par` is moved to before the failure, if any.
 * @param isRemovalFailing - Whether removing the placed record fails.
 * @param effect - Whether the failure leaves `/par` dirty, or makes the read-back fail.
 * @returns The world's failRun option.
 */
const failFinalMove = (live: Checkout, moveTo?: string, isRemovalFailing = false, effect?: 'dirty' | 'unreadable') => {
  const state = { isFailed: false }
  return (argv: string[]) => {
    if (argv.includes('--ff-only')) {
      state.isFailed = true
      if (moveTo) live.graph = { ...live.graph!, refs: { ...live.graph!.refs, par: moveTo } }
      const parRoot = Object.entries(live.worktrees ?? {}).find(([, worktree]) => worktree.branch === 'par')?.[0] ?? '/par'
      if (effect === 'dirty') live.worktrees = { ...live.worktrees, [parRoot]: { branch: 'par', isDirty: true } }
      return { exitCode: 1, stderr: 'fatal: cannot lock ref \'refs/heads/par\'' }
    }
    if (effect === 'unreadable' && state.isFailed && argv.includes('for-each-ref')) return { exitCode: 128, stderr: 'fatal: unreadable refs' }
    return isRemovalFailing && argv[0] === 'rm' && argv.some(arg => arg.includes('/placed/par@')) ? { exitCode: 1, stderr: 'rm: read-only file system' } : undefined
  }
}

// contract: a failed final fast-forward that leaves the parent's worktree changed is a stop saying so and how to restore it, never that nothing changed
test('a final fast-forward that fails after changing the parent\'s worktree is a stop naming the worktree and how to restore it', async ($, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, failRun: failFinalMove(live, undefined, false, 'dirty') })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.text).toContain(`merge_child stopped: git merge --ff-only ${tipA} failed in /par (exit 1: fatal: cannot lock ref 'refs/heads/par'), `
    + `so par stays at p1 and nothing was merged into it, but /par is no longer clean: the failed merge may have left ${tipA}'s files there; `
    + 'check with git -C /par status, and once nothing there is anyone\'s own work, restore it with git -C /par reset --hard p1; then call merge_child again.')
  expect(merged.text).not.toContain('merge_child refused')
  expect(world.files.has(placedFile('par', tipA))).toBe(false)
})

// contract: the commands a failed final fast-forward hands over quote the parent's worktree, so a path with a space still runs
test('a failed final fast-forward in a worktree whose path holds a space hands over quoted commands', async ($, on) => {
  const live = gatedCheckout()
  live.worktrees = { ...Object.fromEntries(Object.entries(live.worktrees ?? {}).filter(([path]) => path !== '/par')), '/work/parent tree': { branch: 'par' } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, failRun: failFinalMove(live, undefined, false, 'dirty') })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.text).toContain('check with git -C \'/work/parent tree\' status, and once nothing there is anyone\'s own work, '
    + 'restore it with git -C \'/work/parent tree\' reset --hard p1; then call merge_child again.')
  expect(merged.text).not.toContain('git -C /work/parent tree')
})

// contract: a failed final fast-forward whose parent cannot be read back is unknown, names no tip it did not read and keeps the placed record
test('a final fast-forward that fails and whose parent cannot be read back is unknown, keeping the placed record', async ($, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, failRun: failFinalMove(live, undefined, false, 'unreadable') })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.text).toContain(`git merge --ff-only ${tipA} failed in /par (exit 1: fatal: cannot lock ref 'refs/heads/par'), `
    + 'and par\'s tip could not be read back, so whether a was merged is unknown')
  expect(merged.text).toContain('check git log -1 par and plan')
  expect(merged.text).not.toContain('neither')
  expect(world.files.has(placedFile('par', tipA))).toBe(true)
})

// contract: a final fast-forward that fails with the parent unchanged names git's error and leaves no placed record claiming the move
test('a final fast-forward that fails with the parent unchanged names git\'s error and removes its placed record', async ($, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, failRun: failFinalMove(live) })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.isError).toBe(true)
  expect(merged.text).toContain(`git merge --ff-only ${tipA} failed in /par (exit 1: fatal: cannot lock ref 'refs/heads/par'), so nothing was merged and par stays at p1; `
    + 'check with git -C /par status, then call merge_child again.')
  expect(merged.text).not.toContain('tip moved')
  expect(live.graph?.refs.par).toBe('p1')
  expect(world.files.has(placedFile('par', tipA))).toBe(false)
})

// contract: a final fast-forward refused on a tree whose gate pass is already recorded is a refusal, since nothing ran and nothing changed
test('a final fast-forward that fails after a recorded gate pass is refused', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const failing = { isOn: false }
  const failRun = failFinalMove(live)
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, failRun: argv => failing.isOn ? failRun(argv) : undefined })
  await seedDelegatedChild(world)
  expect((await callModTool($, 'merge_child', { child: 'a', tip: tipA })).isError).toBe(false)
  live.graph = { ...live.graph!, refs: { ...live.graph!.refs, par: 'p3' } }
  world.files.delete(placedFile('par', mergeA))
  failing.isOn = true
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.text).toContain(`merge_child refused: git merge --ff-only ${mergeA} failed in /par (exit 1: fatal: cannot lock ref 'refs/heads/par'), so nothing was merged and par stays at p3`)
  expect(world.files.has(placedFile('par', mergeA))).toBe(false)
})

// contract: a final fast-forward that fails and whose placed record cannot be removed is a stop naming the record left behind
test('a final fast-forward that fails and leaves its placed record is a stop naming that record', async ($, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, failRun: failFinalMove(live, undefined, true) })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.text).toContain('merge_child stopped: ')
  expect(merged.text).toContain(`par stays at p1, but its placed-ref record ${placedFile('par', tipA)} could not be removed (rm: read-only file system); remove that file`)
  expect(world.files.has(placedFile('par', tipA))).toBe(true)
})

// contract: a final fast-forward that exits nonzero with the parent at the verified commit is a stop that records the merge as delegated
test('a final fast-forward that exits nonzero with the parent at the verified commit is recorded as delegated and stopped', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, failRun: failFinalMove(live, mergeA) })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.text).toContain(`merge_child stopped: a was merged into par at ${mergeA} (the verified commit) and recorded as delegated, `
    + 'but git merge exited 1 (fatal: cannot lock ref \'refs/heads/par\'); check with git -C /par status.')
  expect(readDelegated(world)).toContainEqual(expect.objectContaining({ sha: mergeA, branch: 'par' }))
})

// contract: a final fast-forward that exits nonzero with the parent at the verified commit names a record write that failed
test('a final fast-forward that exits nonzero with the parent at the verified commit names a failed record write', async ($, on) => {
  const live = gatedCheckout(advancePar({ 'src/par.ts': 'p3' }))
  const failMove = failFinalMove(live, mergeA)
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, failRun: argv =>
    argv[0] === 'mv' && (argv.at(-1) ?? '').includes('/delegated/') && live.graph?.refs.par === mergeA ? { exitCode: 1, stderr: 'disk full' } : failMove(argv) })
  await seedDelegatedChild(world)
  const merged = await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  expect(merged.text).toContain(`merge_child stopped: a was merged into par at ${mergeA} (the verified commit), but git merge exited 1 `
    + '(fatal: cannot lock ref \'refs/heads/par\') and the merge is not recorded as delegated (its record was not written (disk full)) — tell the user.')
  expect(readDelegated(world)).not.toContainEqual(expect.objectContaining({ sha: mergeA }))
})
