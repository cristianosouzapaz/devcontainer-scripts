import type { KeptStart, PendingStart, ProcessState } from '../../types'
import { composeCoordinatePrompt } from '../domain/coordinator'
import { composeDelegatePrompt } from '../domain/delegation'
import { composeStart, composeStartPrompt, describeLoadFailure, describeStartFailure, describeStartTarget, readStartLead } from '../domain/instruction'
import type { StartComposition } from '../domain/instruction'
import type { DeclaredFlow, StartFault } from '../domain/instruction'
import { sameIdentity } from '../domain/records'
import { applyApproval } from '../features/approve'
import { runFollowUpCommand } from '../features/follow-up'
import { fail, formatError, formatErrorLine, settle, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { bestEffort } from './best-effort'
import { findLiveDelegation, recordDelegatedStep } from './delegation'
import type { EnginePort } from './engine-port'
import { createFeaturePort } from './feature-port'
import { logEvent } from './flow-log'
import { refreshView } from './pane-view'
import { locatePosition, readUnitFlow } from './position'
import { createReadPort } from './read-port'
import { readSession, updateUnits } from './record-store'
import { readOwedCancels } from './mailbox'
import { claimLoad, isLoadRecorded, keepStart, UnknownKeepError, noteLoadRecorded, readKeptStarts, readLoadId, readPredecessor, readProcessState, refuseWithoutStartRoom,
  transactProcess, transitOwned, withKeptStarts } from './process-state'
import { applyEnteringPrompt, dismissNotices, judgeNow, keepNotices, releaseEarlierAttempts, settleAttempts, submitAttempt, takeReceipts, withdrawClaims } from './attempts'
import { clearKeepFaults, forgetStartFault, noteStartFault, resolveUnknownKeeps } from './start-notices'
import { retryTurnChanges, writeTurnFacts } from './turn-evidence'
import { sessionMemory, withRecordLock } from './session-memory'
import { createQueue } from '../lib/queue'
import { moduleState } from '../lib/module-state'
import { clearFault, raiseFault } from './fault-registry'

// why: one delivery at a time in this module load, from its composition to its submit, so a start kept later never reaches the host before one kept earlier.
const deliveries = moduleState(() => ({ run: createQueue(), isTickPending: false }))

/**
 * Runs `/flow skip <step> <reason>`: records the skip, as delegated in a delegated unit, then starts a turn on the new current step.
 * The typed command and a coordinator's checked step both run it.
 * @param port - The engine calls.
 * @param tail - The words after `skip`.
 * @param via - What the delegated-step record adds after the command, such as the Remote Control note.
 * @returns The reply, or the refusal.
 */
export async function runSkipStep(port: EnginePort, tail: string, via = ''): Promise<Result<string>> {
  const full = await refuseWithoutStartRoom(port)
  if (full) return fail(full)
  const id = tail.split(/\s+/)[0]?.toLowerCase() ?? ''
  const result = await withRecordLock(async (): Promise<Result<string>> => {
    const session = await readSession(port)
    // why: a skip must name a step the unit's flow runs (Integrate for a child unit, PR for any other), so the flow is read first.
    const flow = (await readUnitFlow(createReadPort(port), session))?.flow
    if (!flow) return fail('No flow declared — declare a flow before skipping a step.')
    const match = flow.steps.find(step => [step.id, step.label].some(name => tail.toLowerCase() === name.toLowerCase() || tail.toLowerCase().startsWith(`${name.toLowerCase()} `)))
    if (!match) return fail('Unknown step — use a step id or label from this flow.')
    const reason = tail.slice(tail.toLowerCase().startsWith(`${match.id.toLowerCase()} `) ? match.id.length : match.label.length).trim()
    if (!reason) return fail('A skip needs a non-empty reason.')
    await updateUnits(port, session, unit => ({ ...unit, skips: [...(unit.skips ?? []), { step: match.id, reason }] }))
    logEvent(port, session, 'skip', { step: match.id, reason })
    await refreshView(port, { isQuiet: true, isSynced: true })
    return succeed(`Skipped ${match.label}: ${reason}`)
  })
  const note = await recordIfDelegated(port, `${`/flow skip ${id}`.trim()}${via}`, result.isOk)
  return startAfter(port, result.isOk ? succeed(`${result.value}${note}`) : result)
}

/**
 * Runs `/flow approve <diagnosis URL>`: approves the diagnosis, as delegated in a delegated unit, then starts a turn on the new current step.
 * @param port - The engine calls.
 * @param tail - The words after `approve`.
 * @param via - What the delegated-step record adds after the command, such as the Remote Control note.
 * @returns The reply, or the refusal.
 */
export async function runApproveStep(port: EnginePort, tail: string, via = ''): Promise<Result<string>> {
  const full = await refuseWithoutStartRoom(port)
  if (full) return fail(full)
  const result = await applyApproval(createFeaturePort(port), tail)
  if (!result.isOk) return result
  // why: a repeat of the approved comment took no step, so it is neither credited to delegation nor given a turn.
  if (!result.value.changed) return succeed(result.value.reply)
  return startAfter(port, succeed(`${result.value.reply}${await recordIfDelegated(port, `/flow approve${via}`, true)}`))
}

/**
 * Runs `/flow follow-up #n`: declares the Follow-up flow, as delegated in a delegated unit, then starts a turn on its first step.
 * @param port - The engine calls.
 * @param tail - The words after `follow-up`.
 * @param via - What the delegated-step record adds after the command, such as the Remote Control note.
 * @returns The reply, or the refusal.
 */
export async function runFollowUpStep(port: EnginePort, tail: string, via = ''): Promise<Result<string>> {
  const full = await refuseWithoutStartRoom(port)
  if (full) return fail(full)
  const result = await runFollowUpCommand(createFeaturePort(port), tail)
  const note = await recordIfDelegated(port, `/flow follow-up${via}`, result.isOk)
  return startStep(port, result.isOk ? succeed({ ...result.value, reply: `${result.value.reply}${note}` }) : result)
}

/**
 * Records a reserved step that succeeded in a delegated unit as delegated, and repaints the pane when it was.
 * @param port - The engine calls.
 * @param command - The step's command.
 * @param isApplied - Whether the step succeeded; a refused one records nothing.
 * @returns What the outcome adds when the record failed, from what reading the record back established; empty otherwise.
 */
async function recordIfDelegated(port: EnginePort, command: string, isApplied: boolean): Promise<string> {
  if (!isApplied) return ''
  // why: only the unit this write is for may confirm it, never an earlier unit of this session holding the same command.
  const unit = await port.readSessionState().then(snapshot => snapshot.value?.unit ?? null, () => null)
  const recorded = await settle(recordDelegatedStep(port, command))
  if (recorded.isOk) {
    if (recorded.value) await refreshView(port, { isQuiet: true, isSynced: true })
    return ''
  }
  const error = recorded.error.split('\n')[0] ?? ''
  // why: the record is written before its copy on disk, so a failure leaves it written or not, which only the record itself tells.
  const held = await port.readSessionState().then(snapshot => snapshot.value, (failure: unknown) => new Error(formatErrorLine(failure)))
  if (held instanceof Error) return `; the mod could not confirm whether it was recorded as delegated (${error}; reading this session's record back failed: ${held.message}); check /flow status`
  if (!unit) return `; the mod could not confirm whether it was recorded as delegated (${error}; which unit it was for could not be read); check /flow status`
  return (held?.units ?? []).some(entry => sameIdentity(entry.identity, unit) && entry.delegated?.includes(command))
    ? `; it was recorded as delegated, but a later write failed (${error}), so the copy of this session's record that other sessions read may not hold it yet; check /flow status`
    : `; it was not recorded as delegated (${error}); check /flow status`
}

/**
 * Starts an agent turn on the current step once a declaration succeeded.
 * @param port - The engine calls.
 * @param result - The declaration.
 * @returns The declaration's reply, or its refusal.
 */
export async function startStep(port: EnginePort, result: Result<DeclaredFlow>): Promise<Result<string>> {
  if (!result.isOk) return result
  const { reply, start } = result.value
  const lead = start ? readStartLead(start) : undefined
  const unkept = lead ? await submitStart(port, { kind: 'step', lead }) : null
  return succeed(withUnkept(reply, unkept))
}

/**
 * Adds to a command's reply why its start prompt was not kept, so the user reads it at once, whatever the pane shows later.
 * @param reply - The command's reply.
 * @param unkept - Why its start was not kept, or null once kept.
 * @returns The reply.
 */
export const withUnkept = (reply: string, unkept: string | null): string => unkept ? `${reply}\n${unkept}` : reply

/**
 * Starts an agent turn on the new current step once a command that moved the unit succeeded; its reply leads the prompt.
 * @param port - The engine calls.
 * @param result - The command's reply, or its refusal.
 * @returns The result, with why its start was not kept, if it was not.
 */
async function startAfter(port: EnginePort, result: Result<string>): Promise<Result<string>> {
  if (!result.isOk) return result
  return succeed(withUnkept(result.value, await submitStart(port, { kind: 'step', lead: result.value })))
}

/**
 * Writes a start prompt from the unit's position when it is composed, so it names the step current then and any cancel the unit owes.
 * @param port - The engine calls.
 * @param lead - What the command did, as the prompt's first sentence.
 * @returns The prompt, or why none could be written.
 */
async function composeStartFrom(port: EnginePort, lead: string): Promise<StartComposition> {
  const session = await readSession(port)
  const position = await locatePosition(createReadPort(port), session)
  if (!position) return { kind: 'refused', isFinal: true, reason: 'the session had no flow declared when its turn came' }
  const isDelegated = !!await bestEffort(port, 'delegation read', () => findLiveDelegation(port, session.issues), null)
  const cancels = await bestEffort(port, 'cancel read', () => readOwedCancels(port), [])
  return composeStart(position, session, lead, isDelegated, cancels.map(envelope => envelope.id))
}

/**
 * Writes a kept start's prompt now, so it names the step current when it is taken.
 * @param port - The engine calls.
 * @param start - The kept start.
 * @returns The prompt, or why none could be written.
 */
async function composePendingStart(port: EnginePort, start: PendingStart): Promise<StartComposition> {
  if (start.kind === 'coordinate') return { kind: 'prompt', text: composeCoordinatePrompt(start.text) }
  if (start.kind === 'delegate') return { kind: 'prompt', text: composeDelegatePrompt(start.issues, start.instructions) }
  return composeStartFrom(port, start.lead)
}

/**
 * Keeps the start prompt once the command has answered, behind any start kept before it, then delivers from a dispatch of its own once
 * the session is idle. It is kept before the delivery is deferred, so a reload that cancels the delivery leaves it for the next tick or
 * the turn end; a start that cannot be kept is named in the command's reply, and shown on the pane until a render of the Flow view showed it, with how to
 * start it by hand.
 * @param port - The engine calls.
 * @param start - The start, composed when it is delivered.
 * @returns Why it was not kept, for the reply, or null once kept and its delivery deferred.
 */
export async function submitStart(port: EnginePort, start: PendingStart): Promise<string | null> {
  const owner = readLoadId()
  const kept: KeptStart = { id: crypto.randomUUID(), start }
  try {
    await keepStart(port, owner, kept)
  } catch (error) {
    // why: a keep whose write answered with a failure may have landed, so it is never called not kept, which would have the user keep it twice; the tick settles which.
    const fault: StartFault = { stage: error instanceof UnknownKeepError ? 'keep-unknown' : 'keep', cause: formatError(error), kind: start.kind, label: describeStartTarget(start), isShown: false }
    noteStartFault(kept.id, fault)
    return describeStartFailure(fault)
  }
  clearKeepFaults()
  // why: a reload that cancels this dispatch leaves the start kept for the tick.
  port.defer(() => void bestEffort(port, 'start prompt', () => deliverPendingStart(port), undefined))
  return null
}

/**
 * Delivers the oldest kept start from a dispatch of its own, as the turn end and the idle tick ask; a reload that cancels it leaves the start kept.
 * @param port - The engine calls.
 */
export function scheduleStart(port: EnginePort): void {
  // why: a tick or turn-end delivery still pending already covers the oldest start, so none is queued behind it.
  if (deliveries.isTickPending) return
  deliveries.isTickPending = true
  port.defer(() => void bestEffort(port, 'start prompt', () => deliverPendingStart(port), undefined).finally(() => { deliveries.isTickPending = false }))
}

/**
 * Delivers the start first in line once the session is idle, and only it: a start never passes an earlier one, so a start whose
 * composition fails holds the starts behind it until it composes. It is composed before its claim, so the claim is the last write before
 * the submit, and the common driver judges the gate again in it on the current state and writes the attempt; the start leaves the
 * keeping only once its attempt is known to have entered, or with a notice. A start with no current step to start leaves with a notice
 * that says so. Deliveries of this module run one at a time.
 * @param port - The engine calls.
 * @returns Once delivered, or not.
 */
function deliverPendingStart(port: EnginePort): Promise<void> {
  return deliveries.run(async () => {
    const owner = readLoadId()
    const state = await readProcessState(port)
    const head = state ? readKeptStarts(state)[0] : undefined
    if (!head || judgeNow(state, await port.now()).kind !== 'idle') return
    const prompt = await composePendingStart(port, head.start).then(text => ({ text }), (error: unknown) => ({ error }))
    if ('error' in prompt) {
      noteStartFault(head.id, { stage: 'compose', cause: formatError(prompt.error), kind: head.start.kind, label: describeStartTarget(head.start) })
      port.logDebug(`working-agreement: start prompt not composed: ${formatError(prompt.error)}`)
      return
    }
    const composed = prompt.text
    if (composed.kind === 'refused' && !composed.isFinal) {
      // why: a step that is not known yet may be known later, so the start holds its place, as one whose composition failed does, with why.
      noteStartFault(head.id, { stage: 'compose', cause: composed.reason, kind: head.start.kind, label: describeStartTarget(head.start) })
      return
    }
    if (sessionMemory.startFaults.get(head.id)?.stage === 'compose') forgetStartFault(head.id)
    if (composed.kind === 'refused') {
      // why: with nothing to start, the start leaves the keeping with a notice that names why, never as delivered.
      const notice = { id: head.id, subject: head.id, route: 'start' as const, kind: head.start.kind, label: describeStartTarget(head.start),
        cause: `it was not started: ${composed.reason}` }
      await transitOwned(port, owner, held => readKeptStarts(held)[0]?.id === head.id
        ? { kind: 'won', value: null, state: { ...withKeptStarts(held, readKeptStarts(held).slice(1)), notices: keepNotices([...held.notices ?? [], notice]) } } : { kind: 'gone' })
      return
    }
    const ended = await submitAttempt(port, { owner, route: 'start', subject: head.id, kind: head.start.kind, label: describeStartTarget(head.start), text: composeStartPrompt(composed.text),
      isWanted: held => readKeptStarts(held)[0]?.id === head.id })
    if (ended.kind === 'submitted' && ended.status.kind === 'dropped') noteStartFault(head.id, { stage: 'dropped', cause: ended.status.cause, kind: head.start.kind, label: describeStartTarget(head.start) })
    if (ended.kind === 'submitted' && ended.status.kind === 'entered') { forgetStartFault(head.id); clearKeepFaults() }
  })
}

/**
 * Keeps the evidence and the deliveries moving at the tick: writes again the turn changes and turn facts whose write failed, records this
 * load in the process state until its record lands, and, as the load the state records, withdraws its claims it never submitted, settles
 * the attempts whose outcome is established, ends with a notice those an earlier load made that a reload left unanswered, and forgets
 * the notices a render of the Flow view showed. A load
 * that stands down changes nothing else.
 * @param port - The engine calls.
 * @returns The process state as recovery left it, read in a compare-and-set, or null when it cannot be read.
 */
export async function recoverStarts(port: EnginePort): Promise<ProcessState | null> {
  const owner = readLoadId()
  await retryTurnChanges(port)
  await writeTurnFacts(port)
  const recorded = await claimThisLoad(port)
  // why: a keep whose answer failed is settled against the state that stands as this compare-and-set lands, never against a read this tick took before the keep.
  if ([...sessionMemory.startFaults.values()].some(fault => fault.stage === 'keep-unknown')) {
    const state = await transactProcess(port, held => ({ state: held, result: held })).catch(() => null)
    if (state) resolveUnknownKeeps(state)
  }
  if (recorded && !sessionMemory.isLoadSuperseded) {
    await withdrawClaims(port, owner)
    await applyEnteringPrompt(port, owner)
    await settleAttempts(port, owner)
    await releaseEarlierAttempts(port, owner)
    await takeReceipts(port, owner)
    await dismissNotices(port, owner, new Set(sessionMemory.shownNotices))
  }
  // why: what the tick says next is said of the state this recovery left, which a read taken before it no longer is.
  return transactProcess(port, held => ({ state: held, result: held })).catch(() => null)
}

/**
 * Records this load in the process state at a session start, unless a newer load already recorded itself; a failure is shown until
 * the tick records it.
 * @param port - The engine calls.
 * @returns Once tried.
 */
export async function recordLoad(port: EnginePort): Promise<void> {
  await claimThisLoad(port)
}

/**
 * Records this load in the process state as its claim allows, once: the load the state names at this load's first look is the one it
 * replaces, and once its record landed only a newer load replaces it, so it is never written again. The step is pure: whether a newer load
 * recorded itself reaches this load's memory only from the run that was written, so a run on a stale value never marks this load
 * superseded.
 * @param port - The engine calls.
 * @returns Whether this load's record stands or it stood down, as known; false while it is not written, which is shown until a tick writes it.
 */
async function claimThisLoad(port: EnginePort): Promise<boolean> {
  // why: the load is read before the first await, so a claim that resumes after a reload still claims for the load that began it.
  const loadId = readLoadId()
  if (isLoadRecorded() || sessionMemory.isLoadSuperseded) return true
  // why: the load this one replaces is the one the state names at this load's first look, read once outside the compare-and-set, so a write that fails, or a run on a stale value, never moves it.
  if (readPredecessor() === undefined) {
    const first = await readProcessState(port)
    if (!first) { noteLoadFault('the process state could not be read'); return false }
  }
  const predecessor = readPredecessor() ?? null
  const isSuperseded = await transactProcess(port, held => {
    const claimed = claimLoad(held, loadId, predecessor)
    return { state: claimed ?? held, result: !claimed }
  }).catch((error: unknown) => { noteLoadFault(formatError(error)); return null })
  if (isSuperseded === null) return false
  // why: a load's memory is its own; a claim of a load a reload replaced since never marks the load that runs now.
  if (readLoadId() !== loadId) return false
  // why: a load recorded after the one this load replaced may be newer, so this load submits, settles and releases nothing for good, and its pane says so.
  sessionMemory.isLoadSuperseded = isSuperseded
  if (isSuperseded) clearFault('load-id')
  else noteLoadRecorded(loadId)
  return true
}

/**
 * Holds why recording this load failed, shown until the tick records it; no prompt is submitted meanwhile.
 * @param cause - Why.
 */
function noteLoadFault(cause: string): void {
  raiseFault('load-id', { row: 'Process', text: describeLoadFailure(cause), cause })
}

/**
 * Reads whether kept starts wait and the gate would let one go now, as the tick and the turn end decide whether to deliver.
 * @param state - The process state, null when unknown.
 * @param now - The time, in epoch ms.
 * @returns Whether a delivery should be scheduled.
 */
export const isStartDue = (state: ProcessState | null, now: number): boolean => !!state && readKeptStarts(state).length > 0 && judgeNow(state, now).kind === 'idle'
