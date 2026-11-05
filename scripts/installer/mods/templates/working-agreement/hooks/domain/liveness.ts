import { hasOnlyKeys, isFiniteNumber, isNonEmptyString, isRecord } from '../lib/guards'
import type { DialogEntry } from './dialogs'
import { findDialog } from './dialogs'
import { formatIssueReferences } from './messages'

/**
 * What a unit's own mod last recorded of its session: whether a turn runs, when the last turn or tool event came, and whether a
 * permission dialog holds it, which its coordinator was already told of.
 */
export interface Activity { v: 1; isTurn: boolean; at: number; isDialog: boolean }

/** Holds a unit's oldest unread message and how long it has waited. */
interface UnreadMail { id: string; ageMs: number }

/**
 * What a coordinator's tick reads of one unit: whether its process ended and the start time its host record names, its activity, its
 * oldest unread mail, and whether herdr shows it blocked now and showed it on two ticks in a row.
 */
export interface UnitWatch {
  isGone: boolean; pidStart: string; activity: Activity | null; oldestUnread: UnreadMail | null; isBlockedNow: boolean; isBlocked: boolean
}

/**
 * The stall a coordinator last reported for a unit, kept on disk so a restarted coordinator does not report the same episode again, with
 * the catalogue id of the dialog the report named, which is the only dialog dismiss_dialog may clear.
 */
export interface StallRecord { v: 1; session: string; stall: Stall; key: string; dialog?: string }

/** Why a unit is reported: its process ended, or the stalled clause that fired. */
export type Stall = 'dead' | 'mail' | 'blocked' | 'turn'

const stalls: readonly Stall[] = ['dead', 'mail', 'blocked', 'turn']
const minuteMs = 60000
/** How long a unit may hold unread mail while idle: five ticks, so five missed doorbell recoveries are silence, not latency. */
const mailStallMs = 5 * minuteMs
// why: the engine's Bash tool refuses a timeout above ten minutes unless its environment raises the cap.
const bashMaxMs = 10 * minuteMs
const marginMs = 5 * minuteMs
/** The most characters of a pane an unknown dialog's question carries, well inside a message's body limit. */
const excerptLimit = 6000

/**
 * Bounds how long a running turn may show no tool or turn event: a Verify call waits up to its timeout for the queue and CI, then runs up to
 * its timeout again, so a unit inside the longest legitimate call is never reported.
 * @param verifyTimeoutMinutes - The repository's Verify timeout.
 * @returns The bound.
 */
export const turnStallMs = (verifyTimeoutMinutes: number): number => Math.max(2 * verifyTimeoutMinutes * minuteMs, bashMaxMs) + marginMs

/**
 * Validates an activity record read from disk.
 * @param value - The decoded JSON.
 * @returns The record, or null.
 */
export function parseActivity(value: unknown): Activity | null {
  return isRecord(value) && value.v === 1 && typeof value.isTurn === 'boolean' && isFiniteNumber(value.at) && typeof value.isDialog === 'boolean'
    ? { v: 1, isTurn: value.isTurn, at: value.at, isDialog: value.isDialog } : null
}

/**
 * Judges a unit: dead once its process ended, else stalled by the first clause that holds; a permission dialog already told the
 * coordinator, so neither herdr's blocked nor the silent turn it causes counts again.
 * @param watch - What the tick read of the unit.
 * @param now - The time.
 * @param turnLimitMs - The bound on a silent turn.
 * @returns Why to report the unit, or null.
 */
export function judgeUnit(watch: UnitWatch, now: number, turnLimitMs: number): Stall | null {
  if (watch.isGone) return 'dead'
  const activity = watch.activity
  if (!activity?.isTurn && watch.oldestUnread && watch.oldestUnread.ageMs > mailStallMs) return 'mail'
  if (activity?.isDialog) return null
  if (watch.isBlocked) return 'blocked'
  return activity?.isTurn && now - activity.at > turnLimitMs ? 'turn' : null
}

/**
 * Words the report of a dead or stalled unit for the user's mailbox, naming the dialog its pane shows and whether Esc clears it.
 * @param issues - The unit's issues.
 * @param stall - Why it is reported.
 * @param turnLimitMs - The bound on a silent turn.
 * @param dialog - The catalogued dialog the pane shows, if any.
 * @returns The report.
 */
export function composeStallReport(issues: number[], stall: Stall, turnLimitMs: number, dialog?: DialogEntry): string {
  const unit = formatIssueReferences(issues, ' ')
  if (stall === 'dead') return `${unit} is dead: its session's process ended; spawn resumes it.`
  const clause = describeStall(stall, turnLimitMs)
  if (!dialog) return `${unit} is stalled: ${clause}; read its pane.`
  const clear = dialog.key ? `dismiss_dialog ${dialog.id} clears it with Esc` : 'the mod sends it no key: answer it in the unit\'s pane'
  return `${unit} is stalled: ${clause}; its pane shows ${dialog.name} (${dialog.id}): ${clear}.`
}

/**
 * Words the question a stalled unit whose pane shows a dialog the catalogue does not know becomes: nothing was sent to it, and the user
 * sees what the pane shows.
 * @param issues - The unit's issues.
 * @param stall - The stalled clause that fired.
 * @param turnLimitMs - The bound on a silent turn.
 * @param excerpt - The pane's visible rows.
 * @returns The question's body.
 */
export function composeUnknownDialogQuestion(issues: number[], stall: Exclude<Stall, 'dead'>, turnLimitMs: number, excerpt: string): string {
  const head = `${formatIssueReferences(issues, ' ')} is stalled: ${describeStall(stall, turnLimitMs)}; its pane shows a dialog the mod does not know, so it sent no key. `
    + 'Answer it in the unit\'s pane. Its visible screen:'
  // why: the excerpt is cut to what a message carries, keeping the bottom rows, where a dialog's options are.
  return `${head}\n\`\`\`\n${excerpt.slice(-excerptLimit)}\n\`\`\``
}

/**
 * Words the stalled clause that fired.
 * @param stall - The clause.
 * @param turnLimitMs - The bound on a silent turn.
 * @returns The clause's words.
 */
function describeStall(stall: Exclude<Stall, 'dead'>, turnLimitMs: number): string {
  return {
    mail: `it is idle and has held mail unread for over ${mailStallMs / minuteMs} min`,
    blocked: 'herdr reports it blocked',
    turn: `its turn has shown no tool or turn event for over ${turnLimitMs / minuteMs} min`,
  }[stall]
}

/**
 * Keys one episode of a stall on facts that outlive a coordinator restart: the oldest unread message for mail, the activity record's time,
 * which stays still while the unit is stuck, for blocked and turn, and the process start time for dead; a new episode of the same clause
 * gets a new key.
 * @param session - The unit's session.
 * @param stall - The stall.
 * @param watch - What the tick read of the unit.
 * @returns The key.
 */
export function composeStallKey(session: string, stall: Stall, watch: UnitWatch): string {
  const episode = stall === 'dead' ? watch.pidStart : stall === 'mail' ? watch.oldestUnread?.id ?? '' : String(watch.activity?.at ?? '')
  return `${session}:${stall}:${episode}`
}

/**
 * Validates a stall record read from disk.
 * @param value - The decoded JSON.
 * @returns The record, or null.
 */
export function parseStallRecord(value: unknown): StallRecord | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'session', 'stall', 'key', 'dialog']) || value.v !== 1 || !isNonEmptyString(value.session)
    || !stalls.includes(value.stall as Stall) || !isNonEmptyString(value.key)) return null
  // why: a record naming no catalogued dialog still keys its episode; it only allows no dismissal.
  const dialog = typeof value.dialog === 'string' && findDialog(value.dialog) ? { dialog: value.dialog } : {}
  return { v: 1, session: value.session, stall: value.stall as Stall, key: value.key, ...dialog }
}
