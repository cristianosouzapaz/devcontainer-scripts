import { coordinatorAddress, mailFileName, userAddress } from '../domain/mail'
import type { Envelope } from '../domain/mail'
import { deriveReplyId } from '../domain/mail-reply'
import { answerUsage, commentMarker, composeAnswerComment, composeQuestionComment, composeUserAnswer, formatInboxEntry, minimumOptions } from '../domain/user-inbox'
import { isNonEmptyString, isRecord } from '../lib/guards'
import { readMarkedComments } from '../lib/github'
import { readJson } from '../lib/json'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { readOwnScope, findLiveScope } from './delegation'
import type { EnginePort } from './engine-port'
import { commentIssue } from './issue-write'
import { findMessage, mailPath, markShown, readMailbox, redirectMail, sendMail } from './mailbox'
import { atomicCreate, atomicReplace, readCommonDir, recordsPath } from './record-store'
import { isFromRetiredSession, keepLateReply } from './retire'
import { withRecordLock } from './session-memory'

/** A unit's question the coordinator forwarded to the user: after it, only the user answers it. */
interface ForwardRecord { v: 1; id: string; coordinator: string; at: string; note: string }

/** An issue comment that records a question to the user or the user's answer, owed until it is posted. */
interface CommentRecord { v: 1; issue: number; id: string; body: string; isPosted: boolean; error: string }

/** The user's mailbox as the inbox and the pane read it. */
export interface InboxCounts { open: number; unrecorded: number }

/**
 * Reads the forward record of a message.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param id - The message's id.
 * @returns The record, or null when the message was never forwarded.
 */
export async function readForward(port: EnginePort, common: string, id: string): Promise<ForwardRecord | null> {
  const value: unknown = await readJson(port.files, recordsPath(common, 'forwards', `${id}.json`))
  return isRecord(value) && value.v === 1 && value.id === id && isNonEmptyString(value.coordinator) && typeof value.at === 'string' && typeof value.note === 'string'
    ? { v: 1, id, coordinator: value.coordinator, at: value.at, note: value.note } : null
}

/**
 * Forwards a unit's question from the coordinator's mailbox to the user's, unchanged but for its receiver, so the unit stays the asker
 * and the user's answer goes back to it; the forward is recorded, and the question recorded on its issue.
 * @param port - The engine calls.
 * @param coordinator - The coordinator's address.
 * @param id - The question's id.
 * @param note - The coordinator's note for the user.
 * @returns What happened, or why nothing was forwarded.
 */
export async function forwardToUser(port: EnginePort, coordinator: string, id: string, note: string): Promise<Result<string>> {
  const common = await readCommonDir(port)
  if (!common) return fail('this session is not inside a git repository, which holds the mailboxes')
  const question = await findMessage(port, common, coordinator, id)
  if (!question || question.kind !== 'question' || !/^\d+$/.test(question.from)) return fail(`no unit's question ${id} reached this coordinator's mailbox, so there is nothing to forward`)
  if (question.options.length < minimumOptions) {
    return fail(`question ${id} offers ${question.options.length} options and a question to the user needs at least ${minimumOptions}: answer the unit and ask it to send the question again with options`)
  }
  if (await findMessage(port, common, question.from, deriveReplyId(id, coordinator))) return fail(`question ${id} already has this coordinator's answer, so it is not the user's to answer`)
  const record: ForwardRecord = { v: 1, id, coordinator, at: new Date(await port.now()).toISOString(), note }
  const isNew = await withRecordLock(() => atomicCreate(port, recordsPath(common, 'forwards'), recordsPath(common, 'forwards', `${id}.json`), JSON.stringify(record)))
  if (!isNew) return fail(`question ${id} was already forwarded to the user`)
  await redirectMail(port, common, question, userAddress)
  const recorded = await recordComment(port, common, question.issue, question.id, composeQuestionComment(question, note))
  return succeed(`Forwarded question ${id} from #${question.issue}'s unit to the user's mailbox; the user's answer goes to the unit, and this session is told.${recorded}`)
}

/**
 * Opens the coordinator's own question to the user, whose answer comes back to the coordinator; the question is recorded on its issue.
 * @param port - The engine calls.
 * @param issue - The issue the question is about.
 * @param body - The question.
 * @param options - Its options.
 * @param refs - What the body points to.
 * @returns What happened, or why nothing was sent.
 */
export async function askUser(port: EnginePort, issue: number, body: string, options: string[], refs: string[]): Promise<Result<string>> {
  if (options.length < minimumOptions) return fail(`a question to the user needs at least ${minimumOptions} options, labelled a, b, c… in the inbox`)
  const sent = await sendMail(port, { kind: 'question', to: userAddress, issue, body, options, refs })
  const common = await readCommonDir(port)
  if (!sent.isOk || !common) return sent
  const question = await findMessage(port, common, userAddress, sent.value)
  const recorded = question ? await recordComment(port, common, issue, question.id, composeQuestionComment(question, '')) : ''
  return succeed(`Sent question ${sent.value} to the user's mailbox; the user's answer arrives in this session's mailbox.${recorded}`)
}

/**
 * Tells whether a question to the user still waits for the user's answer: its asker's mailbox holds no reply from the user, and its asker
 * is not a unit session retired since it asked.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param question - The question.
 * @returns Whether it is open.
 */
async function isOpen(port: EnginePort, common: string, question: Envelope): Promise<boolean> {
  return question.kind === 'question' && !await findMessage(port, common, question.from, deriveReplyId(question.id, userAddress))
    && !await isFromRetiredSession(port, question)
}

/**
 * Lists the questions to the user still waiting for an answer, which never expire: they are read from the mailboxes, never from a time.
 * @param port - The engine calls.
 * @returns The open questions.
 */
async function listOpenQuestions(port: EnginePort): Promise<Envelope[]> {
  const common = await readCommonDir(port)
  if (!common) return []
  const mail = (await readMailbox(port, common, userAddress)).map(({ envelope }) => envelope)
  const open = await Promise.all(mail.map(async envelope => await isOpen(port, common, envelope) ? [envelope] : []))
  return open.flat()
}

/**
 * Counts the user's open questions and the issue comments not yet recorded.
 * @param port - The engine calls.
 * @returns The counts.
 */
export async function countInbox(port: EnginePort): Promise<InboxCounts> {
  const common = await readCommonDir(port)
  if (!common) return { open: 0, unrecorded: 0 }
  return { open: (await listOpenQuestions(port)).length, unrecorded: (await readComments(port, common)).filter(record => !record.isPosted).length }
}

/**
 * Runs the user's `/flow inbox`: with no words it shows every open question and the mail not shown yet, then marks it shown; with
 * `answer <id> <letter|no> [words]` it sends the user's answer to the asker.
 * @param port - The engine calls.
 * @param words - The arguments after the subcommand.
 * @param text - Those arguments as typed.
 * @returns The inbox, the answer's outcome, or why nothing was sent.
 */
export async function runInboxCommand(port: EnginePort, words: string[], text: string): Promise<string> {
  const common = await readCommonDir(port)
  if (!common) return 'The inbox needs a git repository, which holds the mailboxes.'
  if (words[0] === 'answer') {
    const id = words[1] ?? ''
    const said = text.replace(/^answer\s+\S+\s*/, '')
    if (!id || !said) return answerUsage
    const answered = await answerQuestion(port, common, id, said)
    return answered.isOk ? answered.value : `Not sent: ${answered.error}.`
  }
  if (words.length) return answerUsage
  const mail = await readMailbox(port, common, userAddress)
  const entries = await Promise.all(mail.map(async ({ box, envelope }) => ({ box, envelope, isOpen: await isOpen(port, common, envelope) })))
  const shown = entries.filter(entry => entry.isOpen || entry.box === 'new')
  if (!shown.length) return 'The inbox is empty: no question waits for you.'
  const lines = await Promise.all(shown.map(async entry => formatInboxEntry(entry.envelope, entry.isOpen, (await readForward(port, common, entry.envelope.id))?.note ?? '')))
  await markShown(port, common, userAddress, shown.filter(entry => entry.box === 'new').map(entry => entry.envelope))
  const open = shown.filter(entry => entry.isOpen).length
  return [`Inbox: ${open} open question${open === 1 ? '' : 's'} for you. An answer is information to the asker and never approves anything.`, ...lines].join('\n\n')
}

/**
 * Sends the user's answer to a question in their mailbox, from the user, to the question's sender, which is the unit for a forwarded
 * one; tells the coordinator that forwarded it, and records the answer on the issue.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param id - The question's id.
 * @param said - What the user typed after the id.
 * @returns What was sent, or why not.
 */
async function answerQuestion(port: EnginePort, common: string, id: string, said: string): Promise<Result<string>> {
  const question = await findMessage(port, common, userAddress, id)
  if (!question || question.kind !== 'question') return fail(`no question ${id} is in your inbox`)
  const body = composeUserAnswer(question.options, said)
  const kept = await keepLateReply(port, common, question, { kind: 'answer', from: userAddress, body, refs: [] })
  if (kept) {
    await markShown(port, common, userAddress, [question])
    return succeed(kept)
  }
  const replyId = deriveReplyId(id, userAddress)
  const sent = await sendMail(port, { kind: 'answer', from: userAddress, author: 'user', to: question.from, issue: question.issue, body,
    reply: { inReplyTo: id, id: replyId, from: userAddress } })
  if (!sent.isOk) return fail(sent.error.includes('replied to once') ? `question ${id} is already answered` : sent.error)
  await markShown(port, common, userAddress, [question])
  const forward = await readForward(port, common, id)
  if (forward) {
    await sendMail(port, { kind: 'inform', author: 'mod', from: userAddress, to: forward.coordinator, issue: question.issue,
      body: `The user answered #${question.issue}'s question ${id}, which you forwarded; the answer went to the unit:\n${body}` }).catch(() => null)
  }
  const answer = await findMessage(port, common, question.from, replyId)
  const recorded = answer ? await recordComment(port, common, question.issue, replyId, composeAnswerComment(answer)) : ''
  return succeed(`Answered ${id} to ${question.from}: ${body.split('\n')[0]}.${recorded}`)
}

/**
 * Records an issue comment as owed and tries to post it at once; a failure never blocks the message, and the coordinator's tick retries it.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue.
 * @param id - The message the comment records.
 * @param body - The comment, which ends with its marker.
 * @returns A note for the caller's result: empty once posted, else the failure and the retry.
 */
async function recordComment(port: EnginePort, common: string, issue: number, id: string, body: string): Promise<string> {
  const record: CommentRecord = { v: 1, issue, id, body, isPosted: false, error: '' }
  await withRecordLock(() => atomicReplace(port, commentPath(common, id), JSON.stringify(record)))
  const posted = await postComment(port, common, record)
  return posted.isPosted ? '' : ` Recording it on #${issue} failed (${posted.error}); the coordinator retries it.`
}

/**
 * Posts an owed comment unless the issue already carries its marker, and records the outcome.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param record - The owed comment.
 * @returns The record as written.
 */
async function postComment(port: EnginePort, common: string, record: CommentRecord): Promise<CommentRecord> {
  const outcome = await (async (): Promise<Result<undefined>> => {
    const comments = await readMarkedComments(port.processes, record.issue)
    if (!comments.isOk) return comments
    if (comments.value.some(comment => comment.body.includes(commentMarker(record.id)))) return succeed(undefined)
    const posted = await commentIssue(port, { number: record.issue, body: record.body })
    return posted.isOk ? succeed(undefined) : posted
  })().catch((error: unknown) => fail(formatErrorLine(error)))
  const next: CommentRecord = { ...record, isPosted: outcome.isOk, error: outcome.isOk ? '' : outcome.error }
  await withRecordLock(() => atomicReplace(port, commentPath(common, record.id), JSON.stringify(next)))
  return next
}

/**
 * Posts every comment still owed; run by a coordinator session's tick.
 * @param port - The engine calls.
 * @returns Once each was tried.
 */
export async function retryOwedComments(port: EnginePort): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  for (const record of (await readComments(port, common)).filter(each => !each.isPosted)) await postComment(port, common, record)
}

/**
 * Raises a notification in a coordinator session when mail reaches the user's mailbox about an issue this coordinator delegates, or
 * from it; a session that is no coordinator, or not that issue's, raises none.
 * @param port - The engine calls.
 * @param path - The file the event names.
 * @returns Whether it notified.
 */
export async function notifyUserMail(port: EnginePort, path: string): Promise<boolean> {
  const common = await readCommonDir(port)
  if (!common || !path.startsWith(`${mailPath(common, userAddress, 'new')}/`)) return false
  const scope = await readOwnScope(port)
  if (!scope) return false
  const name = path.slice(path.lastIndexOf('/') + 1)
  const envelope = (await readMailbox(port, common, userAddress)).find(entry => mailFileName(entry.envelope) === name)?.envelope
  if (!envelope || (!scope.issues.includes(envelope.issue) && envelope.from !== coordinatorAddress(scope.sessionId))) return false
  const subject = envelope.kind === 'question' ? `#${envelope.issue} asks you` : `#${envelope.issue}`
  await port.notify(`${subject}: ${envelope.body.split('\n')[0]?.slice(0, 120) ?? ''} — /flow inbox`)
  return true
}

/**
 * Tells the user, never the model, how many questions wait for them when no live coordinator delegates any of their issues.
 * @param port - The engine calls.
 * @returns Once told, or when there was nothing to tell.
 */
export async function remindUnwatchedQuestions(port: EnginePort): Promise<void> {
  const open = await listOpenQuestions(port)
  if (!open.length) return
  for (const question of open) if (await findLiveScope(port, [question.issue], false)) return
  port.toast(`${open.length === 1 ? '1 question for you waits' : `${open.length} questions for you wait`} in /flow inbox.`)
}

/**
 * Names a comment record.
 * @param common - The git common directory.
 * @param id - The message the comment records.
 * @returns The path.
 */
const commentPath = (common: string, id: string): string => recordsPath(common, 'comments', `${id}.json`)

/**
 * Reads every comment record.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @returns The valid records.
 */
async function readComments(port: EnginePort, common: string): Promise<CommentRecord[]> {
  // The bucket exists only once a comment was owed.
  const names = await port.files.list(recordsPath(common, 'comments')).catch(() => [])
  const read = await Promise.all(names.filter(({ name }) => name.endsWith('.json')).map(async ({ name }): Promise<CommentRecord[]> => {
    const value: unknown = await readJson(port.files, recordsPath(common, 'comments', name))
    return isRecord(value) && value.v === 1 && typeof value.issue === 'number' && isNonEmptyString(value.id) && isNonEmptyString(value.body) && typeof value.isPosted === 'boolean'
      ? [{ v: 1, issue: value.issue, id: value.id, body: value.body, isPosted: value.isPosted, error: typeof value.error === 'string' ? value.error : '' }] : []
  }))
  return read.flat()
}
