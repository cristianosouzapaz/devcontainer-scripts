import type { MailKind } from './mail'

/** The kinds an agent sends with `send`: a unit's question, blocked and done, and either side's answer. */
export const sendKinds = ['question', 'blocked', 'answer', 'done'] as const

/** The legal-reply map: the one reply each conversation-opening kind takes; any other reply is refused. */
const legalReplies: Partial<Record<MailKind, MailKind>> = { assign: 'done', blocked: 'answer', question: 'answer', cancel: 'done', step: 'done' }

/**
 * Tells whether a kind is a reply, which answers a message, rather than one that opens a conversation.
 * @param kind - The kind.
 * @returns Whether it is answer or done.
 */
export const isReplyKind = (kind: MailKind): boolean => kind === 'answer' || kind === 'done'

/**
 * Judges a reply against the legal-reply map.
 * @param repliedTo - The kind of the message replied to.
 * @param reply - The reply's kind.
 * @returns Why the reply is refused, or null when the map allows it.
 */
export function judgeReply(repliedTo: MailKind, reply: MailKind): string | null {
  const legal = legalReplies[repliedTo]
  if (!legal) return `${withArticle(repliedTo)} takes no reply`
  return legal === reply ? null : `${withArticle(repliedTo)} is replied to only with ${legal}, never with ${reply}`
}

/**
 * Names a kind with its indefinite article.
 * @param kind - The kind.
 * @returns The kind after a or an.
 */
export const withArticle = (kind: MailKind): string => `${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind}`

/**
 * Derives a reply's id from the message it answers and its sender, so one sender replies to one message once.
 * @param inReplyTo - The id answered.
 * @param from - The sender's address.
 * @returns The id.
 */
export const deriveReplyId = (inReplyTo: string, from: string): string => `${inReplyTo}-re-${from}`
