import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { noteEnteringPrompt } from '../core/attempts'
import { bestEffort } from '../core/best-effort'
import type { EnginePort } from '../core/engine-port'
import { takeMail } from '../core/mail-delivery'
import { abandonTurnChange, beginTurnChange, writeTurnTransition } from '../core/turn-evidence'
import { resendOwedDones } from '../core/owed-done'
import { sessionMemory } from '../core/session-memory'
import { doorbellText, emptyDoorbell } from '../domain/mail'
import { markForAgent } from '../domain/messages'

/**
 * Delivers all unread mail with a submitted prompt, in one block of context, acknowledging it as it is injected; marks the prompt as
 * entering until its turn starts; gives the doorbell's own prompt a context that asks for nothing when an earlier injection point already
 * delivered the mail it rang for; notes a doorbell turn that only delivered informs or found no mail. It first resends the dones this
 * session's mod owes, naming one that keeps failing.
 * @param port - The engine calls.
 * @param event - The classic prompt submit, which fires for the mod's own prompts too.
 * @param next - The rest of the chain.
 * @returns What the chain answers, with the mail block or the empty doorbell's context.
 */
export async function handleMailPromptSubmit(port: EnginePort, event: Frozen<Args<'classic.UserPromptSubmit'>>,
  next: Next<'classic.UserPromptSubmit'>): Promise<EventResult<'classic.UserPromptSubmit'>> {
  const turnChange = beginTurnChange('prompt', null, 0)
  // why: the prompt hands over only what this load knew unresolved as it entered, never a submit that turns unknown while the handler waits.
  const unknownAtEntry = [...sessionMemory.unknownAttempts]
  const result = await next(event)
  const isDoorbell = event.prompt === doorbellText
  // why: mail arriving from here on is not in this prompt's block, so it needs a ring of its own.
  if (isDoorbell) sessionMemory.doorbellRungAt = null
  const enteredAt = await port.now()
  const entering = { ...turnChange, at: enteredAt }
  sessionMemory.ownPromptAt = enteredAt
  // why: the turn starts only after every UserPromptSubmit hook, and a doorbell rung meanwhile would queue behind it.
  if (!result.block) {
    // why: an accepted prompt is a boundary this load heard itself, which ends a reload's uncertainty; a blocked one leaves it.
    sessionMemory.isActivityUnchecked = false
    sessionMemory.isBoundaryHeard = true
    await writeTurnTransition(port, entering, state => ({ ...state, prompt: { enteredAt, isInformOnly: false, isEmptyDoorbell: false } }))
  } else abandonTurnChange(turnChange)
  // why: the prompt is evidence about the mod's unresolved submits: its own prompt entering, or the user's, who takes over from the mod.
  if (!result.block) await bestEffort(port, 'attempt evidence', () => noteEnteringPrompt(port, event.prompt, enteredAt, unknownAtEntry), undefined)
  // why: only a prompt names an owed done that keeps failing: a Stop or deny that carried it would be blocked again by the same note forever.
  const owed = (await bestEffort(port, 'owed dones', () => resendOwedDones(port, true), [])).map(markForAgent)
  const { block: mail, kinds } = await bestEffort(port, 'mail delivery', () => takeMail(port), { block: null, kinds: [] })
  // why: an inform asks for nothing, so a turn the doorbell started for informs alone owes the coordinator no message.
  const isInformOnly = isDoorbell && kinds.length > 0 && kinds.every(kind => kind === 'inform')
  // why: a block shows in the error colour and a queued doorbell cannot be withdrawn, so an empty one enters as a turn that asks for nothing.
  const isEmptyDoorbell = isDoorbell && !mail
  if (!result.block && (isInformOnly || isEmptyDoorbell)) {
    await writeTurnTransition(port, entering, state => ({ ...state, prompt: { enteredAt, isInformOnly, isEmptyDoorbell } }))
  }
  const added = [...mail ? [mail] : isDoorbell ? [emptyDoorbell] : [], ...owed]
  return added.length ? { ...result, additionalContext: [...result.additionalContext ?? [], ...added] } : result
}
