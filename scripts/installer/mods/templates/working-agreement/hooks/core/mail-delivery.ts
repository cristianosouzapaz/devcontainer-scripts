import { composeMailBlock } from '../domain/mail'
import type { Envelope, MailKind } from '../domain/mail'
import { applyStepMail } from './delegated-step'
import type { EnginePort } from './engine-port'
import { takeEnvelopes } from './mailbox'

/**
 * Takes and acknowledges all unread mail; a step message a unit received is applied or refused by the mod first, and the model is
 * shown its outcome in place of its body.
 * @param port - The engine calls.
 * @returns The block, or null when there was none, and the kinds of the messages this call acknowledged.
 */
export async function takeMail(port: EnginePort): Promise<{ block: string | null; kinds: MailKind[] }> {
  const taken = await takeEnvelopes(port)
  const shown: Envelope[] = []
  for (const envelope of taken) {
    // why: only a unit's own mailbox, a number, takes steps; one reaching any other address is shown, never applied.
    shown.push(envelope.kind === 'step' && /^\d+$/.test(envelope.to) ? { ...envelope, body: await applyStepMail(port, envelope), author: 'mod' } : envelope)
  }
  return { block: shown.length ? composeMailBlock(shown) : null, kinds: shown.map(envelope => envelope.kind) }
}

/**
 * Takes and acknowledges all unread mail, for an injection point that adds its block after the rest of its chain answered.
 * @param port - The engine calls.
 * @returns The block of the messages this call acknowledged, or null when there were none.
 */
export async function takeMailBlock(port: EnginePort): Promise<string | null> {
  return (await takeMail(port)).block
}
