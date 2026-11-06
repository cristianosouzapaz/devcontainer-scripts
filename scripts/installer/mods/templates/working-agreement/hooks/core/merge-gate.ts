import type { Identity, VerifyFailure, VerifyRecord, VerifyTimeout } from '../../types'
import { readGitOutput, runGit } from '../lib/git'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { bestEffort } from './best-effort'
import type { EnginePort } from './engine-port'
import { refreshView } from './pane-view'
import { recordPlaced } from './placed-refs'
import { readCommonDir } from './record-store'
import { readWorkingTreeKey } from './repository'
import { describeTail } from './run-command'
import { minuteMs } from './timing'
import { executeCommand, prepareRunLog } from './tool-run'
import { composeApprovalCommand, isVerifyApproved, readVerifyEvidence, verifyOutcome, writeVerifyEvidence } from './verify'
import { readVerifyConfig, selectVerify } from './verify-config'
import { holdVerifyTurn, isTurnHeld, leaveVerifyQueue, waitCiIdle, waitVerifyTurn } from './verify-queue'

/** Holds the outcome of the run's first failed command and the text naming it, or null while every command passed. */
interface GateOutcome { failed: { value: VerifyFailure | VerifyTimeout; text: string } | null }

/** Names the commit a parent branch would move to and what it is judged against. */
interface MergeGate {
  /** The commit the parent would move to: the child's tip, or the merge commit no ref points at yet. */
  target: string
  /** The parent's tip, whose tree selects the commands as a unit's base does. */
  base: string
  /** The parent's worktree, beside which the temporary worktree is placed. */
  root: string
  /** The child unit the run's evidence is recorded for. */
  origin: Identity
}

/**
 * Verifies the exact tree a parent branch would move to, through the repository's Verify queue, in a temporary detached worktree
 * removed afterwards; a gate-stage pass already recorded on that tree, config and selection counts without a new run.
 * @param port - The engine calls.
 * @param gate - The commit, its base, the parent's worktree and the child unit.
 * @param signal - The call's cancellation signal.
 * @returns How the tree passed, or the failure naming the command, its output tail and the log.
 */
export async function verifyMergeTarget(port: EnginePort, gate: MergeGate, signal: AbortSignal): Promise<Result<string>> {
  const [tree, baseTree] = await Promise.all([gate.target, gate.base].map(sha => readGitOutput(port.processes, ['rev-parse', `${sha}^{tree}`])))
  if (!tree || !baseTree) return fail('the merged tree is unreadable')
  const short = tree.slice(0, 12)
  const loaded = await readVerifyConfig(port, tree)
  if (loaded.kind !== 'valid') return fail(`tree ${short} cannot be verified: ${loaded.fact}`)
  if (!await isVerifyApproved(port, loaded.blob)) return fail(`the Verify config of tree ${short} is not approved; the user approves it from their own terminal with ${await composeApprovalCommand(port, loaded.blob)}`)
  const selection = await selectVerify(port, loaded.config, baseTree, tree, 'gate')
  const earlier = await readVerifyEvidence(port, { tree, configBlob: loaded.blob, commands: selection.commands, stage: 'gate' })
  if (earlier?.run.outcome.kind === 'pass') return succeed(`Verify ${earlier.run.runId} already passed on tree ${short}. Selection: ${selection.description}`)
  const sid = await port.readSessionId()
  const common = await readCommonDir(port)
  if (!common) return fail('cannot locate the repository metadata')
  const prepared = await prepareRunLog(port, sid)
  if ('error' in prepared) return fail(prepared.error)
  const { runId, log } = prepared
  const minutes = loaded.config.timeoutMinutes
  const queueDeadline = await port.now() + minutes * minuteMs
  const onMove = () => bestEffort(port, 'queue view refresh', () => refreshView(port, { isQuiet: true, isSynced: true }), undefined)
  const wait = await waitVerifyTurn(port, common, sid, queueDeadline, signal, onMove)
  if (wait.kind !== 'acquired') return fail(wait.kind === 'cancelled' ? 'Verify of the merged tree cancelled' : `Verify of the merged tree timed out after ${minutes} min in the queue`)
  const stop = holdVerifyTurn(port, wait.turn)
  // why: one fixed path per parent; the queue lock serializes gating runs, and a worktree a crash left behind is removed first.
  const path = `${gate.root}.verify`
  try {
    const labels = loaded.config.waitForCiLabels
    if (labels.length && await waitCiIdle(port, wait.turn, labels, queueDeadline, signal, onMove) === 'cancelled') return fail('Verify of the merged tree cancelled')
    await runGit(port.processes, ['worktree', 'remove', '--force', path])
    // why: the target is a commit no ref points at, so a window another session closes while it is checked out sees a new detached HEAD.
    await recordPlaced(port, path, gate.target)
    if ((await runGit(port.processes, ['worktree', 'add', '--detach', path, gate.target])).exitCode !== 0) return fail(`cannot check tree ${short} out at ${path}`)
    if (await readWorkingTreeKey(port, path) !== tree) return fail(`the worktree at ${path} does not hold tree ${short}`)
    const deadline = await port.now() + minutes * minuteMs
    const outcome: GateOutcome = { failed: null }
    for (const [index, command] of selection.commands.entries()) {
      const { run, status, duration, tail } = await executeCommand(port, sid, index, { argv: command, cwd: path, tree, log, deadline, signal }, minutes)
      if (run.kind === 'cancelled' || signal.aborted) return fail('Verify of the merged tree cancelled')
      const value = verifyOutcome(run, minutes)
      if (value.kind !== 'pass') {
        outcome.failed = { value, text: `Verify failed on tree ${short}: ${JSON.stringify(command)}, ${status}, ${duration}.\n${describeTail(tail, log)}` }
        break
      }
    }
    if (await readWorkingTreeKey(port, path) !== tree) return fail(`the Verify commands changed tree ${short}, so nothing counts; log: ${log}`)
    if (!await isTurnHeld(port, wait.turn)) return fail(`Verify lock lost: another session broke it as stale while the commands ran; log: ${log}`)
    const record = { tree, base: gate.base, configBlob: loaded.blob, commands: selection.commands, outcome: outcome.failed?.value ?? { kind: 'pass' }, runId, at: await port.now(), stage: 'gate' } satisfies VerifyRecord
    await bestEffort(port, 'verify evidence write', () => writeVerifyEvidence(port, record, gate.origin), undefined)
    return outcome.failed ? fail(`${outcome.failed.text}\nSelection: ${selection.description}`) : succeed(`Verify ${runId} passed on tree ${short}; log: ${log}. Selection: ${selection.description}`)
  } finally {
    await runGit(port.processes, ['worktree', 'remove', '--force', path]).catch(() => null)
    await stop()
    await leaveVerifyQueue(port, wait.turn)
  }
}
