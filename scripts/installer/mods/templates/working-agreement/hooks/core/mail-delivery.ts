import { composeMailBlock } from '../domain/mail'
import type { Envelope, MailKind, StepTerms } from '../domain/mail'
import { markForAgent } from '../domain/messages'
import { formatErrorLine } from '../lib/result'
import { applyStepMail, checkPendingMarks } from './delegated-step'
import type { PendingCheck } from './delegated-step'
import type { EnginePort } from './engine-port'
import { readClaimedSteps, takeEnvelopes } from './mailbox'
import { listOwedSteps } from './owed-done'
import { sessionMemory } from './session-memory'

/** One claimed step's try: what the model is shown with its terms, its kind of state, and the decision whose pending mark it wrote. */
interface StepTry { body: string; terms: StepTerms | null; marked: string | null; state: 'closed' | 'threw' }

// why: two injection points that meet one step, or two steps about one decision, never run it twice; the later one leaves it to the next point.
const inFlight = new Set<string>()
// why: a repeated note would block every Stop, deny or compaction again, so those see it once per message and kind, never keyed on an error text that changes.
const shownStates = new Map<string, string>()

/**
 * Tells whether a note is new to its reader and records it: always at a prompt, and at a blocking injection point only when its kind changed.
 * @param key - What the note is about, such as a step's id.
 * @param state - The note's kind of state, such as `threw`, never its error text.
 * @param isOnce - Whether the reader blocks, so a repeat is left out.
 * @returns Whether to show it.
 */
function isNewState(key: string, state: string, isOnce: boolean): boolean {
  const isNew = !isOnce || shownStates.get(key) !== state
  shownStates.set(key, state)
  return isNew
}

/**
 * Applies one claimed step, or says why it did not finish here; it stays claimed in cur/ and owed, so the next injection point tries it again.
 * @param port - The engine calls.
 * @param envelope - The step.
 * @returns What the model is shown in place of its body with its terms and kind of state, or null when another injection point is applying it.
 */
async function tryStep(port: EnginePort, envelope: Envelope): Promise<StepTry | null> {
  const keys = [`step:${envelope.id}`, `decision:${envelope.refs[0] ?? ''}`]
  if (keys.some(key => inFlight.has(key))) return null
  for (const key of keys) inFlight.add(key)
  try {
    return { ...await applyStepMail(port, envelope), state: 'closed' }
  } catch (error) {
    return { body: markForAgent(`Step ${envelope.id} did not finish at this point (${formatErrorLine(error)}): it stays read and claimed, and this session's mod `
      + 'tries it again at the next prompt, Stop or denied call; nothing to do.'), terms: null, marked: null, state: 'threw' }
  } finally {
    for (const key of keys) inFlight.delete(key)
  }
}

/**
 * Settles the pending marks at an injection point, a failure of which is named rather than thrown.
 * @param port - The engine calls.
 * @param skipped - The steps this injection point shows or replays itself.
 * @returns What the check found.
 */
async function settleMarks(port: EnginePort, skipped: ReadonlySet<string>): Promise<PendingCheck> {
  return checkPendingMarks(port, skipped).then(check => {
    sessionMemory.pendingNotes.delete('check')
    return check
  }, (error: unknown) => {
    const isNew = !sessionMemory.pendingNotes.has('check')
    sessionMemory.pendingNotes.set('check', 'failed')
    return { recovered: [], notes: isNew ? [markForAgent(`The mod could not check this session's pending step outcomes `
      + `(${formatErrorLine(error)}), so whether one waits to be shown again is unknown; it tries again at the next prompt, Stop or denied call; nothing to do.`)] : [] }
  })
}

/**
 * Takes and acknowledges all unread mail, then applies the steps this unit claimed and still owes a done, the ones just taken and any a
 * throw or a kill left before: the model is shown each step's outcome in place of its body, then its decision's Choice. A step is
 * exactly-once: it stays claimed until its done. An outcome shown with its Choice stays marked until a later injection point, so a process
 * that ends before its block is injected leaves it for the next process to show again. Any other message is at most once: a kill
 * between its claim and the block's injection loses it.
 * @param port - The engine calls.
 * @param isOnce - Whether a recovery or a failed read already shown in the same state is left out, as a blocking injection point needs.
 * @returns The block, or null when there was none, and the kinds of the messages this call acknowledged or recovered.
 */
export async function takeMail(port: EnginePort, isOnce = false): Promise<{ block: string | null; kinds: MailKind[] }> {
  const taken = await takeEnvelopes(port).catch((error: unknown) => formatErrorLine(error))
  // why: a step whose done is kept for a resend is closed by that resend, never recovered beside it.
  const claimed = await Promise.all([readClaimedSteps(port), listOwedSteps(port)]).then(([steps, owed]) => steps.filter(step => !owed.includes(step.id)),
    (error: unknown) => formatErrorLine(error))
  const unread = typeof taken === 'string' || typeof claimed === 'string'
    ? markForAgent(`The mod could not read this session's mail (${typeof taken === 'string' ? taken : claimed}), so whether mail waits is unknown; `
      + 'it tries again at the next prompt; to check now, list the new/ and cur/ directories under working-agreement/mail/ in `git rev-parse --git-common-dir`.')
    : null
  const fresh = typeof taken === 'string' ? [] : taken.envelopes
  const untaken = typeof taken === 'string' ? [] : taken.untaken
  const steps = typeof claimed === 'string' ? [] : claimed
  // why: only a unit's own mailbox, a number, takes steps; one reaching any other address is shown, never applied.
  const isClaimed = (envelope: Envelope): boolean => envelope.kind === 'step' && /^\d+$/.test(envelope.to)
  const recovered = steps.filter(step => !fresh.some(envelope => envelope.id === step.id))
  // why: a claimed step that could not be listed may still be replayed, so marks are left for an injection point that knows which steps it replays.
  const marks = typeof claimed === 'string' ? null : await settleMarks(port, new Set([...fresh, ...steps].map(envelope => envelope.id)))
  const shown: Envelope[] = []
  const terms = new Map<string, StepTerms>()
  const marked = new Map<string, string>()
  /**
   * Adds a step's terms to the block when their kind is new for that step, at prompts too, so a Choice or its note is shown once per state.
   * @param id - The step's id.
   * @param each - Its terms.
   */
  const showTerms = (id: string, each: StepTerms): void => {
    if (sessionMemory.shownTerms.get(id) === each.kind) return
    sessionMemory.shownTerms.set(id, each.kind)
    terms.set(id, each)
  }
  for (const { envelope, terms: each, url } of marks?.recovered ?? []) {
    marked.set(url, envelope.id)
    if (sessionMemory.shownTerms.get(envelope.id) === each.kind) continue
    shown.push(envelope)
    showTerms(envelope.id, each)
  }
  for (const envelope of [...fresh, ...recovered]) {
    if (!isClaimed(envelope)) {
      shown.push(envelope)
      continue
    }
    const tried = await tryStep(port, envelope)
    if (tried?.marked) marked.set(tried.marked, envelope.id)
    // why: the terms' kind is part of the state, so a Choice that becomes readable after a failed read reaches a blocking injection point too.
    if (!tried || !isNewState(`step:${envelope.id}`, `${tried.state}:${tried.terms?.kind ?? 'none'}`, isOnce)) continue
    shown.push({ ...envelope, body: tried.body, author: 'mod' })
    if (tried.terms) showTerms(envelope.id, tried.terms)
  }
  // why: the hook returns this block once this call ends, so the next injection point of this module clears the marks whose Choice it showed; any other is read again until it is shown.
  for (const [url, step] of marked) {
    const isShown = sessionMemory.shownTerms.get(step) === 'shown'
    if (isShown) sessionMemory.shownMarks.set(url, step)
    else sessionMemory.unshownMarks.set(url, step)
    if (isShown) sessionMemory.unshownMarks.delete(url)
  }
  const notes = [
    ...marks?.notes ?? [],
    ...untaken.filter(each => isNewState(`untaken:${each.id}`, 'untaken', isOnce)).map(each => markForAgent(`The mod could not take message ${each.id} `
      + `(${each.error}): its move out of ${each.path} failed, so the next prompt, Stop or denied call tries again; check that file.`)),
    ...unread !== null && isNewState('unread', 'unknown', isOnce) ? [unread] : [],
  ]
  if (unread === null) shownStates.delete('unread')
  const blocks = [...shown.length ? [composeMailBlock(shown, terms)] : [], ...notes]
  return { block: blocks.length ? blocks.join('\n\n') : null, kinds: shown.map(envelope => envelope.kind) }
}

/**
 * Takes and acknowledges all unread mail, for an injection point that adds its block after the rest of its chain answered.
 * @param port - The engine calls.
 * @returns The block of the messages this call acknowledged, or null when there were none.
 */
export async function takeMailBlock(port: EnginePort): Promise<string | null> {
  return (await takeMail(port, true)).block
}
