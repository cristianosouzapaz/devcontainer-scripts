import { findFlow, hasDiagnoseStep, hasIssueTreeStep } from '../domain/flow-definitions'
import type { GithubStatus, IssueInfo } from '../domain/records'
import type { GithubFailure, IssueComment, IssueRead, ReadFailure, SubIssueInfo } from '../../types'
import { probeGithub, readIssue, readIssueComments, readSubIssues } from '../lib/github'
import type { IssueSnapshot } from '../lib/github'
import type { ProcessPort } from '../lib/process'
import { createLimiter } from '../lib/queue'
import { fail } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { updateSession } from './record-store'
import type { VersionedSession } from './record-store'
import { sessionMemory, withRecordLock } from './session-memory'
import { githubTtlMs } from './timing'

/** What GitHub answered for one issue: its fields, and its comments and sub-issues where its flow judges them. */
export interface IssueAnswer {
  issue: Result<IssueSnapshot>
  comments: Result<IssueComment[]> | undefined
  subIssues: Result<SubIssueInfo[]> | undefined
}

/** An issue's info merged from one answer, and why part of that answer failed, null when all of it succeeded. */
interface IssueMerge { info: IssueInfo; error: string | null }

/** How an issue sync runs: whether it reads within its minute, and whether a probe that last failed runs again then. */
interface SyncOptions { isForced?: boolean; isProbeForced?: boolean }

// why: `/flow status` probes on its own and through the re-read it starts; a forced read this soon after another
// reuses that probe, in flight or settled, rather than paying for a second one.
const probeReuseMs = 1000
// why: Every issue starts up to three gh reads at once; a unit with many issues must not start them all together.
const ghConcurrency = 4

/**
 * Reads whether GitHub is reachable, probing at most once a minute unless forced.
 *
 * @param port - The engine calls.
 * @param isForced - Whether to probe even with a fresh answer cached.
 * @returns The status.
 */
export async function readGithubStatus(port: EnginePort, isForced = false): Promise<GithubStatus> {
  const now = await port.now()
  const age = sessionMemory.githubProbe ? now - sessionMemory.githubProbe.at : Infinity
  // A clock that moved back makes the last probe's age unknown, so it is not reused.
  if (sessionMemory.githubProbe && age >= 0 && age < (isForced ? probeReuseMs : githubTtlMs)) return sessionMemory.githubProbe.status
  // Stored before the probe settles, so a read that starts meanwhile shares it.
  const status: Promise<GithubStatus> = probeGithub(port.processes).then(probe => {
    // A probe that a newer one replaced while it ran leaves the newer answer in place.
    if (sessionMemory.githubProbe?.status !== status) return probe.status
    if (probe.status === 'connected') {
      sessionMemory.githubLastOk = now
      sessionMemory.githubError = null
    } else sessionMemory.githubError = probe.error
    sessionMemory.githubCache = { at: now, status: probe.status }
    return probe.status
  })
  sessionMemory.githubProbe = { at: now, status }
  return status
}

/**
 * Keeps a list fact's last good value when its read fails, so one failed read never erases it.
 * @param read - The list as GitHub reports it, or why the read failed.
 * @param previous - The stored value, if any.
 * @returns The fresh list, the stored list when the read failed, or the failure when no list was ever read.
 */
function keepList<T>(read: Result<T[]>, previous: T[] | ReadFailure | undefined): T[] | ReadFailure {
  return read.isOk ? read.value : Array.isArray(previous) ? previous : { error: read.error }
}

/**
 * Selects stored info that holds facts from a successful read.
 * @param previous - The stored info, if any.
 * @returns The facts, or undefined when the issue was never read successfully.
 */
function readGoodInfo(previous: IssueInfo | undefined): IssueRead | undefined {
  return previous && !('error' in previous) ? previous : undefined
}

/**
 * Merges what GitHub answered for an issue into its stored info, keeping the last good facts wherever a read failed.
 * @param previous - The stored info, if any.
 * @param answer - What GitHub answered.
 * @returns The merged info, carrying a read error only where no earlier read succeeded, and the first error.
 */
export function mergeIssue(previous: IssueInfo | undefined, answer: IssueAnswer): IssueMerge {
  const kept = readGoodInfo(previous)
  if (!answer.issue.isOk) return { info: kept ?? { error: `GitHub read failed (${answer.issue.error})` }, error: answer.issue.error }
  const { comments, subIssues, issue: { value: issue } } = answer
  const failed = [comments, subIssues].find(read => read && !read.isOk)
  return {
    info: { state: issue.state, title: issue.title, labels: issue.labels,
      ...(comments ? { comments: keepList(comments, kept?.comments) } : {}), ...(subIssues ? { subIssues: keepList(subIssues, kept?.subIssues) } : {}) },
    error: failed && !failed.isOk ? failed.error : null,
  }
}

/**
 * Reads an issue, and its comments and sub-issues where its flow judges them, all at once.
 * @param processes - The process runner.
 * @param flow - The declared flow's id, or null with none declared.
 * @param number - The issue number.
 * @returns What GitHub answered, each read with its own result.
 */
async function readIssueAnswer(processes: ProcessPort, flow: string | null, number: number): Promise<IssueAnswer> {
  const definition = findFlow(flow)
  const [issue, comments, subIssues] = await Promise.all([readIssue(processes, number),
    hasDiagnoseStep(definition) ? readIssueComments(processes, number) : undefined,
    hasIssueTreeStep(definition) ? readSubIssues(processes, number) : undefined])
  return { issue, comments, subIssues }
}

/**
 * Words why GitHub did not answer the reachability probe.
 * @param github - The probe's status.
 * @returns The reason: not authenticated, gh's first error line (a timeout included), or unreachable.
 */
function describeUnavailable(github: GithubStatus): string {
  return github === 'unauth' ? 'not authenticated — run gh auth login' : sessionMemory.githubError?.trim().split('\n')[0] || 'unreachable'
}

/**
 * Describes the latest GitHub failure for every surface that reports one: a failed issue sync first, since it says
 * which facts are kept, then a probe that did not connect.
 * @param github - The reachability status shown, null when none is.
 * @returns The reason and the kept facts' read time, or null while GitHub answers.
 */
export function readGithubFailure(github: GithubStatus | null): GithubFailure | null {
  if (sessionMemory.issuesError !== null) return { reason: sessionMemory.issuesError, readAt: sessionMemory.issuesReadAt }
  return github === null || github === 'connected' || github === 'unknown' ? null : { reason: describeUnavailable(github), readAt: null }
}

/**
 * Records a declaration's issue read as the latest attempt, superseding any sync still in flight.
 * @param now - When the issues were read.
 * @param error - Why part of the read failed, null when all of it succeeded.
 */
export function markIssuesDeclared(now: number, error: string | null): void {
  sessionMemory.issuesCheckedAt = now
  sessionMemory.issuesAttempt += 1
  applyIssuesOutcome(sessionMemory.issuesAttempt, now, error)
  // The last full read may have been of another unit's issues, so its time no longer dates these facts.
  if (error !== null) sessionMemory.issuesReadAt = null
}

/**
 * Drops the issue sync failure: with no flow declared, or a concluded unit, no issues are read, so no failure of theirs is current.
 */
export function clearIssuesFailure(): void {
  sessionMemory.issuesError = null
}

/**
 * Holds an attempt's outcome as the one the session record reflects.
 * @param attempt - The attempt.
 * @param now - When it started.
 * @param error - Why part of it failed, null when all of it succeeded.
 */
function applyIssuesOutcome(attempt: number, now: number, error: string | null): void {
  sessionMemory.issuesAppliedAttempt = attempt
  sessionMemory.issuesError = error
  if (error === null) sessionMemory.issuesReadAt = now
}

/**
 * Reads issues back from GitHub, a few gh processes at a time.
 *
 * @param processes - The process runner.
 * @param flow - The declared flow's id, or null with none declared.
 * @param issues - The issue numbers.
 * @returns Each issue's answer, in the order given.
 */
export function readIssueAnswers(processes: ProcessPort, flow: string | null, issues: number[]): Promise<IssueAnswer[]> {
  const limit = createLimiter(ghConcurrency)
  const limited: ProcessPort = { run: (argv, options) => limit(() => processes.run(argv, options)) }
  return Promise.all(issues.map(issue => readIssueAnswer(limited, flow, issue)))
}

/**
 * Stores the declared issues' info as GitHub reports it, at most once a minute unless forced; a failed read keeps the
 * last good facts and holds its reason in session memory until a read succeeds. Each attempt merges into the stored
 * info as it is when the write runs, and an older attempt never overwrites a newer one's outcome.
 * It must not run inside `withRecordLock`: the gh reads stay off the lock, and only the re-read and write take it.
 *
 * @param port - The engine calls.
 * @param held - The session the issues are read for, with its version.
 * @param options - Whether to read within the minute, and whether a probe that last failed runs again then.
 * @returns The session as stored, or the held one when nothing was written.
 */
export async function syncIssues(port: EnginePort, held: VersionedSession, options: SyncOptions = {}): Promise<VersionedSession> {
  const { isForced = false, isProbeForced = isForced } = options
  const session = held.session
  const now = await port.now()
  const age = now - sessionMemory.issuesCheckedAt
  if ((!isForced && age >= 0 && age < githubTtlMs) || !session.issues.length) return held
  sessionMemory.issuesCheckedAt = now
  sessionMemory.issuesAttempt += 1
  const attempt = sessionMemory.issuesAttempt
  // A connected answer keeps its minute, so only recovery from an outage pays for the extra probe.
  const github = await readGithubStatus(port, isProbeForced && sessionMemory.githubCache?.status !== 'connected')
  const reason = github === 'connected' ? null : describeUnavailable(github)
  const answers = reason === null ? await readIssueAnswers(port.processes, session.flow, session.issues)
    : session.issues.map((): IssueAnswer => ({ issue: fail(reason), comments: undefined, subIssues: undefined }))
  return withRecordLock(async () => {
    const outcome: { error: string | null; isApplied: boolean } = { error: null, isApplied: false }
    const written = await updateSession(port, current => {
      outcome.isApplied = false
      // The info is for the issues read; a unit declared meanwhile has its own.
      if (JSON.stringify(current.issues) !== JSON.stringify(session.issues)) return null
      const merges = session.issues.map((issue, index) => mergeIssue(current.info[issue], answers[index]!))
      outcome.error = merges.find(merge => merge.error !== null)?.error ?? null
      // A newer attempt already stored its outcome, or one still in flight will: a failed older one has nothing to add,
      // even when that newer one then fails to write, since the next sync reads again.
      if (attempt < sessionMemory.issuesAppliedAttempt || (outcome.error !== null && attempt < sessionMemory.issuesAttempt)) return null
      outcome.isApplied = true
      const info = Object.fromEntries(session.issues.map((issue, index) => [issue, merges[index]!.info]))
      return JSON.stringify(info) === JSON.stringify(current.info) ? null : { ...current, info }
    })
    if (outcome.isApplied) applyIssuesOutcome(attempt, now, outcome.error)
    return written ?? held
  })
}
