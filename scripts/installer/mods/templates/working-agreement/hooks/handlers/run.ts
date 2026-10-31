import type { Identity, RunRecord, Unit } from '../../types'
import type { ToolRunResult } from '../core/tool-run'
import type { VerifyTurn } from '../core/verify-queue'
import type { EnginePort } from '../core/engine-port'
import { minuteMs } from '../core/timing'
import { bestEffort } from '../core/best-effort'
import { refreshView } from '../core/pane-view'
import { readCommonDir, readSession, readUnit } from '../core/record-store'
import { readWorkingTreeKey } from '../core/repository'
import { finishRunView, runStatus, withRunView } from '../core/run-view'
import { findWorktreeRoot } from '../lib/git'
import { executeCommand, prepareRunLog, recordToolRun, withToolRun } from '../core/tool-run'
import { describeTail, readFailingLines } from '../core/run-command'
import { masksExitStatus, wrapperRefusal } from '../domain/run-argv'
import { verifyOutcome } from '../core/verify'
import { holdVerifyTurn, isTurnHeld, leaveVerifyQueue, waitVerifyTurn } from '../core/verify-queue'
import { changedPaths, defaultVerifyTimeoutMinutes, readVerifyConfig } from '../core/verify-config'
import { findFlow, hasDiagnoseStep } from '../domain/flow-definitions'
import { retainRuns } from '../domain/records'
import { describeDiagnoseNeed } from '../domain/instruction'
import { findFixGreen, judgeDiagnose } from '../domain/step-states'
import { hasOnlyKeys, isNonEmptyString, isRecord, isStringArray } from '../lib/guards'

interface RunInput { argv: string[] }

interface RunJob { argv: string[]; sid: string; identity: Identity; inherited: Unit; root: string; tree: string; log: string; runId: string; minutes: number; turn: VerifyTurn }

const cancelled = 'Run cancelled; no record written.'

/**
 * Runs a Diagnose argv, recording only completed runs on unchanged worktree content.
 * @param port - The engine calls.
 * @param input - The untrusted tool arguments.
 * @param signal - The dispatch's cancellation signal.
 * @returns The outcome, output tail, log path and Diagnose progress.
 */
export async function handleRun(port: EnginePort, input: unknown, signal: AbortSignal): Promise<ToolRunResult> {
  if (!isRunInput(input)) return { result: 'Expected { argv: string[] }: a non-empty array of non-empty strings.' }
  const argv = input.argv
  if (masksExitStatus(argv)) return { result: wrapperRefusal }
  return withToolRun(port, 'Run', sid => run(port, argv, signal, sid))
}

/**
 * Identifies a non-empty Diagnose argv without extra input fields.
 * @param input - The untrusted tool arguments.
 * @returns Whether the arguments are valid.
 */
function isRunInput(input: unknown): input is RunInput {
  return isRecord(input) && hasOnlyKeys(input, ['argv']) && isStringArray(input.argv) && input.argv.length > 0 && input.argv.every(isNonEmptyString)
}

/**
 * Records Diagnose evidence only when a completed command leaves the worktree content unchanged.
 * @param port - The engine calls.
 * @param argv - The Diagnose command and arguments.
 * @param signal - The dispatch's cancellation signal.
 * @param sid - The session owning the run.
 * @returns The refusal, cancellation or recorded run summary.
 */
async function run(port: EnginePort, argv: string[], signal: AbortSignal, sid: string): Promise<string> {
  const session = await readSession(port)
  if (!session.unit) return 'No unit declared in this chat.'
  const flow = findFlow(session.flow)
  if (!hasDiagnoseStep(flow)) return 'The declared flow has no Diagnose step; run is unavailable.'
  const identity = session.unit
  const inherited = await readUnit(port, identity)
  const root = await findWorktreeRoot(port.processes, identity.branch)
  if (!root) return "The unit's branch is checked out nowhere."
  const prepared = await prepareRunLog(port, sid)
  if ('error' in prepared) return prepared.error
  const { runId, log } = prepared
  const tree = await readWorkingTreeKey(port, root)
  if (!tree) return 'The unit worktree tree is unavailable; no record written.'
  const loaded = await readVerifyConfig(port, tree)
  const minutes = loaded.kind === 'valid' ? loaded.config.timeoutMinutes : defaultVerifyTimeoutMinutes
  if (signal.aborted) return cancelled
  const common = await readCommonDir(port)
  if (!common) return 'Cannot locate the repository metadata.'
  // A Diagnose run waits in the Verify queue, so no two heavy runs share the machine and a red never reflects a neighbour's load.
  const onMove = () => bestEffort(port, 'queue view refresh', () => refreshView(port, { isQuiet: true, isSynced: true }), undefined)
  const wait = await waitVerifyTurn(port, common, sid, await port.now() + minutes * minuteMs, signal, onMove)
  if (wait.kind !== 'acquired') return wait.kind === 'cancelled' ? cancelled
    : `Run queued, timed out after ${minutes} min behind another session's Verify or run; no record written.`
  const { turn } = wait
  const stop = holdVerifyTurn(port, turn)
  try {
    return await execute(port, { argv, sid, identity, inherited, root, tree, log, runId, minutes, turn }, signal)
  } finally {
    await stop()
    await leaveVerifyQueue(port, turn)
  }
}

/**
 * Runs the Diagnose argv under a held queue turn and records its outcome.
 * @param port - The engine calls.
 * @param job - The run's command, unit, worktree, log and turn.
 * @param signal - The dispatch's cancellation signal.
 * @returns The cancellation, refusal or recorded run summary.
 */
async function execute(port: EnginePort, job: RunJob, signal: AbortSignal): Promise<string> {
  const { argv, sid, identity, inherited, root, tree, log, runId, minutes, turn } = job
  return withRunView(port, sid, identity, inherited.generation, {
    runId, kind: 'Run', status: 'running', selection: '', tree, cwd: root, log, duration: 0, at: await port.now(),
    commands: [{ argv, status: 'running', duration: 0, outcome: '', output: '' }],
  }, signal, async () => {
    const { run: result, status, tail } = await executeCommand(port, sid, 0, { argv, cwd: root, tree, log, deadline: await port.now() + minutes * minuteMs, signal }, minutes)
    if (result.kind === 'cancelled' || signal.aborted) return cancelled
    const after = await readWorkingTreeKey(port, root)
    if (after !== tree) {
      const changed = after ? await changedPaths(port, tree, after) : []
      await finishRunView(port, sid, { kind: result.kind === 'ended' && result.code === 0 && !result.signal ? 'green' : 'red', status: 'tree changed', changed }, signal)
      return `The command changes the tree; no record written. Changed paths: ${changed.map(path => JSON.stringify(path)).join(', ') || 'tree unavailable'}. Log: ${log}`
    }
    if (!await isTurnHeld(port, turn)) return `Verify lock lost: another session broke it as stale while this command ran; no record written. Log: ${log}`
    const record: RunRecord = { argv, tree, outcome: verifyOutcome(result, minutes), runId, at: await port.now() }
    const recorded = await recordToolRun(port, identity, inherited, signal, own => ({ runs: retainRuns([record, ...own.runs]) }))
    if (!recorded) return cancelled
    await finishRunView(port, sid, { kind: record.outcome.kind === 'pass' ? 'green' : 'red', status: runStatus(record.outcome) }, signal)
    const current = await readSession(port)
    const unit = await readUnit(port, identity)
    const judgement = judgeDiagnose(unit, identity.issues, current.info)
    const need = describeDiagnoseNeed(judgement.done ? undefined : judgement.need, identity.issues)
    const pinned = judgement.done ? unit.approvedRed : undefined
    const isFixGreen = judgement.done && judgement.approvedAt !== undefined && findFixGreen(unit.runs, judgement.approvedAt, pinned)?.runId === record.runId
    const progress = record.outcome.kind !== 'pass'
      ? `red recorded on tree ${tree.slice(0, 12)}; ${!judgement.done ? need : pinned ? `the fix green needs the approved red's argv ${JSON.stringify(pinned.argv)} passing on a different tree` : 'a green needs the same argv on a different tree'}`
      : isFixGreen ? 'green after red: the approved fix passes; call the verify tool'
      : !judgement.done ? `this pass does not count: ${need}`
      : pinned ? `this pass is not the fix green: that is the approved red's argv ${JSON.stringify(pinned.argv)} passing on a different tree`
      : 'this pass pairs with no earlier red of the same argv on a different tree'
    const failing = await readFailingLines(port, log)
    const failures = failing.length ? `failing test lines (first ${failing.length}):\n${failing.join('\n')}\noutput tail:\n` : ''
    return `Run ${record.outcome.kind}: ${status}.\n${failures}${describeTail(tail, log)}\n${progress}`
  })
}
