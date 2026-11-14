import type { Identity, VerifyRecord } from '../../types'
import { isWorktreeListed, readGitOutput, runGit } from '../lib/git'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { bestEffort } from './best-effort'
import type { EnginePort } from './engine-port'
import { refreshView } from './pane-view'
import { recordPlaced } from './placed-refs'
import { readCommonDir } from './record-store'
import { readWorkingTree } from './repository'
import { describeTail } from './run-command'
import { minuteMs } from './timing'
import { executeCommand, prepareRunLog } from './tool-run'
import { composeApprovalCommand, isVerifyApproved, readVerifyEvidence, verifyOutcome, writeVerifyEvidence } from './verify'
import { readVerifyConfig, selectVerify } from './verify-config'
import { describeCiWait, waitCiIdle, withVerifyTurn } from './verify-queue'
import type { CiObservation, CiWait, VerifyTurn } from './verify-queue'

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
 * What a gate left changed beyond its records: nothing, an established change such as a run log or a worktree left behind,
 * or a change it cannot establish, with what to read before retrying.
 */
type GateEffect = { kind: 'none' | 'changed' } | { kind: 'unknown'; check: string }

/** What every gate outcome carries: its text, what the CI wait could not establish, whether a command started and what it left changed. */
interface GateFacts {
  text: string
  /** The CI wait's unestablished state, null when the runner was free, no wait ran or a recorded pass answered. */
  ci: CiObservation | null
  isCommandStarted: boolean
  effect: GateEffect
}

/** A tree whose commands passed, now or in a recorded gate run, named by its short id; a recorded pass wrote no evidence. */
interface GatePass extends GateFacts { kind: 'pass'; tree: string; evidence: Result<void> | null }

/**
 * A tree, named by its short id, whose commands ran on it exactly, unchanged and under the held lock, until one exited non-zero or
 * hit the gate's deadline.
 */
interface GateRed extends GateFacts { kind: 'red'; tree: string; evidence: Result<void> }

/** Any other end of a gate: nothing about the tree is established, so it names no child. */
interface GateNotVerified extends GateFacts { kind: 'not verified' }

/** How a gate ended: pass, red, or not verified. */
export type GateOutcome = GatePass | GateRed | GateNotVerified

/** How removing the gate's worktree ended: removed or proven absent, left at its path, or unknown. */
type Removal = { kind: 'removed'; wasPresent: boolean } | { kind: 'left'; text: string } | { kind: 'unknown'; text: string; check: string }

/** What a held gate has done so far, read by its cleanup. */
interface HeldState {
  isAdded: boolean
  isStarted: boolean
  /** Whether this gate removed a worktree an earlier gate left at its path. */
  isCleared: boolean
  /** What the CI wait could not establish, kept for an answer that a later throw words. */
  ci: CiObservation | null
}

/** What a gating run answers when its lock's holder process ended under it. */
const lockLost = 'Verify lock lost: the host process holding it ended while the commands ran, so they were stopped and nothing counts'
/** What a gating run answers when its lock's holder process ended before any command ran. */
const lockLostBefore = 'Verify lock lost before any command ran: the host process holding it ended, so nothing ran'
/** What a gating run answers when its call was cancelled before any command started. */
const cancelled = 'Verify of the merged tree cancelled before any command ran'
/** What to read when a gate's worktree may be left behind. */
const worktreeCheck = 'git worktree list'

/**
 * Verifies the exact tree a parent branch would move to, through the repository's Verify queue, in a temporary detached worktree
 * removed afterwards while this gate still holds the lock; a gate-stage pass already recorded on that tree, config and selection counts
 * without a new run. Only commands that ran on the exact tree, read back unchanged under the held lock, until one exited non-zero or hit
 * the gate's deadline, make a red; every other end is not verified.
 * @param port - The engine calls.
 * @param gate - The commit, its base, the parent's worktree and the child unit.
 * @param signal - The call's cancellation signal.
 * @returns The outcome, with its text, the CI wait's unestablished state, whether a command started and what it left changed.
 */
export async function verifyMergeTarget(port: EnginePort, gate: MergeGate, signal: AbortSignal): Promise<GateOutcome> {
  const [tree, baseTree] = await Promise.all([gate.target, gate.base].map(sha => readGitOutput(port.processes, ['rev-parse', `${sha}^{tree}`])))
  if (!tree || !baseTree) return refuse('the merged tree is unreadable')
  const short = tree.slice(0, 12)
  const loaded = await readVerifyConfig(port, tree)
  if (loaded.kind !== 'valid') return refuse(`tree ${short} cannot be verified: ${loaded.fact}`)
  if (!await isVerifyApproved(port, loaded.blob)) return refuse(`the Verify config of tree ${short} is not approved; the user approves it from their own terminal with ${await composeApprovalCommand(port, loaded.blob)}`)
  const selection = await selectVerify(port, loaded.config, baseTree, tree, 'gate')
  const earlier = await readVerifyEvidence(port, { tree, configBlob: loaded.blob, commands: selection.commands, stage: 'gate' })
  if (earlier?.run.outcome.kind === 'pass') {
    return { kind: 'pass', text: `Verify ${earlier.run.runId} already passed on tree ${short}. Selection: ${selection.description}`, ci: null, isCommandStarted: false, effect: { kind: 'none' }, tree: short, evidence: null }
  }
  const sid = await port.readSessionId()
  const common = await readCommonDir(port)
  if (!common) return refuse('cannot locate the repository metadata')
  const prepared = await prepareRunLog(port, sid)
  if ('error' in prepared) return refuse(prepared.error)
  const { runId, log } = prepared
  const minutes = loaded.config.timeoutMinutes
  const queueDeadline = await port.now() + minutes * minuteMs
  const onMove = () => bestEffort(port, 'queue view refresh', () => refreshView(port, { isQuiet: true, isSynced: true }), undefined)
  // why: one fixed path per parent; the queue lock serializes gating runs, and a worktree a crash left behind is removed first.
  const path = `${gate.root}.verify`
  // why: one gate call holds at most one Verify turn, so its run and its cleanup share one state.
  const state: HeldState = { isAdded: false, isStarted: false, isCleared: false, ci: null }
  const run = async (turn: VerifyTurn): Promise<GateOutcome> => {
    const labels = loaded.config.waitForCiLabels
    const ciStart = await port.now()
    const waited: CiWait = labels.length ? await waitCiIdle(port, turn, labels, { deadline: queueDeadline, signal, onMove }) : { kind: 'idle' }
    const ci = waited.kind === 'unknown' || waited.kind === 'timeout' ? waited : null
    state.ci = ci
    // why: a worktree an earlier gate left and this one removed is gone for good, so an end after that removal is a change, never a refusal.
    const end = (text: string): GateNotVerified => state.isStarted || state.isCleared
      ? { kind: 'not verified', text: state.isStarted ? text : `${text}; this gate removed the worktree an earlier gate left at ${path}`, ci, isCommandStarted: state.isStarted, effect: { kind: 'changed' } }
      : { ...refuse(text), ci }
    if (signal.aborted) return end(cancelled)
    if (turn.lost.aborted) return end(lockLostBefore)
    if (waited.kind === 'cancelled') return end(cancelled)
    if (waited.kind === 'budget') return end(`CI still holds the runner after ${Math.round((await port.now() - ciStart) / minuteMs)} min, so nothing ran; call merge_child again`)
    const cleared = await removeWorktree(port, path)
    // why: a worktree an earlier gate left at the path is still there, so the answer names it rather than refusing as if nothing were left.
    if (cleared.kind === 'left') return { ...end(`the worktree an earlier gate left at ${path} could not be removed, so nothing ran; ${cleared.text}`), effect: { kind: 'changed' } }
    if (cleared.kind === 'unknown') return { ...end(`the worktree an earlier gate left at ${path} may not be removed (${cleared.text}), so nothing ran`), effect: { kind: 'unknown', check: cleared.check } }
    state.isCleared = cleared.wasPresent
    // why: the target is a commit no ref points at, so a window another session closes while it is checked out sees a new detached HEAD.
    await recordPlaced(port, path, gate.target)
    state.isAdded = true
    const added = await runGit(port.processes, ['worktree', 'add', '--detach', path, gate.target])
    if (added.exitCode !== 0) return end(`cannot check tree ${short} out at ${path}${added.stderr.trim() ? ` (${added.stderr.trim().split('\n')[0]})` : ''}`)
    const before = await readWorkingTree(port, path)
    if (!before.isOk) return end(`the tree at ${path} could not be read (${before.error}); nothing counts`)
    if (before.value !== tree) return end(`the worktree at ${path} does not hold tree ${short}`)
    // why: a holder that ends mid-run frees the lock for the next in line, so the commands stop rather than share the machine.
    const stopping = AbortSignal.any([signal, turn.lost])
    const deadline = await port.now() + minutes * minuteMs
    const failed: { value: VerifyRecord['outcome']; text: string }[] = []
    for (const [index, command] of selection.commands.entries()) {
      // why: a throw may come after the spawn, so the gate counts the command started until its result says no spawn happened.
      const wasStarted = state.isStarted
      state.isStarted = true
      const { run, status, duration, tail } = await executeCommand(port, sid, index, { argv: command, cwd: path, tree, log, deadline, signal: stopping }, minutes)
      if (run.start === 'unspawned') state.isStarted = wasStarted
      const stoppedRun = state.isStarted ? `Verify of the merged tree cancelled while its commands ran, so nothing counts; log: ${log}` : cancelled
      // why: an Esc ends the holder process too, so a stopped call reads as cancelled before the lock reads as lost.
      if (signal.aborted) return end(stoppedRun)
      if (turn.lost.aborted) return end(state.isStarted ? `${lockLost}; log: ${log}` : lockLostBefore)
      if (run.kind === 'cancelled') return end(stoppedRun)
      // why: only an exit code the command chose, or the gate's own deadline, judges the tree; a signal from outside judges nothing.
      if (run.kind === 'ended' && (run.signal !== null || run.code === null)) return end(`Verify of tree ${short} stopped: ${JSON.stringify(command)} ended by ${status}, so nothing counts; log: ${log}`)
      const value = verifyOutcome(run, minutes)
      if (value.kind !== 'pass') {
        failed.push({ value, text: `Verify failed on tree ${short}: ${JSON.stringify(command)}, ${status}, ${duration}.\n${describeTail(tail, log)}` })
        break
      }
    }
    const after = await readWorkingTree(port, path)
    if (!after.isOk) return end(`the tree at ${path} could not be read (${after.error}); nothing counts; log: ${log}`)
    if (after.value !== tree) return end(`the Verify commands changed tree ${short}, so nothing counts; log: ${log}`)
    if (turn.lost.aborted) return end(`${lockLost}; log: ${log}`)
    const red = failed[0]
    const record = { tree, base: gate.base, configBlob: loaded.blob, commands: selection.commands, outcome: red?.value ?? { kind: 'pass' }, runId, at: await port.now(), stage: 'gate' } satisfies VerifyRecord
    const evidence = await writeVerifyEvidence(port, record, gate.origin).then(() => succeed(undefined), (error: unknown) => fail(formatErrorLine(error)))
    // why: a red ran its commands and wrote their log, so naming its culprit is a stop, never a refusal; a pass moves the parent, which is its own answer.
    return red ? { kind: 'red', text: `${red.text}\nSelection: ${selection.description}`, ci, isCommandStarted: true, effect: { kind: 'changed' }, tree: short, evidence }
      : { kind: 'pass', text: `Verify ${runId} passed on tree ${short}; log: ${log}. Selection: ${selection.description}`, ci, isCommandStarted: state.isStarted, effect: { kind: 'none' }, tree: short, evidence }
  }
  const held = async (turn: VerifyTurn): Promise<GateOutcome> => {
    const settled = await run(turn).then(outcome => ({ outcome }), (error: unknown) => ({ error: formatErrorLine(error) }))
    const outcome: GateOutcome = 'outcome' in settled ? settled.outcome : { kind: 'not verified', text: `the gate did not finish (${settled.error})${state.isStarted ? `; log: ${log}` : ''}`,
      ci: state.ci, isCommandStarted: state.isStarted, effect: { kind: 'unknown', check: `${worktreeCheck}${state.isStarted ? ` and ${log}` : ''}` } }
    if (!state.isAdded) return outcome
    // why: once the lock is lost the next holder may already use this path, so its worktree is never removed from here.
    const removal: Removal = turn.lost.aborted ? { kind: 'left', text: `worktree left at ${path}, since the Verify lock was lost and the next holder replaces it` } : await removeWorktree(port, path)
    return removal.kind === 'removed' ? outcome : withRemoval(outcome, removal)
  }
  const hold = await withVerifyTurn(port, common, sid, held, { call: 'merge gate', deadline: queueDeadline, signal, onMove, log })
  if (hold.kind === 'done') return hold.value
  if (hold.kind === 'failed') return refuse(`Verify of the merged tree could not queue: ${hold.error}`)
  return refuse(hold.kind === 'cancelled' ? 'Verify of the merged tree cancelled in the queue' : `Verify of the merged tree timed out after ${minutes} min in the queue`)
}

/**
 * Words what a gate's CI wait could not establish, as its answer leads with it.
 * @param outcome - The gate's outcome.
 * @returns The line ending with a newline, or empty when there is nothing to say.
 */
export function leadCiLine(outcome: GateOutcome): string {
  const line = outcome.ci ? describeCiWait(outcome.ci, outcome.isCommandStarted) : null
  return line ? `${line}.\n` : ''
}

/**
 * Builds a gate that ended before any command started and changed nothing.
 * @param text - Why.
 * @returns The outcome.
 */
function refuse(text: string): GateNotVerified {
  return { kind: 'not verified', text, ci: null, isCommandStarted: false, effect: { kind: 'none' } }
}

/**
 * Removes the gate's worktree, telling a worktree proven absent from one git failed to remove or whose presence it cannot read.
 * @param port - The engine calls.
 * @param path - The worktree's path.
 * @returns Removed (or proven absent), left with the error, or unknown with what to read.
 */
async function removeWorktree(port: EnginePort, path: string): Promise<Removal> {
  const removed = await runGit(port.processes, ['worktree', 'remove', '--force', path])
    .then(run => run.exitCode === 0 ? null : run.stderr.trim().split('\n')[0] || `git worktree remove exited ${run.exitCode}`, (error: unknown) => formatErrorLine(error))
  if (removed === null) return { kind: 'removed', wasPresent: true }
  const listed = await isWorktreeListed(port.processes, path)
  if (listed.isOk && !listed.value) return { kind: 'removed', wasPresent: false }
  if (listed.isOk) return { kind: 'left', text: `worktree left at ${path} (${removed})` }
  return { kind: 'unknown', text: `worktree may be left at ${path} (${removed}; the worktree list could not be read: ${listed.error})`, check: worktreeCheck }
}

/**
 * Adds a worktree left behind to a gate's outcome: an established change, or an unknown one.
 * @param outcome - The gate's outcome.
 * @param removal - The removal that did not remove it.
 * @returns The outcome naming the worktree, never one that reads as nothing changed.
 */
function withRemoval(outcome: GateOutcome, removal: Exclude<Removal, { kind: 'removed' }>): GateOutcome {
  const effect: GateEffect = outcome.effect.kind === 'unknown' ? outcome.effect : removal.kind === 'unknown' ? { kind: 'unknown', check: removal.check } : { kind: 'changed' }
  return { ...outcome, text: `${outcome.text}\n${removal.text}`, effect }
}
