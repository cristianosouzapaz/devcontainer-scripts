import { findWorktreeRoot, hasMovedSinceCut, isAncestor, readGitOutput, readLocalBranchTips, readWorktreeStatus, runGit } from '../lib/git'
import { listPullRequests } from '../lib/github'
import { isRecord } from '../lib/guards'
import { readJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { sameIdentity } from '../domain/records'
import type { Identity } from '../domain/records'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { isInsideHerdr, runHerdr } from './herdr-worktrees'
import { atomicReplace, listIdentityRecords, readCommonDir, readSession, readSessionMirrors, recordsPath } from './record-store'
import { deriveSessionId, listUnitWorkspaces, progressPath, withSpawnLock } from './spawn'
import { findUnitBranch } from './unit-state'
import { noticePath } from './coordinator-notice'
import type { UnitWorkspace } from './spawn'

/** Everything a retirement archives and removes for one issue's unit, as read before anything changes. */
export interface RetirementPlan {
  issue: number; branch: string; tip: string; session: string
  workspace: UnitWorkspace | null; worktree: string | null; isDirty: boolean
  identities: Identity[]; records: string[]; transcripts: string[]
}

/** What an archive kept: the ref holding the branch tip, the patch of uncommitted changes, and the command that restores both. */
export interface Archive { v: 1; issue: number; branch: string; ref: string; patch: string | null; restore: string }

// why: Beside the other records, under the common directory every worktree shares, so a coordinator's report reads them.
const bucket = 'retired'

/**
 * Reads what retiring an issue's unit would archive and remove, refusing a unit whose work has left its branch or that runs this session.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns The plan, or why the unit is not retired.
 */
export async function planRetirement(port: EnginePort, issue: number): Promise<Result<RetirementPlan>> {
  const common = await readCommonDir(port)
  if (!common) return fail('this session is not in a git repository')
  const found = await findUnitBranch(port, issue)
  if (!found) return fail(`#${issue} has no unit branch, so there is nothing to retire`)
  if (!found.isOk) return found
  const branch = found.value
  const tip = await readGitOutput(port.processes, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  if (!tip) return fail(`cannot resolve ${branch}`)
  const session = await deriveSessionId(common, issue)
  const worktree = await findWorktreeRoot(port.processes, branch) ?? null
  if (session === await port.readSessionId() || worktree === await port.readCwd()) return fail(`this session is #${issue}'s unit, and a session never retires itself`)
  const merged = await findMerge(port, branch, tip)
  if (merged) return fail(`${branch} ${merged}, so its unit is not retired`)
  const workspace = await isInsideHerdr(port) ? (await listUnitWorkspaces(port)).find(entry => entry.issue === issue) ?? null : null
  const isDirty = worktree !== null && await readWorktreeStatus(port.processes, worktree) !== ''
  const mirror = (await readSessionMirrors(port)).find(entry => entry.session.sessionId === session)?.session
  const identities = [{ branch, issues: [issue] }, ...mirror?.units.map(entry => entry.identity) ?? [], ...mirror?.unit ? [mirror.unit] : []]
    .filter((identity, index, all) => identity.branch === branch && all.findIndex(other => sameIdentity(other, identity)) === index)
  const delegated = await listBranchRecords(port, common, 'delegated', branch)
  const records = [progressPath(common, issue), recordsPath(common, 's', `${session}.json`),
    noticePath(common, branch), ...delegated, ...(await Promise.all(identities.map(identity => listIdentityRecords(port, identity)))).flat()]
  const transcripts = await findTranscripts(port, session)
  if (!transcripts.isOk) return transcripts
  return succeed({ issue, branch, tip, session, workspace, worktree, isDirty, identities,
    records: await filterExisting(port, records), transcripts: transcripts.value })
}

/**
 * Lists what a retirement keeps and what it removes, for the user's preview.
 * @param plan - The retirement.
 * @returns The lines, the same for the same plan.
 */
export function describeRetirement(plan: RetirementPlan): string {
  return [
    `Retiring #${plan.issue}'s unit archives, before removing anything:`,
    `- the tip of ${plan.branch} (${plan.tip.slice(0, 7)}) as refs/${bucket}/${plan.issue}/<timestamp>`,
    plan.isDirty ? `- the uncommitted changes in ${plan.worktree} as a patch under the records directory` : '- no uncommitted changes',
    'Then it removes:',
    plan.workspace ? `- herdr workspace ${plan.workspace.workspaceId} with its agent, and worktree ${plan.workspace.path}` : plan.worktree ? `- worktree ${plan.worktree}` : '- no worktree',
    `- branch ${plan.branch}`,
    ...plan.records.map(path => `- record ${path}`),
    ...plan.transcripts.map(path => `- transcript ${path}`),
    `A later spawn ${plan.issue} starts a fresh session.`,
  ].join('\n')
}

/**
 * Retires an issue's unit under the spawn lock: archives its branch tip and uncommitted changes, lets the caller record the decision,
 * then removes its workspace, worktree, branch, records and transcript, and logs the retirement in the unit's transition log.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param check - Judges the plan read under the lock before anything is archived; a failure stops the retirement.
 * @param record - Records the decision once the archive exists; a failure leaves the unit in place.
 * @returns What was archived and removed with the restore command, or why nothing was removed.
 */
export function retireUnit(port: EnginePort, issue: number, check: (plan: RetirementPlan) => Result<void>,
  record: (plan: RetirementPlan, archive: Archive) => Promise<Result<string>>): Promise<Result<string>> {
  return withSpawnLock(port, async common => {
    const plan = await planRetirement(port, issue)
    if (!plan.isOk) return plan
    const judged = check(plan.value)
    if (!judged.isOk) return judged
    const archive = await archiveUnit(port, common, plan.value)
    if (!archive.isOk) return fail(`nothing was removed: ${archive.error}`)
    const recorded = await record(plan.value, archive.value)
    if (!recorded.isOk) return fail(`archived as ${archive.value.ref}, but nothing was removed: ${recorded.error}`)
    const removed = await removeUnit(port, plan.value)
    const session = await readSession(port)
    for (const identity of plan.value.identities) logEvent(port, { ...session, unit: identity }, 'retired', { ref: archive.value.ref, patch: archive.value.patch, by: session.sessionId })
    const kept = `archived as ${archive.value.ref}${archive.value.patch ? ` and ${archive.value.patch}` : ''}; restore with: ${archive.value.restore}`
    if (!removed.isOk) return fail(`#${issue}'s unit is ${kept}, but its removal stopped: ${removed.error}`)
    return succeed(`Retired #${issue}'s unit (${plan.value.branch}): ${kept}${recorded.value ? `\n${recorded.value}` : ''}\nA later spawn ${issue} starts a fresh session.`)
  })
}

/**
 * Reads every archive the retirements of an issue's units left, oldest first.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns The archives; none when nothing was ever retired.
 */
export async function readArchives(port: EnginePort, issue: number): Promise<Archive[]> {
  const common = await readCommonDir(port)
  const directory = recordsPath(common, bucket)
  const names = (await port.files.list(directory).catch(() => [])).map(entry => entry.name).filter(name => name.startsWith(`${issue}-`) && name.endsWith('.json')).sort()
  const archives = await Promise.all(names.map(async name => parseArchive(await readJson(port.files, `${directory}/${name}`).catch(() => null))))
  return archives.filter((archive): archive is Archive => archive?.issue === issue)
}

/**
 * Tells whether a unit's work has left its branch: a pull request from it, or its moved tip inside another local branch.
 * @param port - The engine calls.
 * @param branch - The unit branch.
 * @param tip - Its tip.
 * @returns How the branch is merged, or undefined when it is not.
 */
async function findMerge(port: EnginePort, branch: string, tip: string): Promise<string | undefined> {
  const prs = await listPullRequests(port.processes, branch)
  if (!prs.isOk) return `cannot be told apart from a branch with a PR (${prs.error})`
  if (prs.value[0]) return `has PR ${prs.value[0].url}`
  if (!await hasMovedSinceCut(port.processes, branch)) return undefined
  const tips = await readLocalBranchTips(port.processes)
  if (!tips) return 'cannot be checked against the other branches'
  for (const other of tips.keys()) if (other !== branch && await isAncestor(port.processes, tip, `refs/heads/${other}`)) return `is merged into ${other}`
  return undefined
}

/**
 * Archives a unit's work: its branch tip as a ref and its uncommitted changes as a patch, with a record naming both and the restore command.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param plan - The retirement.
 * @returns The archive, or why it could not be made.
 */
async function archiveUnit(port: EnginePort, common: string, plan: RetirementPlan): Promise<Result<Archive>> {
  const stamp = new Date(await port.now()).toISOString().replace(/[-:]|\.\d+/g, '')
  const ref = `refs/${bucket}/${plan.issue}/${stamp}`
  if (await readGitOutput(port.processes, ['update-ref', ref, plan.tip, '']) === null) return fail(`cannot write ${ref}`)
  await executeProcess(port.processes, ['mkdir', '-p', '--', recordsPath(common, bucket)])
  const patch = plan.isDirty && plan.worktree ? recordsPath(common, bucket, `${plan.issue}-${stamp}.patch`) : null
  if (patch && plan.worktree) {
    // why: staging every path first puts untracked files in the patch too; the worktree is removed next, so its index does not matter.
    await runGit(port.processes, ['-C', plan.worktree, 'add', '-A'])
    const diff = await runGit(port.processes, ['-C', plan.worktree, 'diff', '--cached', '--binary', 'HEAD'])
    if (diff.exitCode !== 0) return fail(`archived ${ref}, but cannot read the uncommitted changes in ${plan.worktree}`)
    await atomicReplace(port, patch, diff.stdout)
  }
  const path = plan.worktree ?? `../${plan.branch.replace(/\//g, '-')}`
  const restore = `git worktree add ${path} -b ${plan.branch} ${ref}${patch ? ` && git -C ${path} apply --index ${patch}` : ''}`
  const archive: Archive = { v: 1, issue: plan.issue, branch: plan.branch, ref, patch, restore }
  await atomicReplace(port, recordsPath(common, bucket, `${plan.issue}-${stamp}.json`), JSON.stringify(archive))
  return succeed(archive)
}

/**
 * Removes a unit once its work is archived: the herdr workspace with its agent first, so the session writes no more records, then the worktree,
 * the branch, the records and the transcript.
 * @param port - The engine calls.
 * @param plan - The retirement.
 * @returns Nothing, or the step that failed.
 */
async function removeUnit(port: EnginePort, plan: RetirementPlan): Promise<Result<void>> {
  if (plan.workspace) await runHerdr(port, ['worktree', 'remove', '--workspace', plan.workspace.workspaceId, '--force'])
  const worktree = await findWorktreeRoot(port.processes, plan.branch)
  if (worktree && await readGitOutput(port.processes, ['worktree', 'remove', '--force', worktree]) === null) return fail(`cannot remove worktree ${worktree}`)
  if (await readGitOutput(port.processes, ['branch', '-D', plan.branch]) === null) return fail(`cannot delete branch ${plan.branch}`)
  const paths = [...plan.records, ...plan.transcripts]
  if (paths.length && (await executeProcess(port.processes, ['rm', '-rf', '--', ...paths])).exitCode !== 0) return fail('cannot remove the records and transcript')
  return succeed(undefined)
}

/**
 * Finds a unit session's transcript, wherever Claude Code filed it: the session id belongs to the repository and issue alone.
 * @param port - The engine calls.
 * @param session - The unit's session id.
 * @returns The transcript file and its directory of subagent transcripts, where they exist.
 */
async function findTranscripts(port: EnginePort, session: string): Promise<Result<string[]>> {
  const directory = await port.readClaudeDir()
  if (!directory) return fail('neither CLAUDE_CONFIG_DIR nor HOME is set, so the unit\'s transcript cannot be found, and a kept transcript would make the next spawn resume it')
  const projects = `${directory}/projects`
  const entries = await port.files.list(projects).catch(() => [])
  return succeed(await filterExisting(port, entries.flatMap(entry => [`${projects}/${entry.name}/${session}.jsonl`, `${projects}/${entry.name}/${session}`])))
}

/**
 * Lists the records of a bucket that name a branch.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param name - The bucket.
 * @param branch - The branch.
 * @returns The records' paths.
 */
async function listBranchRecords(port: EnginePort, common: string, name: string, branch: string): Promise<string[]> {
  const directory = recordsPath(common, name)
  const entries = (await port.files.list(directory).catch(() => [])).filter(entry => entry.name.endsWith('.json'))
  const named = await Promise.all(entries.map(async entry => {
    const value: unknown = await readJson(port.files, `${directory}/${entry.name}`).catch(() => null)
    return isRecord(value) && value.branch === branch ? [`${directory}/${entry.name}`] : []
  }))
  return named.flat()
}

/**
 * Keeps the paths that exist, as files or directories.
 * @param port - The engine calls.
 * @param paths - The candidates.
 * @returns The existing ones, in order.
 */
async function filterExisting(port: EnginePort, paths: string[]): Promise<string[]> {
  const present = await Promise.all(paths.map(path => port.files.stat(path).then(() => true, () => false)))
  return paths.filter((_, index) => present[index])
}

/**
 * Validates an archive record read from disk.
 * @param value - The decoded JSON.
 * @returns The archive, or null.
 */
function parseArchive(value: unknown): Archive | null {
  return isRecord(value) && value.v === 1 && typeof value.issue === 'number' && typeof value.branch === 'string' && typeof value.ref === 'string'
    && (value.patch === null || typeof value.patch === 'string') && typeof value.restore === 'string'
    ? { v: 1, issue: value.issue, branch: value.branch, ref: value.ref, patch: value.patch, restore: value.restore } : null
}
