import type { Identity, VerifyRecord } from '../../types'
import type { ToolRunResult } from '../core/tool-run'
import type { CallFacts, CallRef } from '../core/command-calls'
import { withToolRun } from '../core/command-calls'
import type { EnginePort } from '../core/engine-port'
import { minuteMs } from '../core/timing'
import { hasCodeChange } from '../domain/step-states'
import { readCommonDir, readSession, readUnit } from '../core/record-store'
import { bestEffort } from '../core/best-effort'
import { describeEscalationStop } from '../core/escalation'
import { describeParentConflicts } from '../core/parent-merge'
import { refreshView } from '../core/pane-view'
import { readGit, readWorkingTree } from '../core/repository'
import { finishRunView, runStatus, updateRunCommand, withRunView } from '../core/run-view'
import { describeTail } from '../core/run-command'
import { readUnitSlice } from '../core/unit-slice'
import { composeApprovalCommand, isVerifyApproved, verifyOutcome, writeVerifyEvidence } from '../core/verify'
import { updateProcessState } from '../core/process-state'
import { recordTurnFact } from '../core/turn-evidence'
import { changedPaths, readVerifyConfig, selectVerify } from '../core/verify-config'
import { describeStoppedWait, readWatch, watchCancels } from '../core/cancel-gate'
import { describeCiWait, waitCiIdle, withVerifyTurn } from '../core/verify-queue'
import type { CiWait, VerifyTurn } from '../core/verify-queue'
import { locateWorktreeRoot } from '../lib/git'
import { formatErrorLine } from '../lib/result'
import { describeMirrorFailure, describeUnrecorded, executeCommand, labelUnrecorded, prepareRunLog, readLifetimeEnd, recordToolRun } from '../core/tool-run'
import type { RecordOutcome } from '../core/tool-run'

interface VerifyOutcomeState { value: VerifyRecord['outcome']; failure: string | null }

const cancelled = 'Verify cancelled; no record written.'
const lockLost = 'Verify lock lost: the host process holding it ended while these commands ran, so they were stopped; no record written.'
const lockLostBefore = 'Verify lock lost before any command ran: the host process holding it ended; nothing ran and no record was written.'

/**
 * Owns the session's Verify dispatch; every refusal and failure is a normal tool result.
 * @param port - Engine calls.
 * @param signal - The dispatch's cancellation signal, watched even during a silent pull.
 * @param call - The call, which names its ledger entry.
 * @returns The result text for the agent.
 */
export async function handleVerify(port: EnginePort, signal: AbortSignal, call: CallRef): Promise<ToolRunResult> {
  return withToolRun(port, 'Verify', call, (sid, facts) => verify(port, signal, sid, facts), signal)
}

/**
 * Records Verify evidence only for approved commands on an unchanged unit slice.
 * @param port - The engine calls.
 * @param signal - The dispatch's cancellation signal.
 * @param sid - The session owning the run.
 * @param facts - The call's ledger facts.
 * @returns The refusal, cancellation or verification summary.
 */
async function verify(port: EnginePort, signal: AbortSignal, sid: string, facts: CallFacts): Promise<string> {
  const session = await readSession(port)
  if (!session.unit) return 'No unit declared in this chat.'
  const escalation = await describeEscalationStop(port)
  if (escalation?.kind === 'refused') return escalation.text
  const reply = await verifyUnit(port, signal, sid, session.unit, facts)
  return escalation ? `${reply}\n${escalation.text}` : reply
}

/**
 * Runs Verify on the unit's slice once no escalation refuses it.
 * @param port - The engine calls.
 * @param signal - The dispatch's cancellation signal.
 * @param sid - The session owning the run.
 * @param identity - The session's declared unit.
 * @param facts - The call's ledger facts.
 * @returns The refusal, cancellation or verification summary.
 */
async function verifyUnit(port: EnginePort, signal: AbortSignal, sid: string, identity: Identity, facts: CallFacts): Promise<string> {
  const git = await readGit(port)
  const unit = await readUnit(port, identity)
  const slice = git ? await readUnitSlice(port, identity, unit, git) : null
  const located = await locateWorktreeRoot(port.processes, identity.branch)
  if (!located.isOk) return `Verify refused: the worktree list could not be read (${located.error}), so whether the unit's branch is checked out is unknown; no record written.`
  const root = located.value
  if (!root) return "The unit's branch is checked out nowhere."
  const conflicts = await describeParentConflicts(port)
  if (conflicts) return conflicts
  if (!hasCodeChange(slice)) return 'Code is not done (empty change set or unavailable slice).'
  const tree = slice.tree
  const loaded = await readVerifyConfig(port, tree)
  if (loaded.kind !== 'valid') return loaded.fact
  if (!await isVerifyApproved(port, loaded.blob)) {
    // why: the unit asked for Verify, so it now waits for the user, and the pane must show that wait.
    const blob = loaded.blob
    await recordTurnFact(port, 'asked', null, state => ({ ...state, verifyAskedBlob: blob }))
    await bestEffort(port, 'approval wait view refresh', () => refreshView(port, { isQuiet: true }), undefined)
    return `Config not approved. Stop, end your turn and ask the user to approve it from their own terminal, never from a session: ${await composeApprovalCommand(port, loaded.blob)}`
  }
  // why: a run on an approved config is the step the approval follow-up pointed to, so that wait is over.
  await bestEffort(port, 'turn state', () => updateProcessState(port, state => state.approvalWait ? { ...state, approvalWait: null } : state), null)
  const selection = await selectVerify(port, loaded.config, slice.baseTree, tree, 'unit')
  const worktree = await readWorkingTree(port, root)
  if (!worktree.isOk) return `Verify refused: the worktree could not be read (${worktree.error}), so whether it matches the unit tree is unknown; no record written.`
  if (worktree.value !== tree) return 'The worktree content differs from the unit tree; Verify cannot run on this slice.'
  const prepared = await prepareRunLog(port, sid)
  if ('error' in prepared) return prepared.error
  const { runId, log } = prepared
  const common = await readCommonDir(port)
  if (!common) return 'Cannot locate the repository metadata.'
  // why: the wait for another session's Verify and for CI gets the same bound as the run, so a queued call never outlives two runs.
  const queueDeadline = await port.now() + loaded.config.timeoutMinutes * minuteMs
  const onMove = () => bestEffort(port, 'queue view refresh', () => refreshView(port, { isQuiet: true, isSynced: true }), undefined)
  // why: a cancel stops only the waits, through their own signal; a command that runs keeps the dispatch's and finishes.
  const watch = watchCancels(port, signal)
  const held = async (turn: VerifyTurn): Promise<string> => {
    const labels = loaded.config.waitForCiLabels
    const ciStart = await port.now()
    const ci: CiWait = labels.length ? await waitCiIdle(port, turn, labels, { deadline: queueDeadline, signal: watch.signal, onMove, onStep: watch.check }) : { kind: 'idle' }
    const ciCancel = watch.cancelId()
    if (ciCancel) return describeStoppedWait('CI', ciCancel)
    if (signal.aborted) return cancelled
    if (turn.lost.aborted) return lockLostBefore
    if (ci.kind === 'cancelled') return cancelled
    if (ci.kind === 'budget') return `CI still holds the runner after ${Math.round((await port.now() - ciStart) / minuteMs)} min; nothing ran and no record was written; call verify again.`
    // why: a holder that ends mid-run frees the lock for the next in line, so the commands stop rather than share the machine.
    const stopping = AbortSignal.any([signal, turn.lost])
    const started = { value: false }
    const ciFact = describeCiWait(ci, false)
    const deadline = await port.now() + loaded.config.timeoutMinutes * minuteMs
    const reply = await withRunView(port, sid, identity, unit.generation, {
      runId, kind: 'Verify', status: 'running', selection: ciFact ? `${selection.description} · ${ciFact}` : selection.description, tree, cwd: root, log, duration: 0, at: await port.now(),
      commands: selection.commands.map((argv, index) => ({ argv, status: index === 0 ? 'running' : 'waiting', duration: 0, outcome: '', output: '' })),
    }, signal, async () => {
      const summaries: string[] = []
      // why: a lock lost before the first spawn started nothing, so no log exists to cite.
      const stopOnLostLock = async (): Promise<string> => {
        await finishRunView(port, sid, { status: 'ended', label: 'not recorded · lock lost' }, signal)
        return started.value ? `${lockLost} Log: ${log}` : lockLostBefore
      }
      const outcome: VerifyOutcomeState = { value: { kind: 'pass' }, failure: null }
      const stopUnrecorded = async (unrecorded: Exclude<RecordOutcome, { kind: 'written' | 'cancelled' }>): Promise<string> => {
        await finishRunView(port, sid, { status: 'ended', label: labelUnrecorded(unrecorded) }, signal)
        return `${describeUnrecorded('Verify', runStatus(outcome.value), unrecorded, log)}\n${outcome.failure ?? `Ran: ${summaries.join(', ') || 'no command'}.`}`
      }
      for (const [index, command] of selection.commands.entries()) {
        if (signal.aborted) return cancelled
        updateRunCommand(sid, index, { status: 'running' })
        const { run, status, duration, tail } = await executeCommand(port, sid, index, { argv: command, cwd: root, tree, log, deadline, signal: stopping }, loaded.config.timeoutMinutes, facts)
        if (run.start !== 'unspawned') started.value = true
        // why: an Esc ends the holder process too, so a stopped call reads as cancelled before the lock reads as lost.
        if (signal.aborted) return cancelled
        if (turn.lost.aborted) return await stopOnLostLock()
        if (run.kind === 'cancelled') return cancelled
        summaries.push(`${JSON.stringify(command)} (${duration})`)
        outcome.value = verifyOutcome(run, loaded.config.timeoutMinutes)
        if (outcome.value.kind !== 'pass') {
          outcome.failure = `Verify failed: ${JSON.stringify(command)}, ${status}, ${duration}.\n${describeTail(tail, log)}\nNot run: ${selection.commands.slice(index + 1).map(argv => JSON.stringify(argv)).join(', ') || 'none'}`
          break
        }
      }
      // why: an ended lifetime drops the unit's evidence, which moves its slice base, so it is told before any tree check reads that as a change.
      const ended = await readLifetimeEnd(port, identity, unit)
      if (ended) return await stopUnrecorded({ kind: 'ended', ended })
      const after = git ? await readUnitSlice(port, identity, await readUnit(port, identity), git) : null
      const worktreeAfter = await readWorkingTree(port, root)
      // why: the slice was read before the commands ran, so one that cannot be read now, like a worktree that cannot, is unknown, not a change.
      if (!worktreeAfter.isOk || !after) {
        const unread = !worktreeAfter.isOk ? `the worktree could not be read afterwards (${worktreeAfter.error})` : "the unit's slice could not be read afterwards"
        await finishRunView(port, sid, { status: 'ended', label: 'not recorded · worktree unreadable' }, signal)
        return `Verify stopped: ${selection.commands.length ? `the commands ran (${runStatus(outcome.value)})` : 'it ran no command'}, but ${unread}, so whether it changed the tree is unknown; no record written. Log: ${log}.`
      }
      if (after.tree !== tree || worktreeAfter.value !== tree || after.base !== slice.base) {
        const changed = await changedPaths(port, tree, worktreeAfter.value)
        await finishRunView(port, sid, { status: 'tree changed', changed }, signal)
        return `The commands change the tree; no record written. Changed paths: ${changed.map(path => JSON.stringify(path)).join(', ') || 'none listed; the slice base moved'}. Log: ${log}`
      }
      if (signal.aborted) return cancelled
      if (turn.lost.aborted) return await stopOnLostLock()
      const record = { tree, base: slice.base, configBlob: loaded.blob, commands: selection.commands, outcome: outcome.value, runId, at: await port.now(), stage: 'unit' } satisfies VerifyRecord
      const recorded = await recordToolRun(port, identity, unit, signal,
        { runId, change: own => ({ verifyRuns: [record], redVerifies: record.outcome.kind === 'pass' ? 0 : (own.redVerifies ?? 0) + 1 }) }, facts)
      if (recorded.kind === 'cancelled') return cancelled
      if (recorded.kind !== 'written') return await stopUnrecorded(recorded)
      const evidence = await writeVerifyEvidence(port, record, identity).then(() => null, (error: unknown) => formatErrorLine(error))
      await finishRunView(port, sid, { status: runStatus(outcome.value) }, signal)
      const answer = outcome.failure ?? `Verify passed on tree ${tree.slice(0, 12)}: ${summaries.join(', ') || 'no command run'}. Selection: ${selection.description}.`
      const notes = [
        ...recorded.mirrorError ? [describeMirrorFailure(recorded.mirrorError)] : [],
        ...evidence ? [`recorded for this unit; the shared evidence other sessions on this tree reuse was not written (${evidence}), so they will not see this ${outcome.value.kind === 'pass' ? 'pass' : 'run'}`] : [],
      ]
      return [answer, ...notes].join('\n')
    }, slice.base)
    const ciLine = describeCiWait(ci, started.value)
    return ciLine && reply !== cancelled ? `${ciLine}.\n${reply}` : reply
  }
  const options = { call: 'verify' as const, deadline: queueDeadline, signal: watch.signal, onMove, onPoke: watch.check, log, ...await readWatch(port) }
  facts.queued()
  const hold = await withVerifyTurn(port, common, sid, held, options)
  if (hold.kind === 'done') return hold.value
  const queueCancel = watch.cancelId()
  if (queueCancel) return describeStoppedWait('the Verify queue', queueCancel)
  if (hold.kind === 'failed') return `Verify could not queue: ${hold.error}; no record written.`
  return hold.kind === 'cancelled' ? cancelled
    : `Verify queued, timed out after ${loaded.config.timeoutMinutes} min behind another session's Verify, run or merge gate; no record written.`
}
