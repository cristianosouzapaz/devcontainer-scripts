import { hasDiagnoseStep } from '../domain/flow-definitions'
import type { Session } from '../domain/records'
import { readTextFile, writeTextFile } from '../lib/files'
import { isWorktreeClean, readExcludePath, readWorktreeHead, resetWorktree } from '../lib/git'
import { isRecord, toStringOrEmpty } from '../lib/json'
import { unwrapOr } from '../lib/result'
import type { EnginePort } from './engine-port'
import { worktreesFolder } from './main-checkout'
import { findUnitKey, readUnit, updateUnits } from './record-store'

/** The line that keeps Claude Code's worktrees out of `git status`, as git's own exclude syntax writes it. */
const excludeLine = '.claude/worktrees/'

/**
 * Keeps Claude Code's worktrees out of `git status` through the repository's `info/exclude`, the place git gives patterns
 * of one user's workflow that no clone shares, so it holds whatever the project's `.gitignore` says. The line is added once.
 *
 * @param port - The engine calls.
 * @returns Nothing; a repository whose exclude file git cannot name is left alone.
 */
export async function excludeWorktrees(port: EnginePort): Promise<void> {
  const path = unwrapOr(await readExcludePath(port.processes), null)
  if (!path) return
  // A missing exclude file reads as empty and is created.
  const text = unwrapOr(await readTextFile(port.files, port.clock, path), '')
  if (text.split('\n').some(line => line.trim() === excludeLine)) return
  const written = await writeTextFile(port.files, port.clock, path, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${excludeLine}\n`)
  if (!written.isOk) throw new Error(written.error)
}

/**
 * Takes in the worktree an `EnterWorktree` call entered, in a flow with Diagnose: records it on the unit and, when the call
 * created it (no `path`), it holds no change and its HEAD is not the unit's start commit, moves it to that commit, so
 * Diagnose runs against the code the unit began from whatever base `worktree.baseRef` gave it. A worktree that holds work is never reset.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @param args - The call's input.
 * @param result - The call's result, which names the worktree's path.
 */
export async function adoptWorktree(port: EnginePort, session: Session, args: Record<string, unknown>, result: unknown): Promise<void> {
  const path = isRecord(result) ? toStringOrEmpty(result.worktreePath) : ''
  if (!path || !hasDiagnoseStep(session.flow)) return
  const name = path.includes(worktreesFolder) ? path.slice(path.indexOf(worktreesFolder) + worktreesFolder.length) : path
  await updateUnits(port, session, unit => ({ ...unit, worktree: { name, path } }))
  const { start } = await readUnit(port, await findUnitKey(port, session))
  if (!start || toStringOrEmpty(args.path)) return
  // Every git call names the worktree with -C: the runner pins processes to the main checkout once the session is in a worktree.
  if (!unwrapOr(await isWorktreeClean(port.processes, path), false)) return
  if (unwrapOr(await readWorktreeHead(port.processes, path), start) === start) return
  const reset = await resetWorktree(port.processes, path, start)
  if (!reset.isOk) throw new Error(reset.error)
}
