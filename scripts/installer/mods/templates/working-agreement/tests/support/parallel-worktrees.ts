import type { StepSkip } from '../../types'
import type { Identity, UnitEntry } from '../../hooks/domain/records'
import { buildParentGraph, buildParentPullRequest, coordinator } from './builders'
import { buildScope, configBlob, declarationFile, delegatedFile, hashIdentity, records, scopeFile } from './world'
import type { Checkout, Graph, Options, World } from './world'

/** A gated checkout with two finished children, and the world options whose gate command fails on chosen trees. */
export interface TwoChildren { live: Checkout; options: Options }

/** A child unit cut from parent, as the declaration caches it. */
export const childUnit: Options = { unit: { base: 'p0', baseBranch: 'parent' } }

/** A Close out on issue 1 with Verify skipped, awaiting only its PR. */
export const roundCloseOut: Options = {
  session: { flow: 'close-out', issues: [1], info: { 1: { title: 'round', labels: [] } } }, unit: { skips: [{ step: 'verify', reason: 'covered separately' }] },
}

/** The Verify config every commit of a gated checkout carries: one command, which every merged tree runs. */
const gateConfig ='{"always":[["./check"]]}'

/** Approves the gated checkout's config, so merge_child's Verify runs its command. */
export const gateOptions: Options = { verifyFile: gateConfig, approvedConfig: gateConfig }

/** The full SHA child `a`'s tip carries in the delegation workflow, the reference workflow's `a2`, so merge_child can be given it as a tip. */
export const tipA = `a2${'0'.repeat(38)}`

/** The full SHA child `b`'s tip carries in the delegation workflow, the reference workflow's `b1`. */
export const tipB = `b1${'0'.repeat(38)}`

/** The child tips the delegation workflow renames to full SHAs. */
const fullTips: Record<string, string> = { a2: tipA, b1: tipB }

/**
 * Builds the parallel workflow: main, a parent branch cut from it, the session's child with one slice commit, and a sibling.
 * @param refs - Refs that replace or add to the defaults.
 * @returns The history before the call.
 */
const parallelGraph = (refs: Record<string, string>): Graph => ({
  commits: { m0: { parents: [], files: {} }, p0: { parents: ['m0'], files: { p: '0' } }, c1: { parents: ['p0'], files: { p: '0', c: '1' } } },
  refs: { main: 'm0', 'origin/main': 'm0', parent: 'p0', child: 'c1', sibling: 'p0', ...refs },
})

/**
 * Places the session's own worktree (`/repo`) on child, the main worktree on parent and the sibling in its own worktree.
 * @param worktrees - Worktrees that replace or add to the defaults.
 * @param refs - Refs that replace or add to the defaults.
 * @returns The checkout before the call.
 */
export const parallelCheckout = (worktrees: Checkout['worktrees'] = {}, refs: Record<string, string> = {}): Checkout => ({
  branch: 'child', graph: parallelGraph(refs),
  worktrees: { '/repo': { branch: 'child' }, '/main': { branch: 'parent' }, '/sibling': { branch: 'sibling' }, ...worktrees },
})

/**
 * Adds a commit to a history and moves a branch onto it.
 * @param graph - The history, left unchanged.
 * @param id - The new commit.
 * @param parents - Its parents.
 * @param branch - The branch moved onto it, if any.
 * @returns The history with the commit.
 */
export const withCommit = (graph: Graph, id: string, parents: string[], branch?: string): Graph => ({
  ...graph, commits: { ...graph.commits, [id]: { parents, files: { [id]: id } } }, refs: branch ? { ...graph.refs, [branch]: id } : graph.refs,
})

/**
 * Builds a child entry shaped like the records a sibling's session leaves behind.
 * @param branch - The child's branch.
 * @param issue - The child's issue.
 * @param changes - Fields that replace the child of `par` cut at `p1`.
 * @returns The entry.
 */
export const buildChildEntry = (branch: string, issue: number, changes: Partial<UnitEntry> = {}): UnitEntry =>
  ({ identity: { branch, issues: [issue] }, base: 'p1', baseBranch: 'par', skills: [], verifyRuns: [], runs: [], generation: `dead:${branch}:1`, ...changes })

/**
 * Writes another chat's mirror holding the given child entries, and their declarations.
 * @param world - The world.
 * @param units - The entries.
 * @returns The mirror's and the declarations' paths.
 */
export async function seedChildren(world: World, units: UnitEntry[]): Promise<string[]> {
  const mirror = `${records}/s/dead.json`
  world.files.set(mirror, JSON.stringify({ ...world.sessions.get('sid')!, sessionId: 'dead', unit: units[0]!.identity, units }))
  const declarations = await Promise.all(units.map(async ({ identity, generation }) => {
    const path = await declarationFile(identity)
    world.files.set(path, JSON.stringify({ v: 1, identity, flow: 'small-feature', generation }))
    return path
  }))
  return [mirror, ...declarations]
}

/**
 * Checks out parent branch `par` of the reference workflow in the session's worktree.
 * @param refs - Refs that replace the graph's defaults, such as `par` moved onto a merge.
 * @returns The checkout.
 */
export const parentCheckout = (refs: Record<string, string> = {}): Checkout => {
  const graph = buildParentGraph()
  return { branch: 'par', graph: { ...graph, refs: { ...graph.refs, ...refs } }, worktrees: { '/repo': { branch: 'par' } } }
}

/**
 * Builds the open PR of `par` into the default branch that delivers the round.
 * @param head - The PR's head.
 * @param issues - The issues the PR closes.
 * @returns A candidate response sample.
 */
export const buildRoundPullRequest = (head: string, issues: number[]): Record<string, unknown> =>
  buildParentPullRequest({ number: 10, state: 'OPEN', headRefOid: head, closingIssuesReferences: issues.map(number => ({ number })) })

/**
 * Names a session's observed slice end file of a unit.
 * @param identity - The unit identity.
 * @param owner - The writing session.
 * @returns The path.
 */
export const observedEndFile = async (identity: Identity, owner: string): Promise<string> =>
  `${records}/end/${await hashIdentity(identity.branch, identity.issues)}/${owner}.json`

/**
 * Writes a session's observed slice end of a unit, as that session's judgement leaves it.
 * @param world - The world.
 * @param identity - The unit identity.
 * @param owner - The writing session.
 * @param end - The observed end.
 * @param generation - The unit lifetime it was observed in.
 * @returns The path.
 */
export async function seedObservedEnd(world: World, identity: Identity, owner: string, end: string, generation: string): Promise<string> {
  const path = await observedEndFile(identity, owner)
  world.files.set(path, JSON.stringify({ v: 1, identity, generation, end }))
  return path
}

/**
 * Reads the end a session's observed end file holds.
 * @param world - The world.
 * @param identity - The unit identity.
 * @param owner - The writing session.
 * @returns The end, or undefined without a file.
 */
export async function readObservedEndFile(world: World, identity: Identity, owner: string): Promise<string | undefined> {
  const text = world.files.get(await observedEndFile(identity, owner))
  return text === undefined ? undefined : (JSON.parse(text) as { end: string }).end
}

/**
 * Gives the session's own unit a lifetime in its declaration, as a declaration writes it, once the world is ready.
 * @param world - The world, whose session entry already carries the generation.
 * @param identity - The unit identity.
 * @param generation - The lifetime.
 */
export async function seedGeneration(world: World, identity: Identity, generation: string): Promise<void> {
  await world.ready
  const path = await declarationFile(identity)
  world.files.set(path, JSON.stringify({ ...JSON.parse(world.files.get(path)!) as object, generation }))
}

/**
 * Deletes a branch from a history, as a merged PR's cleanup does.
 * @param graph - The history, left unchanged.
 * @param branch - The branch.
 * @returns The history without the branch.
 */
export const withoutBranch = (graph: Graph, branch: string): Graph => ({ ...graph, refs: Object.fromEntries(Object.entries(graph.refs).filter(([name]) => name !== branch)) })

/**
 * Checks out child `a` of the reference workflow in the session's worktree `/repo`, its parent `par` held by `/par`.
 * @param change - Rewrites the reference workflow's history.
 * @returns The checkout.
 */
export const childCheckout = (change: (git: Graph) => Graph = git => git): Checkout => ({
  branch: 'a', graph: change(buildParentGraph()), worktrees: { '/repo': { branch: 'a' }, '/par': { branch: 'par' } },
})

/**
 * Renames commits of a history, in its commits, their parents, its refs and its reflog cuts.
 * @param graph - The history, left unchanged.
 * @param names - The new id of each renamed commit.
 * @returns The renamed history.
 */
const renameCommits = (graph: Graph, names: Record<string, string>): Graph => {
  const rename = (id: string) => names[id] ?? id
  const renameValues = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([key, id]) => [key, rename(id)]))
  return { ...graph, commits: Object.fromEntries(Object.entries(graph.commits).map(([id, commit]) => [rename(id), { ...commit, parents: commit.parents.map(rename) }])),
    refs: renameValues(graph.refs), ...graph.cuts ? { cuts: renameValues(graph.cuts) } : {} }
}

/**
 * Checks out the coordinator on the default branch, with parent `par` held by `/par` and child `a` (issue 2, cut from `par`) by `/a`;
 * the children's tips `a2` and `b1` carry the full SHAs `tipA` and `tipB`, so merge_child can be given them.
 * @param change - Rewrites the reference workflow's history before the call, naming the tips `a2` and `b1`.
 * @returns The checkout.
 */
export const delegationCheckout = (change: (git: Graph) => Graph = git => git): Checkout => ({
  branch: 'main', graph: renameCommits(change(buildParentGraph()), fullTips), worktrees: { '/repo': { branch: 'main' }, '/par': { branch: 'par' }, '/a': { branch: 'a' } },
})

/**
 * Checks out the delegation workflow with the gate config committed in every commit, as the world's working trees hold it under `gateOptions`;
 * a config only in the working tree reads as an uncommitted change, which refuses merge_child before any Verify.
 * @param change - Rewrites the reference workflow's history before the config is committed.
 * @param config - The committed config, `gateOptions`' unless a test approves another one.
 * @returns The checkout.
 */
export const gatedCheckout = (change: (git: Graph) => Graph = git => git, config = gateConfig): Checkout => delegationCheckout(git => {
  const changed = change(git)
  return { ...changed, commits: Object.fromEntries(Object.entries(changed.commits).map(([sha, commit]) =>
    [sha, { ...commit, files: { ...commit.files, '.claude/working-agreement.json': configBlob(config) } }])) }
})

/**
 * Seeds another session holding one unit, its mirror and the unit's declaration, as a unit session writes them once the world is ready.
 * @param world - The world.
 * @param sessionId - The unit's session.
 * @param identity - The unit's branch and issue.
 * @param entry - Unit entry fields, such as skips and base.
 * @param flow - The declared flow.
 */
export async function seedUnit(world: World, sessionId: string, identity: Identity, entry: Partial<UnitEntry> = {}, flow = 'small-feature'): Promise<void> {
  await world.ready
  world.files.set(`${records}/s/${sessionId}.json`, JSON.stringify({ ...world.sessions.get('sid'), role: undefined, sessionId,
    info: { [identity.issues[0]!]: { title: identity.branch, labels: [] } }, unit: identity, units: [{ identity, skills: [], verifyRuns: [], runs: [], ...entry }] }))
  world.files.set(await declarationFile(identity), JSON.stringify({ v: 1, identity, flow }))
}

/**
 * Seeds the child's and the parent's unit sessions, the coordinator's scope over the issues, and the child's delegated commits.
 * @param world - The world.
 * @param issues - The issues the scope delegates.
 */
export async function seedDelegatedChild(world: World, issues = [1, 2]): Promise<void> {
  await world.ready
  await seedUnit(world, 'child', { branch: 'a', issues: [2] }, { skips: coveredSkips(), base: 'p1', baseBranch: 'par' })
  await seedUnit(world, 'parent', { branch: 'par', issues: [1] }, { skips: coveredSkips() })
  world.files.set(scopeFile('sid'), buildScope('sid', issues))
  for (const sha of ['a1', tipA]) world.files.set(delegatedFile(sha), JSON.stringify({ v: 1, key: sha, sha, branch: 'a' }))
}

/**
 * Lists the delegated-commit records the mod wrote.
 * @param world - The world.
 * @returns The decoded records.
 */
export const readDelegated = (world: World): unknown[] =>
  [...world.files].filter(([path]) => path.startsWith(`${records}/delegated/`)).map(([, text]) => JSON.parse(text) as unknown)

/**
 * Builds the steps a seeded unit has past it, skipped as covered.
 * @returns The skips, fresh for each test.
 */
export function coveredSkips(): StepSkip[] {
  return ['grill', 'spec', 'code', 'verify'].map(step => ({ step, reason: 'covered' }))
}

/**
 * Builds the options of child `a`, cut from `par` in the reference workflow, past Commit: its base and base branch as the declaration
 * caches them, with Code and Verify skipped.
 * @returns The world options, fresh for each test.
 */
export function parChild(): Options {
  return { unit: { base: 'p1', baseBranch: 'par', skips: [{ step: 'code', reason: 'covered' }, { step: 'verify', reason: 'covered' }] } }
}

/**
 * Builds the gated delegation workflow with a second finished child, `b` (issue 3, cut from `par` at `p1`), in its own worktree.
 * @param redAt - The commits whose tree fails the gate's command when a gating Verify checks them out.
 * @returns The checkout, and the world options whose command fails on those trees.
 */
export function twoChildren(redAt: string[] = []): TwoChildren {
  const live = gatedCheckout()
  live.worktrees = { ...live.worktrees, '/b': { branch: 'b' } }
  const spawnCode = () => redAt.includes(live.worktrees?.['/par.verify']?.head ?? '') ? 1 : 0
  return { live, options: { session: coordinator, ...gateOptions, spawnCode, spawnOutput: 'check: 1 failing' } }
}

/**
 * Seeds both children of the two-children workflow as finished delegated units in this coordinator's scope.
 * @param world - The world.
 */
export async function seedTwoChildren(world: World): Promise<void> {
  await seedDelegatedChild(world, [1, 2, 3])
  await seedUnit(world, 'child-b', { branch: 'b', issues: [3] }, { skips: coveredSkips(), base: 'p1', baseBranch: 'par' })
  world.files.set(delegatedFile(tipB), JSON.stringify({ v: 1, key: tipB, sha: tipB, branch: 'b' }))
}
