import type { Identity, UnitEntry } from '../../hooks/domain/records'
import { buildParentGraph, buildParentPullRequest } from './builders'
import { common, hashIdentity } from './world'
import type { Checkout, Graph, Options, World } from './world'

/** A child unit cut from parent, as the declaration caches it. */
export const childUnit: Options = { unit: { base: 'p0', baseBranch: 'parent' } }

/** A Close out on #1 with Verify skipped, awaiting only its PR. */
export const roundCloseOut: Options = {
  session: { flow: 'close-out', issues: [1], info: { 1: { title: 'round', labels: [] } } }, unit: { skips: [{ step: 'verify', reason: 'covered separately' }] },
}

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
  const directory = `${common}/working-agreement`
  const mirror = `${directory}/s/dead.json`
  world.files.set(mirror, JSON.stringify({ ...world.sessions.get('sid')!, sessionId: 'dead', unit: units[0]!.identity, units }))
  const declarations = await Promise.all(units.map(async ({ identity, generation }) => {
    const path = `${directory}/u/${await hashIdentity(identity.branch, identity.issues)}.json`
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
  `${common}/working-agreement/end/${await hashIdentity(identity.branch, identity.issues)}/${owner}.json`

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
  const path = `${common}/working-agreement/u/${await hashIdentity(identity.branch, identity.issues)}.json`
  world.files.set(path, JSON.stringify({ ...JSON.parse(world.files.get(path)!) as object, generation }))
}

/**
 * Deletes a branch from a history, as a merged PR's cleanup does.
 * @param graph - The history, left unchanged.
 * @param branch - The branch.
 * @returns The history without the branch.
 */
export const withoutBranch = (graph: Graph, branch: string): Graph => ({ ...graph, refs: Object.fromEntries(Object.entries(graph.refs).filter(([name]) => name !== branch)) })
