import type { VerifyRecord } from '../../types'
import type { ToolRunResult } from '../core/tool-run'
import type { EnginePort } from '../core/engine-port'
import { minuteMs } from '../core/timing'
import { hasCodeChange } from '../domain/step-states'
import { readSession, readUnit } from '../core/record-store'
import { readGit, readWorkingTreeKey } from '../core/repository'
import { finishRunView, runStatus, updateRunCommand, withRunView } from '../core/run-view'
import { readUnitSlice } from '../core/unit-slice'
import { isVerifyApproved, verifyOutcome } from '../core/verify'
import { changedPaths, readVerifyConfig, selectVerify } from '../core/verify-config'
import { executeCommand, prepareRunLog, readUnitWorktree, recordToolRun, withToolRun } from '../core/tool-run'

interface VerifyOutcomeState { value: VerifyRecord['outcome']; failure: string | null }

const cancelled = 'Verify cancelled; no record written.'

/**
 * Owns the session's Verify dispatch; every refusal and failure is a normal tool result.
 * @param port - Engine calls.
 * @param signal - The dispatch's cancellation signal, watched even during a silent pull.
 * @returns The result text for the agent.
 */
export async function handleVerify(port: EnginePort, signal: AbortSignal): Promise<ToolRunResult> {
  return withToolRun(port, 'Verify', sid => verify(port, signal, sid))
}

/**
 * Records Verify evidence only for approved commands on an unchanged unit slice.
 * @param port - The engine calls.
 * @param signal - The dispatch's cancellation signal.
 * @param sid - The session owning the run.
 * @returns The refusal, cancellation or verification summary.
 */
async function verify(port: EnginePort, signal: AbortSignal, sid: string): Promise<string> {
  const session = await readSession(port)
  if (!session.unit) return 'No unit declared in this chat.'
  const identity = session.unit
  const git = await readGit(port)
  const unit = await readUnit(port, identity)
  const slice = git ? await readUnitSlice(port, identity, unit, git) : null
  const root = await readUnitWorktree(port, identity.branch)
  if (!root) return "The unit's branch is checked out nowhere."
  if (!hasCodeChange(slice)) return 'Code is not done (empty change set or unavailable slice).'
  const tree = slice.tree
  const loaded = await readVerifyConfig(port, tree)
  if (loaded.kind !== 'valid') return loaded.fact
  if (!await isVerifyApproved(port, loaded.blob)) return 'Config not approved. Stop and ask the user to run /flow approve verify from the composer, then confirm its blob id.'
  const selection = await selectVerify(port, loaded.config, slice.baseTree, tree)
  if (await readWorkingTreeKey(port, root) !== tree) return 'The worktree content differs from the unit tree; Verify cannot run on this slice.'
  const prepared = await prepareRunLog(port, sid)
  if ('error' in prepared) return prepared.error
  const { runId, log } = prepared
  const deadline = await port.now() + loaded.config.timeoutMinutes * minuteMs
  return withRunView(port, sid, identity, unit.generation, {
    runId, kind: 'Verify', status: 'running', selection: selection.description, tree, cwd: root, log, duration: 0, at: await port.now(),
    commands: selection.commands.map((argv, index) => ({ argv, status: index === 0 ? 'running' : 'waiting', duration: 0, outcome: '', output: '' })),
  }, signal, async () => {
    const summaries: string[] = []
    const outcome: VerifyOutcomeState = { value: { kind: 'pass' }, failure: null }
    for (const [index, command] of selection.commands.entries()) {
      if (signal.aborted) return cancelled
      updateRunCommand(sid, index, { status: 'running' })
      const { run, status, duration, tail } = await executeCommand(port, sid, index, { argv: command, cwd: root, tree, log, deadline, signal }, loaded.config.timeoutMinutes)
      if (run.kind === 'cancelled' || signal.aborted) return cancelled
      summaries.push(`${JSON.stringify(command)} (${duration})`)
      outcome.value = verifyOutcome(run, loaded.config.timeoutMinutes)
      if (outcome.value.kind !== 'pass') {
        outcome.failure = `Verify failed: ${JSON.stringify(command)}, ${status}, ${duration}.\n${tail}\nthe first error may be earlier — see ${log}\nNot run: ${selection.commands.slice(index + 1).map(argv => JSON.stringify(argv)).join(', ') || 'none'}`
        break
      }
    }
    const after = git ? await readUnitSlice(port, identity, await readUnit(port, identity), git) : null
    const worktreeAfter = await readWorkingTreeKey(port, root)
    if (after?.tree !== tree || worktreeAfter !== tree || after.base !== slice.base) {
      const changed = worktreeAfter ? await changedPaths(port, tree, worktreeAfter) : []
      await finishRunView(port, sid, { status: 'tree changed', changed }, signal)
      return `The commands change the tree; no record written. Changed paths: ${changed.map(path => JSON.stringify(path)).join(', ') || 'tree or base unavailable/changed'}. Log: ${log}`
    }
    if (signal.aborted) return cancelled
    const record: VerifyRecord = { tree, base: slice.base, configBlob: loaded.blob, commands: selection.commands, outcome: outcome.value, runId, at: await port.now() }
    const recorded = await recordToolRun(port, identity, unit, signal, () => ({ verifyRuns: [record] }))
    if (!recorded) return cancelled
    await finishRunView(port, sid, { status: runStatus(outcome.value) }, signal)
    return outcome.failure ?? `Verify passed on tree ${tree.slice(0, 12)}: ${summaries.join(', ')}. Selection: ${selection.description}.`
  })
}
