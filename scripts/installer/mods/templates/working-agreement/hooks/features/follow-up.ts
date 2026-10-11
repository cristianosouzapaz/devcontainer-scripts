import { createEmptyUnit } from '../domain/records'
import type { GithubStatus, IssueInfo, Session } from '../domain/records'
import { readIssue, searchPullRequests } from '../lib/github'
import type { ProcessPort } from '../lib/process'
import { fail, succeed, unwrapOr } from '../lib/result'
import type { Result } from '../lib/result'

/** The engine and core calls `/flow follow-up` makes, each a closure the entry file builds. */
export interface FollowUpPort {
  processes: ProcessPort
  readSession: () => Promise<Session>
  writeSession: (session: Session) => Promise<void>
  writeStored: (key: string, value: unknown) => Promise<void>
  findUnitKey: (session: Session) => Promise<string>
  readHead: () => Promise<string | undefined>
  readGithubStatus: (isForced: boolean) => Promise<GithubStatus>
  refresh: () => Promise<void>
  /** Runs a read-modify-write of the records under the store lock; the work must not refresh the pane, whose GitHub sync takes the lock too. */
  withLock: <T>(work: () => Promise<T>) => Promise<T>
  openPane: () => void
}

/**
 * Starts a follow-up on an issue whose PR exists: on the PR's branch while it is open, on a new branch once it is merged.
 *
 * @param port - The engine and core calls.
 * @param issue - The followed-up issue.
 * @returns The message for the user, or why the follow-up cannot start.
 */
export async function startFollowUp(port: FollowUpPort, issue: number): Promise<Result<string>> {
  const session = await port.readSession()
  if (session.prCreated) return fail('A PR was already created in this session — run /handoff, then /clear, then /flow follow-up in the new session.')
  if (session.flow) return fail('Follow-ups start only in a new session — run /handoff, then /clear.')
  if ((await port.readGithubStatus(true)) !== 'connected') return fail('Follow-up needs GitHub to find the PR — check gh auth status.')
  const pullRequests = unwrapOr(await searchPullRequests(port.processes, `${issue}`), [])
  const referencesIssue = new RegExp(`\\b(closes|refs|fixes|resolves)\\s+#${issue}\\b`, 'i')
  const pullRequest = pullRequests.find(candidate => referencesIssue.test(candidate.body))
  if (!pullRequest) return fail(`#${issue} has no PR yet — continue it in its own flow (declare it), not as a follow-up.`)
  const flow = pullRequest.state === 'OPEN' ? 'follow-up-open' : pullRequest.state === 'MERGED' ? 'follow-up-merged' : null
  if (!flow) return fail(`PR #${pullRequest.number} for #${issue} is ${pullRequest.state.toLowerCase()} — nothing to follow up on.`)
  const snapshot = await readIssue(port.processes, issue)
  const info: Record<string, IssueInfo> = snapshot.isOk ? { [issue]: { title: snapshot.value.title, labels: snapshot.value.labels } } : {}
  // GitHub is read off the lock; the session is read again under it, so a flow declared meanwhile is not overwritten.
  const stored = await port.withLock(async (): Promise<Result<undefined>> => {
    const current = await port.readSession()
    if (current.flow) return fail('Follow-ups start only in a new session — run /handoff, then /clear.')
    const next: Session = { ...current, flow, issues: [issue], followUp: issue, gh: 'connected', info }
    await port.writeSession(next)
    // An open PR's follow-up starts from the PR's head, wherever the checkout is; a merged one's from here.
    await port.writeStored(await port.findUnitKey(next), flow === 'follow-up-open'
      ? { ...createEmptyUnit(), start: pullRequest.headRefOid || await port.readHead(), branch: pullRequest.headRefName, pr: { number: pullRequest.number, state: 'OPEN' } }
      : { ...createEmptyUnit(), start: await port.readHead() })
    return succeed(undefined)
  })
  if (!stored.isOk) return stored
  await port.refresh()
  port.openPane()
  return succeed(flow === 'follow-up-open'
    ? `Follow-up on #${issue}: continue on ${pullRequest.headRefName}; the user pushes to PR #${pullRequest.number}.`
    : `Follow-up on #${issue}: PR #${pullRequest.number} is merged — work on a new branch; its PR body must carry "Refs #${issue}".`)
}

/**
 * Runs `/flow follow-up #<n>`.
 *
 * @param port - The engine and core calls.
 * @param args - The words after `follow-up`.
 * @returns The message for the user, or why the command was refused.
 */
export async function runFollowUpCommand(port: FollowUpPort, args: string): Promise<Result<string>> {
  const issue = Number(args.replace('#', ''))
  return issue ? startFollowUp(port, issue) : fail('Usage: /flow follow-up #<n>.')
}
