import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import type { EnginePort } from '../core/engine-port'
import { takeMail } from '../core/mail-delivery'
import { sessionMemory } from '../core/session-memory'
import { doorbellText, emptyDoorbell } from '../domain/mail'

/**
 * Delivers all unread mail with a submitted prompt, in one block of context, acknowledging it as it is injected; blocks the
 * doorbell's own prompt when an earlier injection point already delivered the mail it rang for; notes a doorbell turn that only delivered informs.
 * @param port - The engine calls.
 * @param event - The classic prompt submit, which fires for the mod's own prompts too.
 * @param next - The rest of the chain.
 * @returns What the chain answers, with the mail block, or the doorbell prompt's block.
 */
export async function handleMailPromptSubmit(port: EnginePort, event: Frozen<Args<'classic.UserPromptSubmit'>>,
  next: Next<'classic.UserPromptSubmit'>): Promise<EventResult<'classic.UserPromptSubmit'>> {
  const result = await next(event)
  const isDoorbell = event.prompt === doorbellText
  // why: mail arriving from here on is not in this prompt's block, so it needs a ring of its own.
  if (isDoorbell) sessionMemory.doorbellRungAt = null
  const { block: mail, kinds } = await bestEffort(port, 'mail delivery', () => takeMail(port), { block: null, kinds: [] })
  // why: an inform asks for nothing, so a turn the doorbell started for informs alone owes the coordinator no message.
  sessionMemory.isInformOnlyTurn = isDoorbell && kinds.length > 0 && kinds.every(kind => kind === 'inform')
  if (mail) return { ...result, additionalContext: [...result.additionalContext ?? [], mail] }
  return isDoorbell ? { ...result, block: emptyDoorbell } : result
}
