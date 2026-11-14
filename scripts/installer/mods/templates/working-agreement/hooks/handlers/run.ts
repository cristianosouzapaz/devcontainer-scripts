import type { Identity, RunRecord, Unit } from '../../types'
import type { ToolRunResult } from '../core/tool-run'
import type { CallFacts, CallRef } from '../core/command-calls'
import type { VerifyTurn } from '../core/verify-queue'
import type { EnginePort } from '../core/engine-port'
import { minuteMs } from '../core/timing'
import { bestEffort } from '../core/best-effort'
import { refreshView } from '../core/pane-view'
import { readCommonDir, readSession, readUnit } from '../core/record-store'
import { readWorkingTree, readWorkingTreeKey } from '../core/repository'
import { readDelegatedUnit } from '../core/delegated-commits'
import { finishRunView, runStatus, withRunView } from '../core/run-view'
import { locateWorktreeRoot } from '../lib/git'
import { describeMirrorFailure, describeUnrecorded, executeCommand, labelUnrecorded, prepareRunLog, recordToolRun } from '../core/tool-run'
import { withToolRun } from '../core/command-calls'
import { describeTail, readFailingLines } from '../core/run-command'
import { masksExitStatus, wrapperRefusal } from '../domain/run-argv'
import { verifyOutcome } from '../core/verify'
import { describeStoppedWait, readWatch, watchCancels } from '../core/cancel-gate'
import { withVerifyTurn } from '../core/verify-queue'
import { changedPaths, defaultVerifyTimeoutMinutes, readVerifyConfig } from '../core/verify-config'
import { findFlow, hasDiagnoseStep } from '../domain/flow-definitions'
import { retainRuns } from '../domain/records'
import { describeDiagnoseNeed } from '../domain/instruction'
import { findFixGreen, judgeDiagnose } from '../domain/step-states'
import { hasOnlyKeys, isNonEmptyString, isRecord, isStringArray } from '../lib/guards'

interface RunInput { argv: string[] }

interface RunJob { argv: string[]; isEvidence: boolean; sid: string; identity: Identity; inherited: Unit; root: string; tree: string; log: string; runId: string; minutes: number; turn: VerifyTurn; facts: CallFacts }

const cancelled = 'Run cancelled; no record written.'
const lockLost = 'Verify lock lost: the host process holding it ended while this command ran, so the command was stopped; no record written.'
const lockLostBefore = 'Verify lock lost before the command ran: the host process holding it ended; nothing ran and no record was written.'

/**
 * Runs a Diagnose argv, or a delegated unit's test argv in any flow, recording Diagnose evidence only for completed runs on unchanged worktree content.
 * @param port - The engine calls.
 * @param input - The untrusted tool arguments.
 * @param signal - The dispatch's cancellation signal.
 * @param call - The call, which names its ledger entry.
 * @returns The outcome, output tail, log path and Diagnose progress.
 */
export async function handleRun(port: EnginePort, input: unknown, signal: AbortSignal, call: CallRef): Promise<ToolRunResult> {
  if (!isRunInput(input)) return { result: 'Expected { argv: string[] }: a non-empty array of non-empty strings.' }
  const argv = input.argv
  if (masksExitStatus(argv)) return { result: wrapperRefusal }
  return withToolRun(port, 'Run', call, (sid, facts) => run(port, argv, signal, sid, facts), signal)
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
 * @param facts - The call's ledger facts.
 * @returns The refusal, cancellation or recorded run summary.
 */
async function run(port: EnginePort, argv: string[], signal: AbortSignal, sid: string, facts: CallFacts): Promise<string> {
  const session = await readSession(port)
  if (!session.unit) return 'No unit declared in this chat.'
  const flow = findFlow(session.flow)
  // why: a delegated unit's only queued targeted test run is this one, whatever its flow; outside Diagnose it is no evidence.
  const isEvidence = hasDiagnoseStep(flow)
  if (!isEvidence && !await readDelegatedUnit(port).catch(() => null)) return 'The declared flow has no Diagnose step; run is unavailable.'
  const identity = session.unit
  const inherited = await readUnit(port, identity)
  const located = await locateWorktreeRoot(port.processes, identity.branch)
  if (!located.isOk) return `Run refused: the worktree list could not be read (${located.error}), so whether the unit's branch is checked out is unknown; no record written.`
  const root = located.value
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
  // why: a Diagnose run waits in the Verify queue, so no two heavy runs share the machine and a red never reflects a neighbour's load.
  const onMove = () => bestEffort(port, 'queue view refresh', () => refreshView(port, { isQuiet: true, isSynced: true }), undefined)
  // why: a cancel stops only the wait, through its own signal; the command, once it runs, keeps the dispatch's and finishes.
  const watch = watchCancels(port, signal)
  const options = { call: 'run' as const, deadline: await port.now() + minutes * minuteMs, signal: watch.signal, onMove, onPoke: watch.check, log, ...await readWatch(port) }
  facts.queued()
  const held = await withVerifyTurn(port, common, sid, turn => execute(port, { argv, isEvidence, sid, identity, inherited, root, tree, log, runId, minutes, turn, facts }, signal), options)
  if (held.kind === 'done') return held.value
  const stopped = watch.cancelId()
  if (stopped) return describeStoppedWait('the Verify queue', stopped)
  if (held.kind === 'failed') return `Run could not queue: ${held.error}; no record written.`
  return held.kind === 'cancelled' ? cancelled : `Run queued, timed out after ${minutes} min behind another session's Verify, run or merge gate; no record written.`
}

/**
 * Runs the argv under a held queue turn and records its outcome as Diagnose evidence when the flow has a Diagnose step.
 * @param port - The engine calls.
 * @param job - The run's command, unit, worktree, log and turn.
 * @param signal - The dispatch's cancellation signal.
 * @returns The cancellation, refusal or recorded run summary.
 */
async function execute(port: EnginePort, job: RunJob, signal: AbortSignal): Promise<string> {
  const { argv, isEvidence, sid, identity, inherited, root, tree, log, runId, minutes, turn, facts } = job
  // why: a stop that landed while the queue granted the lock starts no command.
  if (signal.aborted) return cancelled
  // why: a holder that ends mid-run frees the lock for the next in line, so the command stops rather than share the machine.
  const stopping = AbortSignal.any([signal, turn.lost])
  return withRunView(port, sid, identity, inherited.generation, {
    runId, kind: 'Run', status: 'running', selection: '', tree, cwd: root, log, duration: 0, at: await port.now(),
    commands: [{ argv, status: 'running', duration: 0, outcome: '', output: '' }],
  }, signal, async () => {
    const { run: result, status, tail } = await executeCommand(port, sid, 0, { argv, cwd: root, tree, log, deadline: await port.now() + minutes * minuteMs, signal: stopping }, minutes, facts)
    // why: an Esc ends the holder process too, so a stopped call reads as cancelled before the lock reads as lost.
    if (signal.aborted) return cancelled
    if (turn.lost.aborted) {
      await finishRunView(port, sid, { status: 'ended', label: 'not recorded · lock lost' }, signal)
      // why: a lock lost between the grant and the spawn started nothing, so no log exists to cite.
      return result.start === 'unspawned' ? lockLostBefore : `${lockLost} Log: ${log}`
    }
    if (result.kind === 'cancelled') return cancelled
    const after = await readWorkingTree(port, root)
    if (!after.isOk) {
      await finishRunView(port, sid, { status: 'ended', label: 'not recorded · worktree unreadable' }, signal)
      return `Run stopped: the command ran (${status}), but the worktree could not be read afterwards (${after.error}), so whether it changed the tree is unknown; no record written. Log: ${log}.`
    }
    if (after.value !== tree) {
      const changed = await changedPaths(port, tree, after.value)
      await finishRunView(port, sid, { kind: result.kind === 'ended' && result.code === 0 && !result.signal ? 'green' : 'red', status: 'tree changed', changed }, signal)
      return `The command changes the tree; no record written. Changed paths: ${changed.map(path => JSON.stringify(path)).join(', ') || 'none listed'}. Log: ${log}`
    }
    const record: RunRecord = { argv, tree, outcome: verifyOutcome(result, minutes), runId, at: await port.now() }
    const failing = await readFailingLines(port, log)
    const failures = failing.length ? `failing test lines (first ${failing.length}):\n${failing.join('\n')}\noutput tail:\n` : ''
    const summary = `Run ${record.outcome.kind}: ${status}.\n${failures}${describeTail(tail, log)}`
    if (!isEvidence) {
      // why: the kind stays Run, so the log never calls evidence that was not recorded red or green.
      await finishRunView(port, sid, { status: runStatus(record.outcome) }, signal)
      return `${summary}\nno Diagnose evidence recorded: the declared flow has no Diagnose step`
    }
    const recorded = await recordToolRun(port, identity, inherited, signal, { runId, change: own => ({ runs: retainRuns([record, ...own.runs]) }) }, facts)
    if (recorded.kind === 'cancelled') return cancelled
    if (recorded.kind !== 'written') {
      await finishRunView(port, sid, { status: 'ended', label: labelUnrecorded(recorded) }, signal)
      return `${describeUnrecorded('Run', status, recorded, log)}\n${failures}${describeTail(tail, log)}`
    }
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
    return `${summary}\n${progress}${recorded.mirrorError ? `\n${describeMirrorFailure(recorded.mirrorError)}` : ''}`
  })
}
