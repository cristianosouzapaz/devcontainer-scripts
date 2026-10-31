import { isAncestor, readGitOutput, readWorktreeStatus } from '../lib/git'
import { parseJson } from '../lib/json'
import { executeProcess } from '../lib/process'
import { formatErrorLine } from '../lib/result'
import type { EnginePort } from './engine-port'
import { readRepositoryRoot } from './repository'
import { holdError, sessionMemory } from './session-memory'

/** Names a worktree this mod created through herdr: its workspace, checkout and Claude Code worktree name. */
interface HerdrWorktree { workspaceId: string; path: string; name: string }

const herdrTimeoutMs = 5000
/** Every mod-created workspace label starts with this, followed by the creating session's id prefix. */
const labelPrefix = 'claude-'
/** Where a parallel unit starts inside herdr: the coordinator's spawn tool opens its workspace and session. */
export const spawnGuide = 'a coordinator session (/flow coordinate) starts it with the spawn tool, in its own herdr workspace and Claude session'
/** The refusal of a unit tool in a session outside herdr. */
export const outsideHerdr = 'this session does not run inside herdr, which hosts every unit session'

/**
 * Tells whether the session runs in a herdr pane.
 * @param port - The engine calls.
 * @returns True when herdr set its environment marker.
 */
export async function isInsideHerdr(port: EnginePort): Promise<boolean> {
  return (await port.readHerdrEnv()).environment === '1'
}

/**
 * Creates a Claude Code worktree as a herdr worktree workspace, without focus, from the chat checkout's HEAD.
 * @param port - The engine calls.
 * @param name - The worktree name Claude Code chose.
 * @param cwd - The directory the hook runs in, inside the repository.
 * @returns The checkout path, or undefined outside herdr or after a failure held in the worktree error window.
 */
export async function createHerdrWorktree(port: EnginePort, name: string, cwd: string): Promise<string | undefined> {
  if (!await isInsideHerdr(port)) return undefined
  try {
    const label = `${await ownLabelPrefix(port)}${name}`
    const reply = await runHerdr(port, ['worktree', 'create', '--cwd', cwd, '--branch', `worktree-${name}`, '--base', 'HEAD', '--label', label, '--no-focus'])
    const path = readField(reply, 'result', 'worktree', 'path')
    if (typeof path !== 'string') throw new Error('the reply names no worktree path')
    sessionMemory.worktreeError = null
    return path
  } catch (error) {
    sessionMemory.worktreeError = holdError(sessionMemory.worktreeError, formatErrorLine(error), await port.now())
    return undefined
  }
}

/**
 * Removes a mod-created herdr worktree Claude Code has already confirmed for removal, then its branch when merged.
 * @param port - The engine calls.
 * @param path - The checkout path Claude Code removes.
 * @returns True when the path was a mod-created herdr worktree and is removed.
 */
export async function removeHerdrWorktree(port: EnginePort, path: string): Promise<boolean> {
  const worktree = (await listHerdrWorktrees(port, labelPrefix)).find(entry => entry.path === path)
  if (!worktree) return false
  await runHerdr(port, ['worktree', 'remove', '--workspace', worktree.workspaceId, '--force'])
  await readGitOutput(port.processes, ['branch', '-d', `worktree-${worktree.name}`])
  return true
}

/**
 * Removes this session's mod-created worktrees that hold no work: a clean checkout whose HEAD the chat's HEAD contains.
 * A worktree with work stays, in the sidebar under its label.
 * @param port - The engine calls.
 * @returns Once every removable worktree is gone.
 */
export async function sweepHerdrWorktrees(port: EnginePort): Promise<void> {
  if (!await isInsideHerdr(port)) return
  const root = await readRepositoryRoot(port)
  for (const worktree of await listHerdrWorktrees(port, await ownLabelPrefix(port))) {
    if (worktree.path === root || await readWorktreeStatus(port.processes, worktree.path) !== '') continue
    const head = await readGitOutput(port.processes, ['-C', worktree.path, 'rev-parse', 'HEAD'])
    if (!head || !await isAncestor(port.processes, head, 'HEAD')) continue
    await runHerdr(port, ['worktree', 'remove', '--workspace', worktree.workspaceId])
    await readGitOutput(port.processes, ['branch', '-d', `worktree-${worktree.name}`])
  }
}

/**
 * Lists the herdr worktree workspaces whose label carries a prefix.
 * @param port - The engine calls.
 * @param prefix - The label prefix: one session's, any mod-created one, or the spawn label.
 * @returns The matching worktrees, each named by what its label holds after the first colon.
 * @throws When herdr fails or answers with no JSON.
 */
export async function listHerdrWorktrees(port: EnginePort, prefix: string): Promise<HerdrWorktree[]> {
  const workspaces = readField(await runHerdr(port, ['workspace', 'list']), 'result', 'workspaces')
  return (Array.isArray(workspaces) ? workspaces : []).flatMap((workspace: unknown) => {
    const label = readField(workspace, 'label')
    const workspaceId = readField(workspace, 'workspace_id')
    const path = readField(workspace, 'worktree', 'checkout_path')
    if (typeof label !== 'string' || !label.startsWith(prefix) || typeof workspaceId !== 'string' || typeof path !== 'string') return []
    return [{ workspaceId, path, name: label.slice(label.indexOf(':') + 1) }]
  })
}

/**
 * Builds this session's label prefix, so a sweep never takes another live session's worktree.
 * @param port - The engine calls.
 * @returns The prefix, ending in a colon.
 */
async function ownLabelPrefix(port: EnginePort): Promise<string> {
  return `${labelPrefix}${(await port.readSessionId()).slice(0, 8)}:`
}

/**
 * Runs a herdr command and returns what it printed.
 * @param port - The engine calls.
 * @param args - The herdr arguments.
 * @param timeoutMs - How long it may run.
 * @returns Its standard output.
 * @throws With the first stderr line, or the message of the JSON error herdr prints on stdout, when it exits non-zero.
 */
export async function runHerdrText(port: EnginePort, args: string[], timeoutMs = herdrTimeoutMs): Promise<string> {
  const result = await executeProcess(port.processes, ['herdr', ...args], { timeoutMs })
  if (result.exitCode === 0) return result.stdout
  const stderr = result.stderr.trim().split(/\r?\n/)[0]
  const parsed = parseJson(result.stdout)
  const reply = parsed.isOk ? readField(parsed.value, 'error', 'message') : undefined
  const detail = stderr || (typeof reply === 'string' ? reply : '')
  throw new Error(`herdr ${args.slice(0, 2).join(' ')}: exit ${result.exitCode}${detail ? `: ${detail}` : ''}`)
}

/**
 * Runs a herdr command and parses its JSON reply.
 * @param port - The engine calls.
 * @param args - The herdr arguments.
 * @param timeoutMs - How long it may run.
 * @returns The parsed reply.
 * @throws When herdr exits non-zero or prints no JSON.
 */
export async function runHerdr(port: EnginePort, args: string[], timeoutMs = herdrTimeoutMs): Promise<unknown> {
  const parsed = parseJson(await runHerdrText(port, args, timeoutMs))
  if (!parsed.isOk) throw new Error(`herdr ${args.slice(0, 2).join(' ')}: not JSON`)
  return parsed.value
}

/**
 * Reads a nested field of an unknown JSON value.
 * @param value - The parsed JSON.
 * @param keys - The field path.
 * @returns The field, or undefined when any step is missing.
 */
export function readField(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((current, key) => typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined, value)
}
