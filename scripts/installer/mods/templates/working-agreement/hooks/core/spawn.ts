import { findWorktreeRoot, readGitOutput, readParentBranch, readWorktreeStatus } from '../lib/git'
import { appendInstructions } from '../domain/messages'
import { isIssueNumber, isRecord, isSafeInteger } from '../lib/guards'
import { parseJson, readJsonUnlessStrict } from '../lib/json'
import { executeProcess, runProcess } from '../lib/process'
import { createQueue } from '../lib/queue'
import { fail, formatErrorLine, succeed, unwrapOr } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { isInsideHerdr, listHerdrWorktrees, outsideHerdr, readField, runHerdr, runHerdrText } from './herdr-worktrees'
import { recordPlaced } from './placed-refs'
import { atomicReplace, readCommonDir, readSessionMirrors, recordsPath } from './record-store'
import { readGit, readRepositoryRoot } from './repository'
import { readSessionLiveness } from './session-host'
import { sessionMemory } from './session-memory'
import { findUnitBranch, readDefaultBase, readIssueStart, readUnitState } from './unit-state'
import { breakStaleLock } from './verify-queue'

/** A spawned unit's herdr workspace. */
export interface UnitWorkspace { issue: number; workspaceId: string; path: string }

/** The model and effort a unit runs on, and why; both absent, the user's own defaults. */
export interface UnitLevel { model?: string; effort?: Effort; reason?: string }

/**
 * What a unit's session has been through, so a re-run resumes it instead of starting it twice, the permission mode it last started in,
 * the level it runs on, the reason of an escalation the coordinator asked for while the unit worked, and the session it runs as.
 */
interface Progress extends UnitLevel {
  isStarted: boolean; isPrompted: boolean; isTyped?: boolean; mode?: string; escalation?: string; sessionId?: string
}

/** An effort a coordinator may give a unit; xhigh and max stay the user's to ask for. */
type Effort = typeof efforts[number]

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
/** The efforts a coordinator may pick for a unit. */
export const efforts = ['low', 'medium', 'high'] as const
// why: an unknown model still opens an interactive session, which fails only at its first prompt; a one-turn print run fails up front.
// No settings source but the project's, run from /, so the probe loads no plugin or hook and touches no repository.
const probeTimeoutMs = 60000
// why: claude takes /exit from the input box; a resumed session reopens the same conversation.
const exitWaitMs = 30000
/** How long a unit's working agent is given to go idle before an escalation is put off. */
export const busyWaitMs = 1000
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
 * @param level - The model and effort the coordinator picks for a unit not yet started, with its reason; a started unit keeps its recorded one.
 * @returns What the unit is now, or why it is not started.
 */
export async function spawnUnit(port: EnginePort, issue: number, instructions = '', level: UnitLevel = {}): Promise<Result<string>> {
  if (!await isInsideHerdr(port)) return fail(outsideHerdr)
  return withSpawnLock(port, (common, root) => spawnLocked(port, common, root, issue, instructions, level))
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
 * @param chosen - The level the coordinator picks, used only by a unit never started.
 * @returns What the unit is now, or why it is not started.
 */
async function spawnLocked(port: EnginePort, common: string, root: string, issue: number, instructions: string, chosen: UnitLevel): Promise<Result<string>> {
  const declaring = await findDeclaringSession(port, issue)
  if (declaring) return fail(describeDeclaring(issue, declaring))
  const workspaces = await listUnitWorkspaces(port)
  const own = workspaces.find(workspace => workspace.issue === issue)
  const running = own ? [] : await filterRunning(port, workspaces)
  if (running.length >= spawnConfig.limit) {
    return fail(`${running.length} units already run, the cap is ${spawnConfig.limit}: ${running.map(workspace => `#${workspace.issue} (${workspace.path})`).join(', ')}`)
  }
  const progress = await readProgressFile(port, common, issue, true)
  const level = progress.isStarted ? pickLevel(progress) : pickLevel(chosen)
  // why: checked before the branch and worktree exist, so a wrong name starts nothing.
  if (!progress.isStarted && level.model) {
    const probed = await probeModel(port, level.model)
    if (!probed.isOk) return probed
  }
  const branch = await findUnitBranch(port, issue) ?? await createUnitBranch(port, issue)
  if (!branch.isOk) return branch
  const pane = own ? await findIdlePane(port, own.workspaceId) : await openWorktree(port, root, issue, branch.value)
  const session = await deriveSessionId(common, issue)
  const mode = pane === null ? progress.mode : inheritMode(sessionMemory.permissionMode)
  const kept = { ...level, ...progress.escalation ? { escalation: progress.escalation } : {}, mode, sessionId: session }
  if (pane !== null) {
    await runHerdrText(port, ['agent', 'start', unitAgent(issue), '--kind', 'claude', '--pane', pane, '--timeout', String(agentStartTimeoutMs),
      '--', '--permission-mode', inheritMode(mode), ...levelFlags(level), progress.isStarted ? '--resume' : '--session-id', session], agentStartTimeoutMs + 15000)
    await writeProgress(port, common, issue, { ...progress, ...kept, isStarted: true })
  }
  // why: a live unit whose start prompt failed would otherwise wait forever on an empty prompt.
  if (!progress.isPrompted) {
    const { paneId } = await port.readHerdrEnv()
    const text = appendInstructions(`Work on issue #${issue} on branch ${branch.value}: read it with its comments `
      + `(\`gh issue view ${issue} --comments\`), declare its flow, and work only in this worktree. The coordinator is herdr pane ${paneId}.`, instructions)
    if (!await submitPrompt(port, unitAgent(issue), text, progress.isTyped === true)) {
      await writeProgress(port, common, issue, { isStarted: true, isPrompted: false, isTyped: true, ...kept })
      return fail(`#${issue} did not take its start prompt: herdr agent ${unitAgent(issue)} stays idle. `
        + 'Read it with unit_read; spawn again submits it if its input box shows it, or types it again if not')
    }
    await writeProgress(port, common, issue, { isStarted: true, isPrompted: true, ...kept })
  }
  // why: a unit already past its start prompt is mid-turn; text sent now would queue behind that turn, so the coordinator decides how to send it.
  const clauses = [progress.isPrompted && instructions ? '; its start prompt went earlier, so the instructions are not sent: send them with unit_prompt' : '',
    progress.isStarted && (chosen.model || chosen.effort) ? '; its recorded model and effort are kept, the ones given are ignored' : '']
  if (pane === null) {
    return succeed(`#${issue} already runs as herdr agent ${unitAgent(issue)} on ${branch.value}${own ? ` in ${own.path}` : ''}`
      + `${[progress.isPrompted ? '' : '; its start prompt is sent now', ...clauses].join('')}.`)
  }
  const standing = progress.isStarted ? await describeStanding(port, branch.value) : ''
  return succeed(`#${issue} ${progress.isStarted ? 'resumed' : 'started'} as herdr agent ${unitAgent(issue)} on ${branch.value} in ${mode} mode, `
    + `${describeLevel(level)} (session ${session})${[...clauses, standing].join('')}.`)
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
 * @returns The session id, or null when spawn never started a unit for the issue or retired it.
 */
export async function readSpawnedSession(port: EnginePort, issue: number, strict: boolean): Promise<string | null> {
  const common = await readCommonDir(port)
  if (!common) return null
  const progress = await readProgressFile(port, common, issue, strict)
  if (!progress.isStarted) return null
  // why: a record without sessionId names the session the id derivation gives.
  return progress.sessionId ?? deriveSessionId(common, issue)
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
 * Submits a unit's start prompt and confirms the agent took it; a submit the agent missed, right after its start, gets one more Enter,
 * and a prompt an earlier spawn typed that its input box no longer shows is typed again.
 * @param port - The engine calls.
 * @param agent - The unit's herdr agent.
 * @param text - The start prompt.
 * @param isTyped - Whether an earlier spawn already typed it, so only the submit is left.
 * @returns Whether the agent left idle for it.
 */
async function submitPrompt(port: EnginePort, agent: string, text: string, isTyped: boolean): Promise<boolean> {
  const isTaken = (args: string[]) => runHerdrText(port, args, promptWaitMs + 5000).then(() => true, () => false)
  // why: a prompt sent before the agent's TUI was ready never reached its input box, so only a box that shows it is left to submit.
  const isShown = isTyped && await isTypedInBox(port, agent, text)
  // herdr 0.9.5 takes the text as a positional argument and rejects `--` before it, even for text starting with a dash.
  if (!isShown && await isTaken(['agent', 'prompt', agent, text, '--wait', ...taken, '--timeout', String(promptWaitMs)])) return true
  // why: the missed text stays typed in the input box; typing it again would submit it twice.
  await runHerdrText(port, ['agent', 'send-keys', agent, 'Enter'])
  return isTaken(['agent', 'wait', agent, ...taken, '--timeout', String(promptWaitMs)])
}

/**
 * Checks whether a unit's screen shows its start prompt's opening words, typed and unsent.
 * @param port - The engine calls.
 * @param agent - The unit's herdr agent.
 * @param text - The start prompt.
 * @returns Whether they show; true when the screen is unreadable, so a prompt is never typed twice.
 */
async function isTypedInBox(port: EnginePort, agent: string, text: string): Promise<boolean> {
  const collapse = (value: string) => value.replace(/\s+/g, ' ')
  // why: the box wraps a long prompt, so only its opening words reliably sit on one line.
  const opening = collapse(text).split(' ').slice(0, 4).join(' ')
  return runHerdrText(port, ['agent', 'read', agent, '--source', 'visible']).then(screen => collapse(screen).includes(opening), () => true)
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
  const base = await readDefaultBase(port)
  if (!base) return workspaces
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
 * Checks a condition until it holds or the time runs out.
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
    await port.clock.sleep(intervalMs, new AbortController().signal)
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
    ...(isRecord(value) && value.isTyped === true ? { isTyped: true } : {}), ...text('mode'), ...text('model'), ...(effort ? { effort } : {}),
    ...text('reason'), ...text('escalation'), ...text('sessionId') }
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
 * Names the permission mode spawn last started a unit of these issues in.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @returns The mode, or undefined when spawn never started one.
 */
export async function readSpawnMode(port: EnginePort, issues: number[]): Promise<string | undefined> {
  for (const issue of issues) {
    const mode = (await readSpawnProgress(port, issue))?.mode
    if (mode) return mode
  }
  return undefined
}

/**
 * Reads the level spawn records for a unit of these issues.
 * @param port - The engine calls.
 * @param issues - The unit's issues.
 * @returns The level, or undefined when spawn never started one.
 */
export async function readSpawnLevel(port: EnginePort, issues: number[]): Promise<UnitLevel | undefined> {
  for (const issue of issues) {
    const progress = await readSpawnProgress(port, issue)
    if (progress?.isStarted) return pickLevel(progress)
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
 * Tells whether a unit's agent is idle, waiting briefly for a turn that is ending.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param waitMs - How long a working agent is given to go idle.
 * @returns Whether herdr reports it idle or done within that time.
 */
export function isUnitIdle(port: EnginePort, issue: number, waitMs: number): Promise<boolean> {
  return runHerdrText(port, ['agent', 'wait', unitAgent(issue), '--until', 'idle', '--until', 'done', '--timeout', String(waitMs)], waitMs + 5000).then(() => true, () => false)
}

/**
 * Raises an idle unit to the user's default model with effort high: closes its session with /exit, records the new level, and resumes the
 * same conversation on it, under the spawn lock. A unit that works, or already runs at that level, is left as it is.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param signal - What triggered the escalation, recorded as the level's reason.
 * @returns The resumed unit, or why it was not escalated.
 */
export async function escalateUnit(port: EnginePort, issue: number, signal: string): Promise<Result<string>> {
  if (!await isInsideHerdr(port)) return fail(outsideHerdr)
  return withSpawnLock(port, async (common, root) => {
    const progress = await readProgressFile(port, common, issue, true)
    if (!progress.isStarted) return fail(`#${issue} has no unit spawn started`)
    if (isTopLevel(progress)) return fail(`#${issue} already runs on the user's default model and effort, so it is not escalated: its case is the coordinator's`)
    const own = (await listUnitWorkspaces(port)).find(workspace => workspace.issue === issue)
    if (own && (await listPanes(port, own.workspaceId)).some(hasAgent)) {
      if (!await isUnitIdle(port, issue, busyWaitMs)) return fail(`#${issue}'s unit works, so it is not escalated now`)
      await runHerdrText(port, ['agent', 'prompt', unitAgent(issue), '/exit'])
      if (!await waitForExit(port, own.workspaceId)) return fail(`#${issue}'s session did not close after /exit, so it is not escalated`)
    }
    const { model: _model, escalation: _escalation, ...rest } = progress
    await writeProgress(port, common, issue, { ...rest, effort: 'high', reason: `escalated: ${signal}` })
    return spawnLocked(port, common, root, issue, '', {})
  })
}

/**
 * Waits for the agent of a workspace to leave its pane.
 * @param port - The engine calls.
 * @param workspaceId - The unit's workspace.
 * @returns Whether no agent runs there before the wait ends.
 */
async function waitForExit(port: EnginePort, workspaceId: string): Promise<boolean> {
  return pollUntil(port, exitWaitMs, 500, async () => !(await listPanes(port, workspaceId)).some(hasAgent))
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
