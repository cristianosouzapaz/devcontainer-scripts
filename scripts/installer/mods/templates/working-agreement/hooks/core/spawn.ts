import { findWorktreeRoot, readGitOutput, readParentBranch, readWorktreeStatus } from '../lib/git'
import { bodyLimit, unitAddress } from '../domain/mail'
import { appendInstructions } from '../domain/messages'
import { isRecord, isSafeInteger } from '../lib/guards'
import { parseJson, readJsonUnlessStrict } from '../lib/json'
import { executeProcess, runProcess } from '../lib/process'
import { createQueue } from '../lib/queue'
import { fail, formatErrorLine, succeed, unwrapOr } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { outsideHerdr } from './herdr-worktrees'
import { isMailAnswered, readMailState, sendMail } from './mailbox'
import { recordPlaced } from './placed-refs'
import { atomicReplace, readCommonDir, readSessionMirrors, recordsPath } from './record-store'
import { readGit, readRepositoryRoot } from './repository'
import { readSessionLiveness } from './session-host'
import { sessionMemory } from './session-memory'
import { unitArgs } from './unit-args'
import { readUnitHost, unitAgent } from './unit-host'
import type { UnitHost, UnitWorkspace } from './unit-host'
import { findUnitBranch, readDefaultBase, readIssueStart, readUnitState } from './unit-state'
import { breakStaleLock } from './verify-queue'

/** The model and effort a unit runs on, and why; both absent, the user's own defaults. */
export interface UnitLevel { model?: string; effort?: Effort; reason?: string }

/** How spawn started a unit: the permission mode it recorded, absent on a record that predates it, and the level the unit runs on. */
interface SpawnStart { mode?: string; level: UnitLevel }

/**
 * What a unit's session has been through, so a re-run resumes it instead of starting it twice, the permission mode it last started in,
 * the level it runs on, the reason of an escalation the coordinator asked for while the unit worked, the session it runs as, the start
 * assignment sent to its mailbox and why it was closed without a done, and whether merge_child integrated it while it worked, so its
 * session is closed once that turn ends.
 */
interface Progress extends UnitLevel {
  isStarted: boolean; isPrompted: boolean; assignId?: string; assignClosed?: string; mode?: string; escalation?: string; sessionId?: string; isClosing?: boolean
  /** When spawn first started the unit's session, ISO 8601: a delegated decision older than it belongs to an earlier unit of the issue. */
  startedAt?: string
}

/** How a host start ended: the session reported started, a start error with a workspace open, or a failure before any workspace existed. */
type StartOutcome = { kind: 'started' } | { kind: 'failed'; error: string } | { kind: 'no-workspace'; error: string }

/** The message a starting session takes first: its start assignment, or the inform that resumes it while that assignment is open. */
interface StartMessage { kind: 'assign' | 'inform'; id: string }

/** An effort a coordinator may give a unit; xhigh and max stay the user's to ask for. */
type Effort = typeof efforts[number]

/** A Conventional Commit title prefix, its type captured. */
const conventionalPrefix = /^([a-z]+)(\([^)]*\))?!?:\s*/i
// why: The RFC 4122 URL namespace, so the same repository and issue always give the same session id.
const namespace = '6ba7b8119dad11d180b400c04fd430c8'
const lockWaitMs = 30000
// why: a spawn's model check, host start and ack wait add up to a few minutes; a lock this much older belongs to a process that died holding it.
const staleLockMs = 600000
// why: a unit acks its assign in the first turn a ring or the tick starts after its session start, which a loaded machine can bring later than the host's own start wait.
/** How long after its send, which follows its session's host start, a unit's start assignment must get its transport ack. */
const assignAckMs = 120000
// why: bypassPermissions would lift every engine check in a session nobody watches; plan would stall it; anything unknown fails closed.
const inheritedModes = ['default', 'acceptEdits', 'auto']
/** The efforts a coordinator may pick for a unit. */
export const efforts = ['low', 'medium', 'high'] as const
// why: an unknown model still opens an interactive session, which fails only at its first prompt; a one-turn print run fails up front.
// No settings source but the project's, run from /, so the probe loads no plugin or hook and touches no repository.
const probeTimeoutMs = 60000
// why: a closed session's conversation stays on disk, so the restart resumes it; its host is given this long to end it.
const exitWaitMs = 30000
/** How long a unit's working agent is given to go idle before an escalation is put off. */
export const busyWaitMs = 1000
const queueSpawn = createQueue()
const spawnConfig = { limit: 4, continueAtUsageLimit: false }

/**
 * Sets how many spawned units may run at once, from the plugin's configuration.
 * @param limit - The configured cap; anything but a positive integer keeps the default.
 */
export function setSpawnLimit(limit: unknown): void {
  if (isSafeInteger(limit) && limit > 0) spawnConfig.limit = limit
}

/**
 * Sets whether unit sessions wait out a usage limit and continue on their own, from the plugin's configuration.
 * @param value - The configured option; anything but true leaves it off.
 */
export function setContinueAtUsageLimit(value: unknown): void {
  spawnConfig.continueAtUsageLimit = value === true
}

/**
 * Opens, reopens or reuses the unit session of an issue in its own herdr worktree; every step first checks whether it is done,
 * so a re-run after a crash completes a half-created unit.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param instructions - The coordinator's text for this unit, appended verbatim to its start prompt; empty appends nothing.
 * @param level - The model and effort the coordinator picks for a unit not yet started, with its reason; a started unit keeps its recorded one.
 * @returns What the unit is now, or why it is not started.
 */
export async function spawnUnit(port: EnginePort, issue: number, instructions = '', level: UnitLevel = {}): Promise<Result<string>> {
  const host = await readUnitHost(port)
  if (!host) return fail(outsideHerdr)
  return withSpawnLock(port, (common, root) => spawnLocked(port, host, common, root, issue, instructions, level))
}

/**
 * Runs work that creates or removes units while this process holds the repository's spawn lock, so it never races a spawn.
 * @param port - The engine calls.
 * @param work - What runs under the lock, given the git common directory and this session's checkout.
 * @returns What the work returns, or why it did not run.
 */
export async function withSpawnLock<T>(port: EnginePort, work: (common: string, root: string) => Promise<Result<T>>): Promise<Result<T>> {
  const common = await readCommonDir(port)
  const root = await readRepositoryRoot(port)
  if (!common || !root) return fail('this session is not in a git repository')
  return queueSpawn(() => holdLock(port, common, () => work(common, root)))
}

/**
 * Runs the spawn steps while this process holds the repository's spawn lock: the start assignment goes to the unit's mailbox once its
 * session's host start returns, so its doorbell starts the first turn only after the host saw the session ready, and spawn fails loudly
 * unless it is acknowledged within assignAckMs of that send.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param common - The git common directory.
 * @param root - The coordinator's checkout, which the host creates worktrees from.
 * @param issue - The issue number.
 * @param instructions - The coordinator's text for the start assignment.
 * @param chosen - The level the coordinator picks, used only by a unit never started.
 * @returns What the unit is now, or why it is not started.
 */
async function spawnLocked(port: EnginePort, host: UnitHost, common: string, root: string, issue: number, instructions: string,
  chosen: UnitLevel): Promise<Result<string>> {
  const declaring = await findDeclaringSession(port, issue)
  if (declaring) return fail(describeDeclaring(issue, declaring))
  const workspaces = await host.list(port)
  const own = workspaces.find(workspace => workspace.issue === issue)
  const running = own ? [] : await filterRunning(port, host, workspaces)
  if (running.length >= spawnConfig.limit) {
    return fail(`${running.length} units already run, the cap is ${spawnConfig.limit}: ${running.map(workspace => `#${workspace.issue} (${workspace.path})`).join(', ')}`)
  }
  const { isClosing, ...read } = await readProgressFile(port, common, issue, true)
  // why: a request is kept only for a unit below the top level, so a stale one never survives a rewrite.
  const { escalation, ...progress } = read
  // why: a spawn wants the unit live, so a close merge_child put off until its turn ended no longer applies.
  if (isClosing) await writeProgress(port, common, issue, { ...progress, ...read.escalation ? { escalation: read.escalation } : {} })
  const level = progress.isStarted ? pickLevel(progress) : pickLevel(chosen)
  // why: checked before the branch and worktree exist, so a wrong name starts nothing.
  if (!progress.isStarted && level.model) {
    const probed = await probeModel(port, level.model)
    if (!probed.isOk) return probed
  }
  const branch = await findUnitBranch(port, issue) ?? await createUnitBranch(port, issue)
  if (!branch.isOk) return branch
  const isLive = await host.state(port, own, 0) !== 'none'
  const session = await deriveSessionId(common, issue)
  const mode = isLive ? progress.mode : inheritMode(sessionMemory.permissionMode)
  const kept = { ...level, ...read.escalation && !isTopLevel(level) ? { escalation: read.escalation } : {}, mode, sessionId: session,
    startedAt: progress.startedAt ?? new Date(await port.now()).toISOString() }
  // why: the unit finds its mailbox by this record's session id, so the record names it before the session starts.
  if (progress.sessionId !== session) await writeProgress(port, common, issue, { ...progress, ...read.escalation ? { escalation: read.escalation } : {}, sessionId: session })
  const { paneId } = await port.readHerdrEnv()
  const body = appendInstructions(`Work on issue #${issue} on branch ${branch.value}: `
    + `read it with its comments (\`gh issue view ${issue} --comments\`), declare its flow, and work only in this worktree. The coordinator is herdr pane ${paneId}.`, instructions)
  // why: checked before the session starts, since the assignment is sent only once it runs.
  if (body.length > bodyLimit) return fail(`the start assignment is ${body.length} characters, over the ${bodyLimit} a message carries: put the rest in an issue comment and send its URL`)
  // why: a session that never took a prompt saved no conversation, and claude refuses to resume one it cannot find.
  // The host's start wait only guesses whether the session came up; the ack, or a live session, proves it, so its error alone is not fatal.
  const start = isLive ? { kind: 'live' as const } : await startSession(port, host, common, issue, { ...progress, ...kept, isStarted: true }, {
    root, issue, branch: branch.value, workspace: own, argv: [...unitArgs({ mode: inheritMode(mode), continueAtUsageLimit: spawnConfig.continueAtUsageLimit }),
      ...levelFlags(level), await hasConversation(port, session) ?? progress.isStarted ? '--resume' : '--session-id', session] })
  if (start.kind === 'no-workspace') {
    return fail(`#${issue}'s session was not started: its host opened no workspace for it (${start.error}), so no ack is waited for and the unit is not recorded as started`)
  }
  const startError = start.kind === 'failed' ? start.error : null
  // why: a session already running may have been left unnamed by a start whose host wait failed, so a reuse names it too.
  if (isLive || startError) await nameSession(port, host, issue)
  // why: mail sent before the host saw the session idle would start its first turn during the host's start wait and fail it.
  const message = await stageStartMessage(port, issue, progress, isLive, level, body).finally(() => executeProcess(port.processes, ['rm', '-f', '--', startingPath(common, issue)]))
  if (!message.isOk) return message
  const sent = message.value
  const assigned = sent?.kind === 'assign' ? { assignId: sent.id } : {}
  if (sent) {
    await writeProgress(port, common, issue, isLive ? { ...progress, ...read.escalation ? { escalation: read.escalation } : {}, sessionId: session, ...assigned }
      : { ...progress, ...kept, ...assigned, isStarted: true })
    // why: spawn's own start check, not a protocol deadline: the message gets no further attempt, retry or dead letter.
    if (!await pollUntil(port, assignAckMs, 1000, async () => await readMailState(port, unitAddress(issue), sent.id) === 'acknowledged')) {
      if (sent.kind === 'assign') await writeProgress(port, common, issue, { ...progress, ...kept, ...assigned, isStarted: true, isPrompted: false })
      const closed = isLive ? '' : await closeIfGone(port, host, issue)
      return fail(`#${issue} did not acknowledge its ${describeMessage(sent)} within ${assignAckMs / 1000} s of its send after the session's start${closed || ': its session '
        + 'took no mail, so it does not work on the issue. Read it with unit_read; a later spawn waits for this same message and never sends a second one'}`
        + `${startError ? ` (the host's start said: ${startError})` : ''}`)
    }
    await writeProgress(port, common, issue, { ...progress, ...kept, ...assigned, isStarted: true, isPrompted: true })
  } else if (startError) {
    const closed = await closeIfGone(port, host, issue)
    if (closed) return fail(`#${issue}'s session did not start${closed} (the host's start said: ${startError})`)
  }
  // why: a unit already past its start assignment is mid-turn; text sent now would queue behind that turn, so the coordinator decides how to send it.
  const clauses = [progress.isPrompted && instructions ? '; its start assignment went earlier, so the instructions are not sent: send them with unit_prompt' : '',
    progress.isStarted && (chosen.model || chosen.effort) ? '; its recorded model and effort are kept, the ones given are ignored' : '']
  if (isLive) {
    return succeed(`#${issue} already runs as herdr agent ${unitAgent(issue)} on ${branch.value}${own ? ` in ${own.path}` : ''}`
      + `${[sent ? `; its ${describeMessage(sent)} was acknowledged now` : '', ...clauses].join('')}.`)
  }
  const standing = progress.isStarted ? await describeStanding(port, branch.value) : ''
  return succeed(`#${issue} ${progress.isStarted ? 'resumed' : 'started'} as herdr agent ${unitAgent(issue)} on ${branch.value} in ${mode} mode, `
    + `${describeLevel(level)} (session ${session})${sent ? `, its ${describeMessage(sent)} acknowledged` : ''}${[...clauses, standing].join('')}.`)
}

/**
 * Starts a unit's session through its host once its record says it started, so a session the host reports as failed but that runs
 * is already the unit's; a start marker stands until the start message is sent, so no other mail rings meanwhile.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @param record - The spawn record the started unit has.
 * @param request - The host's start request.
 * @returns How the start ended; a start that opened no workspace leaves the record as it was.
 */
async function startSession(port: EnginePort, host: UnitHost, common: string, issue: number, record: Progress,
  request: Parameters<UnitHost['start']>[1]): Promise<StartOutcome> {
  const before = await readProgressFile(port, common, issue, true)
  await atomicReplace(port, startingPath(common, issue), String(await port.now()))
  await writeProgress(port, common, issue, record)
  const error = await host.start(port, request).then(() => null, (thrown: unknown) => formatErrorLine(thrown))
  if (!error) return { kind: 'started' }
  if ((await host.list(port)).some(workspace => workspace.issue === issue)) return { kind: 'failed', error }
  // why: with no workspace no session can run, so the record goes back to what it said before this start.
  await writeProgress(port, common, issue, before)
  await executeProcess(port.processes, ['rm', '-f', '--', startingPath(common, issue)])
  return { kind: 'no-workspace', error }
}

/**
 * Names the marker a spawn keeps while it starts an issue's session, until the start message is sent.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @returns The file path.
 */
function startingPath(common: string, issue: number): string {
  return recordsPath(common, 'spawn', `${issue}.starting`)
}

/**
 * Tells whether a spawn is starting an issue's session now: mail sent meanwhile would ring before the host saw the session ready.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns Whether the start marker exists and is younger than a spawn can run.
 */
export async function isUnitStarting(port: EnginePort, issue: number): Promise<boolean> {
  const common = await readCommonDir(port)
  const marker = common ? await port.files.stat(startingPath(common, issue)).catch(() => null) : null
  return !!marker && await port.now() - marker.mtimeMs <= staleLockMs
}

/**
 * Names a unit's running session through its host, so a session the host left unnamed is reachable by name as well.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param issue - The unit's issue.
 * @returns Once the host named it, or found no session to name.
 */
async function nameSession(port: EnginePort, host: UnitHost, issue: number): Promise<void> {
  const own = (await host.list(port)).find(workspace => workspace.issue === issue)
  if (own) await host.name(port, own)
}

/**
 * Closes a unit's workspace when the host shows no session in it: the only proof, beside a missing ack, that its start failed.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param issue - The unit's issue.
 * @returns The clause saying the workspace was closed, empty when a session runs in it or no workspace is open.
 */
async function closeIfGone(port: EnginePort, host: UnitHost, issue: number): Promise<string> {
  const own = (await host.list(port)).find(workspace => workspace.issue === issue)
  if (!own || await host.state(port, own, 0) !== 'none') return ''
  await host.close(port, own)
  return `, and no session runs in its workspace, so its workspace was closed: spawn it again to start it afresh`
}

/**
 * Tells whether Claude Code saved a session's conversation, wherever it filed it under the projects directory.
 * @param port - The engine calls.
 * @param session - The session id.
 * @returns Whether its transcript exists, or null when the Claude config directory is unknown.
 */
async function hasConversation(port: EnginePort, session: string): Promise<boolean | null> {
  const directory = await port.readClaudeDir()
  if (!directory) return null
  // The projects directory exists only once a session saved something.
  const projects = await port.files.list(`${directory}/projects`).catch(() => [])
  const found = await Promise.all(projects.map(entry => port.files.stat(`${directory}/projects/${entry.name}/${session}.jsonl`).then(() => true, () => false)))
  return found.includes(true)
}

/**
 * Picks and sends the message a starting unit's session takes first: its start assignment until one is acknowledged, an earlier spawn's
 * still unread one included; on a resume, an inform while that assignment is still open, or an assignment for a unit that never got one
 * as mail. A live session gets nothing more: its conversation is under way.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @param progress - The unit's spawn record.
 * @param isLive - Whether its session already runs.
 * @param level - The level the session runs on.
 * @param body - The start assignment.
 * @returns The message to wait for, null when none is due, or why it was not sent.
 */
async function stageStartMessage(port: EnginePort, issue: number, progress: Progress, isLive: boolean, level: UnitLevel,
  body: string): Promise<Result<StartMessage | null>> {
  const to = unitAddress(issue)
  const send = async (kind: StartMessage['kind'], text: string): Promise<Result<StartMessage>> => {
    const sent = await sendMail(port, { kind, to, issue, body: text })
    return sent.isOk ? succeed({ kind, id: sent.value }) : sent
  }
  const recorded = progress.assignId
  if (!progress.isPrompted) return recorded && await readMailState(port, to, recorded) !== 'none' ? succeed({ kind: 'assign', id: recorded }) : send('assign', body)
  if (isLive) return succeed(null)
  // why: a unit started before start assignments travelled as mail has none to keep open.
  if (!recorded) return send('assign', body)
  if (progress.assignClosed || await isMailAnswered(port, to, recorded)) return succeed(null)
  return send('inform', `This session was resumed on ${describeLevel(level)}. Go on with issue #${issue} where you left it: its start assignment `
    + `(message ${recorded}) is still open.`)
}

/**
 * Names a start message in spawn's result.
 * @param message - The message.
 * @returns Such as `start assignment (message …)`.
 */
function describeMessage(message: StartMessage): string {
  return `${message.kind === 'assign' ? 'start assignment' : 'resume message'} (message ${message.id})`
}

/**
 * Closes the start assignment a unit integrated without replying done to, so a resume never reopens it, and records the closing in its
 * spawn record; the caller holds the spawn lock.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @returns The closed assignment's id, or null when none was open.
 */
export async function closeOpenAssign(port: EnginePort, common: string, issue: number): Promise<string | null> {
  const progress = await readProgressFile(port, common, issue, true)
  const id = progress.assignId
  if (!id || progress.assignClosed || await isMailAnswered(port, unitAddress(issue), id)) return null
  await writeProgress(port, common, issue, { ...progress, assignClosed: 'integrated without done' })
  return id
}

/**
 * Finds another session that runs and has declared an issue, so no second unit for it starts beside that session.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @returns The session id, or null when only the issue's own unit session, or none, declares it.
 */
export async function findDeclaringSession(port: EnginePort, issue: number): Promise<string | null> {
  const own = await readSpawnedSession(port, issue, false)
  for (const { session } of await readSessionMirrors(port)) {
    if (session.sessionId !== own && session.unit?.issues.includes(issue) && await readSessionLiveness(port, session.sessionId) === 'live') return session.sessionId
  }
  return null
}

/**
 * Names the session spawn started for an issue's unit, which keeps its id across a resume.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param strict - Whether an unreadable spawn record throws.
 * @returns The session id, or null when spawn never named a session for the issue or retired it.
 */
export async function readSpawnedSession(port: EnginePort, issue: number, strict: boolean): Promise<string | null> {
  const common = await readCommonDir(port)
  if (!common) return null
  const progress = await readProgressFile(port, common, issue, strict)
  // why: the record names the session before it starts, and a start the host reported failed may still run as that session.
  if (progress.sessionId) return progress.sessionId
  // why: a started record without sessionId names the session the id derivation gives.
  return progress.isStarted ? deriveSessionId(common, issue) : null
}

/**
 * Says why an issue another session declares gets no unit.
 * @param issue - The issue.
 * @param session - The declaring session.
 * @returns The refusal.
 */
export function describeDeclaring(issue: number, session: string): string {
  return `#${issue} is declared by session ${session}, which still runs: no unit starts for it until that session's declaration is removed`
}

/**
 * Describes how a resumed unit stands: how far its branch is behind its parent's current tip and whether its worktree holds
 * uncommitted changes, so the coordinator decides up front instead of finding out at merge_child.
 * @param port - The engine calls.
 * @param branch - The unit branch.
 * @returns The clauses to append, empty when the branch holds its parent's tip and its worktree is clean.
 */
async function describeStanding(port: EnginePort, branch: string): Promise<string> {
  const git = await readGit(port)
  const parent = git ? await readParentBranch(port.processes, branch, git.base) : null
  const behind = parent ? await readGitOutput(port.processes, ['rev-list', '--count', `${branch}..${parent}`]) : null
  const root = await findWorktreeRoot(port.processes, branch)
  const status = root ? await readWorktreeStatus(port.processes, root) : null
  return `${behind && behind !== '0' ? `; ${branch} is ${behind} commit(s) behind ${parent}'s tip` : ''}${status ? `; ${root} has uncommitted changes` : ''}`
}

/**
 * Keeps the workspaces that hold a machine slot: a live session whose unit is still working toward its result.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param workspaces - The spawned workspaces.
 * @returns The workspaces the cap counts; all of them when the repository state is unreadable.
 * @throws When the host fails or the branches cannot be listed.
 */
async function filterRunning(port: EnginePort, host: UnitHost, workspaces: UnitWorkspace[]): Promise<UnitWorkspace[]> {
  const base = await readDefaultBase(port)
  if (!base) return workspaces
  const mirrors = await readSessionMirrors(port)
  const counted = await Promise.all(workspaces.map(async workspace => await host.state(port, workspace, 0) !== 'none'
    && !['finished', 'integrated'].includes(await readUnitState(port, workspace.issue, base, mirrors))))
  return workspaces.filter((_, index) => counted[index])
}

/**
 * Creates the unit branch of a ready-for-agent issue, `<type>/<n>-<slug>`, typed by the title's Conventional Commit prefix (`<n>-<slug>` without one),
 * create-only, from the default branch or from its open dependency's branch.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns The branch, or what it waits for.
 */
async function createUnitBranch(port: EnginePort, issue: number): Promise<Result<string>> {
  const start = await readIssueStart(port, issue)
  if (!start.isOk) return start
  const { title, base } = start.value
  if (!base.isReady) return fail(base.reason)
  const sha = await readGitOutput(port.processes, ['rev-parse', '--verify', '--quiet', base.ref])
  if (!sha) return fail(`cannot resolve ${base.ref}`)
  const type = title.match(conventionalPrefix)?.[1]?.toLowerCase()
  const branch = `${type ? `${type}/` : ''}${issue}-${slugify(title)}`
  // why: recorded before the ref exists, so a window that sees the branch already finds the record.
  await recordPlaced(port, branch, sha)
  // why: the unit's declaration reads its parent from this first reflog entry; without it a child counts the parent's commits as its own.
  const created = await readGitOutput(port.processes, ['update-ref', '-m', `branch: Created from ${base.parent}`, `refs/heads/${branch}`, sha, ''])
  if (created !== null) return succeed(branch)
  return await findUnitBranch(port, issue) ?? fail(`cannot create ${branch}`)
}

/**
 * Holds the repository's spawn lock, an atomic `mkdir`, for one piece of work; a lock older than a spawn can run is broken.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param work - What runs under the lock.
 * @returns What the work returns, or the failure to take the lock in time.
 */
async function holdLock<T>(port: EnginePort, common: string, work: () => Promise<Result<T>>): Promise<Result<T>> {
  const directory = recordsPath(common, 'spawn')
  const lock = `${directory}/lock`
  await executeProcess(port.processes, ['mkdir', '-p', '--', directory])
  const take = async (): Promise<boolean> => {
    if ((await executeProcess(port.processes, ['mkdir', '--', lock])).exitCode === 0) return true
    // why: a listing reports a directory's mtime as zero, so only stat dates the lock.
    const held = await port.files.stat(lock).catch(() => null)
    if (!held || await port.now() - held.mtimeMs <= staleLockMs) return false
    await breakStaleLock(port, directory, await port.readSessionId())
    return take()
  }
  if (!await pollUntil(port, lockWaitMs, 250, take)) return fail('another spawn holds the lock; retry once it ends')
  try {
    return await work()
  } catch (error) {
    return fail(formatErrorLine(error))
  } finally {
    await executeProcess(port.processes, ['rmdir', '--', lock])
  }
}

/**
 * Checks a condition until it holds or the time runs out, pausing in a host `sleep`: a process call in flight stops the hook's budget
 * clock, which a `$.clock` wait runs down, so a wait as long as the assignment's deadline outlasts the engine's ten-second hook budget.
 * @param port - The engine calls.
 * @param timeoutMs - How long it is checked.
 * @param intervalMs - The pause between two checks.
 * @param check - The condition.
 * @returns Whether it held before the time ran out.
 */
async function pollUntil(port: EnginePort, timeoutMs: number, intervalMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = await port.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (await port.now() > deadline) return false
    await executeProcess(port.processes, ['sleep', String(intervalMs / 1000)])
  }
}

/**
 * Names an issue's spawn progress record.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @returns The file path.
 */
export function progressPath(common: string, issue: number): string {
  return recordsPath(common, 'spawn', `${issue}.json`)
}

/**
 * Reads an issue's spawn progress record.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @param strict - Whether an unreadable record throws; else it reads as a unit never started.
 * @returns The progress.
 */
export async function readProgressFile(port: EnginePort, common: string, issue: number, strict: boolean): Promise<Progress> {
  return readProgress(await readJsonUnlessStrict(port.files, progressPath(common, issue), strict, undefined))
}

/**
 * Replaces an issue's spawn progress record.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @param progress - The whole record.
 * @returns Once the record is written.
 */
export function writeProgress(port: EnginePort, common: string, issue: number, progress: Progress): Promise<void> {
  return atomicReplace(port, progressPath(common, issue), JSON.stringify(progress))
}

/**
 * Reads a unit's progress record, a missing or foreign one standing for a unit never started.
 * @param value - The parsed record.
 * @returns The progress.
 */
function readProgress(value: unknown): Progress {
  const text = (key: string): Record<string, string> => isRecord(value) && typeof value[key] === 'string' && value[key] ? { [key]: value[key] } : {}
  const effort = isRecord(value) ? parseEffort(value.effort) : undefined
  return { isStarted: isRecord(value) && value.isStarted === true, isPrompted: isRecord(value) && value.isPrompted === true,
    ...text('assignId'), ...text('assignClosed'), ...text('mode'), ...text('model'), ...(effort ? { effort } : {}),
    ...text('reason'), ...text('escalation'), ...text('sessionId'), ...text('startedAt'), ...(isRecord(value) && value.isClosing === true ? { isClosing: true } : {}) }
}

/**
 * Reads an effort a coordinator may give a unit.
 * @param value - The effort as given or recorded.
 * @returns The effort, or undefined when it is not one of efforts.
 */
export function parseEffort(value: unknown): Effort | undefined {
  return efforts.find(each => each === value)
}

/**
 * Keeps only a level's own fields, so a record or a call never carries more into the start command.
 * @param level - The level, as recorded or given.
 * @returns The model, effort and reason that are set.
 */
function pickLevel(level: UnitLevel): UnitLevel {
  return { ...level.model ? { model: level.model } : {}, ...level.effort ? { effort: level.effort } : {}, ...level.reason ? { reason: level.reason } : {} }
}

/**
 * Turns a level into the claude flags that start a session on it.
 * @param level - The level.
 * @returns `--model` and `--effort` for what is set; none for the user's defaults.
 */
function levelFlags(level: UnitLevel): string[] {
  return [...level.model ? ['--model', level.model] : [], ...level.effort ? ['--effort', level.effort] : []]
}

/**
 * Words the level a unit runs on, with its reason.
 * @param level - The level.
 * @returns Such as `model haiku, effort low (a typo fix)`; the user's defaults read as such.
 */
export function describeLevel(level: UnitLevel): string {
  const model = level.model ? `model ${level.model}` : 'default model'
  const effort = level.effort ? `effort ${level.effort}` : 'default effort'
  return `${model}, ${effort}${level.reason ? ` (${level.reason})` : ''}`
}

/**
 * Tells whether the claude CLI accepts a model name, by one print turn that loads no plugin, MCP server or hook.
 * @param port - The engine calls.
 * @param model - The model name or alias.
 * @returns Nothing, or why the model is refused.
 */
async function probeModel(port: EnginePort, model: string): Promise<Result<undefined>> {
  const run = await runProcess(port.processes, ['claude', '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence',
    '--model', model, '--max-turns', '1', '--output-format', 'json', '-p', 'Reply with OK.'], probeTimeoutMs, { cwd: '/' })
  if (!run.isOk) return fail(`the model ${model} could not be checked, so nothing is started: ${run.error}`)
  const reply = unwrapOr(parseJson(run.value.stdout), undefined)
  if (run.value.exitCode === 0 && isRecord(reply) && reply.is_error === false) return succeed(undefined)
  const said = isRecord(reply) && typeof reply.result === 'string' ? reply.result : run.value.stderr.trim() || `exit ${run.value.exitCode}`
  return fail(`the claude CLI does not run model ${model}, so nothing is started: ${said}`)
}

/**
 * Picks the permission mode a unit starts in from the coordinator's.
 * @param mode - The coordinator's mode, if the engine reported one.
 * @returns The same mode when a unit may run in it, else default.
 */
function inheritMode(mode: string | null | undefined): string {
  return mode && inheritedModes.includes(mode) ? mode : 'default'
}

/**
 * Reads how spawn started a unit of these issues, from the first started record.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @returns The recorded mode and level, or undefined when spawn never started one.
 */
export async function readSpawnStart(port: EnginePort, issues: number[]): Promise<SpawnStart | undefined> {
  for (const issue of issues) {
    const progress = await readSpawnProgress(port, issue)
    if (progress?.isStarted) return { ...progress.mode ? { mode: progress.mode } : {}, level: pickLevel(progress) }
  }
  return undefined
}

/**
 * Reads an issue's spawn progress record.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @returns The progress, or null outside a repository or when the record is unreadable.
 */
export async function readSpawnProgress(port: EnginePort, issue: number): Promise<Progress | null> {
  const common = await readCommonDir(port)
  return common ? readProgressFile(port, common, issue, false) : null
}

/**
 * Tells whether a level is the escalation target already: the user's default model with effort high, or the user's defaults untouched,
 * which the mod never overrides.
 * @param level - The unit's level.
 * @returns Whether an escalation would not raise it.
 */
export function isTopLevel(level: UnitLevel): boolean {
  return !level.model && level.effort !== 'low' && level.effort !== 'medium'
}

/**
 * Tells whether a unit's session is idle, waiting briefly for a turn that is ending.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param waitMs - How long a working session is given to go idle.
 * @returns Whether its host reports it idle within that time; false without a host or a running session.
 */
export async function isUnitIdle(port: EnginePort, issue: number, waitMs: number): Promise<boolean> {
  const host = await readUnitHost(port)
  if (!host) return false
  return await host.state(port, (await host.list(port)).find(workspace => workspace.issue === issue), waitMs) === 'idle'
}

/**
 * Raises an idle unit to the user's default model with effort high: closes its session through its host, records the new level, and
 * resumes the same conversation on it, under the spawn lock. A unit that works, or already runs at that level, is left as it is.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param signal - What triggered the escalation, recorded as the level's reason.
 * @returns The resumed unit, or why it was not escalated.
 */
export async function escalateUnit(port: EnginePort, issue: number, signal: string): Promise<Result<string>> {
  const host = await readUnitHost(port)
  if (!host) return fail(outsideHerdr)
  return withSpawnLock(port, async (common, root) => {
    const progress = await readProgressFile(port, common, issue, true)
    if (!progress.isStarted) return fail(`#${issue} has no unit spawn started`)
    if (isTopLevel(progress)) return fail(`#${issue} already runs on the user's default model and effort, so it is not escalated: its case is the coordinator's`)
    const own = (await host.list(port)).find(workspace => workspace.issue === issue)
    const state = await host.state(port, own, busyWaitMs)
    if (state === 'working') return fail(`#${issue}'s unit works, so it is not escalated now`)
    if (own && state === 'idle') {
      await host.close(port, own)
      const isClosed = await pollUntil(port, exitWaitMs, 500, async () => await host.state(port, own, 0) === 'none')
      if (!isClosed) return fail(`#${issue}'s session did not end after its host closed it, so it is not escalated`)
    }
    const { model, escalation, ...rest } = progress
    await writeProgress(port, common, issue, { ...rest, effort: 'high', reason: `escalated: ${signal}` })
    return spawnLocked(port, host, common, root, issue, '', {})
  })
}

/**
 * Turns an issue title into a branch slug, without its Conventional Commit prefix.
 * @param title - The issue title.
 * @returns Lowercase words joined by hyphens, at most 40 characters.
 */
function slugify(title: string): string {
  const words = title.replace(conventionalPrefix, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const slug = words.reduce((kept, word) => !kept ? word : `${kept}-${word}`.length <= 40 ? `${kept}-${word}` : kept, '')
  return slug.slice(0, 40) || 'unit'
}

/**
 * Derives the unit's session id as a UUIDv5 of the repository and the issue, so a restart resumes the same session.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @returns The session id.
 */
export async function deriveSessionId(common: string, issue: number): Promise<string> {
  const name = new TextEncoder().encode(`${common}#${issue}`)
  const bytes = new Uint8Array(16 + name.length)
  bytes.set(namespace.match(/../g)?.map(pair => parseInt(pair, 16)) ?? [])
  bytes.set(name, 16)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes)).slice(0, 16)
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80
  const hex = [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
