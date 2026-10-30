import { findWorktreeRoot, readDefaultRef, readGitOutput, readParentBranch, readWorktreeStatus } from '../lib/git'
import { appendInstructions } from '../domain/messages'
import { isIssueNumber, isRecord, isSafeInteger } from '../lib/guards'
import { readJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import { createQueue } from '../lib/queue'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { isInsideHerdr, listHerdrWorktrees, readField, runHerdr, runHerdrText } from './herdr-worktrees'
import { recordPlaced } from './placed-refs'
import { atomicReplace, readCommonDir, readSessionMirrors, recordsPath } from './record-store'
import { readGit, readRepositoryRoot } from './repository'
import { sessionMemory } from './session-memory'
import { findUnitBranch, readIssueStart, readUnitState } from './unit-state'
import { breakStaleLock } from './verify-queue'

/** A spawned unit's herdr workspace. */
export interface UnitWorkspace { issue: number; workspaceId: string; path: string }

/** What a unit's session has been through, so a re-run resumes it instead of starting it twice, and the permission mode it last started in. */
interface Progress { isStarted: boolean; isPrompted: boolean; isTyped?: boolean; mode?: string }

/** Every spawned workspace's label is this followed by the issue number; the cap counts them. */
const labelPrefix = 'wa-spawn:'
/** A Conventional Commit title prefix, its type captured. */
const conventionalPrefix = /^([a-z]+)(\([^)]*\))?!?:\s*/i
// why: The RFC 4122 URL namespace, so the same repository and issue always give the same session id.
const namespace = '6ba7b8119dad11d180b400c04fd430c8'
const lockWaitMs = 30000
// why: A spawn waits up to a minute for the agent; a lock this much older belongs to a process that died holding it.
const staleLockMs = 120000
const agentStartTimeoutMs = 60000
// why: herdr fails a waited prompt that saw no working or blocked state within 5s; the retry's wait gets as long.
const promptWaitMs = 10000
/** The states that show the agent took its prompt: blocked is a permission question inside the turn. */
const taken = ['--until', 'working', '--until', 'blocked']
// why: bypassPermissions would lift every engine check in a session nobody watches; plan would stall it; anything unknown fails closed.
const inheritedModes = ['default', 'acceptEdits', 'auto']
const queueSpawn = createQueue()
const spawnConfig = { limit: 4 }

/**
 * Sets how many spawned units may run at once, from the plugin's configuration.
 * @param limit - The configured cap; anything but a positive integer keeps the default.
 */
export function setSpawnLimit(limit: unknown): void {
  if (isSafeInteger(limit) && limit > 0) spawnConfig.limit = limit
}

/**
 * Names the herdr agent of an issue's unit session.
 * @param issue - The issue number.
 * @returns The agent name the unit messaging tools target.
 */
export function unitAgent(issue: number): string {
  return `issue-${issue}`
}

/**
 * Opens, reopens or reuses the unit session of an issue in its own herdr worktree; every step first checks whether it is done,
 * so a re-run after a crash completes a half-created unit.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param instructions - The coordinator's text for this unit, appended verbatim to its start prompt; empty appends nothing.
 * @returns What the unit is now, or why it is not started.
 */
export async function spawnUnit(port: EnginePort, issue: number, instructions = ''): Promise<Result<string>> {
  if (!await isInsideHerdr(port)) return fail('this session does not run inside herdr, which hosts every unit session')
  return withSpawnLock(port, (common, root) => spawnLocked(port, common, root, issue, instructions))
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
 * Runs the spawn steps while this process holds the repository's spawn lock.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param root - The coordinator's checkout, which herdr creates worktrees from.
 * @param issue - The issue number.
 * @param instructions - The coordinator's text for the start prompt.
 * @returns What the unit is now, or why it is not started.
 */
async function spawnLocked(port: EnginePort, common: string, root: string, issue: number, instructions: string): Promise<Result<string>> {
  const workspaces = await listUnitWorkspaces(port)
  const own = workspaces.find(workspace => workspace.issue === issue)
  const running = own ? [] : await filterRunning(port, workspaces)
  if (running.length >= spawnConfig.limit) {
    return fail(`${running.length} units already run, the cap is ${spawnConfig.limit}: ${running.map(workspace => `#${workspace.issue} (${workspace.path})`).join(', ')}`)
  }
  const branch = await findUnitBranch(port, issue) ?? await createUnitBranch(port, issue)
  if (!branch.isOk) return branch
  const pane = own ? await findIdlePane(port, own.workspaceId) : await openWorktree(port, root, issue, branch.value)
  const progressFile = progressPath(common, issue)
  const progress = readProgress(await readJson(port.files, progressFile))
  const session = await deriveSessionId(common, issue)
  const mode = pane === null ? progress.mode : inheritMode(sessionMemory.permissionMode)
  if (pane !== null) {
    await runHerdrText(port, ['agent', 'start', unitAgent(issue), '--kind', 'claude', '--pane', pane, '--timeout', String(agentStartTimeoutMs),
      '--', '--permission-mode', inheritMode(mode), progress.isStarted ? '--resume' : '--session-id', session], agentStartTimeoutMs + 15000)
    await atomicReplace(port, progressFile, JSON.stringify({ ...progress, isStarted: true, mode }))
  }
  // why: a live unit whose start prompt failed would otherwise wait forever on an empty prompt.
  if (!progress.isPrompted) {
    const { paneId } = await port.readHerdrEnv()
    const text = appendInstructions(`Work on issue #${issue} on branch ${branch.value}: read it with its comments `
      + `(\`gh issue view ${issue} --comments\`), declare its flow, and work only in this worktree. The coordinator is herdr pane ${paneId}.`, instructions)
    if (!await submitPrompt(port, unitAgent(issue), text, progress.isTyped === true)) {
      await atomicReplace(port, progressFile, JSON.stringify({ isStarted: true, isPrompted: false, isTyped: true, mode }))
      return fail(`#${issue} did not take its start prompt: herdr agent ${unitAgent(issue)} stays idle with it typed and unsent in its input box. `
        + 'Read it with unit_read; spawn again submits it without typing it twice')
    }
    await atomicReplace(port, progressFile, JSON.stringify({ isStarted: true, isPrompted: true, mode }))
  }
  // why: a unit already past its start prompt is mid-turn; text sent now would queue behind that turn, so the coordinator decides how to send it.
  const unsent = progress.isPrompted && instructions ? '; its start prompt went earlier, so the instructions are not sent: send them with unit_prompt' : ''
  if (pane === null) {
    return succeed(`#${issue} already runs as herdr agent ${unitAgent(issue)} on ${branch.value}${own ? ` in ${own.path}` : ''}${progress.isPrompted ? '' : '; its start prompt is sent now'}${unsent}.`)
  }
  const standing = progress.isStarted ? await describeStanding(port, branch.value) : ''
  return succeed(`#${issue} ${progress.isStarted ? 'resumed' : 'started'} as herdr agent ${unitAgent(issue)} on ${branch.value} in ${mode} mode (session ${session})${unsent}${standing}.`)
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
 * Submits a unit's start prompt and confirms the agent took it; a submit the agent missed, right after its start, gets one more Enter.
 * @param port - The engine calls.
 * @param agent - The unit's herdr agent.
 * @param text - The start prompt.
 * @param isTyped - Whether an earlier spawn already typed it, so only the submit is left.
 * @returns Whether the agent left idle for it.
 */
async function submitPrompt(port: EnginePort, agent: string, text: string, isTyped: boolean): Promise<boolean> {
  const isTaken = (args: string[]) => runHerdrText(port, args, promptWaitMs + 5000).then(() => true, () => false)
  // herdr 0.9.5 takes the text as a positional argument and rejects `--` before it, even for text starting with a dash.
  if (!isTyped && await isTaken(['agent', 'prompt', agent, text, '--wait', ...taken, '--timeout', String(promptWaitMs)])) return true
  // why: the missed text stays typed in the input box; typing it again would submit it twice.
  await runHerdrText(port, ['agent', 'send-keys', agent, 'Enter'])
  return isTaken(['agent', 'wait', agent, ...taken, '--timeout', String(promptWaitMs)])
}

/**
 * Lists the workspaces spawn opened, alive in herdr now.
 * @param port - The engine calls.
 * @returns Each workspace with its issue.
 * @throws When herdr fails.
 */
export async function listUnitWorkspaces(port: EnginePort): Promise<UnitWorkspace[]> {
  return (await listHerdrWorktrees(port, labelPrefix)).flatMap(({ name, workspaceId, path }) =>
    isIssueNumber(Number(name)) ? [{ issue: Number(name), workspaceId, path }] : [])
}

/**
 * Keeps the workspaces that hold a machine slot: a live session whose unit is still working toward its result.
 * @param port - The engine calls.
 * @param workspaces - The spawned workspaces.
 * @returns The workspaces the cap counts; all of them when the repository state is unreadable.
 * @throws When herdr fails or the branches cannot be listed.
 */
async function filterRunning(port: EnginePort, workspaces: UnitWorkspace[]): Promise<UnitWorkspace[]> {
  const git = await readGit(port)
  if (!git) return workspaces
  const base = { name: git.base, ref: await readDefaultRef(port.processes, git.base) }
  const mirrors = await readSessionMirrors(port)
  const counted = await Promise.all(workspaces.map(async workspace => (await listLivePanes(port, workspace.workspaceId)).some(hasAgent)
    && !['finished', 'integrated'].includes(await readUnitState(port, workspace.issue, base, mirrors))))
  return workspaces.filter((_, index) => counted[index])
}

/**
 * Lists a unit workspace's panes; a workspace closed since spawn listed it has none.
 * @param port - The engine calls.
 * @param workspaceId - The workspace.
 * @returns The panes, empty when the workspace is gone.
 * @throws When herdr fails while the workspace still exists.
 */
async function listLivePanes(port: EnginePort, workspaceId: string): Promise<unknown[]> {
  try {
    return await listPanes(port, workspaceId)
  } catch (error) {
    if ((await listUnitWorkspaces(port)).some(workspace => workspace.workspaceId === workspaceId)) throw error
    return []
  }
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
 * Opens the unit's worktree as a labelled herdr workspace: the checkout git already lists, or a new one on the branch.
 * @param port - The engine calls.
 * @param root - The coordinator's checkout.
 * @param issue - The issue number.
 * @param branch - The unit branch.
 * @returns The workspace's root pane.
 * @throws When herdr fails or names no pane.
 */
async function openWorktree(port: EnginePort, root: string, issue: number, branch: string): Promise<string> {
  const path = await findWorktreeRoot(port.processes, branch)
  const label = ['--label', `${labelPrefix}${issue}`, '--no-focus']
  const reply = await runHerdr(port, path
    ? ['worktree', 'open', '--cwd', root, '--path', path, ...label]
    : ['worktree', 'create', '--cwd', root, '--branch', branch, '--base', branch, ...label])
  const pane = readField(reply, 'result', 'root_pane', 'pane_id')
  if (typeof pane !== 'string') throw new Error('herdr named no pane for the worktree')
  return pane
}

/**
 * Finds a pane of the unit's workspace to start its session in, unless an agent already runs there.
 * @param port - The engine calls.
 * @param workspaceId - The unit's workspace.
 * @returns The pane, or null when the session is live.
 * @throws When herdr fails or lists no pane.
 */
async function findIdlePane(port: EnginePort, workspaceId: string): Promise<string | null> {
  const list = await listPanes(port, workspaceId)
  if (list.some(hasAgent)) return null
  const pane = readField(list[0], 'pane_id')
  if (typeof pane !== 'string') throw new Error(`herdr lists no pane in workspace ${workspaceId}`)
  return pane
}

/**
 * Lists a workspace's panes as herdr reports them.
 * @param port - The engine calls.
 * @param workspaceId - The workspace.
 * @returns The panes, empty when herdr names none.
 * @throws When herdr fails.
 */
async function listPanes(port: EnginePort, workspaceId: string): Promise<unknown[]> {
  const panes = readField(await runHerdr(port, ['pane', 'list', '--workspace', workspaceId]), 'result', 'panes')
  return Array.isArray(panes) ? panes : []
}

/**
 * Tells whether an agent runs in a pane.
 * @param pane - The pane as herdr reports it.
 * @returns Whether herdr names its agent.
 */
function hasAgent(pane: unknown): boolean {
  return typeof readField(pane, 'agent') === 'string'
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
  const deadline = await port.now() + lockWaitMs
  for (;;) {
    if ((await executeProcess(port.processes, ['mkdir', '--', lock])).exitCode === 0) break
    // why: a listing reports a directory's mtime as zero, so only stat dates the lock.
    const held = await port.files.stat(lock).catch(() => null)
    if (held && await port.now() - held.mtimeMs > staleLockMs) {
      await breakStaleLock(port, directory, await port.readSessionId())
      continue
    }
    if (await port.now() > deadline) return fail('another spawn holds the lock; retry once it ends')
    await port.clock.sleep(250, new AbortController().signal)
  }
  try {
    return await work()
  } catch (error) {
    return fail(formatErrorLine(error))
  } finally {
    await executeProcess(port.processes, ['rmdir', '--', lock])
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
 * Reads a unit's progress record, a missing or foreign one standing for a unit never started.
 * @param value - The parsed record.
 * @returns The progress.
 */
function readProgress(value: unknown): Progress {
  const mode = isRecord(value) && typeof value.mode === 'string' ? value.mode : undefined
  return { isStarted: isRecord(value) && value.isStarted === true, isPrompted: isRecord(value) && value.isPrompted === true,
    ...(isRecord(value) && value.isTyped === true ? { isTyped: true } : {}), ...(mode ? { mode } : {}) }
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
 * Names the permission mode spawn last started a unit of these issues in.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @returns The mode, or undefined when spawn never started one.
 */
export async function readSpawnMode(port: EnginePort, issues: number[]): Promise<string | undefined> {
  const common = await readCommonDir(port)
  if (!common) return undefined
  for (const issue of issues) {
    const { mode } = readProgress(await readJson(port.files, progressPath(common, issue)).catch(() => undefined))
    if (mode) return mode
  }
  return undefined
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
