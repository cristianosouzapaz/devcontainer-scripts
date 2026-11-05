import { findOption, formatOptions } from './mail'
import type { Envelope } from './mail'

/** The fewest options a question to the user offers, so the user always picks between declared choices. */
export const minimumOptions = 2
/** How the user answers a question in the inbox. */
export const answerUsage = 'Usage: /flow inbox answer <id> <letter|no> [words].'

/**
 * Builds the body of the user's answer from what they typed after the id: the option a declared letter names, or No, then their words
 * verbatim; a first word that is neither a declared letter nor `no` is a no, so the answer's meaning is decided by code, never by wording.
 * @param options - The question's options.
 * @param text - What the user typed after the id.
 * @returns The answer's body.
 */
export function composeUserAnswer(options: readonly string[], text: string): string {
  const first = text.split(/\s+/)[0] ?? ''
  const index = findOption(options, first)
  const choice = index >= 0 ? `Option ${first.toLowerCase()}: ${options[index]}` : first.toLowerCase() === 'no' ? 'No' : 'No (unrecognised answer)'
  return `${choice}\nUser's words: "${text}"`
}

/**
 * Names the hidden marker that tells a comment for a message apart, so a retry never posts it twice.
 * @param id - The message's id.
 * @returns The marker.
 */
export const commentMarker = (id: string): string => `<!-- mail:${id} -->`

/**
 * Writes the issue comment that records a question to the user.
 * @param question - The question as the user's mailbox holds it.
 * @param note - The coordinator's note when it forwarded a unit's question, else empty.
 * @returns The comment's body.
 */
export function composeQuestionComment(question: Envelope, note: string): string {
  return ['## Question for the user', '', question.body, '', ...formatOptions(question.options), '',
    `From \`${question.from}\` · message \`${question.id}\``, ...note ? [`Coordinator's note: ${note}`] : [],
    `Answer in a session of this repository with \`/flow inbox answer ${question.id} <letter|no> [words]\`.`, commentMarker(question.id)].join('\n')
}

/**
 * Writes the issue comment that records the user's answer.
 * @param answer - The answer as sent.
 * @returns The comment's body.
 */
export function composeAnswerComment(answer: Envelope): string {
  return ['## User answer', '', answer.body, '', `In reply to message \`${answer.in_reply_to}\` · sent to \`${answer.to}\``, commentMarker(answer.id)].join('\n')
}

/**
 * Words one message of the user's inbox.
 * @param envelope - The message.
 * @param isOpen - Whether it is a question still waiting for the user's answer.
 * @param note - The coordinator's note when it forwarded the question, else empty.
 * @returns The entry's lines.
 */
export function formatInboxEntry(envelope: Envelope, isOpen: boolean, note: string): string {
  const head = `${isOpen ? '●' : '○'} ${envelope.kind} about #${envelope.issue} from ${envelope.from} (${envelope.created_at} · id ${envelope.id})`
  return [head, ...note ? [`Coordinator's note: ${note}`] : [], envelope.body, ...formatOptions(envelope.options),
    ...envelope.refs.length ? [`refs: ${envelope.refs.join(' ')}`] : [], ...isOpen ? [`Answer: /flow inbox answer ${envelope.id} <letter|no> [words]`] : []].join('\n')
}
