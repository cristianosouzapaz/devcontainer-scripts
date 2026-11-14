import type { Attempt, Notice, ProcessState } from '../../types'
import { describeByHand, describeHolds, describeStartFailure } from '../domain/instruction'
import type { HoldNote, StartFault } from '../domain/instruction'
import { shortId } from './attempts'
import type { HoldReason } from './gate'
import { readKeptStarts, readLoadId } from './process-state'
import { sessionMemory } from './session-memory'

/** The most start failures the pane keeps, newest last, so failures never shown resolved cannot grow the notes without bound. */
const startFaultLimit = 8

/** How a turn change the hold names reads. */
const turnChangeNames = { start: 'start', complete: 'end', prompt: 'entering prompt' } as const

/**
 * Notes why a start was not delivered, keeping only the newest few; past the bound the oldest a paint already showed go first, and a
 * keep failure no render showed yet goes only when nothing else can, as the command's reply already named it.
 * @param id - The start.
 * @param fault - Why.
 */
export function noteStartFault(id: string, fault: StartFault): void {
  sessionMemory.startFaults.delete(id)
  sessionMemory.startFaults.set(id, fault)
  while (sessionMemory.startFaults.size > startFaultLimit) {
    const entries = [...sessionMemory.startFaults]
    const oldest = (entries.find(([, each]) => each.isShown !== false) ?? entries[0])?.[0]
    if (oldest === undefined) return
    sessionMemory.startFaults.delete(oldest)
  }
}

/**
 * Forgets the failures to keep a start that a render of the Flow view showed once a start is kept or delivered again, which shows the keeping works; one
 * no render showed yet stays until one does.
 */
export function clearKeepFaults(): void {
  for (const [id, fault] of sessionMemory.startFaults) if (fault.stage === 'keep' && fault.isShown !== false) sessionMemory.startFaults.delete(id)
}

/**
 * Marks the notices and start failures a completed render of the Flow view drew: the tick then forgets those notices, and a keep failure
 * may be cleared by a later success.
 * @param ids - The notices and failures the render drew.
 */
export function markShown(ids: readonly string[]): void {
  for (const id of ids) {
    sessionMemory.shownNotices.add(id)
    const fault = sessionMemory.startFaults.get(id)
    if (fault?.isShown === false) sessionMemory.startFaults.set(id, { ...fault, isShown: true })
  }
}

/**
 * Forgets the composition and drop notes of starts no longer kept, as one another load delivered or the user released, so the pane shows
 * only failures that still hold.
 * @param state - The process state.
 */
export function pruneStartFaults(state: ProcessState): void {
  const kept = new Set(readKeptStarts(state).map(start => start.id))
  for (const [id, fault] of sessionMemory.startFaults) if (fault.stage !== 'keep' && fault.stage !== 'keep-unknown' && !kept.has(id)) sessionMemory.startFaults.delete(id)
}

/**
 * Settles the keeps whose write answered with a failure, from a state a later dispatch read: one the state keeps waits, and its note goes;
 * one it does not keep, with no attempt or notice of it, was not kept, which its note then says, with how to start it by hand.
 * @param state - The process state, read after the keep's own dispatch.
 */
export function resolveUnknownKeeps(state: ProcessState): void {
  const kept = new Set(readKeptStarts(state).map(start => start.id))
  for (const [id, fault] of sessionMemory.startFaults) {
    if (fault.stage !== 'keep-unknown') continue
    const isTraced = (state.attempts ?? []).some(attempt => attempt.subject === id) || (state.notices ?? []).some(notice => notice.subject === id)
    if (kept.has(id) || isTraced) sessionMemory.startFaults.delete(id)
    else sessionMemory.startFaults.set(id, { ...fault, stage: 'keep', cause: `its keep did not land: ${fault.cause}`, isShown: false })
  }
}

/**
 * Forgets the failure of a start that was delivered, composed, or dropped as having nothing to start.
 * @param id - The start.
 */
export function forgetStartFault(id: string): void {
  sessionMemory.startFaults.delete(id)
}

/**
 * Words the start notes the pane and `/flow status` show: this load's failures to keep a start, the drops the engine answered and a
 * composition failure of the start first in line, which holds only the starts behind it; then the notices the process state holds, each
 * an obligation the mod ended, until a render of the Flow view showed it.
 * @param state - The process state, null when unknown.
 * @returns The rows' words, oldest first.
 */
export function describeStartNotices(state: ProcessState | null = null): string[] {
  return [...[...sessionMemory.startFaults.values()].map(fault => describeStartFailure(fault)), ...(state?.notices ?? []).map(describeNotice)]
}

/**
 * Words a notice of an obligation the mod ended.
 * @param notice - The notice.
 * @returns The words.
 */
function describeNotice(notice: Notice): string {
  const name = notice.label || 'a prompt of the mod'
  if (notice.id.startsWith('notice:overflow')) return `${name} [${shortId(notice.id)}]: ${notice.cause}; check: the transcript shows which entered; ${describeByHand(notice.route, notice.kind)}`
  if (notice.outcome === 'entered') return `${name} [${shortId(notice.id)}]: it entered, after the mod had stopped waiting for its answer, so nothing is left to do`
  if (notice.outcome === 'dropped') return `${name} [${shortId(notice.id)}]: the engine dropped it, so it did not enter, after the mod had stopped waiting for its answer; the mod no longer delivers it: ${describeByHand(notice.route, notice.kind)}`
  const isUnstarted = notice.cause.startsWith('it was not started')
  const what = isUnstarted ? `${name} [${shortId(notice.id)}]: ${notice.cause}` : `${name} [${shortId(notice.id)}]: whether it entered is unknown, and the mod no longer delivers it: ${notice.cause}`
  return isUnstarted ? what : `${what}; check: the transcript shows whether it entered; if it did not, ${describeByHand(notice.route, notice.kind)}`
}

/**
 * Words what an attempt holds, how to check it and how to resolve it.
 * @param attempt - The attempt.
 * @returns The note.
 */
function describeAttemptHold(attempt: Attempt): HoldNote {
  const id = shortId(attempt.id)
  const name = attempt.label || 'a prompt of the mod'
  const unwritten = sessionMemory.unwrittenReceipts.get(attempt.id)
  const answer = unwritten?.kind === 'entered' ? 'entered' : unwritten?.kind === 'dropped' || unwritten?.kind === 'unknown' ? unwritten.cause : 'answered'
  // why: a pending attempt is a claim written before its submit, so whether the engine was called is not known; who claimed it is its owner, never its status.
  const by = attempt.owner === readLoadId() ? 'this load of the mod' : attempt.owner ? 'an earlier load of the mod' : 'an earlier version of the mod'
  const what = unwritten ? `${name} [${id}]: its submit answered (${answer}), but recording that answer in the process state failed; its submit records it again a tick later, and nothing is submitted until it is`
    : attempt.status.kind === 'pending' ? `${name} [${id}] was claimed by ${by}; whether its submit was made, and whether it entered, is not known yet, and its answer is recorded here when it arrives`
      : `${name} [${id}]: ${attempt.status.kind === 'unknown' ? attempt.status.cause : 'its submit answered'}; it is not submitted again`
  // why: a submit with no answer may still enter after the transcript was read, so the check names that before a start by hand.
  const check = `the transcript shows whether it entered; a submit that has not answered may still enter later${attempt.subject ? '' : '; this counts several starts, each checked the same way'}`
  return { what, check, byHand: `type any prompt, which hands it to you and ends this hold, or reload the plugins; then, if it did not enter, ${describeByHand(attempt.route, attempt.kind)}` }
}

/**
 * Words one obligation of the hold row.
 * @param reason - The obligation.
 * @returns The note.
 */
function describeHoldReason(reason: HoldReason): HoldNote {
  const restart = 'if it never resolves, restart the session (/exit, then claude --resume): a new process starts its state over, losing the start prompts still waiting, so start the current step by hand after it'
  if (reason.kind === 'unstarted') return { what: 'this load of the mod has not adopted the process state yet: its session start is still reading it, or that read failed', check: 'the Process row names a read that failed; the tick reads it again', byHand: restart }
  if (reason.kind === 'unreadable') return { what: 'the process state cannot be read, or holds a value this mod does not know', check: 'the Process row names why', byHand: restart }
  if (reason.kind === 'legacy') {
    const what = reason.missing === 'own identity'
      ? 'this process could not read its own identity (its /proc stat, boot id or pid namespace), so it cannot tell whether the turn an earlier version of the mod recorded is its own'
      : `the ${reason.missing} an earlier version of the mod left could not be read, so whether a turn runs is unknown`
    return { what, check: 'the tick reads it again until it can', byHand: 'type any prompt: the turn it starts settles whether a turn runs' }
  }
  if (reason.kind === 'activity') {
    return { what: 'this load of the mod started by a reload, and the load it replaced may have heard a turn start or end that it never recorded, so whether a turn runs is not known until this load hears a turn start, a turn end or a prompt itself',
      check: 'the transcript shows whether a turn runs', byHand: 'type any prompt: its entry ends this hold, and the starts kept wait for its turn to end' }
  }
  if (reason.kind === 'turn-change' && reason.change.kind === 'prompt') {
    return { what: 'a prompt entered and its turn has not started yet: it may have been withdrawn, or blocked by a hook after this mod\'s, and the mod waits for that turn',
      check: 'the transcript shows whether a turn runs', byHand: 'type any prompt: its entry ends this hold' }
  }
  if (reason.kind === 'turn-change') {
    const change = reason.change
    return { what: `the ${turnChangeNames[change.kind]} of turn ${change.turnId ?? ''} was not written to the process state (${change.failure?.cause ?? 'not written yet'})`.replace('turn  ', 'a turn '),
      check: 'the tick writes it again, and the Process row names a write that keeps failing', byHand: restart }
  }
  return describeAttemptHold(reason.attempt)
}

/**
 * Words the hold row: every obligation holding the session; null when nothing holds.
 * @param reasons - What holds the session.
 * @returns The row's words, or null.
 */
export function describeHoldRow(reasons: readonly HoldReason[]): string | null {
  return reasons.length ? describeHolds(reasons.map(describeHoldReason)) : null
}
