import { findWorktreeRoot, hasMovedSinceCut, isAncestor, readGitOutput, readLocalBranchTips, readWorktrees } from '../lib/git'
import { listPullRequests } from '../lib/github'
import { isRecord } from '../lib/guards'
import { readJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import { fail, formatError, settle, succeed } from '../lib/result'
import { quoteWord } from '../lib/shell'
import type { Result } from '../lib/result'
import { unitAddress } from '../domain/mail'
import type { Envelope } from '../domain/mail'
import { deriveReplyId } from '../domain/mail-reply'
import { stop as stopAfter } from '../domain/outcome'
import type { Stopped } from '../domain/outcome'
import { sameIdentity } from '../domain/records'
import type { Identity } from '../domain/records'
import type { SessionLiveness } from '../domain/process-host'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { outsideHerdr } from './herdr-worktrees'
import { atomicReplace, listIdentityRecords, mirrorRevisionPath, readCommonDir, readSession, readSessionMirrors, recordsPath } from './record-store'
import type { RecordBucket } from './record-store'
import { mailPath } from './mailbox'
import { setUnitAside } from './retire-checkout'
import { isSameHost, readSessionHostStrictly, readSessionLiveness } from './session-host'
import { deriveSessionId, exitWaitMs, pollUntil, progressPath, readProgressFile, resolveSpawnedSession, withSpawnLock } from './spawn'
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
  workspace: UnitWorkspace | null; worktree: string | null; liveness: SessionLiveness
  identities: Identity[]; records: string[]; transcripts: string[]; mail: MailCount
}


/** How many messages a mailbox holds: unread in new/, read in cur/, and invalid in bad/. */
interface MailCount { unread: number; read: number; invalid: number }

/**
 * What a retirement kept: the ref holding the branch tip, the checkout moved aside, the command that resumes the work, and the command
 * that reclaims the checkout's disk, which only the user runs.
 */
export interface Archive { v: 1; issue: number; branch: string; ref: string; checkout: string | null; restore: string; reclaim: string | null }

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
  const progress = await settle(readProgressFile(port, common, issue, true))
  if (!progress.isOk) return fail(`#${issue}'s spawn record ${progressPath(common, issue)} could not be read (${progress.error}), so its unit's session is unknown; nothing was removed`)
  // why: the record names the session that runs the unit, a handoff's included; with no session recorded, the derived one is where a spawn would have started it.
  const derived = await deriveSessionId(common, issue)
  const session = await resolveSpawnedSession(common, issue, progress.value) ?? derived
  // why: a later spawn starts the derived session again, so its conversation and records go too, or it would be resumed; so do those of superseded sessions.
  const sessions = [...new Set([session, derived, ...progress.value.predecessors ?? []])]
  const worktree = await findWorktreeRoot(port.processes, branch) ?? null
  const cwd = await resolvePath(port, await port.readCwd())
  if (session === await port.readSessionId() || worktree !== null && isInside(cwd, await resolvePath(port, worktree))) {
    return fail(`this session is #${issue}'s unit, and a session never retires itself`)
  }
  const merged = await findMerge(port, branch, tip)
  if (merged) return fail(`${branch} ${merged}, so its unit is not retired`)
  const host = await readUnitHost(port)
  const workspace = host ? (await host.list(port)).find(entry => entry.issue === issue) ?? null : null
  if (workspace && isInside(cwd, await resolvePath(port, workspace.path))) return fail(`this session runs in #${issue}'s workspace, and a session never retires itself`)
  for (const other of sessions.filter(each => each !== session)) {
    const hosts = await Promise.all([other, session].map(each => readSessionHostStrictly(port, each)))
    const unread = [other, session].find((_, index) => hosts[index] === null)
    if (unread) {
      return fail(`whether #${issue}'s superseded session ${other} runs on its own is unknown: the host record ${recordsPath(common, 'host', `${unread}.json`)} `
        + 'could not be read; nothing was removed; check that file')
    }
    const [own, unit] = hosts.map(read => read?.value ?? null)
    // why: a superseded session resumed on its own runs outside the unit's process, so its conversation is in use; an absent record is pruned only once its process ended.
    if (own && await readSessionLiveness(port, other) === 'live' && !(unit && isSameHost(own, unit))) {
      return fail(`#${issue}'s superseded session ${other} runs on its own, in another process than its unit's, so its conversation is not removed; `
        + `nothing was removed; end that session, or check its host record ${recordsPath(common, 'host', `${other}.json`)}`)
    }
  }
  const transcripts = await findTranscripts(port, sessions)
  if (!transcripts.isOk) return transcripts
  const stray = await findStrayCheckout(port, issue, worktree, transcripts.value)
  if (stray) return fail(`${stray}, which may hold #${issue}'s uncommitted work; check it out on ${branch} or set it aside by hand; nothing was removed`)
  const mirrors = (await readSessionMirrors(port)).filter(entry => sessions.includes(entry.session.sessionId)).map(entry => entry.session)
  const identities = [{ branch, issues: [issue] }, ...mirrors.flatMap(mirror => [...mirror.units.map(entry => entry.identity), ...mirror.unit ? [mirror.unit] : []])]
    .filter((identity, index, all) => identity.branch === branch && all.findIndex(other => sameIdentity(other, identity)) === index)
  const delegated = await listBranchRecords(port, common, 'delegated', branch)
  const count = async (box: 'new' | 'cur' | 'bad'): Promise<number> => (await port.files.list(mailPath(common, unitAddress(issue), box)).catch(() => []))
    .filter(entry => entry.name.endsWith('.json')).length
  const records = [progressPath(common, issue), ...sessions.flatMap(each => [recordsPath(common, 's', `${each}.json`), mirrorRevisionPath(common, each)]),
    noticePath(common, branch), stallPath(common, issue), ...delegated, ...(await Promise.all(identities.map(identity => listIdentityRecords(port, identity)))).flat()]
  const liveness = await readSessionLiveness(port, session)
  return succeed({ issue, branch, tip, session, workspace, worktree, liveness, identities,
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
    `Retiring #${plan.issue}'s unit deletes none of its work:`,
    plan.workspace ? `- closes herdr workspace ${plan.workspace.workspaceId} and waits for its session to end`
      : plan.liveness === 'gone' ? '- no session to close: its recorded process has ended'
        : '- its session may still run with no herdr workspace to close, so retiring it is refused',
    `- keeps the tip of ${plan.branch} (${plan.tip.slice(0, 7)}) as refs/${bucket}/${plan.issue}/<timestamp>`,
    plan.worktree ? `- moves worktree ${plan.worktree} aside to ${plan.worktree}.retired-<timestamp>, every file it holds included` : '- no worktree',
    `- deletes branch ${plan.branch} only while it is still at ${plan.tip.slice(0, 7)}`,
    'Then it removes:',
    ...plan.records.map(path => `- record ${path}`),
    `- ${describeMail(plan.mail)} in its mailbox, moved into the archive`,
    ...plan.transcripts.map(path => `- transcript ${path}`),
    `A later spawn ${plan.issue} starts a fresh session.`,
  ].join('\n')
}

/**
 * Retires an issue's unit under the spawn lock without deleting any of its work: closes its session and waits for it to end, re-reads the
 * plan, keeps its tip as a ref, moves its checkout aside and deletes its branch only while unmoved, writes the archive record, then
 * archives its mailbox, removes its records and transcript, lets the caller record the decision, and only then logs the retirement in the
 * unit's transition log.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param check - Judges the plan read under the lock before anything changes; a failure stops the retirement.
 * @param record - Records the decision once every other step has succeeded.
 * @returns What was kept with the commands that resume the work and reclaim its disk; a refusal that removed nothing; or, marked by
 * {@link isStopped}, the step a retirement already under way stopped at, with the steps done and how to finish.
 */
export function retireUnit(port: EnginePort, issue: number, check: (plan: RetirementPlan) => Result<void>,
  record: (plan: RetirementPlan, archive: Archive) => Promise<Result<string>>): Promise<Result<string>> {
  return withSpawnLock(port, async (common): Promise<Result<string>> => {
    const host = await readUnitHost(port)
    if (!host) return fail(`${outsideHerdr}, so the unit's session cannot be stopped; nothing was removed`)
    const plan = await planRetirement(port, issue)
    if (!plan.isOk) return plan
    const judged = check(plan.value)
    if (!judged.isOk) return judged
    const { branch, tip, worktree, workspace } = plan.value
    if (workspace && (worktree === null || await resolvePath(port, workspace.path) !== await resolvePath(port, worktree))) {
      return fail(`#${issue}'s workspace holds ${quoteWord(workspace.path)}, but ${branch} is checked out in ${worktree ? quoteWord(worktree) : 'no worktree'}; nothing was removed`)
    }
    // why: a unit stopped by a dialog before its mod loaded never records its process, so only an ended one proves no session runs.
    if (!workspace && plan.value.liveness !== 'gone') {
      return fail(`#${issue}'s session ${plan.value.liveness === 'live' ? 'still runs' : 'may still run, as no ended process of it is recorded'}, `
        + 'but no herdr workspace of it is found to close; nothing was removed')
    }
    if (workspace) {
      await host.close(port, workspace)
      if (!await pollUntil(port, exitWaitMs, 500, async () => await host.state(port, workspace, 0) === 'none')) {
        return fail(`#${issue}'s session did not end after its host was asked to close it; nothing was removed`)
      }
    }
    // why: once anything changed, a refusal's "nothing was removed" would be false, so the reply names what was done, kept and left.
    const stop = (detail: string): Stopped => stopAfter(`#${issue}'s retirement: ${workspace ? 'session stopped; ' : ''}${detail}`)
    const keptAt = `${worktree ? `checkout kept at ${quoteWord(worktree)} and ` : ''}branch ${branch} kept`
    const left = [...plan.value.records, ...plan.value.transcripts].map(quoteWord).join(' ')
    const again = await planRetirement(port, issue)
    if (!again.isOk) return stop(`${keptAt}; re-reading the plan failed: ${again.error}`)
    if (again.value.tip !== tip || again.value.worktree !== worktree) return stop(`${keptAt}; re-reading the plan failed: ${branch} or its worktree changed while the session closed`)
    const stamp = new Date(await port.now()).toISOString().replace(/[-:]|\.\d+/g, '')
    const ref = `refs/${bucket}/${issue}/${stamp}`
    // why: written as soon as the checkout has moved, and again for a branch with none, so /flow report lists the retirement whatever step fails next.
    const writeArchive = async (archive: Archive): Promise<string> =>
      atomicReplace(port, recordsPath(common, bucket, `${issue}-${stamp}.json`), JSON.stringify(archive)).then(() => '', formatError)
    const moved: { archive?: Archive; error?: string } = {}
    const aside = await setUnitAside(port.processes, { issue, branch, tip, worktree, stamp }, async checkout => {
      moved.archive = composeArchive(plan.value, ref, checkout, stamp)
      moved.error = await writeArchive(moved.archive)
    })
    const describeArchive = (archive: Archive, error: string | undefined): string => `${error ? `writing the archive record failed: ${error}` : 'archive record written'}`
      + `.\nResume the work with: ${archive.restore}${archive.reclaim ? `\nReclaim its disk with: ${archive.reclaim}` : ''}`
    if (!aside.isOk) return stop(`${aside.error}${moved.archive ? `; ${describeArchive(moved.archive, moved.error)}` : ''}`)
    const archive = moved.archive ?? composeArchive(plan.value, ref, null, stamp)
    const kept = aside.value.done.join('; ')
    const written = moved.archive ? moved.error ?? '' : await writeArchive(archive)
    if (written) return stop(`${kept}; its mailbox, records and transcript are left in place, so remove by hand: ${left}; ${describeArchive(archive, written)}`)
    const commands = describeArchive(archive, undefined).replace(/^archive record written\.\n/, '')
    const removed = await removeRecords(port, common, plan.value, archive)
    if (!removed.isOk) {
      return stop(`${kept}; archive record written; removing its mailbox, records and transcript failed: ${removed.error}; `
        + `remove by hand whichever of these is left: ${left}.\n${commands}`)
    }
    const recorded = await record(plan.value, archive)
    if (!recorded.isOk) return stop(`${kept}; archive record written; records and transcript removed; recording the decision failed: ${recorded.error}\n${commands}`)
    const session = await readSession(port)
    for (const identity of plan.value.identities) {
      logEvent(port, { ...session, unit: identity }, 'retired', { ref: archive.ref, checkout: archive.checkout, by: session.sessionId, mailArchived: plan.value.mail })
    }
    return succeed([`Retired #${issue}'s unit (${branch}): ${kept}.`, `Resume the work with: ${archive.restore}`,
      ...archive.reclaim ? [`Reclaim its disk with: ${archive.reclaim}`] : [], ...recorded.value ? [recorded.value] : [],
      `A later spawn ${issue} starts a fresh session.`].join('\n'))
  })
}

/**
 * Writes a retirement's archive record: the kept ref and checkout with the commands that resume the work and reclaim the checkout.
 * @param plan - The retirement.
 * @param ref - The ref holding the branch tip.
 * @param checkout - The checkout moved aside, or null when the branch had none.
 * @param stamp - The retirement's stamp.
 * @returns The archive.
 */
function composeArchive(plan: RetirementPlan, ref: string, checkout: string | null, stamp: string): Archive {
  // why: the unit's own branch name goes to the respawned unit, so the resumed work takes a name of its own.
  const free = quoteWord(`${plan.branch}-retired-${stamp}`)
  return { v: 1, issue: plan.issue, branch: plan.branch, ref, checkout,
    restore: checkout ? `git -C ${quoteWord(checkout)} switch -c ${free}` : `git branch ${free} ${quoteWord(ref)}`,
    reclaim: checkout ? `git worktree remove --force ${quoteWord(checkout)}` : null }
}

/**
 * Resolves a path as the filesystem reads it, so two spellings of one checkout compare equal.
 * @param port - The engine calls.
 * @param path - The path.
 * @returns The canonical path, or the path itself when it cannot be resolved.
 */
async function resolvePath(port: EnginePort, path: string): Promise<string> {
  const resolved = await executeProcess(port.processes, ['realpath', '-m', '--', path]).catch(() => null)
  return resolved?.exitCode === 0 && resolved.stdout.trim() ? resolved.stdout.trim() : path
}

/**
 * Tells whether a directory is a checkout or lies under it.
 * @param directory - The resolved directory.
 * @param checkout - The resolved checkout.
 * @returns Whether the directory is inside the checkout.
 */
function isInside(directory: string, checkout: string): boolean {
  return directory === checkout || directory.startsWith(`${checkout}/`)
}

/**
 * Finds a checkout that may hold a unit's work outside its branch's worktree: the one its session worked in, which its transcript's
 * directory names, when it is no longer the branch's worktree, on whatever branch or commit. Only when no transcript identifies that
 * checkout and the branch has no worktree, any linked checkout with a detached HEAD, as a rebase, a bisect or a checkout of an older commit
 * leaves it, may be the unit's; checkouts earlier retirements set aside are left out.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param worktree - The branch's worktree, or null when it has none.
 * @param transcripts - The unit session's transcript paths.
 * @returns Why retiring is unsafe, naming the checkout, or null when no such checkout exists.
 */
async function findStrayCheckout(port: EnginePort, issue: number, worktree: string | null, transcripts: string[]): Promise<string | null> {
  const worktrees = await readWorktrees(port.processes)
  if (!worktrees) return 'the worktrees cannot be listed, so a checkout of the unit cannot be ruled out'
  // why: Claude Code files a session's transcript under its working directory with every other character than a letter or digit as `-`.
  const sessionDirectories = transcripts.map(path => path.split('/').at(-2))
  const listed = worktrees.filter(each => !/\.retired-\d{8}T\d{6}Z$/.test(each.root))
  const describe = (each: (typeof listed)[number]): string => each.branch ? `on ${each.branch.replace(/^refs\/heads\//, '')}` : `detached at ${each.head.slice(0, 7)}`
  const own = listed.find(each => sessionDirectories.includes(each.root.replace(/[^A-Za-z0-9]/g, '-')))
  if (own) return own.root === worktree ? null : `the checkout at ${quoteWord(own.root)} #${issue}'s session worked in is ${describe(own)}`
  // why: a long working directory gets a shortened transcript directory, so a checkout no transcript names may still be the unit's.
  const detached = worktree === null ? listed.slice(1).find(each => !each.branch) : undefined
  return detached ? `the checkout at ${quoteWord(detached.root)} is ${describe(detached)}` : null
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
  // why: an archive that cannot be read is left out, so one bad file never hides the issue's other retirements.
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
 * Removes what a unit leaves outside its checkout once the checkout is set aside: its mailbox's messages move into the archive, then its
 * records and transcript go.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param plan - The retirement.
 * @param archive - The retirement's archive.
 * @returns Nothing, or the step that failed.
 */
async function removeRecords(port: EnginePort, common: string, plan: RetirementPlan, archive: Archive): Promise<Result<void>> {
  // why: the retired session's mail stays readable for the record, but out of the mailbox a respawn reads.
  const target = mailArchivePath(common, archive)
  await executeProcess(port.processes, ['mkdir', '-p', '--', target])
  for (const box of archivedBoxes) {
    const source = mailPath(common, unitAddress(plan.issue), box)
    if (await port.files.stat(source).then(() => true, () => false) && (await executeProcess(port.processes, ['mv', '--', source, `${target}/${box}`])).exitCode !== 0) {
      return fail(`cannot move ${source} into ${target}`)
    }
  }
  const paths = [...plan.records, ...plan.transcripts]
  if (paths.length && (await executeProcess(port.processes, ['rm', '-rf', '--', ...paths])).exitCode !== 0) return fail('cannot remove the records and transcript')
  return succeed(undefined)
}

/**
 * Finds a unit's session transcripts, wherever Claude Code filed them: each session id belongs to the repository and issue alone.
 * @param port - The engine calls.
 * @param sessions - The unit's session ids: the recorded one, the derived one a later spawn would resume, and those handoffs superseded.
 * @returns Each transcript file and its directory of subagent transcripts, where they exist.
 */
async function findTranscripts(port: EnginePort, sessions: string[]): Promise<Result<string[]>> {
  const directory = await port.readClaudeDir()
  if (!directory) return fail('neither CLAUDE_CONFIG_DIR nor HOME is set, so the unit\'s transcript cannot be found, and a kept transcript would make the next spawn resume it')
  const projects = `${directory}/projects`
  const entries = await port.files.list(projects).catch(() => [])
  return succeed(await filterExisting(port, entries.flatMap(entry => sessions.flatMap(session => [`${projects}/${entry.name}/${session}.jsonl`, `${projects}/${entry.name}/${session}`]))))
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
    // why: a record that cannot be read is not taken as this branch's, so retirement never moves a file it could not check.
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
  if (!isRecord(value) || value.v !== 1 || typeof value.issue !== 'number' || typeof value.branch !== 'string' || typeof value.ref !== 'string'
    || typeof value.restore !== 'string') return null
  // why: a record written before checkouts were moved aside names no checkout and no reclaim command.
  const optional = (field: unknown): string | null => typeof field === 'string' ? field : null
  return { v: 1, issue: value.issue, branch: value.branch, ref: value.ref, checkout: optional(value.checkout), restore: value.restore, reclaim: optional(value.reclaim) }
}
