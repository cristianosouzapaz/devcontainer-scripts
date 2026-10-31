import type { Identity, PullRequest, Unit } from '../domain/records'
import { isChildUnit } from '../domain/step-states'
import type { DeliveryFact, Evidence, UnitSlice } from '../domain/step-states'
import { compareCommits, listPullRequests, readCommitChecks, readIssue, readRequiredChecks } from '../lib/github'
import type { GitState } from '../lib/git'
import type { CommitCheck, Comparison, PullRequestCandidate, RequiredChecks } from '../lib/github'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { readGithubStatus } from './github-sync'
import { sessionMemory } from './session-memory'
import { githubTtlMs } from './timing'
import { knownEnd, readChildEnd } from './child-end'
import { readDeclaration } from './record-store'
import { readUnitSlice } from './unit-slice'
import { facts } from '../domain/facts'

interface Cached<T> { at: number; result: Result<T> }

/** The GitHub facts used to judge delivery independently of local evidence. */
type Delivery = Pick<Evidence, 'checks' | 'pullRequest' | 'prFact' | 'prDetail' | 'prFactCode' | 'isConcluded'>

/**
 * Identifies one lifetime of a unit for absorbing conclusions.
 * @param identity - The branch and issues.
 * @param unit - The declaration's evidence.
 * @returns The in-memory lifetime key.
 */
export const unitMemoryKey = (identity: Identity, unit: Unit): string => JSON.stringify([identity, unit.generation ?? null, unit.base ?? null])

/**
 * Reads complete candidate lists into every base, refreshing at most once a minute unless forced.
 * @param port - The engine calls.
 * @param branch - The unit branch.
 * @param isLocal - Whether cached facts remain usable regardless of age.
 * @param isForced - Whether to refresh immediately.
 * @returns Candidates or the current read failure.
 */
export async function readCandidates(port: EnginePort, branch: string, isLocal = false, isForced = false): Promise<Result<PullRequestCandidate[]>> {
  const key = JSON.stringify([branch])
  const cached = sessionMemory.candidates.get(key)
  const now = await port.now()
  const held = readCached(cached, now, isLocal, isForced)
  if (held) return held
  const result = await readGithubStatus(port, isForced) === 'connected' ? await listPullRequests(port.processes, branch) : fail('GitHub unreachable')
  sessionMemory.candidates.set(key, { at: now, result })
  return result
}

/**
 * Reads an issue's state, refreshing at most once a minute unless forced.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param isLocal - Whether cached facts remain usable regardless of age.
 * @param isForced - Whether to refresh immediately.
 * @returns The state as GitHub reports it, or the current read failure.
 */
export async function readIssueState(port: EnginePort, issue: number, isLocal = false, isForced = false): Promise<Result<string>> {
  const now = await port.now()
  const held = readCached(sessionMemory.issueStates.get(issue), now, isLocal, isForced)
  if (held) return held
  const read = await readGithubStatus(port, isForced) === 'connected' ? await readIssue(port.processes, issue) : fail('GitHub unreachable')
  const result = read.isOk ? succeed(read.value.state) : read
  sessionMemory.issueStates.set(issue, { at: now, result })
  return result
}

/**
 * Selects the PR whose base the unit is judged against: the open one, else the most recent merged or closed one.
 * @param candidates - The unit branch's complete candidate list.
 * @returns The PR, null without one, or a refusal naming every open PR when there are several.
 */
export function selectBasePullRequest(candidates: PullRequestCandidate[]): Result<PullRequestCandidate | null> {
  const open = candidates.filter(pr => pr.state === 'OPEN').sort((a, b) => a.number - b.number)
  if (open.length > 1) return fail(`open PRs ${open.map(pr => `#${pr.number} into ${pr.baseRefName}`).join(', ')} share this branch — close all but one`)
  return succeed(open[0] ?? [...candidates].sort((a, b) => b.number - a.number)[0] ?? null)
}

/**
 * Names a PR whose base is not the branch the unit's base was computed against; the base never moves on its own.
 * @param unit - The unit record.
 * @param pullRequest - The unit's PR.
 * @returns The mismatch fact, or null when the bases agree or the unit's base came from no branch.
 */
export function describeBaseMismatch(unit: Unit, pullRequest: PullRequestCandidate | null | undefined): string | null {
  return pullRequest && unit.baseBranch && pullRequest.baseRefName !== unit.baseBranch
    ? `PR #${pullRequest.number} targets ${pullRequest.baseRefName}, but the unit's base was taken from ${unit.baseBranch}` : null
}

/**
 * Drops every cached candidate list, so the next judgement reads the PRs a finished call may have opened or closed.
 */
export function forgetCandidates(): void {
  sessionMemory.candidates.clear()
}

/**
 * Reuses immutable SHA comparisons and reads a missing comparison from GitHub.
 * @param port - The engine calls.
 * @param from - The comparison's base SHA.
 * @param to - The comparison's tip SHA.
 * @returns The comparison, null for an unavailable pair, or a read failure.
 */
async function compare(port: EnginePort, from: string, to: string): Promise<Result<Comparison | null>> {
  const key = JSON.stringify([from, to])
  const cached = sessionMemory.comparisons.get(key)
  if (cached) return succeed(cached)
  const result = await compareCommits(port.processes, from, to)
  // A 404 can become readable after the user pushes; only actual SHA comparisons are immutable.
  if (result.isOk && result.value) sessionMemory.comparisons.set(key, result.value)
  return result
}

/**
 * Tells whether a comparison's tip contains its base: the tip is the base or ahead of it.
 * @param comparison - The comparison of a commit with a PR's head.
 * @returns True when the head contains the commit.
 */
export const isContaining = (comparison: Comparison): boolean => ['identical', 'ahead'].includes(comparison.status)

/**
 * Tells whether a comparison's tip strictly descends from its base.
 * @param comparison - The comparison of a commit with a PR's head.
 * @returns True when the head is ahead of the commit by at least one commit.
 */
export const isDescending = (comparison: Comparison): boolean => comparison.status === 'ahead' && comparison.aheadBy > 0

/**
 * Keeps the PRs whose head a SHA comparison on GitHub accepts.
 * @param port - The engine calls.
 * @param sha - The commit each head is compared with.
 * @param prs - The PRs to examine, in the order kept.
 * @param isKept - Whether a comparison accepts the head.
 * @param isFirstOnly - Whether to stop at the first accepted PR, so no later comparison can fail the read.
 * @returns The accepted PRs, or a comparison failure.
 */
export async function filterByComparison(port: EnginePort, sha: string, prs: PullRequestCandidate[], isKept: (comparison: Comparison) => boolean,
  isFirstOnly = false): Promise<Result<PullRequestCandidate[]>> {
  const kept: PullRequestCandidate[] = []
  for (const pr of prs) {
    const result = await compare(port, sha, pr.headRefOid)
    if (!result.isOk) return result
    if (result.value && isKept(result.value)) kept.push(pr)
    if (isFirstOnly && kept.length) break
  }
  return succeed(kept)
}

/**
 * Joins a unit's own candidates with its parent branch's, as a child unit's conclusion examines them.
 * @param own - The unit branch's candidates.
 * @param parent - The parent branch's candidates, or null for a unit that is no child.
 * @returns Every candidate, or the first read failure.
 */
export function examineCandidates(own: Result<PullRequestCandidate[]>, parent: Result<PullRequestCandidate[]> | null): Result<PullRequestCandidate[]> {
  if (!own.isOk || !parent) return own
  return parent.isOk ? succeed([...own.value, ...parent.value]) : parent
}

/**
 * Finds a merged delivery of this unit, even after its local branch is deleted: for a child unit, a merged PR into the
 * default branch whose head contains its slice end; for any other unit, a merged PR whose head holds any part of it.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @param unit - The unit record.
 * @param candidates - The complete candidate list, with a child unit's parent branch's candidates beside its own.
 * @param defaultBranch - The default branch, which a child unit's delivering PR targets.
 * @param isChild - Whether the unit is a child unit.
 * @param end - The unit's slice end, null when its slice is unreadable or holds no commit; only a child unit is judged on it.
 * @returns The merged PR or null, or a comparison failure.
 */
export async function readConclusion(port: EnginePort, identity: Identity, unit: Unit, candidates: PullRequestCandidate[], defaultBranch: string,
  isChild: boolean, end: string | null = null): Promise<Result<PullRequest | null>> {
  const childEnd = isChild ? end : null
  const key = unitMemoryKey(identity, unit)
  const held = sessionMemory.concluded.get(key)
  // why: A child's conclusion holds for the slice end it was found on: a new commit reopens it, while an end that can no
  // longer be read, as after the branch's deletion, leaves it standing.
  if (held && (childEnd === null || held.end === null || held.end === childEnd)) return succeed(held.pullRequest)
  if (!unit.base) return succeed(null)
  const merged = candidates.filter(pr => pr.state === 'MERGED').sort((a, b) => a.number - b.number)
  // why: A child's own PR into its parent integrates it, as the parent's ancestry shows once fetched; it never delivers it.
  // Its head, not the merge commit, is compared, so a squash or rebase merge of the parent's PR still concludes it.
  const found = !isChild ? await filterByComparison(port, unit.base, merged, isDescending, true)
    : childEnd ? await filterByComparison(port, childEnd, merged.filter(pr => pr.baseRefName === defaultBranch), isContaining, true) : succeed([])
  if (!found.isOk) return found
  const conclusion = found.value[0]
  if (conclusion) sessionMemory.concluded.set(key, { pullRequest: conclusion, end: childEnd })
  return succeed(conclusion ?? null)
}

/**
 * Judges the unit's PR and CI on the slice end against the PR's own base, retaining no GitHub facts on disk.
 * @param port - The engine calls.
 * @param slice - The unit's slice.
 * @param issues - Every issue the PR must close, or none for Trivial.
 * @param describeMissing - Words the fact, and its code, of a required issue the PR does not close.
 * @param unit - The unit record, whose base branch the PR's base must match.
 * @param candidates - The candidate list read for the unit.
 * @param isLocal - Whether cached GitHub facts remain usable regardless of age.
 * @param isForced - Whether CI and branch-rule facts must be refreshed.
 * @returns The PR, CI and first failing fact.
 */
export async function readDelivery(port: EnginePort, slice: UnitSlice | null, issues: number[], describeMissing: (issue: number) => DeliveryFact, unit: Unit, candidates: Result<PullRequestCandidate[]>, isLocal: boolean, isForced = false): Promise<Delivery> {
  const unknown: Delivery = { checks: 'off', isConcluded: false }
  if (!candidates.isOk) return { ...unknown, prFact: facts.githubUnreachable, prFactCode: 'github-unreachable' }
  const chosen = selectBasePullRequest(candidates.value)
  if (!chosen.isOk) return { ...unknown, prFact: facts.closeExtraPrs, prDetail: chosen.error, prFactCode: 'pr-ambiguous' }
  const eligible = candidates.value.filter(pr => pr.state === 'OPEN' || (slice && slice.commits > 0 && pr.state === 'MERGED')).sort((a, b) => a.number - b.number)
  const found = slice ? await filterByComparison(port, slice.end, eligible, isContaining) : succeed([])
  if (!found.isOk) return { ...unknown, prFact: facts.githubUnreachable, prFactCode: 'github-unreachable' }
  const containing = found.value
  const selected = containing.find(pr => pr.state === 'MERGED') ?? containing.find(pr => pr.state === 'OPEN')
  const open = eligible.find(pr => pr.state === 'OPEN')
  if (!selected) return { ...unknown, pullRequest: open, prFact: open ? facts.pushRequired : undefined, prFactCode: open ? 'push-required' : undefined }
  if (selected.state !== 'OPEN') return { ...unknown, pullRequest: selected }
  const mismatch = describeBaseMismatch(unit, selected)
  if (mismatch) return { ...unknown, pullRequest: selected, prFact: facts.retargetPr, prDetail: mismatch, prFactCode: 'base-mismatch' }
  const missing = issues.find(issue => !selected.closingIssuesReferences.includes(issue))
  if (missing !== undefined) return { ...unknown, pullRequest: selected, ...describeMissing(missing) }
  const ci = await readCi(port, slice?.end ?? '', selected.baseRefName, isLocal, isForced)
  return { ...unknown, pullRequest: selected, ...ci }
}

/**
 * Judges delivery against reported and required checks, reading facts missing from the cache.
 * @param port - The engine calls.
 * @param sha - The commit being delivered.
 * @param base - The target branch whose requirements apply.
 * @param isLocal - Whether cached facts remain usable regardless of age.
 * @param isForced - Whether cached facts must be refreshed.
 * @returns The CI state and any fact preventing delivery.
 */
async function readCi(port: EnginePort, sha: string, base: string, isLocal: boolean, isForced: boolean): Promise<Pick<Delivery, 'checks' | 'prFact' | 'prDetail' | 'prFactCode'>> {
  const now = await port.now()
  const checks = sessionMemory.checks.get(sha)
  const rules = sessionMemory.rules.get(base)
  // Only GitHub can finish a pending check, so nothing local triggers the read that would show it.
  const isStale = isForced || judgeCi(checks?.result, rules?.result).checks === 'pending'
  if (!readCached(checks, now, isLocal, isStale)) sessionMemory.checks.set(sha, { at: now, result: await readCommitChecks(port.processes, sha) })
  if (!readCached(rules, now, isLocal, isStale)) sessionMemory.rules.set(base, { at: now, result: await readRequiredChecks(port.processes, base) })
  return judgeCi(sessionMemory.checks.get(sha)?.result, sessionMemory.rules.get(base)?.result)
}

/**
 * Judges delivery against reported and required checks.
 * @param reported - The checks reported on the commit, when read.
 * @param required - The checks the target branch requires, when read.
 * @returns The CI state and any fact preventing delivery.
 */
function judgeCi(reported: Result<CommitCheck[]> | undefined, required: Result<RequiredChecks> | undefined): Pick<Delivery, 'checks' | 'prFact' | 'prDetail' | 'prFactCode'> {
  if (!reported?.isOk || !required?.isOk) return { checks: 'unknown', prFact: facts.ciUnreadable, prFactCode: 'ci-unreadable' }
  const failing = reported.value.find(check => check.state === 'failing')
  if (failing) return { checks: 'failing', prFact: facts.ciFailing, prDetail: `CI failing: ${failing.name}` }
  const pending = reported.value.find(check => check.state === 'pending')
  if (pending) return { checks: 'pending', prFact: facts.ciPending, prDetail: `CI pending: ${pending.name}` }
  const missing = required.value.contexts.find(name => !reported.value.some(check => check.name === name))
  if (missing) return { checks: 'pending', prFact: facts.ciRequiredMissing, prDetail: `required check ${missing} missing` }
  return { checks: 'passing', ...(!reported.value.length ? { prFact: facts.ciNoChecks } : {}) }
}

/**
 * Applies the GitHub freshness policy while allowing local reads and forced refreshes.
 * @param cached - The cached result and observation time.
 * @param now - The current time in milliseconds.
 * @param isLocal - Whether cached facts remain usable regardless of age.
 * @param isForced - Whether freshness must be ignored for a remote refresh.
 * @returns The usable cached result, or undefined when a fresh read is needed.
 */
function readCached<T>(cached: Cached<T> | undefined, now: number, isLocal = false, isForced = false): Result<T> | undefined {
  return cached && (isLocal || (!isForced && now - cached.at < githubTtlMs)) ? cached.result : undefined
}

/**
 * Reads a unit's conclusion as a judgement does, so a declaration decides from git and GitHub alone: a child unit is
 * also judged on its parent branch's PRs and its slice end.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @param unit - The unit record.
 * @param candidates - The unit branch's complete candidate list.
 * @param git - The checkout's repository and default branch.
 * @param isCloseOut - Whether the unit's slice spans its whole branch, read from its declaration when omitted.
 * @returns The merged PR or null, or a read or comparison failure.
 */
export async function readDeclaredConclusion(port: EnginePort, identity: Identity, unit: Unit, candidates: PullRequestCandidate[], git: GitState,
  isCloseOut?: boolean): Promise<Result<PullRequest | null>> {
  const wholeBranch = isCloseOut ?? (await readDeclaration(port, identity))?.flow === 'close-out'
  const isChild = isChildUnit(unit, git.base, wholeBranch)
  const parent = isChild && unit.baseBranch ? await readCandidates(port, unit.baseBranch, false, true) : null
  const examined = examineCandidates(succeed(candidates), parent)
  if (!examined.isOk) return examined
  const end = isChild ? await readChildEnd(port, identity, unit, await readUnitSlice(port, identity, unit, git, wholeBranch)) : undefined
  return readConclusion(port, identity, unit, examined.value, git.base, isChild, knownEnd(end))
}
