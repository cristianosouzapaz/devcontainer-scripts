import { flowDefinitions } from '../domain/flow-definitions'
import type { Step } from '../domain/flow-definitions'
import { listMissingLines } from '../domain/pull-request-body'
import type { GithubStatus, IssueInfo, PullRequest, Session } from '../domain/records'
import { findPullRequestBranch, findPullRequestStep } from '../domain/step-states'
import type { GitState } from '../lib/git'
import { countSubIssues, findPullRequest, probeGithub, readIssue, viewPullRequest } from '../lib/github'
import type { IssueSnapshot } from '../lib/github'
import { unwrapOr } from '../lib/result'
import type { EnginePort } from './engine-port'
import { listUnitKeys, readSession, readUnit, writeSession, writeStored } from './record-store'
import { countCommitsAhead, readGit } from './repository'
import { sessionMemory, withRecordLock } from './session-memory'

/** What GitHub reports for a unit's branch: its PR, and the PR head the sync confirmed as pushed. */
interface PullRequestRead { found: PullRequest; confirmed?: string }

/**
 * Reads whether GitHub is reachable, probing at most once a minute unless forced.
 *
 * @param port - The engine calls.
 * @param isForced - Whether to probe even with a fresh answer cached.
 * @returns The status.
 */
export async function readGithubStatus(port: EnginePort, isForced = false): Promise<GithubStatus> {
  const now = await port.now()
  if (!isForced && sessionMemory.githubCache && now - sessionMemory.githubCache.at < 60000) return sessionMemory.githubCache.status
  const status: GithubStatus = await probeGithub(port.processes)
  sessionMemory.githubCache = { at: now, status }
  return status
}

/**
 * Keeps the title and labels of an issue gh found, and its sub-issue count when the flow has a step that follows sub-issues.
 *
 * @param port - The engine calls.
 * @param flow - The declared flow's id, or null with none declared.
 * @param number - The issue number.
 * @param issue - The issue as gh reports it.
 * @returns The stored issue info; without a count when gh cannot give one, so the step stays open.
 */
export async function describeIssue(port: EnginePort, flow: string | null, number: number, issue: IssueSnapshot): Promise<IssueInfo> {
  const info = { title: issue.title, labels: issue.labels }
  if (!flow || !flowDefinitions.flows[flow]?.steps.some(step => step.observe === 'sub-issues')) return info
  const count = await countSubIssues(port.processes, number)
  return count.isOk ? { ...info, subIssues: count.value } : info
}

/**
 * Reads each unit's PR from GitHub for the unit's branch; a unit with no branch or no PR is left out.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @returns What was read, by unit key.
 */
export async function readPullRequests(port: EnginePort, session: Session): Promise<Record<string, PullRequestRead>> {
  const reads: Record<string, PullRequestRead> = {}
  const definition = session.flow ? flowDefinitions.flows[session.flow] : undefined
  const step = definition ? findPullRequestStep(definition) : undefined
  for (const key of await listUnitKeys(port, session)) {
    const unit = await readUnit(port, key)
    // A unit records its branch only on the agent's first write, so code committed from a terminal leaves none;
    // the default branch never carries a unit's PR, nor does a branch the unit has no commit of its own on.
    const git = unit.branch ? null : await readGit(port)
    const branch = findPullRequestBranch(unit, git, git && unit.start ? await countCommitsAhead(port, unit.start) : 0)
    if (!branch) continue
    const found: PullRequest | undefined = unwrapOr(await findPullRequest(port.processes, branch, 'all'), null) ?? undefined
    if (!found) continue
    // A push to an open PR is the user's, so no command the agent runs reads the PR back: the sync confirms it.
    const confirmed = found.state === 'OPEN' && step && !step.skill ? await confirmPush(port, session, step.requires, found.number, git, unit.prHead) : undefined
    reads[key] = { found, confirmed }
  }
  return reads
}

/**
 * Merges what `readPullRequests` read into the stored units, writing a unit only when it changed.
 * The caller must hold the lock: each unit is re-read here, so a write that landed since the read survives.
 *
 * @param port - The engine calls.
 * @param reads - What `readPullRequests` returned.
 */
export async function storePullRequests(port: EnginePort, reads: Record<string, PullRequestRead>): Promise<void> {
  for (const [key, { found, confirmed }] of Object.entries(reads)) {
    const unit = await readUnit(port, key)
    const isChanged = found.number !== unit.pr?.number || found.state !== unit.pr?.state
    const pullRequest = isChanged ? (unit.pr?.isCreated && found.number === unit.pr.number ? { ...found, isCreated: true } : found) : unit.pr
    const prHead = confirmed && confirmed !== unit.prHead ? confirmed : undefined
    if (isChanged || prHead) await writeStored(port, key, { ...unit, pr: pullRequest, ...(prHead ? { prHead } : {}) })
  }
}

/**
 * Records each unit's PR as GitHub reports it for the unit's branch, at most once a minute unless forced.
 * It must not run inside `serial`: the gh reads stay off the lock, and only the re-read, merge and write take it.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @param isForced - Whether to read even when the last read is recent.
 */
export async function syncPullRequests(port: EnginePort, session: Session, isForced = false): Promise<void> {
  const now = await port.now()
  if (!isForced && now - sessionMemory.pullRequestsCheckedAt < 60000) return
  sessionMemory.pullRequestsCheckedAt = now
  if ((await readGithubStatus(port)) !== 'connected') return
  const reads = await readPullRequests(port, session)
  await withRecordLock(() => storePullRequests(port, reads))
}

// The PR head GitHub reports for an open PR when it is the local HEAD, not yet recorded, and the body carries the step's lines; undefined otherwise.
async function confirmPush(port: EnginePort, session: Session, requires: Step['requires'], number: number, git: GitState | null, recorded: string | undefined): Promise<string | undefined> {
  const head = (git ?? await readGit(port))?.head
  if (!head || head === recorded) return undefined
  const viewed = await viewPullRequest(port.processes, number)
  if (!viewed.isOk) return undefined
  const { body, headRefOid } = viewed.value
  return headRefOid === head && !listMissingLines(requires, session, body).length ? headRefOid : undefined
}

/**
 * Reads each of the session's issues back from GitHub; an issue that cannot be read is left out, so the caller keeps its stored info.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @returns The info of every issue read, by number.
 */
export async function readIssues(port: EnginePort, session: Session): Promise<Record<string, IssueInfo>> {
  const info: Record<string, IssueInfo> = {}
  for (const issue of session.issues) {
    const read = await readIssue(port.processes, issue)
    if (read.isOk) info[issue] = await describeIssue(port, session.flow, issue, read.value)
  }
  return info
}

/**
 * Merges issue info read from GitHub into the stored info. A sub-issue count gh could not give keeps the stored one,
 * so a failed read neither ticks nor unticks Tickets.
 *
 * @param stored - The info the session holds, by issue number.
 * @param fresh - The info just read, by issue number; an issue missing here keeps its stored info.
 * @returns The merged info.
 */
export function mergeIssueInfo(stored: Record<string, IssueInfo>, fresh: Record<string, IssueInfo>): Record<string, IssueInfo> {
  const merged = Object.entries(fresh).map(([issue, info]): [string, IssueInfo] => {
    const subIssues = info.subIssues ?? stored[issue]?.subIssues
    return [issue, subIssues === undefined ? info : { ...info, subIssues }]
  })
  return { ...stored, ...Object.fromEntries(merged) }
}

/**
 * Stores the declared issues' info as GitHub reports it, at most once a minute unless forced.
 * It must not run inside `serial`: the gh reads stay off the lock, and only the re-read, merge of `info` and write take it.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @param isForced - Whether to read even when the last read is recent.
 * @returns The session as stored.
 */
export async function syncIssues(port: EnginePort, session: Session, isForced = false): Promise<Session> {
  const now = await port.now()
  if ((!isForced && now - sessionMemory.issuesCheckedAt < 60000) || !session.issues.length) return session
  sessionMemory.issuesCheckedAt = now
  if ((await readGithubStatus(port)) !== 'connected') return session
  const fresh = await readIssues(port, session)
  return withRecordLock(async () => {
    const current = await readSession(port)
    const info = mergeIssueInfo(current.info, fresh)
    if (JSON.stringify(info) === JSON.stringify(current.info)) return current
    const next = { ...current, info }
    await writeSession(port, next)
    return next
  })
}
