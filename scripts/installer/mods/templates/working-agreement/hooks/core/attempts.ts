import type { Attempt, AttemptRoute, AttemptStatus, Notice, PendingStart, ProcessState, Receipt } from '../../types'
import { formatError } from '../lib/result'
import type { EnginePort } from './engine-port'
import { judge, readEvidence } from './gate'
import type { Gate } from './gate'
import { readKeptStarts, readLoadId, readProcessState, transitOwned, withKeptStarts } from './process-state'
import type { OwnedRefusal } from './process-state'
import { submitWithinTick } from './prompt-submit'
import type { SubmitOutcome } from './prompt-submit'
import { sessionMemory } from './session-memory'
import { tickMs } from './timing'

/**
 * One of the mod's own prompts to submit: the load submitting it, named by the caller before its first await, so a delivery that resumes
 * after a reload still names the load that began it; its route, what it submits, how to name it, its text, and whether the state still
 * wants it.
 */
export interface AttemptRequest {
  owner: string; route: AttemptRoute; subject: string; kind: PendingStart['kind']; label: string; text: string; isWanted: (state: ProcessState) => boolean
}

/** How an attempt ended in this load: its claim refused, with why; or submitted, with what is known of it once its tick passed. */
export type AttemptEnd = { kind: 'refused'; why: OwnedRefusal | 'unknown' } | { kind: 'submitted'; status: AttemptStatus }

/** An attempt the owner's settlement took out of the state, with what was established of it. */
export interface Settled { attempt: Attempt; status: Extract<AttemptStatus, { kind: 'entered' | 'dropped' }> }

/** The most notices the state keeps. */
const noticeLimit = 8

/** The most receipts the process state keeps for the recorded load to take; past it, a receipt becomes a notice at once. */
const receiptLimit = 16

/** How many digests of entered attempts this load remembers, enough for the prompts whose entry may still be heard. */
const settledDigestLimit = 16

/** The id every overflow notice's id starts with; each fold names a new one, so a render that drew an earlier count acknowledges only that. */
const overflowPrefix = 'notice:overflow'

/**
 * Claims the idle window for one of the mod's own prompts and submits it, the one path every start, wake and doorbell takes: in one
 * compare-and-set, as the load the state records, the gate is judged idle on the current state and the attempt is written, pending,
 * with the claim, before the engine is called; so two claims, of this load or another, never both win, and nothing is submitted that
 * no record names. Its outcome is kept on the attempt as a receipt: what the submit answers within its tick, unknown past it, and its
 * late answer whenever it comes. An attempt is never submitted twice.
 * @param port - The engine calls.
 * @param request - What to submit.
 * @returns How it ended in this load.
 */
export async function submitAttempt(port: EnginePort, request: AttemptRequest): Promise<AttemptEnd> {
  const owner = request.owner
  // why: a turn change this load hears after its claim began means the session may no longer be idle, so the claim is withdrawn rather than submitted; the engine offers no submit-if-idle, so this narrows the interval it cannot close.
  const turnSeq = sessionMemory.turnSeq
  const at = await port.now()
  const id = crypto.randomUUID()
  const claim = await transitOwned<Attempt>(port, owner, state => {
    if (!request.isWanted(state)) return { kind: 'gone' }
    const gate = judge(state, readEvidence(at))
    if (gate.kind !== 'idle') return { kind: gate.kind }
    const attempt: Attempt = { id, owner, route: request.route, subject: request.subject, kind: request.kind, label: request.label, at, epoch: state.epoch, status: { kind: 'pending' },
      digest: digestPrompt(request.text) }
    return { kind: 'won', value: attempt, state: { ...state, attempts: [...state.attempts ?? [], attempt], prompt: { enteredAt: at, isInformOnly: false, isEmptyDoorbell: false, isClaim: true } } }
  })
  if (claim.kind === 'unknown') {
    // why: a claim whose write answered with a failure may have landed, though nothing was submitted, so it is withdrawn, or it would hold the session for good.
    sessionMemory.unsubmittedClaims.add(id)
    await withdrawClaims(port, owner)
  }
  if (claim.kind !== 'won') return { kind: 'refused', why: claim.kind }
  if (sessionMemory.turnSeq !== turnSeq) {
    sessionMemory.unsubmittedClaims.add(id)
    await withdrawClaims(port, owner)
    return { kind: 'refused', why: 'busy' }
  }
  sessionMemory.liveAttempts.add(id)
  const submitted = await submitWithinTick(port, request.text).finally(() => { sessionMemory.liveAttempts.delete(id) })
  const status: AttemptStatus = submitted.outcome.kind === 'unsettled'
    ? { kind: 'unknown', cause: `its submit got no answer from the engine within ${tickMs / 1000} s, so whether it entered is unknown` } : toStatus(submitted.outcome)
  if (status.kind !== 'entered') port.logDebug(`working-agreement: ${request.route} prompt failed: ${status.kind === 'pending' ? 'pending' : status.cause}`)
  const meta = { subject: request.subject, route: request.route, kind: request.kind, label: request.label }
  await retainReceipt(port, id, status, meta)
  if (submitted.outcome.kind === 'unsettled') void submitted.late.then(async late => { await retainReceipt(port, id, toStatus(late), meta); await settleAttempts(port, owner) })
  await settleAttempts(port, owner)
  return { kind: 'submitted', status }
}

/**
 * Withdraws, as the load the state records, the claims this load wrote whose write answered with a failure, so it never submitted them:
 * each leaves the state with the idle window it took; one whose write did not land is simply forgotten. A withdrawal whose write fails is
 * tried again at the tick.
 * @param port - The engine calls.
 * @param owner - The load, read before the caller's first await.
 * @returns Once tried.
 */
export async function withdrawClaims(port: EnginePort, owner: string): Promise<void> {
  const ids = new Set(sessionMemory.unsubmittedClaims)
  if (!ids.size) return
  const withdrawn = await transitOwned(port, owner, state => {
    const claims = (state.attempts ?? []).filter(attempt => ids.has(attempt.id) && attempt.status.kind === 'pending')
    const isReleased = !state.turn && !!state.prompt?.isClaim && claims.some(attempt => attempt.at === state.prompt?.enteredAt)
    return { kind: 'won', value: null, state: claims.length ? { ...state, attempts: (state.attempts ?? []).filter(attempt => !claims.includes(attempt)), ...isReleased ? { prompt: null } : {} } : state }
  })
  if (withdrawn.kind === 'won' || withdrawn.kind === 'not-owner') for (const id of ids) sessionMemory.unsubmittedClaims.delete(id)
}

/**
 * Maps a submit's answer to what it establishes: a confirmed submit entered, an explicit drop never did, and any other failure may have
 * followed its entry, so it is unknown.
 * @param outcome - The answer.
 * @returns What it establishes.
 */
function toStatus(outcome: SubmitOutcome): AttemptStatus {
  if (outcome.kind === 'submitted') return { kind: 'entered' }
  if (outcome.kind === 'dropped') return { kind: 'dropped', cause: `the engine dropped it (${formatError(outcome.error)}), so it did not enter` }
  return { kind: 'unknown', cause: `its submit failed (${formatError(outcome.error)}), so whether it entered is unknown: the engine may or may not have received it` }
}

/**
 * Combines what is known of an attempt with a receipt: an established outcome never changes, a pending one takes any receipt, and an
 * unknown one takes only an established one.
 * @param current - What the attempt holds.
 * @param receipt - The receipt.
 * @returns What it holds after.
 */
function mergeStatus(current: AttemptStatus, receipt: AttemptStatus): AttemptStatus {
  if (current.kind === 'entered' || current.kind === 'dropped') return current
  if (current.kind === 'unknown') return receipt.kind === 'entered' || receipt.kind === 'dropped' ? receipt : current
  return receipt.kind === 'pending' ? current : receipt
}

/**
 * Records a receipt on an attempt by its id, the one change any load may make to an attempt, a replaced one included: it touches no queue,
 * claim or other attempt, so the load the state records settles it. An established outcome whose attempt already ended goes to the
 * receipts of the process state, apart from any notice, which the load the state records turns into a notice of that outcome, a new
 * revision of the attempt's notice when one is still kept; past their bound, a receipt becomes that notice at once. A write that fails is
 * retried by this continuation at each tick's interval until it lands or the attempt is gone; the attempt stays unresolved meanwhile, so it
 * holds the session. A wait the host cancelled, as a reload cancels the replaced load's, never discards an established outcome: the write
 * is tried again at once, and the retries go on while a wait can still be made; only a write that keeps failing after that is left to the
 * load that replaced this one, which releases the attempt a tick after its submit, with a notice that its outcome is unknown.
 * @param port - The engine calls.
 * @param id - The attempt.
 * @param receipt - What its submit established.
 * @param meta - What the attempt was for, which a receipt kept apart from it names.
 * @returns Once written, or once the attempt is gone, or once no wait for a retry can be made.
 */
async function retainReceipt(port: EnginePort, id: string, receipt: AttemptStatus, meta?: Omit<Receipt, 'id' | 'outcome'>): Promise<void> {
  // why: what this load knows of the submit counts from the answer on, while its record is still being written.
  if (receipt.kind !== 'pending') sessionMemory.answers.set(id, receipt)
  if (receipt.kind === 'unknown') sessionMemory.unknownAttempts = [...sessionMemory.unknownAttempts.filter(each => each !== id), id].slice(-settledDigestLimit)
  const isEstablished = receipt.kind === 'entered' || receipt.kind === 'dropped'
  const retry = { isCancelled: false }
  for (;;) {
    const written = await transitOwned(port, null, state => {
      const attempt = state.attempts?.find(each => each.id === id)
      const notice = state.notices?.find(each => each.id === id)
      if (!attempt && isEstablished && (meta || notice) && notice?.outcome !== receipt.kind && !state.receipts?.some(each => each.id === id)) {
        const late: Receipt = { id, subject: meta?.subject ?? notice?.subject ?? '', route: meta?.route ?? notice?.route ?? 'start', kind: meta?.kind ?? notice?.kind ?? 'step',
          label: meta?.label ?? notice?.label ?? '', outcome: receipt.kind as 'entered' | 'dropped' }
        const receipts = [...state.receipts ?? [], late]
        // why: past their bound, the oldest receipts become notices at once, so none is ever dropped unsaid.
        const spilled = receipts.slice(0, Math.max(0, receipts.length - receiptLimit))
        return { kind: 'won', value: true, state: { ...applyReceipts(state, spilled), receipts: receipts.slice(spilled.length) } }
      }
      const status = attempt ? mergeStatus(attempt.status, receipt) : null
      return { kind: 'won', value: true, state: !attempt || status === attempt.status ? state
        : { ...state, attempts: (state.attempts ?? []).map(each => each.id === id ? { ...each, status: status ?? each.status } : each) } }
    })
    if (written.kind === 'won') {
      sessionMemory.unwrittenReceipts.delete(id)
      sessionMemory.answers.delete(id)
      return
    }
    port.logDebug(`working-agreement: a submit's receipt (${receipt.kind}) was not written (${written.kind === 'unknown' ? written.error : written.kind}); it is written again a tick later`)
    sessionMemory.unwrittenReceipts.set(id, receipt)
    const isSlept = await port.clock.sleep(tickMs, new AbortController().signal).then(() => true, () => false)
    // why: a cancelled wait is the host replacing this load, not the answer going away, so the receipt is written again at once; a second cancelled wait means no wait can be made any more.
    if (!isSlept && retry.isCancelled) return
    if (!isSlept) retry.isCancelled = true
  }
}

/**
 * Settles the attempts whose outcome is established, as the load the state records only: an entered start leaves the keeping and an
 * entered wake its wait, both with their attempt; a dropped one gives its claim back and leaves its start or wake in place, first in
 * line, as nothing passed it while it was unresolved. A pending or unknown attempt is left as it is.
 * @param state - The process state.
 * @returns The state settled, and what it settled.
 */
function settleState(state: ProcessState): { state: ProcessState; settled: Settled[] } {
  const settled = (state.attempts ?? []).flatMap((attempt): Settled[] => attempt.status.kind === 'entered' || attempt.status.kind === 'dropped' ? [{ attempt, status: attempt.status }] : [])
  if (!settled.length) return { state, settled }
  const entered = settled.filter(each => each.status.kind === 'entered').map(each => each.attempt)
  const dropped = settled.filter(each => each.status.kind === 'dropped').map(each => each.attempt)
  const starts = readKeptStarts(state).filter(kept => !entered.some(attempt => attempt.route === 'start' && attempt.subject === kept.id))
  const isWakeEntered = entered.some(attempt => attempt.route === 'wake' && attempt.subject === state.pendingWake)
  const isReleased = !state.turn && !!state.prompt?.isClaim && dropped.some(attempt => attempt.at === state.prompt?.enteredAt)
  return { settled, state: { ...withKeptStarts(state, starts), attempts: (state.attempts ?? []).filter(attempt => !settled.some(each => each.attempt.id === attempt.id)),
    ...isWakeEntered ? { pendingWake: null } : {}, ...isReleased ? { prompt: null } : {} } }
}

/**
 * Settles, as the given load, the attempts whose outcome is established; a load the state no longer records settles nothing.
 * @param port - The engine calls.
 * @param owner - The load settling them, read before the caller's first await.
 * @returns What was settled, empty when nothing was or the write failed, which the tick tries again.
 */
export async function settleAttempts(port: EnginePort, owner = readLoadId()): Promise<Settled[]> {
  const settled = await transitOwned(port, owner, state => {
    const next = settleState(state)
    return { kind: 'won', state: next.state, value: next.settled }
  })
  if (settled.kind !== 'won') return []
  // why: the engine may answer a submit before its prompt's entry is heard, so a prompt that carries an attempt settled already is still the mod's own, never the user's.
  for (const each of settled.value) if (each.status.kind === 'entered' && each.attempt.digest) sessionMemory.settledDigests = [...sessionMemory.settledDigests, each.attempt.digest].slice(-settledDigestLimit)
  return settled.value
}

/**
 * Tells whether an attempt is unresolved: its outcome unknown, or still pending with no submit of this load awaiting it.
 * @param attempt - The attempt.
 * @returns Whether it is.
 */
const isUnresolved = (attempt: Attempt): boolean => attempt.status.kind === 'unknown' || attempt.status.kind === 'pending' && !sessionMemory.liveAttempts.has(attempt.id)

/**
 * Ends unresolved attempts, as the load the state records, by evidence that resolves them for the mod: each leaves the state with the
 * start or wake it submitted, so the mod never delivers it itself, and a notice says its outcome is unknown, how to check it and how to
 * start it by hand, until a render of the Flow view showed it.
 * @param port - The engine calls.
 * @param owner - The load releasing them, read before the caller's first await.
 * @param pick - Which unresolved attempts to end, on the current state.
 * @param why - Why they end, as the notice says it.
 * @returns The attempts ended, empty when none were, or null when the write failed or this load does not hold the state.
 */
async function releaseAttempts(port: EnginePort, owner: string, pick: (attempt: Attempt) => boolean, why: string): Promise<Attempt[] | null> {
  const released = await transitOwned<Attempt[]>(port, owner, state => {
    const ended = (state.attempts ?? []).filter(attempt => isUnresolved(attempt) && pick(attempt))
    if (!ended.length) return { kind: 'gone' }
    const subjects = new Set(ended.filter(attempt => attempt.route === 'start').map(attempt => attempt.subject))
    const isWake = ended.some(attempt => attempt.route === 'wake' && attempt.subject === state.pendingWake)
    const notices: Notice[] = ended.map(attempt => ({ id: attempt.id, subject: attempt.subject, route: attempt.route, kind: attempt.kind, label: attempt.label, cause: why }))
    return { kind: 'won', value: ended, state: { ...withKeptStarts(state, readKeptStarts(state).filter(kept => !subjects.has(kept.id))),
      attempts: (state.attempts ?? []).filter(attempt => !ended.includes(attempt)), ...isWake ? { pendingWake: null } : {}, notices: keepNotices([...state.notices ?? [], ...notices]) } }
  })
  if (released.kind === 'won') sessionMemory.endedUnknown = [...sessionMemory.endedUnknown, ...released.value.filter(attempt => attempt.digest)].slice(-settledDigestLimit)
  return released.kind === 'won' ? released.value : released.kind === 'gone' ? [] : null
}

/**
 * Keeps the newest notices, folding the oldest past the bound into one that counts them and how many of them entered or were dropped,
 * so notices no render shows cannot grow the state without bound, none ends unsaid, and no established outcome is lost in the fold. Every
 * notice it returns new carries a revision of its own.
 * @param notices - The notices, oldest first.
 * @returns The notices kept, the fold first.
 */
export function keepNotices(notices: readonly Notice[]): Notice[] {
  const revised = notices.map(notice => notice.rev ? notice : { ...notice, rev: crypto.randomUUID() })
  if (revised.length <= noticeLimit) return revised
  const folded = revised.slice(0, revised.length - noticeLimit + 1)
  const isOverflow = (notice: Notice): boolean => notice.id.startsWith(overflowPrefix)
  const count = folded.reduce((sum, notice) => sum + (isOverflow(notice) ? Number(/^(\d+)/.exec(notice.label)?.[1] ?? 1) : 1), 0)
  const entered = folded.reduce((sum, notice) => sum + (notice.established?.entered ?? 0) + (notice.outcome === 'entered' ? 1 : 0), 0)
  const dropped = folded.reduce((sum, notice) => sum + (notice.established?.dropped ?? 0) + (notice.outcome === 'dropped' ? 1 : 0), 0)
  const unknown = 'ended without the mod knowing whether it entered, or with nothing to start, past the most notices the session keeps'
  const overflow: Notice = { id: `${overflowPrefix}:${crypto.randomUUID()}`, subject: '', route: 'start', kind: 'step', label: `${count} more prompts of the mod`,
    cause: entered || dropped ? `${entered} of them entered and ${dropped} were dropped, each after the mod had stopped waiting for its answer; each other one ${unknown}` : `each ${unknown}`,
    ...entered || dropped ? { established: { entered, dropped } } : {}, rev: crypto.randomUUID() }
  return [overflow, ...revised.slice(revised.length - noticeLimit + 1)]
}

/**
 * Turns receipts into notices of their outcome: a notice of the same attempt still kept takes the outcome as a new revision, and one with
 * none kept is added, so a render shows the outcome before it is acknowledged.
 * @param state - The process state.
 * @param receipts - The receipts.
 * @returns The state with them as notices.
 */
function applyReceipts(state: ProcessState, receipts: readonly Receipt[]): ProcessState {
  if (!receipts.length) return state
  const updated = (state.notices ?? []).map(notice => {
    const receipt = receipts.find(each => each.id === notice.id)
    return receipt ? { ...notice, outcome: receipt.outcome, rev: crypto.randomUUID() } : notice
  })
  const added = receipts.filter(receipt => !updated.some(notice => notice.id === receipt.id)).map((receipt): Notice => ({ id: receipt.id, subject: receipt.subject, route: receipt.route,
    kind: receipt.kind, label: receipt.label, cause: 'its answer came after the mod had stopped waiting for it', outcome: receipt.outcome }))
  return { ...state, notices: keepNotices([...updated, ...added]) }
}

/**
 * Turns the receipts other loads, or this one, left into notices, as the load the state records, in one write that takes them out.
 * @param port - The engine calls.
 * @param owner - The load the state records, read before the caller's first await.
 * @returns Once done; a failed write leaves them for the next tick.
 */
export async function takeReceipts(port: EnginePort, owner: string): Promise<void> {
  await transitOwned(port, owner, state => state.receipts?.length
    ? { kind: 'won', value: null, state: { ...applyReceipts(state, state.receipts), receipts: undefined } } : { kind: 'gone' })
}

/**
 * Names a notice's content as a render draws it, so acknowledging it forgets that content alone and never a newer revision.
 * @param notice - The notice.
 * @returns Its id and revision.
 */
export const noticeKey = (notice: Notice): string => `${notice.id}@${notice.rev ?? ''}`

/**
 * Takes a prompt entering the session as evidence about the attempts, kept until it is applied, as the tick applies it again after a read
 * or a write that failed: a prompt that carries an unresolved attempt's prompt is that attempt entering, which any load records as its
 * receipt; any other prompt is the user's, who took over from the mod, and hands over what was unresolved when it entered.
 * @param port - The engine calls.
 * @param text - The prompt.
 * @param at - When it entered.
 * @param unknown - The attempts this load knew unknown when it entered, read before its handler's first await.
 * @returns Once applied, or kept for the tick.
 */
export async function noteEnteringPrompt(port: EnginePort, text: string, at: number, unknown: readonly string[]): Promise<void> {
  sessionMemory.enteringPrompt = { at, digest: digestPrompt(text), unknown: [...unknown] }
  await applyEnteringPrompt(port, readLoadId())
}

/**
 * Applies the last prompt that entered: its own attempt entering is recorded; otherwise, as the load the state records, every attempt that
 * was unresolved when it entered ends with a notice: one this load knew unknown then, and an earlier load's a tick after its submit; this
 * load's own submit still in flight then is not handed over, and its claim with no answer yet withdraws itself once it sees the turn
 * change the prompt made.
 * @param port - The engine calls.
 * @param owner - The load, read before the caller's first await.
 * @returns Once done; the prompt is forgotten once applied.
 */
export async function applyEnteringPrompt(port: EnginePort, owner: string): Promise<void> {
  const entering = sessionMemory.enteringPrompt
  if (!entering) return
  const state = await readProcessState(port)
  if (!state) return
  const attempts = state.attempts ?? []
  const own = attempts.filter(attempt => attempt.digest === entering.digest && (attempt.status.kind === 'pending' || attempt.status.kind === 'unknown'))
  for (const attempt of own) await retainReceipt(port, attempt.id, { kind: 'entered' })
  // why: a submit this load ended as unknown may still enter after it, which establishes its outcome for the notice that ended it.
  const late = own.length ? undefined : sessionMemory.endedUnknown.findLast(attempt => attempt.digest === entering.digest)
  if (late) {
    sessionMemory.endedUnknown = sessionMemory.endedUnknown.filter(attempt => attempt !== late)
    await retainReceipt(port, late.id, { kind: 'entered' }, { subject: late.subject, route: late.route, kind: late.kind, label: late.label })
  }
  const isUsers = !late && !attempts.some(attempt => attempt.digest === entering.digest) && !sessionMemory.settledDigests.includes(entering.digest)
  const ended = isUsers ? await releaseAttempts(port, owner, attempt => entering.unknown.includes(attempt.id) || attempt.owner !== owner && entering.at - attempt.at >= tickMs,
    'the user typed a prompt while whether it entered was unknown, which hands it to them') : []
  if (ended && sessionMemory.enteringPrompt === entering) sessionMemory.enteringPrompt = null
}

/**
 * Ends, as the load the state records, the unresolved attempts an earlier load of the mod made: a reload cancelled the waits that would
 * have recorded their answers, so after a tick from its submit, when it would have been unknown, each ends with a notice.
 * @param port - The engine calls.
 * @param owner - The load the state records, read before the caller's first await.
 * @returns Once done.
 */
export async function releaseEarlierAttempts(port: EnginePort, owner: string): Promise<void> {
  const now = await port.now()
  await releaseAttempts(port, owner, attempt => attempt.owner !== owner && (attempt.status.kind === 'unknown' || now - attempt.at >= tickMs),
    'it was submitted, or claimed, by an earlier load of the mod that a reload replaced, which no longer waits for its answer; if that answer still comes, this note shows it')
}

/**
 * Forgets the notices a completed render of the Flow view showed, as the load the state records.
 * @param port - The engine calls.
 * @param owner - The load the state records, read before the caller's first await.
 * @param ids - The notices the render showed.
 * @returns Once done.
 */
export async function dismissNotices(port: EnginePort, owner: string, ids: ReadonlySet<string>): Promise<void> {
  if (!ids.size) return
  const dismissed = await transitOwned(port, owner, state => (state.notices ?? []).some(notice => ids.has(noticeKey(notice)))
    ? { kind: 'won', value: null, state: { ...state, notices: (state.notices ?? []).filter(notice => !ids.has(noticeKey(notice))) } } : { kind: 'gone' })
  if (dismissed.kind === 'won' || dismissed.kind === 'gone') for (const id of ids) sessionMemory.shownNotices.delete(id)
}

/**
 * Digests a prompt, so an attempt names what it submits without holding the prompt's text.
 * @param text - The prompt.
 * @returns A 32-bit FNV-1a digest, in hex.
 */
export function digestPrompt(text: string): string {
  const hash = [...text].reduce((value, char) => Math.imul(value ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0, 2166136261)
  return hash.toString(16).padStart(8, '0')
}

/**
 * Names an attempt or a kept start as the hold row does, short enough to type.
 * @param id - The id.
 * @returns Its first eight characters.
 */
export const shortId = (id: string): string => id.slice(0, 8)

/**
 * Judges, on a state this load read, whether a submit could be claimed now, for callers that only decide whether to try.
 * @param state - The process state, null when unknown.
 * @param now - The time, in epoch ms.
 * @returns The judgment.
 */
export const judgeNow = (state: ProcessState | null, now: number): Gate => judge(state, readEvidence(now))
