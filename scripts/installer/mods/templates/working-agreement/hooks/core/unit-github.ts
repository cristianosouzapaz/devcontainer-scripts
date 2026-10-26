import type { Identity, PullRequest, Unit } from '../domain/records'
import type { Evidence, UnitSlice } from '../domain/step-states'
import { compareCommits, listPullRequests, readCommitChecks, readRequiredChecks } from '../lib/github'
import type { CommitCheck, Comparison, PullRequestCandidate, RequiredChecks } from '../lib/github'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { readGithubStatus } from './github-sync'
import { sessionMemory } from './session-memory'
import { githubTtlMs } from './timing'

interface Cached<T> { at: number; result: Result<T> }

/** The GitHub facts used to judge delivery independently of local evidence. */
type Delivery = Pick<Evidence, 'checks' | 'pullRequest' | 'prFact' | 'prFactCode' | 'isConcluded'>

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
 * Finds a merged delivery of any part of this unit, even after its local branch is deleted.
 * @param port - The engine calls.
 * @param identity - The unit identity.
 * @param unit - The unit record.
 * @param candidates - The complete candidate list.
 * @returns The merged PR or null, or a comparison failure.
 */
export async function readConclusion(port: EnginePort, identity: Identity, unit: Unit, candidates: PullRequestCandidate[]): Promise<Result<PullRequest | null>> {
  const key = unitMemoryKey(identity, unit)
  const held = sessionMemory.concluded.get(key)
  if (held) return succeed(held)
  if (!unit.base) return succeed(null)
  for (const candidate of candidates.filter(pr => pr.state === 'MERGED').sort((a, b) => a.number - b.number)) {
    const result = await compare(port, unit.base, candidate.headRefOid)
    if (!result.isOk) return result
    if (result.value && result.value.status === 'ahead' && result.value.aheadBy > 0) {
      sessionMemory.concluded.set(key, candidate)
      return succeed(candidate)
    }
  }
  return succeed(null)
}

/**
 * Judges the unit's PR and CI on the slice end against the PR's own base, retaining no GitHub facts on disk.
 * @param port - The engine calls.
 * @param slice - The unit's slice.
 * @param issues - Every issue the PR must close, or none for Trivial.
 * @param unit - The unit record, whose base branch the PR's base must match.
 * @param candidates - The candidate list read for the unit.
 * @param isLocal - Whether cached GitHub facts remain usable regardless of age.
 * @param isForced - Whether CI and branch-rule facts must be refreshed.
 * @returns The PR, CI and first failing fact.
 */
export async function readDelivery(port: EnginePort, slice: UnitSlice | null, issues: number[], unit: Unit, candidates: Result<PullRequestCandidate[]>, isLocal: boolean, isForced = false): Promise<Delivery> {
  const unknown: Delivery = { checks: 'off', isConcluded: false }
  if (!candidates.isOk) return { ...unknown, prFact: 'GitHub unreachable', prFactCode: 'github-unreachable' }
  const chosen = selectBasePullRequest(candidates.value)
  if (!chosen.isOk) return { ...unknown, prFact: chosen.error, prFactCode: 'pr-ambiguous' }
  const eligible = candidates.value.filter(pr => pr.state === 'OPEN' || (slice && slice.commits > 0 && pr.state === 'MERGED')).sort((a, b) => a.number - b.number)
  const containing: PullRequestCandidate[] = []
  if (slice) {
    for (const pr of eligible) {
      const result = await compare(port, slice.end, pr.headRefOid)
      if (!result.isOk) return { ...unknown, prFact: 'GitHub unreachable', prFactCode: 'github-unreachable' }
      if (result.value && ['identical', 'ahead'].includes(result.value.status)) containing.push(pr)
    }
  }
  const selected = containing.find(pr => pr.state === 'MERGED') ?? containing.find(pr => pr.state === 'OPEN')
  const open = eligible.find(pr => pr.state === 'OPEN')
  if (!selected) return { ...unknown, pullRequest: open, prFact: open ? "PR does not contain the unit's last commit — push" : 'no PR', prFactCode: open ? 'push-required' : undefined }
  if (selected.state !== 'OPEN') return { ...unknown, pullRequest: selected, prFact: 'no PR' }
  const mismatch = describeBaseMismatch(unit, selected)
  if (mismatch) return { ...unknown, pullRequest: selected, prFact: mismatch, prFactCode: 'base-mismatch' }
  const missing = issues.find(issue => !selected.closingIssuesReferences.includes(issue))
  if (missing !== undefined) return { ...unknown, pullRequest: selected, prFact: `PR does not close #${missing}` }
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
async function readCi(port: EnginePort, sha: string, base: string, isLocal: boolean, isForced: boolean): Promise<Pick<Delivery, 'checks' | 'prFact' | 'prFactCode'>> {
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
function judgeCi(reported: Result<CommitCheck[]> | undefined, required: Result<RequiredChecks> | undefined): Pick<Delivery, 'checks' | 'prFact' | 'prFactCode'> {
  if (!reported?.isOk || !required?.isOk) return { checks: 'unknown', prFact: 'CI could not be read', prFactCode: 'ci-unreadable' }
  const failing = reported.value.find(check => check.state === 'failing')
  if (failing) return { checks: 'failing', prFact: `CI failing: ${failing.name}` }
  const pending = reported.value.find(check => check.state === 'pending')
  if (pending) return { checks: 'pending', prFact: `CI pending: ${pending.name}` }
  const missing = required.value.contexts.find(name => !reported.value.some(check => check.name === name))
  if (missing) return { checks: 'pending', prFact: `required check ${missing} missing` }
  return { checks: 'passing', ...(!reported.value.length ? { prFact: 'CI: no checks reported' } : {}) }
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
