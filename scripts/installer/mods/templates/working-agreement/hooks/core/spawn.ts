import { readDefaultRef, readGitOutput, readLocalBranches, readWorktrees } from '../lib/git'
import { readGraphql } from '../lib/github'
import { isIssueNumber, isRecord, isSafeInteger } from '../lib/guards'
import { filterRecords, readJson, toStringOrEmpty } from '../lib/json'
import { executeProcess } from '../lib/process'
import { createQueue } from '../lib/queue'
import { fail, formatError, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { isInsideHerdr, listHerdrWorktrees, readField, runHerdr, runHerdrText } from './herdr-worktrees'
import { atomicReplace, readCommonDir, recordsPath } from './record-store'
import { readGit, readRepositoryRoot } from './repository'
import { breakStaleLock } from './verify-queue'

/** A spawned unit's herdr workspace. */
interface UnitWorkspace { issue: number; workspaceId: string; path: string }

/** What a unit's session has been through, so a re-run resumes it instead of starting it twice. */
interface Progress { isStarted: boolean; isPrompted: boolean }

/** Where a new unit branch starts, or what it waits for. */
type Base = { isReady: true; ref: string } | { isReady: false; reason: string }

/** Every spawned workspace's label is this followed by the issue number; the cap counts them. */
const labelPrefix = 'wa-spawn:'
// why: The RFC 4122 URL namespace, so the same repository and issue always give the same session id.
const namespace = '6ba7b8119dad11d180b400c04fd430c8'
const lockWaitMs = 30000
// why: A spawn waits up to a minute for the agent; a lock this much older belongs to a process that died holding it.
const staleLockMs = 120000
const agentStartTimeoutMs = 60000
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
 * @returns What the unit is now, or why it is not started.
 */
export async function spawnUnit(port: EnginePort, issue: number): Promise<Result<string>> {
  if (!await isInsideHerdr(port)) return fail('this session does not run inside herdr, which hosts every unit session')
  const common = await readCommonDir(port)
  const root = await readRepositoryRoot(port)
  if (!common || !root) return fail('this session is not in a git repository')
  return queueSpawn(() => holdLock(port, common, () => spawnLocked(port, common, root, issue)))
}

/**
 * Runs the spawn steps while this process holds the repository's spawn lock.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param root - The coordinator's checkout, which herdr creates worktrees from.
 * @param issue - The issue number.
 * @returns What the unit is now, or why it is not started.
 */
async function spawnLocked(port: EnginePort, common: string, root: string, issue: number): Promise<Result<string>> {
  const workspaces = await listUnitWorkspaces(port)
  const own = workspaces.find(workspace => workspace.issue === issue)
  if (!own && workspaces.length >= spawnConfig.limit) {
    return fail(`${workspaces.length} units already run, the cap is ${spawnConfig.limit}: ${workspaces.map(workspace => `#${workspace.issue} (${workspace.path})`).join(', ')}`)
  }
  const branch = await findUnitBranch(port, issue) ?? await createUnitBranch(port, issue)
  if (!branch.isOk) return branch
  const pane = own ? await findIdlePane(port, own.workspaceId) : await openWorktree(port, root, issue, branch.value)
  if (pane === null) return succeed(`#${issue} already runs as herdr agent ${unitAgent(issue)} on ${branch.value}${own ? ` in ${own.path}` : ''}.`)
  const progressPath = recordsPath(common, 'spawn', `${issue}.json`)
  const progress = readProgress(await readJson(port.files, progressPath))
  const session = await deriveSessionId(common, issue)
  await runHerdrText(port, ['agent', 'start', unitAgent(issue), '--kind', 'claude', '--pane', pane, '--timeout', String(agentStartTimeoutMs),
    '--', progress.isStarted ? '--resume' : '--session-id', session], agentStartTimeoutMs + 15000)
  if (!progress.isStarted) await atomicReplace(port, progressPath, JSON.stringify({ isStarted: true, isPrompted: false }))
  if (!progress.isPrompted) {
    const { paneId } = await port.readHerdrEnv()
    await runHerdrText(port, ['agent', 'prompt', unitAgent(issue), '--', `Work on issue #${issue} on branch ${branch.value}: read it with its comments `
      + `(\`gh issue view ${issue} --comments\`), declare its flow, and work only in this worktree. The coordinator is herdr pane ${paneId}.`])
    await atomicReplace(port, progressPath, JSON.stringify({ isStarted: true, isPrompted: true }))
  }
  return succeed(`#${issue} ${progress.isStarted ? 'resumed' : 'started'} as herdr agent ${unitAgent(issue)} on ${branch.value} (session ${session}).`)
}

/**
 * Lists the workspaces spawn opened, alive in herdr now.
 * @param port - The engine calls.
 * @returns Each workspace with its issue.
 * @throws When herdr fails.
 */
async function listUnitWorkspaces(port: EnginePort): Promise<UnitWorkspace[]> {
  return (await listHerdrWorktrees(port, labelPrefix)).flatMap(({ name, workspaceId, path }) =>
    isIssueNumber(Number(name)) ? [{ issue: Number(name), workspaceId, path }] : [])
}

/**
 * Finds the branch an issue's unit already has, whatever slug it was given.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns The branch, as a success, or undefined when the issue has none.
 */
async function findUnitBranch(port: EnginePort, issue: number): Promise<Result<string> | undefined> {
  const branches = await readLocalBranches(port.processes)
  if (branches === null) return fail('cannot list the branches')
  const branch = [...branches].find(name => name.startsWith(`${issue}-`))
  return branch ? succeed(branch) : undefined
}

/**
 * Creates an issue's unit branch, create-only, from the default branch or from its open dependency's branch.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns The branch, or what it waits for.
 */
async function createUnitBranch(port: EnginePort, issue: number): Promise<Result<string>> {
  const read = await readGraphql(port.processes, `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issue(number:${issue}){`
    + 'state title blockedBy(first:50){nodes{number state}}}}}', [], { fallback: 'not found' })
  if (!read.isOk) return fail(`cannot read #${issue}: ${read.error}`)
  const fields = isRecord(read.value.issue) ? read.value.issue : null
  if (!fields) return fail(`cannot read #${issue}: unreadable gh output`)
  if (fields.state !== 'OPEN') return fail(`#${issue} is closed`)
  const blockers = filterRecords(isRecord(fields.blockedBy) ? fields.blockedBy.nodes : null).filter(node => node.state === 'OPEN').map(node => Number(node.number))
  const base = await resolveBase(port, blockers)
  if (!base.isReady) return fail(`#${issue} waits: ${base.reason}`)
  const sha = await readGitOutput(port.processes, ['rev-parse', '--verify', '--quiet', base.ref])
  if (!sha) return fail(`cannot resolve ${base.ref}`)
  const branch = `${issue}-${slugify(toStringOrEmpty(fields.title))}`
  if (await readGitOutput(port.processes, ['update-ref', `refs/heads/${branch}`, sha, '']) !== null) return succeed(branch)
  return await findUnitBranch(port, issue) ?? fail(`cannot create ${branch}`)
}

/**
 * Picks where a new unit branch starts: the dependency's branch once it has a commit past the default branch, else the default branch.
 * @param port - The engine calls.
 * @param blockers - The issue's open blocked-by dependencies.
 * @returns The base ref, or what the unit waits for.
 */
async function resolveBase(port: EnginePort, blockers: number[]): Promise<Base> {
  const git = await readGit(port)
  if (!git) return { isReady: false, reason: 'the repository state is unreadable' }
  const defaultRef = await readDefaultRef(port.processes, git.base)
  const [blocker, ...others] = blockers
  if (blocker === undefined) return { isReady: true, ref: defaultRef }
  if (others.length) return { isReady: false, reason: `it is blocked by #${blockers.join(', #')}, and a child unit has one parent` }
  const parent = await findUnitBranch(port, blocker)
  if (!parent?.isOk) return { isReady: false, reason: `its dependency #${blocker} has no unit branch yet` }
  const ahead = await readGitOutput(port.processes, ['rev-list', '--count', `${defaultRef}..${parent.value}`])
  return ahead && ahead !== '0' ? { isReady: true, ref: parent.value } : { isReady: false, reason: `${parent.value}, the branch of #${blocker}, has no commit past ${defaultRef} yet` }
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
  const path = (await readWorktrees(port.processes))?.find(worktree => worktree.branch === `refs/heads/${branch}`)?.root
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
  const panes = readField(await runHerdr(port, ['pane', 'list', '--workspace', workspaceId]), 'result', 'panes')
  const list = Array.isArray(panes) ? panes : []
  if (list.some(pane => typeof readField(pane, 'agent') === 'string')) return null
  const pane = readField(list[0], 'pane_id')
  if (typeof pane !== 'string') throw new Error(`herdr lists no pane in workspace ${workspaceId}`)
  return pane
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
    return fail(formatError(error).split(/\r?\n/)[0] ?? '')
  } finally {
    await executeProcess(port.processes, ['rmdir', '--', lock])
  }
}

/**
 * Reads a unit's progress record, a missing or foreign one standing for a unit never started.
 * @param value - The parsed record.
 * @returns The progress.
 */
function readProgress(value: unknown): Progress {
  return { isStarted: isRecord(value) && value.isStarted === true, isPrompted: isRecord(value) && value.isPrompted === true }
}

/**
 * Turns an issue title into a branch slug, without its Conventional Commit prefix.
 * @param title - The issue title.
 * @returns Lowercase words joined by hyphens, at most 40 characters.
 */
function slugify(title: string): string {
  const words = title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const slug = words.reduce((kept, word) => !kept ? word : `${kept}-${word}`.length <= 40 ? `${kept}-${word}` : kept, '')
  return slug.slice(0, 40) || 'unit'
}

/**
 * Derives the unit's session id as a UUIDv5 of the repository and the issue, so a restart resumes the same session.
 * @param common - The git common directory.
 * @param issue - The issue number.
 * @returns The session id.
 */
async function deriveSessionId(common: string, issue: number): Promise<string> {
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
