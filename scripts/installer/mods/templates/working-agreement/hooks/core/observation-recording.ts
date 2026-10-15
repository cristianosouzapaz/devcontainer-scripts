import type { CommandEvent, Observation } from '../domain/command-events'
import { listMissingLines } from '../domain/pull-request-body'
import { mergeSkills } from '../domain/records'
import type { Session } from '../domain/records'
import { findPullRequestBranch, findPullRequestStep } from '../domain/step-states'
import { findPullRequest, listOwnIssues, viewPullRequest } from '../lib/github'
import { unwrapOr } from '../lib/result'
import { observeBashCall } from './command-observation'
import type { DirectLaunch, ToolRun } from './command-observation'
import { recordDiagnosis } from './diagnosis'
import type { EnginePort } from './engine-port'
import { mergeIssueInfo, readIssues } from './github-sync'
import { hasIssueSkill, isSkillCounted, locatePosition } from './position'
import { findUnitKey, readUnit, updateUnits, writeSession, writeStored } from './record-store'
import { recordWorktreeRun } from './red-state'
import { readGit, readWorkingTreeKey } from './repository'
import { readTaskEnds, settleBackgroundRun } from './runs-in-flight'

/**
 * Records what a finished Bash call did for the unit, from the events the observation layer reports for the call itself
 * and for every herdr run it reported the end of: issues written, commits, pushes, PRs, verify runs, reds and greens.
 *
 * @param port - The engine calls.
 * @param seen - The session as read under the lock.
 * @param command - The Bash command.
 * @param ran - The call's result.
 * @param launch - The call as observed before it executed, or null when it was not.
 */
export async function observeCommand(port: EnginePort, seen: Session, command: string, ran: ToolRun, launch: DirectLaunch | null): Promise<void> {
  await recordObservations(port, seen, await observeBashCall(port, seen, command, ran, launch))
}

/**
 * Records the outcome of every background run a task notification reports the end of, as a direct run's exit code is.
 *
 * @param port - The engine calls.
 * @param seen - The session as read under the lock.
 * @param text - The notification as the engine submitted it.
 * @returns True when a run was settled.
 */
export async function observeTaskNotification(port: EnginePort, seen: Session, text: string): Promise<boolean> {
  const observations = readTaskEnds(text).flatMap(end => settleBackgroundRun(end) ?? [])
  if (observations.length && seen.flow) await recordObservations(port, seen, observations)
  return observations.length > 0
}

async function recordObservations(port: EnginePort, seen: Session, observations: Observation[]): Promise<void> {
  const session = await observations.reduce(async (previous, observation) => applyObservation(port, await previous, observation), Promise.resolve(seen))
  await writeSession(port, session)
}

// Applies one observed command to the session and its units; the outcome is read the same way for a direct and a herdr run.
async function applyObservation(port: EnginePort, seen: Session, observation: Observation): Promise<Session> {
  const { events, outcome, output } = observation
  const isPassed = outcome === 'passed'
  const hasEvent = (kind: CommandEvent['kind']): boolean => events.some(event => event.kind === kind)
  const hasGithubWrite = hasEvent('issue-create') || hasEvent('issue-edit') || hasEvent('pr-create') || hasEvent('pr-edit')
  const position = seen.flow && hasGithubWrite ? await locatePosition(port, seen) : null
  const isSkill = hasIssueSkill(position)
  const isCreated = isPassed && isSkill && hasEvent('issue-create')
  const isAdopting = isCreated && !seen.issues.length && !seen.followUp
  // A herdr run's output stays in its pane, so the issue it created is found on GitHub by its title.
  const adopted = isAdopting ? Number(output.match(/\/issues\/(\d+)/)?.[1]) || (await findCreatedIssue(port, observation)) : 0
  const session = adopted ? await adoptIssue(port, seen, adopted) : seen
  const edited = isPassed ? events.flatMap(event => (event.kind === 'issue-edit' ? event.issues : []))[0] : undefined
  // The labels decide the step: read the unit's issues back after any write to them.
  const info = isCreated || edited !== undefined ? mergeIssueInfo(session.info, await readIssues(port, session)) : session.info
  const isOutput = isCreated || (edited !== undefined && isSkill) || (isPassed && hasEvent('commit'))
  // The engine reports a direct run's PR number; failing that the output's URL names it, and a herdr run's PR is found by the branch.
  const reportedNumber = events.flatMap(event => (event.kind === 'pr-create' && event.number ? [event.number] : []))[0]
  const created = isPassed && hasEvent('pr-create') ? reportedNumber ?? (Number(output.match(/\/pull\/(\d+)/)?.[1]) || (await findBranchPullRequest(port))) : 0
  if (created) await updateUnits(port, session, unit => ({ ...unit, pr: { number: created, state: 'OPEN', isCreated: true } }))
  for (const event of isPassed ? events : []) {
    if (event.kind !== 'pr-merge') continue
    const unit = await readUnit(port, await findUnitKey(port, session))
    const merged = event.number ?? (unit.pr?.state === 'OPEN' ? unit.pr.number : 0)
    if (merged) await updateUnits(port, session, current => ({ ...current, pr: { number: merged, state: 'MERGED' } }))
  }
  // Trivial has no PR skill: the agent runs gh pr create itself, so the read-back follows the command.
  const pullRequestStep = position ? findPullRequestStep(position.flow) : undefined
  const isReadingBack = isSkillCounted(position, 'create-pr') || (!!pullRequestStep && !pullRequestStep.skill)
  const isConfirmed = isPassed && isReadingBack && (hasEvent('pr-create') || hasEvent('pr-edit')) && (await confirmPullRequest(port, session, output))
  if (isPassed && hasEvent('verify') && observation.tree && (await readWorkingTreeKey(port)) === observation.tree) {
    const tree = observation.tree
    await updateUnits(port, session, unit => ({ ...unit, verify: tree }))
  }
  const commented = isPassed ? events.flatMap(event => (event.kind === 'issue-comment' ? event.issues : [])) : []
  if (commented.length) await recordDiagnosis(port, session, commented)
  if (observation.worktree && outcome !== 'unfinished') await recordWorktreeRun(port, session, observation.worktree, observation.command, isPassed)
  return { ...session, info, output: session.output || isOutput, prCreated: session.prCreated || !!created || isConfirmed }
}

async function adoptIssue(port: EnginePort, session: Session, issue: number): Promise<Session> {
  const before = await readUnit(port, await findUnitKey(port, session))
  const adopted = { ...session, issues: [issue] }
  const key = await findUnitKey(port, adopted)
  const unit = await readUnit(port, key)
  await writeStored(port, key, { ...unit, ...before, skills: mergeSkills(unit.skills, before.skills) })
  return adopted
}

// The issue a `gh issue create` made, found among the user's latest issues by its title and creation time; 0 when none
// matches, which leaves it unattached and says so, rather than attaching another issue.
async function findCreatedIssue(port: EnginePort, observation: Observation): Promise<number> {
  const title = observation.events.flatMap(event => (event.kind === 'issue-create' && event.title ? [event.title.trim()] : []))[0]
  const listed = title ? await listOwnIssues(port.processes) : null
  // GitHub's clock and this machine's can differ a little: an issue created up to a minute before the launch still counts.
  const found = listed?.isOk ? listed.value.find(issue => issue.title.trim() === title && issue.createdAt >= observation.startedAt - 60000) : undefined
  if (!found) port.toast(`The working agreement could not find the issue that gh issue create made${listed && !listed.isOk ? ` (${listed.error})` : ''} — it is not attached to the unit.`)
  return found?.number ?? 0
}

async function findBranchPullRequest(port: EnginePort): Promise<number> {
  const branch = (await readGit(port))?.branch
  return branch ? findOpenPullRequest(port, branch) : 0
}

// The create or edit output carries the PR URL, which names the PR when the unit holds none.
async function confirmPullRequest(port: EnginePort, session: Session, stdout: string): Promise<boolean> {
  const position = session.flow ? await locatePosition(port, session) : null
  const step = position ? findPullRequestStep(position.flow) : undefined
  if (!position || !step || !position.git?.head || ((step.requires === 'linked' || step.requires === 'refs') && session.followUp === undefined)) return false
  const branch = findPullRequestBranch(position.unit, position.git, position.ownCommits)
  const known = (position.unit.pr?.state === 'OPEN' ? position.unit.pr.number : 0) || (Number(stdout.match(/\/pull\/(\d+)/)?.[1]) || 0)
  const found = known || (branch ? await findOpenPullRequest(port, branch) : 0)
  if (!found) return false
  const viewed = await viewPullRequest(port.processes, found)
  if (!viewed.isOk) return false
  const { body, headRefOid } = viewed.value
  if (!headRefOid || headRefOid !== position.git.head || listMissingLines(step.requires, session, body, position.unit).length) return false
  await updateUnits(port, session, unit => ({ ...unit, prHead: headRefOid, pr: unit.pr?.state === 'OPEN' ? unit.pr : { number: found, state: 'OPEN' } }))
  return true
}

// 0 stands for no open PR, so callers can chain it with `||`.
async function findOpenPullRequest(port: EnginePort, branch: string): Promise<number> {
  return unwrapOr(await findPullRequest(port.processes, branch, 'open'), null)?.number ?? 0
}
