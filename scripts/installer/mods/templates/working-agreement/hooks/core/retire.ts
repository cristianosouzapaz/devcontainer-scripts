import { findWorktreeRoot, hasMovedSinceCut, isAncestor, readGitOutput, readLocalBranchTips, readWorktreeStatus, runGit } from '../lib/git'
import { listPullRequests } from '../lib/github'
import { isRecord } from '../lib/guards'
import { readJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { unitAddress } from '../domain/mail'
import type { Envelope } from '../domain/mail'
import { deriveReplyId } from '../domain/mail-reply'
import { sameIdentity } from '../domain/records'
import type { Identity } from '../domain/records'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { runHerdr } from './herdr-worktrees'
import { atomicReplace, listIdentityRecords, readCommonDir, readSession, readSessionMirrors, recordsPath } from './record-store'
import type { RecordBucket } from './record-store'
import { mailPath } from './mailbox'
import { deriveSessionId, progressPath, withSpawnLock } from './spawn'
import { readUnitHost } from './unit-host'
import { findUnitBranch } from './unit-state'
import { noticePath } from './coordinator-notice'
import { stallPath } from './liveness'
import type { UnitWorkspace } from './unit-host'

/**
 * Everything a retirement archives and removes for one issue's unit, as read before anything changes, with how many messages its
 * mailbox held unread, read and invalid.
 */
export interface RetirementPlan {
  issue: number; branch: string; tip: string; session: string
  workspace: UnitWorkspace | null; worktree: string | null; isDirty: boolean
  identities: Identity[]; records: string[]; transcripts: string[]; mail: MailCount
}

/** How many messages a mailbox holds: unread in new/, read in cur/, and invalid in bad/. */
interface MailCount { unread: number; read: number; invalid: number }

/** What an archive kept: the ref holding the branch tip, the patch of uncommitted changes, and the command that restores both. */
export interface Archive { v: 1; issue: number; branch: string; ref: string; patch: string | null; restore: string }

// why: Beside the other records, under the common directory every worktree shares, so a coordinator's report reads them.
const bucket = 'retired'
/** The mailbox directories a retirement moves into its archive; the sequence file stays, so the address never reuses a number. */
const archivedBoxes = ['new', 'cur', 'bad', 'tmp'] as const

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
  const host = await readUnitHost(port)
  const workspace = host ? (await host.list(port)).find(entry => entry.issue === issue) ?? null : null
  const isDirty = worktree !== null && await readWorktreeStatus(port.processes, worktree) !== ''
  const mirror = (await readSessionMirrors(port)).find(entry => entry.session.sessionId === session)?.session
  const identities = [{ branch, issues: [issue] }, ...mirror?.units.map(entry => entry.identity) ?? [], ...mirror?.unit ? [mirror.unit] : []]
    .filter((identity, index, all) => identity.branch === branch && all.findIndex(other => sameIdentity(other, identity)) === index)
  const delegated = await listBranchRecords(port, common, 'delegated', branch)
  const count = async (box: 'new' | 'cur' | 'bad'): Promise<number> => (await port.files.list(mailPath(common, unitAddress(issue), box)).catch(() => []))
    .filter(entry => entry.name.endsWith('.json')).length
  const records = [progressPath(common, issue), recordsPath(common, 's', `${session}.json`),
    noticePath(common, branch), stallPath(common, issue), ...delegated, ...(await Promise.all(identities.map(identity => listIdentityRecords(port, identity)))).flat()]
  const transcripts = await findTranscripts(port, session)
  if (!transcripts.isOk) return transcripts
  return succeed({ issue, branch, tip, session, workspace, worktree, isDirty, identities,
    records: await filterExisting(port, records), transcripts: transcripts.value,
    mail: { unread: await count('new'), read: await count('cur'), invalid: await count('bad') } })
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
    `- ${describeMail(plan.mail)} in its mailbox, moved into the archive`,
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
    const removed = await removeUnit(port, common, plan.value, archive.value)
    const session = await readSession(port)
    for (const identity of plan.value.identities) {
      logEvent(port, { ...session, unit: identity }, 'retired', { ref: archive.value.ref, patch: archive.value.patch, by: session.sessionId, mailArchived: plan.value.mail })
    }
    const kept = `archived as ${archive.value.ref}${archive.value.patch ? ` and ${archive.value.patch}` : ''}; restore with: ${archive.value.restore}`
    if (!removed.isOk) return fail(`#${issue}'s unit is ${kept}, but its removal stopped: ${removed.error}`)
    return succeed(`Retired #${issue}'s unit (${plan.value.branch}): ${kept}${recorded.value ? `\n${recorded.value}` : ''}\nA later spawn ${issue} starts a fresh session.`)
  })
}

/**
 * Words what a retirement drops from the unit's mailbox.
 * @param mail - The mailbox's counts.
 * @returns Such as `2 unread and 5 read message(s)`.
 */
export function describeMail(mail: MailCount): string {
  return `${mail.unread} unread, ${mail.read} read and ${mail.invalid} invalid message(s)`
}

/**
 * Names the directory a retirement archives the unit's mailbox in, beside its archive record.
 * @param common - The git common directory.
 * @param archive - The retirement's archive.
 * @returns The path.
 */
function mailArchivePath(common: string, archive: Archive): string {
  return recordsPath(common, bucket, `${archive.issue}-${archive.ref.split('/').at(-1) ?? ''}-mail`)
}

/**
 * Finds the latest retirement of an issue's unit, so a message its retired session sent or received is told apart from the new unit's.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns The archive and when it was made, or null when the unit was never retired.
 */
export async function readLatestRetirement(port: EnginePort, issue: number): Promise<{ archive: Archive; at: number } | null> {
  const archive = (await readArchives(port, issue)).at(-1)
  // why: the archive's ref ends in its compact UTC stamp, such as 20261104T093000Z.
  const stamp = archive?.ref.split('/').at(-1)?.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
  const at = stamp ? Date.parse(stamp) : NaN
  return archive && Number.isFinite(at) ? { archive, at } : null
}

/**
 * Tells whether a message belongs to a retired unit session: sent or received under the unit's address before its latest retirement.
 * @param port - The engine calls.
 * @param envelope - The message.
 * @returns Whether a unit retirement came after it.
 */
export async function isFromRetiredSession(port: EnginePort, envelope: Envelope): Promise<boolean> {
  const unit = [envelope.from, envelope.to].find(address => /^\d+$/.test(address))
  const retired = unit ? await readLatestRetirement(port, Number(unit)) : null
  return !!retired && Date.parse(envelope.created_at) < retired.at
}

/**
 * Keeps a reply to a retired unit session's message in that retirement's archive instead of sending it, since the unit's address
 * outlives the retirement and the reply would otherwise reach the new unit's session.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param original - The message replied to.
 * @param reply - The reply's kind, sender, text and references.
 * @returns What happened to the reply, or null when the message is the live unit's and the reply goes out as usual.
 */
export async function keepLateReply(port: EnginePort, common: string, original: Envelope,
  reply: { kind: string; from: string; body: string; refs: string[] }): Promise<string | null> {
  const retired = /^\d+$/.test(original.from) ? await readLatestRetirement(port, Number(original.from)) : null
  if (!retired || Date.parse(original.created_at) >= retired.at) return null
  const late = `${mailArchivePath(common, retired.archive)}/late`
  const kept = `${late}/${deriveReplyId(original.id, reply.from)}.json`
  await executeProcess(port.processes, ['mkdir', '-p', '--', late])
  await atomicReplace(port, kept, JSON.stringify({ ...reply, to: original.from, in_reply_to: original.id, at: new Date(await port.now()).toISOString() }))
  return `Not delivered: message ${original.id} came from #${original.from}'s retired session, and its new unit never gets a reply meant for that one. `
    + `The ${reply.kind} is kept in ${kept}.`
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
 * Removes a unit once its work is archived: the herdr workspace with its agent first, so the session writes no more records, then its
 * mailbox's messages move into the archive, then the worktree, the branch, the records and the transcript go.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param plan - The retirement.
 * @param archive - The retirement's archive.
 * @returns Nothing, or the step that failed.
 */
async function removeUnit(port: EnginePort, common: string, plan: RetirementPlan, archive: Archive): Promise<Result<void>> {
  if (plan.workspace) await runHerdr(port, ['worktree', 'remove', '--workspace', plan.workspace.workspaceId, '--force'])
  // why: the retired session's mail stays readable for the record, but out of the mailbox a respawn reads.
  const target = mailArchivePath(common, archive)
  await executeProcess(port.processes, ['mkdir', '-p', '--', target])
  for (const box of archivedBoxes) {
    const source = mailPath(common, unitAddress(plan.issue), box)
    if (await port.files.stat(source).then(() => true, () => false) && (await executeProcess(port.processes, ['mv', '--', source, `${target}/${box}`])).exitCode !== 0) {
      return fail(`cannot move ${source} into ${target}`)
    }
  }
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
async function listBranchRecords(port: EnginePort, common: string, name: RecordBucket, branch: string): Promise<string[]> {
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
