import type { RunRecord } from '../../types'
import type { ToolRunResult } from '../core/tool-run'
import type { EnginePort } from '../core/engine-port'
import { minuteMs } from '../core/timing'
import { readSession, readUnit } from '../core/record-store'
import { readWorkingTreeKey } from '../core/repository'
import { finishRunView, runStatus, withRunView } from '../core/run-view'
import { executeCommand, prepareRunLog, readUnitWorktree, recordToolRun, withToolRun } from '../core/tool-run'
import { verifyOutcome } from '../core/verify'
import { changedPaths, defaultVerifyTimeoutMinutes, readVerifyConfig } from '../core/verify-config'
import { findFlow, hasDiagnoseStep } from '../domain/flow-definitions'
import { retainRuns } from '../domain/records'
import { describeDiagnoseNeed } from '../domain/instruction'
import { findFixGreen, judgeDiagnose } from '../domain/step-states'
import { hasOnlyKeys, isNonEmptyString, isRecord, isStringArray } from '../lib/guards'

interface RunInput { argv: string[] }

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
  const root = await readUnitWorktree(port, identity.branch)
  if (!root) return "The unit's branch is checked out nowhere."
  const prepared = await prepareRunLog(port, sid)
  if ('error' in prepared) return prepared.error
  const { runId, log } = prepared
  const tree = await readWorkingTreeKey(port, root)
  if (!tree) return 'The unit worktree tree is unavailable; no record written.'
  const loaded = await readVerifyConfig(port, tree)
  const minutes = loaded.kind === 'valid' ? loaded.config.timeoutMinutes : defaultVerifyTimeoutMinutes
  if (signal.aborted) return cancelled
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
    const record: RunRecord = { argv, tree, outcome: verifyOutcome(result, minutes), runId, at: await port.now() }
    const recorded = await recordToolRun(port, identity, inherited, signal, own => ({ runs: retainRuns([record, ...own.runs]) }))
    if (!recorded) return cancelled
    await finishRunView(port, sid, { kind: record.outcome.kind === 'pass' ? 'green' : 'red', status: runStatus(record.outcome) }, signal)
    const current = await readSession(port)
    const unit = await readUnit(port, identity)
    const judgement = judgeDiagnose(unit, identity.issues, current.info)
    const need = describeDiagnoseNeed(judgement.done ? undefined : judgement.need, identity.issues)
    const isFixGreen = judgement.done && judgement.approvedAt !== undefined && findFixGreen(unit.runs, judgement.approvedAt)?.runId === record.runId
    const progress = record.outcome.kind !== 'pass'
      ? `red recorded on tree ${tree.slice(0, 12)}; ${judgement.done ? 'a green needs the same argv on a different tree' : need}`
      : isFixGreen ? 'green after red: the approved fix passes; call the verify tool'
      : !judgement.done ? `this pass does not count: ${need}`
      : 'this pass pairs with no earlier red of the same argv on a different tree'
    return `Run ${record.outcome.kind}: ${status}.\n${tail}\nthe first error may be earlier — see ${log}\n${progress}`
  })
}
