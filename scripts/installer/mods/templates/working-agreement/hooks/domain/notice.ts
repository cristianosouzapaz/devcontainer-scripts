import { isNonEmptyString, isRecord, isStringArray } from '../lib/guards'
import { formatIssueReferences } from './messages'

/** What a delegated unit's coordinator is told: the state it names, compared to skip an unchanged one, and the fixed message. */
export interface Notice { key: string; text: string }

/** The last notice a unit composed, whether it reached the coordinator, and the messages that did, oldest first. */
export interface NoticeRecord { v: 1; key: string; text: string; isSent: boolean; sent: string[] }

/** Where a delegated unit stands as its turn ends, as the notice reads it. */
export interface UnitTurn {
  issues: number[]
  /** The current step's label and whether it is the user's, or null once the flow has no current step. */
  step: { id: string; label: string; isHuman: boolean } | null
  /** The slice tree, or null when it cannot be read. */
  tree: string | null
  /** The Verify fact, or null when Verify passed on the tree. */
  verifyFact: string | null
  reason: 'answer' | 'aborted' | 'refusal' | 'error'
  answer: string
  /** The unit's last notice record, or null before the first notice. */
  last: NoticeRecord | null
}

// why: The report lists the sent notices; a long-running unit keeps only its latest ones.
const keptNotices = 20

/**
 * Composes the notice a delegated unit's turn end owes its coordinator; the same turn always composes the same bytes.
 * @param turn - Where the unit stands.
 * @returns The notice, or null after an interrupted turn, which someone at the pane caused.
 */
export function composeTurnNotice(turn: UnitTurn): Notice | null {
  const unit = formatIssueReferences(turn.issues, ' ')
  if (turn.reason === 'aborted') return null
  if (turn.reason !== 'answer') {
    return { key: `blocked:${turn.reason}`, text: `${unit} is blocked: its turn ended on ${turn.reason === 'error' ? 'an API error' : 'a refusal'}; read its pane.` }
  }
  const step = turn.step
  // why: A commit moves the unit past Commit, so a turn that ends there with Verify passed is a unit that stopped instead of committing.
  if (step?.id === 'commit' && turn.tree && turn.verifyFact === null) {
    return { key: `stopped:commit:${turn.tree}:${hashText(turn.answer)}`,
      text: `${unit} ended its turn at ${step.label} without committing: Verify passed on ${turn.tree.slice(0, 7)}; read its pane and have it commit with the commit tool.` }
  }
  if (step && turn.tree && (step.id === 'commit' || step.id === 'integrate')) {
    const verify = turn.verifyFact === null ? `: Verify passed on ${turn.tree.slice(0, 7)}` : ` without a Verify pass (${turn.verifyFact})`
    const reached = { key: `reached:${step.id}:${turn.tree}:${hashText(turn.answer)}`, text: `${unit} reached ${step.label}${verify}; ${step.id === 'integrate' ? 'ready for merge_child.' : 'it commits next.'}` }
    // why: Once the coordinator heard the unit reached the step, a turn there on a new answer replies to it, so it is a wait like any other.
    if (!turn.last?.sent.includes(reached.text) || turn.last.key === reached.key) return reached
  }
  if (step?.isHuman) return { key: `user:${step.id}:${hashText(turn.answer)}`, text: `${unit} ended its turn on the user's step ${step.label}: read its pane and run it there.` }
  // why: A unit waiting again at the same step after an answer is a new wait, so the answer it ended on is part of the state.
  return { key: `waits:${step?.id ?? 'end'}:${hashText(turn.answer)}`,
    text: `${unit} ended its turn${step ? ` at ${step.label}` : ''} on a decision or a question: read its pane and answer through the delegated-decision path.` }
}

/**
 * Composes the notice of a permission dialog the unit's session raised.
 * @param issues - The unit's issues.
 * @param message - The dialog's notification text.
 * @returns The notice.
 */
export function composePermissionNotice(issues: number[], message: string): Notice {
  return { key: `blocked:permission:${hashText(message)}`, text: `${formatIssueReferences(issues, ' ')} is blocked on a permission dialog: read its pane.` }
}

/**
 * Validates a notice record read from disk.
 * @param value - The decoded JSON.
 * @returns The record, or null.
 */
export function parseNoticeRecord(value: unknown): NoticeRecord | null {
  return isRecord(value) && value.v === 1 && isNonEmptyString(value.key) && isNonEmptyString(value.text) && typeof value.isSent === 'boolean' && isStringArray(value.sent)
    ? { v: 1, key: value.key, text: value.text, isSent: value.isSent, sent: value.sent } : null
}

/**
 * Records the outcome of a send.
 * @param record - The last record, or null before the first notice.
 * @param notice - The notice sent.
 * @param isSent - Whether it reached the coordinator.
 * @returns The new record.
 */
export function recordNotice(record: NoticeRecord | null, notice: Notice, isSent: boolean): NoticeRecord {
  const sent = record?.sent ?? []
  return { v: 1, ...notice, isSent, sent: isSent ? [...sent, notice.text].slice(-keptNotices) : sent }
}

/**
 * Tells whether a notice is owed: its state changed since the last one, or the last send failed.
 * @param record - The last record, or null before the first notice.
 * @param notice - The notice composed now.
 * @returns Whether to send it.
 */
export const isNoticeOwed = (record: NoticeRecord | null, notice: Notice): boolean => record?.key !== notice.key || !record.isSent

/**
 * Hashes a text to a short stable key part (FNV-1a, 32 bits).
 * @param text - The text.
 * @returns The hash in hex.
 */
function hashText(text: string): string {
  const hash = [...text].reduce((value, char) => Math.imul(value ^ (char.codePointAt(0) ?? 0), 16777619) >>> 0, 2166136261)
  return hash.toString(16)
}
