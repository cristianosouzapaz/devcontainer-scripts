import type { Identity, PullRequest, Unit, UnitEntry } from '../domain/records'
import { isIntegrationBranch } from '../domain/requirements'
import type { ChildIntegration, ChildUnit, Integration, UnitSlice } from '../domain/step-states'
import { readLocalBranches, readWorktrees } from '../lib/git'
import type { GitState } from '../lib/git'
import type { PullRequestCandidate } from '../lib/github'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { isReachableFromParent, knownEnd, readChildEnd } from './child-end'
import type { ChildEnd } from './child-end'
import type { EnginePort } from './engine-port'
import { composeHerdrRecipe, isInsideHerdr } from './herdr-worktrees'
import { readBaseBranchUnits } from './record-store'
import { examineCandidates, filterByComparison, isContaining, isDescending, readCandidates, readConclusion, readIssueState } from './unit-github'
import { readUnitSlice } from './unit-slice'

/**
 * Holds a parent PR into the default branch that settles a child's delivery: an open one whose head contains the slice
 * end, a merged one whose head contains it, or, with neither, the latest merged one cut after the child whose head lacks it.
 */
interface ParentPullRequest { state: 'open' | 'delivered' | 'stranded'; pullRequest: number }

/** Holds a parent with no PR into the default branch that bears on the child. */
interface NoParentPullRequest { state: 'none' }

/** Holds the merged evidence the records hold for a child unit. */
interface WithEntry { entry: UnitEntry }

/** Holds a child unit of a branch, with the merged evidence the records hold for it. */
export type BranchChild = ChildUnit & WithEntry

/** Holds a child's judgement: its branch's PRs, its conclusion, and its integration, read only while no merged PR concludes it. */
export interface ChildJudgement {
  candidates: Result<PullRequestCandidate[]>
  conclusion: Result<PullRequest | null>
  /** Absent once concluded, or when a read failed and a retry may succeed. */
  integration?: ChildIntegration
}

/** Holds how a branch's children are read. */
interface BranchChildrenOptions {
  isLocal?: boolean
  isForced?: boolean
  /** Whether to stop at the first child that makes the branch an integration branch, for a unit that needs no more than that. */
  isUntilIntegrated?: boolean
}

/** Holds where the parent's PRs into the default branch stand with an integrated child's slice end. */
type ParentDelivery = ParentPullRequest | NoParentPullRequest

/**
 * Judges a child unit as its own position and its parent's Close out both see it: its conclusion, then, unless a
 * merged PR concludes it, its integration. It writes no merge guidance, so it reads nothing a judgement does not need.
 * @param port - The engine calls.
 * @param identity - The child unit's identity.
 * @param unit - The child's merged evidence.
 * @param parent - The child's parent branch.
 * @param git - The checkout's repository and default branch.
 * @param slice - The child's slice, null when it could not be read.
 * @param isLocal - Whether cached GitHub facts remain usable regardless of age.
 * @param isForced - Whether the GitHub facts must be refreshed.
 * @param branches - The local branches, read once for every child a caller judges; read here when omitted.
 * @returns The child branch's PRs, its conclusion and, unless concluded, its integration.
 */
export async function judgeChild(port: EnginePort, identity: Identity, unit: Unit, parent: string, git: GitState, slice: UnitSlice | null,
  isLocal = false, isForced = false, branches?: Set<string> | null): Promise<ChildJudgement> {
  const candidates = await readCandidates(port, identity.branch, isLocal, isForced)
  // A child is delivered by its parent's PR into the default branch, so one read of the parent's PRs serves both its conclusion and its Integrate.
  const parentCandidates = await readCandidates(port, parent, isLocal, isForced)
  const examined = examineCandidates(candidates, parentCandidates)
  const end = await readChildEnd(port, identity, unit, slice, branches)
  const conclusion = examined.isOk ? await readConclusion(port, identity, unit, examined.value, git.base, true, knownEnd(end)) : examined
  if (conclusion.isOk && conclusion.value) return { candidates, conclusion }
  return { candidates, conclusion, integration: await readChildIntegration(port, identity, parent, unit.base, end, git, candidates, parentCandidates) }
}

/**
 * Completes a child's judged integration with the user's merge, which only the child's own guidance shows.
 * @param port - The engine calls.
 * @param integration - The judged integration.
 * @param child - The child branch.
 * @returns The Integrate facts, with the merge command while the child is not integrated.
 */
export async function guideMerge(port: EnginePort, integration: ChildIntegration, child: string): Promise<Integration> {
  return integration.state === 'pending' ? { ...integration, command: await composeMergeCommand(port, integration.parent, child) } : integration
}

/**
 * Composes the command that cuts a new child branch from a parent's tip, naming the parent so the child's reflog
 * records it as the start point; from the parent's worktree a relative path lands beside it, and no path is ever assumed.
 * @param port - The engine calls.
 * @param parent - The parent branch.
 * @returns Inside herdr, the herdr recipe based on the parent; otherwise a `git -C` worktree add in the parent's worktree,
 * or a branch cut when no worktree holds the parent.
 */
export async function composeCutCommand(port: EnginePort, parent: string): Promise<string> {
  const root = await readWorktreeRoot(port, parent)
  if (await isInsideHerdr(port)) return composeHerdrRecipe(quoteArgument(parent), root ? quoteArgument(root) : undefined)
  return root ? `git -C ${quoteArgument(root)} worktree add -b <child-branch> <path> ${quoteArgument(parent)}` : `git branch <child-branch> ${quoteArgument(parent)}`
}

/**
 * Reads every child unit of a branch in the records, the units whose base branch it is, each judged as its own
 * position judges it. A branch with an integrated or stranded child is an integration branch.
 * @param port - The engine calls.
 * @param branch - The branch the children were cut from.
 * @param git - The checkout's repository and default branch.
 * @param options - The GitHub freshness, and whether to stop at the first child that makes the branch an integration branch.
 * @returns The children with their states, or the first read that failed, since a child read as absent would be dropped.
 */
export async function readBranchChildren(port: EnginePort, branch: string, git: GitState, options: BranchChildrenOptions = {}): Promise<Result<BranchChild[]>> {
  if (branch === git.base) return succeed([])
  const units = await readBaseBranchUnits(port, branch)
  if (!units.isOk) return units
  const children: BranchChild[] = []
  const branches = units.value.length ? await readLocalBranches(port.processes) : null
  for (const entry of units.value) {
    const slice = await readUnitSlice(port, entry.identity, entry, git)
    const judged = await judgeChild(port, entry.identity, entry, branch, git, slice, options.isLocal, options.isForced, branches)
    const child = await describeChild(port, entry, judged, options)
    if (!child.isOk) return child
    children.push(child.value)
    if (options.isUntilIntegrated && isIntegrationBranch(children)) break
  }
  return succeed(children)
}

/**
 * Places a judged child among its branch's children: concluded once a merged PR delivers it, else its Integrate state,
 * with the issues still open for a child whose slice end is unknown or whose branch was deleted unmerged, since closing
 * them is the user's way out.
 * @param port - The engine calls.
 * @param entry - The child's merged evidence.
 * @param judged - The child's judgement.
 * @param options - The GitHub freshness.
 * @returns The child, or the read that failed.
 */
async function describeChild(port: EnginePort, entry: UnitEntry, judged: ChildJudgement, options: BranchChildrenOptions): Promise<Result<BranchChild>> {
  const { identity } = entry
  const { conclusion, integration } = judged
  if (!conclusion.isOk) return conclusion
  if (conclusion.value || integration?.state === 'delivered') return succeed({ identity, entry, state: 'concluded' })
  if (!integration) return fail(`integration of ${identity.branch} unreadable`)
  if (integration.state !== 'unknown-end' && integration.state !== 'deleted-unmerged') return succeed({ identity, entry, state: integration.state })
  const openIssues: number[] = []
  for (const issue of identity.issues) {
    const state = await readIssueState(port, issue, options.isLocal, options.isForced)
    if (!state.isOk) return state
    if (state.value !== 'CLOSED') openIssues.push(issue)
  }
  return succeed(integration.state === 'unknown-end' ? { identity, entry, state: 'unknown-end', end: integration.end, openIssues }
    : { identity, entry, state: 'deleted-unmerged', command: integration.command, openIssues })
}

/**
 * Reads the facts that judge a child unit's Integrate step: ancestry by SHA decides, the PRs only enrich the fact.
 * @param port - The engine calls.
 * @param identity - The child unit's branch.
 * @param parent - The child's parent branch.
 * @param base - The child's recorded base, which a parent PR's head must descend from to strand it.
 * @param end - The child's live or observed slice end, undefined when it could not be read.
 * @param git - The checkout's repository and default branch.
 * @param candidates - The child branch's PRs, as read for its delivery.
 * @param parentCandidates - The parent branch's PRs, as read for the child's conclusion.
 * @returns The judged integration, or undefined when a read failed and a retry may succeed.
 */
async function readChildIntegration(port: EnginePort, identity: Identity, parent: string, base: string | undefined, end: ChildEnd | undefined, git: GitState,
  candidates: Result<PullRequestCandidate[]>, parentCandidates: Result<PullRequestCandidate[]>): Promise<ChildIntegration | undefined> {
  if (!end) return undefined
  if (!('end' in end)) return { parent, state: 'unknown-end', branch: identity.branch, end: end.state }
  const isIntegrated = !!end.end && await isReachableFromParent(port, parent, end.end)
  // why: A merge names the child's branch, so once it is gone the user restores it at the end the sessions saw.
  if (end.state === 'observed' && !isIntegrated) {
    return { parent, state: 'deleted-unmerged', branch: identity.branch, end: end.end, command: `git branch ${quoteArgument(identity.branch)} ${quoteArgument(end.end)}` }
  }
  if (end.end && isIntegrated) {
    // why: Only the parent's PRs tell an integrated child from a stranded one, so an unreadable list never reads as done.
    const delivery = parentCandidates.isOk ? await readParentDelivery(port, base, end.end, parentCandidates.value, git.base) : null
    if (!delivery?.isOk) return undefined
    const found = delivery.value
    if (found.state === 'none') return { parent, state: 'integrated' }
    if (found.state === 'open') return { parent, state: 'integrated', parentPullRequest: found.pullRequest }
    return { parent, state: found.state, pullRequest: found.pullRequest }
  }
  const child = candidates.isOk ? candidates.value.filter(pr => pr.state === 'OPEN' && pr.baseRefName === parent).sort((a, b) => a.number - b.number)[0] : undefined
  return { parent, state: 'pending', ...(child ? { childPullRequest: child.number } : {}) }
}

/**
 * Reads where the parent's PRs into the default branch stand with a child's slice end: an open one that contains it,
 * else a merged one that contains it, else the latest merged one that strands the child because its head descends
 * strictly from the child's base without containing it. The descent excludes the parent PRs merged before the child was cut.
 * @param port - The engine calls.
 * @param base - The child's recorded base, without which no PR can strand it.
 * @param end - The child's slice end.
 * @param parentCandidates - The parent branch's PRs.
 * @param defaultBranch - The default branch the parent's PRs deliver into.
 * @returns The parent PR that settles the child's delivery, none, or a comparison failure.
 */
async function readParentDelivery(port: EnginePort, base: string | undefined, end: string, parentCandidates: PullRequestCandidate[],
  defaultBranch: string): Promise<Result<ParentDelivery>> {
  const delivering = parentCandidates.filter(pr => pr.baseRefName === defaultBranch).sort((a, b) => a.number - b.number)
  const merged = delivering.filter(pr => pr.state === 'MERGED')
  const steps: [ParentPullRequest['state'], string | undefined, PullRequestCandidate[], typeof isContaining][] = [
    ['open', end, delivering.filter(pr => pr.state === 'OPEN'), isContaining],
    ['delivered', end, merged, isContaining],
    ['stranded', base, [...merged].reverse(), isDescending],
  ]
  for (const [state, sha, prs, isKept] of steps) {
    if (!sha) continue
    const found = await filterByComparison(port, sha, prs, isKept, true)
    if (!found.isOk) return found
    if (found.value[0]) return succeed({ state, pullRequest: found.value[0].number })
  }
  return succeed({ state: 'none' })
}

/**
 * Writes the user's merge of the child into its parent, in the worktree that holds the parent; no path is ever assumed.
 * @param port - The engine calls.
 * @param parent - The parent branch.
 * @param child - The child branch.
 * @returns A `git -C` merge in the parent's worktree, or a command naming both branches when no worktree holds the parent.
 */
async function composeMergeCommand(port: EnginePort, parent: string, child: string): Promise<string> {
  const root = await readWorktreeRoot(port, parent)
  return root ? `git -C ${quoteArgument(root)} merge --no-ff ${quoteArgument(child)}` : `git switch ${quoteArgument(parent)} && git merge --no-ff ${quoteArgument(child)}`
}

/**
 * Finds the worktree that holds a branch, as `git worktree list` reports it.
 * @param port - The engine calls.
 * @param branch - The branch.
 * @returns The worktree's root, or undefined when no worktree holds the branch or the list is unreadable.
 */
async function readWorktreeRoot(port: EnginePort, branch: string): Promise<string | undefined> {
  return (await readWorktrees(port.processes))?.find(worktree => worktree.branch === `refs/heads/${branch}`)?.root
}

/**
 * Quotes a shell argument only when it holds a character the shell would interpret.
 * @param value - The argument.
 * @returns The argument, single-quoted when needed.
 */
function quoteArgument(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}
