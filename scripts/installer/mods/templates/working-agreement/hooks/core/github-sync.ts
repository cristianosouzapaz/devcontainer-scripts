import { findFlow, hasDiagnoseStep, hasIssueTreeStep } from '../domain/flow-definitions'
import type { GithubStatus, IssueInfo, Session } from '../domain/records'
import { probeGithub, readIssue, readIssueComments, readSubIssues } from '../lib/github'
import type { IssueSnapshot } from '../lib/github'
import type { EnginePort } from './engine-port'
import { readSession, writeSession } from './record-store'
import { sessionMemory, withRecordLock } from './session-memory'
import { githubTtlMs } from './timing'

/**
 * Reads whether GitHub is reachable, probing at most once a minute unless forced.
 *
 * @param port - The engine calls.
 * @param isForced - Whether to probe even with a fresh answer cached.
 * @returns The status.
 */
export async function readGithubStatus(port: EnginePort, isForced = false): Promise<GithubStatus> {
  const now = await port.now()
  if (!isForced && sessionMemory.githubCache && now - sessionMemory.githubCache.at < githubTtlMs) return sessionMemory.githubCache.status
  const probe = await probeGithub(port.processes)
  const status: GithubStatus = probe.status
  if (status === 'connected') {
    sessionMemory.githubLastOk = now
    sessionMemory.githubError = null
  } else sessionMemory.githubError = probe.error
  sessionMemory.githubCache = { at: now, status }
  return status
}

/**
 * Keeps issue metadata and the live sub-issue or comment facts its flow judges.
 *
 * @param port - The engine calls.
 * @param flow - The declared flow's id, or null with none declared.
 * @param number - The issue number.
 * @param issue - The issue as gh reports it.
 * @returns The stored issue info, retaining comment and sub-issue read errors separately from labels.
 */
export async function describeIssue(port: EnginePort, flow: string | null, number: number, issue: IssueSnapshot): Promise<IssueInfo> {
  const definition = findFlow(flow)
  const comments = hasDiagnoseStep(definition) ? await readIssueComments(port.processes, number) : undefined
  const info = { state: issue.state, title: issue.title, labels: issue.labels, ...(comments ? { comments: comments.isOk ? comments.value : { error: comments.error } } : {}) }
  if (!hasIssueTreeStep(definition)) return info
  const subIssues = await readSubIssues(port.processes, number)
  return { ...info, subIssues: subIssues.isOk ? subIssues.value : { error: subIssues.error } }
}

/**
 * Reads each of the session's issues back from GitHub, retaining a read error as its current fact.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @returns The info of every issue read, by number.
 */
async function readIssues(port: EnginePort, session: Session): Promise<Record<string, IssueInfo>> {
  const info: Record<string, IssueInfo> = {}
  for (const issue of session.issues) {
    const read = await readIssue(port.processes, issue)
    info[issue] = read.isOk ? await describeIssue(port, session.flow, issue, read.value) : { error: read.error }
  }
  return info
}

/**
 * Stores the declared issues' info as GitHub reports it, at most once a minute unless forced.
 * It must not run inside `withRecordLock`: the gh reads stay off the lock, and only the re-read and write take it.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @param isForced - Whether to read even when the last read is recent.
 * @returns The session as stored.
 */
export async function syncIssues(port: EnginePort, session: Session, isForced = false): Promise<Session> {
  const now = await port.now()
  if ((!isForced && now - sessionMemory.issuesCheckedAt < githubTtlMs) || !session.issues.length) return session
  sessionMemory.issuesCheckedAt = now
  const github = await readGithubStatus(port)
  const fresh = github === 'connected' ? await readIssues(port, session) : Object.fromEntries(session.issues.map(issue => [issue, {
    error: github === 'unauth' ? 'GitHub not authenticated — run gh auth login' : 'GitHub unreachable',
  }]))
  return withRecordLock(async () => {
    const current = await readSession(port)
    if (JSON.stringify(fresh) === JSON.stringify(current.info)) return current
    const next = { ...current, info: fresh }
    await writeSession(port, next)
    return next
  })
}
