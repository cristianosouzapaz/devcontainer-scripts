import type { VerifyRecord } from '../../types'
import type { ToolRunResult } from '../core/tool-run'
import type { EnginePort } from '../core/engine-port'
import { minuteMs } from '../core/timing'
import { hasCodeChange } from '../domain/step-states'
import { readCommonDir, readSession, readUnit } from '../core/record-store'
import { bestEffort } from '../core/best-effort'
import { describeParentConflicts } from '../core/parent-merge'
import { refreshView } from '../core/pane-view'
import { readGit, readWorkingTreeKey } from '../core/repository'
import { finishRunView, runStatus, updateRunCommand, withRunView } from '../core/run-view'
import { readUnitSlice } from '../core/unit-slice'
import { isVerifyApproved, verifyOutcome, writeVerifyEvidence } from '../core/verify'
import { changedPaths, readVerifyConfig, selectVerify } from '../core/verify-config'
import { holdVerifyTurn, isTurnHeld, leaveVerifyQueue, waitCiIdle, waitVerifyTurn } from '../core/verify-queue'
import { findWorktreeRoot } from '../lib/git'
import { executeCommand, prepareRunLog, recordToolRun, withToolRun } from '../core/tool-run'

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
  const root = await findWorktreeRoot(port.processes, identity.branch)
  if (!root) return "The unit's branch is checked out nowhere."
  const conflicts = await describeParentConflicts(port)
  if (conflicts) return conflicts
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
  const common = await readCommonDir(port)
  if (!common) return 'Cannot locate the repository metadata.'
  // The wait for another session's Verify and for CI gets the same bound as the run, so a queued call never outlives two runs.
  const queueDeadline = await port.now() + loaded.config.timeoutMinutes * minuteMs
  const onMove = () => bestEffort(port, 'queue view refresh', () => refreshView(port, { isQuiet: true, isSynced: true }), undefined)
  const wait = await waitVerifyTurn(port, common, sid, queueDeadline, signal, onMove)
  if (wait.kind !== 'acquired') return wait.kind === 'cancelled' ? cancelled
    : `Verify queued, timed out after ${loaded.config.timeoutMinutes} min behind another session's Verify; no record written.`
  const { turn } = wait
  const stop = holdVerifyTurn(port, turn)
  try {
    const labels = loaded.config.waitForCiLabels
    const ci = labels.length ? await waitCiIdle(port, turn, labels, queueDeadline, signal, onMove) : 'idle'
    if (ci === 'cancelled') return cancelled
    const ciFact = ci === 'unknown' ? 'CI state unknown' : ci === 'timeout' ? `CI still running after ${loaded.config.timeoutMinutes} min, ran anyway` : null
    const deadline = await port.now() + loaded.config.timeoutMinutes * minuteMs
    const reply = await withRunView(port, sid, identity, unit.generation, {
      runId, kind: 'Verify', status: 'running', selection: ciFact ? `${selection.description} · ${ciFact}` : selection.description, tree, cwd: root, log, duration: 0, at: await port.now(),
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
      if (!await isTurnHeld(port, turn)) return `Verify lock lost: another session broke it as stale while these commands ran; no record written. Log: ${log}`
      const record: VerifyRecord = { tree, base: slice.base, configBlob: loaded.blob, commands: selection.commands, outcome: outcome.value, runId, at: await port.now() }
      const recorded = await recordToolRun(port, identity, unit, signal, () => ({ verifyRuns: [record] }))
      if (!recorded) return cancelled
      await bestEffort(port, 'verify evidence write', () => writeVerifyEvidence(port, record, identity), undefined)
      await finishRunView(port, sid, { status: runStatus(outcome.value) }, signal)
      return outcome.failure ?? `Verify passed on tree ${tree.slice(0, 12)}: ${summaries.join(', ') || 'no command run'}. Selection: ${selection.description}.`
    })
    return ciFact && reply !== cancelled ? `${ciFact}.\n${reply}` : reply
  } finally {
    await stop()
    await leaveVerifyQueue(port, turn)
  }
}
