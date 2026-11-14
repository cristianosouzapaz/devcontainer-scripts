import { hasOnlyKeys, isFiniteNumber, isNonEmptyString, isRecord } from '../lib/guards'
import type { DialogEntry } from './dialogs'
import { findDialog } from './dialogs'
import { formatIssueReferences } from './messages'

/**
 * What a unit's own mod last recorded of its session: whether a turn runs, when the last turn or tool event came, whether a
 * permission dialog holds it, which its coordinator was already told of, and why its tools failed to register, when they did.
 */
export interface Activity {
  v: 1; isTurn: boolean; at: number; isDialog: boolean; toolsError?: string; epoch?: number; turnId?: string; generation?: string
  /** Set by a mod load a reload started until it hears a turn start or end itself: whether a turn runs is then unknown, whatever `isTurn` says. */
  isUnknown?: true
}

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
 * the catalogue id of the dialog the report named, which is the only dialog dismiss_dialog may clear. A `cannot-tell` record is the
 * report that the sweep could not judge the unit; its session is the literal `cannot-tell`, since no session was judged.
 */
export interface StallRecord { v: 1; session: string; stall: Stall | 'cannot-tell'; key: string; dialog?: string }

/** A publish that waited past its deadline for its publish lock, held by another load of the session, an earlier publish of this load, or a session sharing that lock, with the command that lists the lock's queue. */
interface PublishTimeout { kind: 'timeout'; lock: string; waitedMs: number; check: string }

/** A publish whose hold ended, as its holder process did, before its rename. */
interface PublishLost { kind: 'lost'; lock: string }

/** A publish whose rename its lock holder was asked for and ended before answering, so whether the record was written is unknown. */
interface PublishUnknown { kind: 'unknown'; lock: string }

/** A publish that could not take its publish lock at all. */
interface PublishFailed { kind: 'failed'; lock: string; cause: string }

/** A publish whose write failed while it held its publish lock. */
interface PublishWriteFailed { kind: 'write'; lock: string; cause: string }

/** Why a publish of a session record wrote nothing. */
export type PublishFault = PublishTimeout | PublishLost | PublishUnknown | PublishFailed | PublishWriteFailed

/** Why a unit is reported: its process ended, or the stalled clause that fired; `unread` is mail held while the unit's turn state is unknown. */
export type Stall = 'dead' | 'tools' | 'mail' | 'unread' | 'uncertain' | 'blocked' | 'turn'

const stalls: readonly (Stall | 'cannot-tell')[] = ['dead', 'tools', 'mail', 'unread', 'uncertain', 'blocked', 'turn', 'cannot-tell']
/** Why a process state of a shape this module does not know cannot be used. */
export const unknownProcessShape = 'the host holds a value of a shape this module does not know, left as it is'
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
    ? { v: 1, isTurn: value.isTurn, at: value.at, isDialog: value.isDialog, ...isNonEmptyString(value.toolsError) ? { toolsError: value.toolsError } : {},
      ...isFiniteNumber(value.epoch) ? { epoch: value.epoch } : {}, ...typeof value.turnId === 'string' ? { turnId: value.turnId } : {},
      ...isNonEmptyString(value.generation) ? { generation: value.generation } : {}, ...value.isUnknown === true ? { isUnknown: true as const } : {} } : null
}

/**
 * Words a failed registration of the mod's tools, as the unit's pane and `/flow status` show it.
 * @param cause - Why the registration failed.
 * @returns The words.
 */
export const describeToolsFailure = (cause: string): string => `the mod's tools did not register: ${cause}; no mod prompt will start a turn`

/**
 * Words a process state the mod cannot read, or a change to it the mod could not write, as the unit's pane and `/flow status` show it.
 * @param kind - Whether a read or a write failed.
 * @param cause - Why.
 * @returns The words.
 */
export function describeProcessStateFailure(kind: 'read' | 'write', cause: string): string {
  if (cause === unknownProcessShape) {
    return `the mod cannot use its process state (${cause}), so it treats this session as busy: it submits no doorbell, start or wake prompt; since it never overwrites a value it does not know, only a new process clears this row: restarting the session clears this and discards any start prompts still waiting; start the current step by hand afterwards (/flow status names it), and run again any /flow coordinate or /flow delegate whose fixed prompt was waiting`
  }
  return kind === 'read'
    ? `the mod cannot read its process state (${cause}), so it treats this session as busy: it submits no doorbell, start or wake prompt until a read succeeds, which clears this row`
    : `the mod could not write a change to its process state (${cause}), so the turn and waits it reads may predate that change; it treats this session as busy and submits no doorbell, start or wake prompt until a write succeeds, which clears this row`
}

/**
 * Judges a unit: dead once its process ended, else reported for tools that failed to register, else stalled by the first clause that
 * holds; a permission dialog already told the coordinator, so neither herdr's blocked nor the silent turn it causes counts again.
 * @param watch - What the tick read of the unit.
 * @param now - The time.
 * @param turnLimitMs - The bound on a silent turn.
 * @returns Why to report the unit, or null.
 */
export function judgeUnit(watch: UnitWatch, now: number, turnLimitMs: number): Stall | null {
  if (watch.isGone) return 'dead'
  const activity = watch.activity
  if (activity?.toolsError) return 'tools'
  // why: a record a reloaded load cannot vouch for says neither that the unit is idle nor that a turn runs, so only held mail is reported, with that uncertainty.
  if (activity?.isUnknown) return watch.oldestUnread && watch.oldestUnread.ageMs > mailStallMs ? 'uncertain' : !activity.isDialog && watch.isBlocked ? 'blocked' : null
  // why: a missing or unreadable record says nothing of the turn, so the mail is reported without calling the unit idle.
  if (watch.oldestUnread && watch.oldestUnread.ageMs > mailStallMs && !activity?.isTurn) return !activity ? 'unread' : activity.isUnknown ? 'uncertain' : 'mail'
  if (activity?.isDialog) return null
  if (watch.isBlocked) return 'blocked'
  return activity?.isTurn && now - activity.at > turnLimitMs ? 'turn' : null
}

/**
 * Words the report of a dead or stalled unit for the user's mailbox, naming the dialog its pane shows and whether Esc clears it.
 * @param issues - The unit's issues.
 * @param stall - Why it is reported.
 * @param turnLimitMs - The bound on a silent turn.
 * @param activityFile - The unit's activity record, which an unknown turn state names.
 * @param dialog - The catalogued dialog the pane shows, if any.
 * @returns The report.
 */
export function composeStallReport(issues: number[], stall: Stall, turnLimitMs: number, activityFile: string, dialog?: DialogEntry): string {
  const unit = formatIssueReferences(issues, ' ')
  if (stall === 'dead') return `${unit} is dead: its session's process ended; spawn resumes it.`
  const clause = describeStall(stall, turnLimitMs, activityFile)
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
 * @param activityFile - The unit's activity record, which an unknown turn state names.
 * @param excerpt - The pane's visible rows.
 * @returns The question's body.
 */
export function composeUnknownDialogQuestion(issues: number[], stall: Exclude<Stall, 'dead'>, turnLimitMs: number, activityFile: string, excerpt: string): string {
  const head = `${formatIssueReferences(issues, ' ')} is stalled: ${describeStall(stall, turnLimitMs, activityFile)}; its pane shows a dialog the mod does not know, so it sent no key. `
    + 'Answer it in the unit\'s pane. Its visible screen:'
  // why: the excerpt is cut to what a message carries, keeping the bottom rows, where a dialog's options are.
  return `${head}\n\`\`\`\n${excerpt.slice(-excerptLimit)}\n\`\`\``
}

/**
 * Words the stalled clause that fired.
 * @param stall - The clause.
 * @param turnLimitMs - The bound on a silent turn.
 * @param activityFile - The unit's activity record, which an unknown turn state names.
 * @returns The clause's words.
 */
function describeStall(stall: Exclude<Stall, 'dead'>, turnLimitMs: number, activityFile: string): string {
  return {
    tools: 'the mod\'s tools did not register in its session, so no mod prompt will start a turn, and a restart of its session retries the registration',
    mail: `it is idle and has held mail unread for over ${mailStallMs / minuteMs} min`,
    unread: `it has held mail unread for over ${mailStallMs / minuteMs} min and its turn state is unknown: its session left no readable activity record at ${activityFile}`,
    uncertain: `it has held mail unread for over ${mailStallMs / minuteMs} min and its turn state is unknown: its mod reloaded and has not seen a turn start or end since, as recorded at ${activityFile}`,
    blocked: 'herdr reports it blocked',
    turn: `its turn has shown no tool or turn event for over ${turnLimitMs / minuteMs} min`,
  }[stall]
}

/**
 * Keys one episode of a stall on facts that outlive a coordinator restart: the oldest unread message for mail, the activity record's time,
 * which stays still while the unit is stuck, for blocked and turn, the registration's cause for tools, since a turn the user drives
 * still moves that time, and the process start time for dead; a new episode of the same clause gets a new key.
 * @param session - The unit's session.
 * @param stall - The stall.
 * @param watch - What the tick read of the unit.
 * @returns The key.
 */
export function composeStallKey(session: string, stall: Stall, watch: UnitWatch): string {
  const episode = stall === 'dead' ? watch.pidStart : stall === 'mail' || stall === 'unread' || stall === 'uncertain' ? watch.oldestUnread?.id ?? ''
    : stall === 'tools' ? watch.activity?.toolsError ?? '' : String(watch.activity?.at ?? '')
  return `${session}:${stall}:${episode}`
}

/**
 * Validates a stall record read from disk.
 * @param value - The decoded JSON.
 * @returns The record, or null.
 */
export function parseStallRecord(value: unknown): StallRecord | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['v', 'session', 'stall', 'key', 'dialog']) || value.v !== 1 || !isNonEmptyString(value.session)
    || !stalls.includes(value.stall as StallRecord['stall']) || !isNonEmptyString(value.key)) return null
  // why: a record naming no catalogued dialog still keys its episode; it only allows no dismissal.
  const dialog = typeof value.dialog === 'string' && findDialog(value.dialog) ? { dialog: value.dialog } : {}
  return { v: 1, session: value.session, stall: value.stall as StallRecord['stall'], key: value.key, ...dialog }
}

/**
 * Words a publish that wrote nothing, as the unit's pane and `/flow status` show it until a publish of that record runs to its end.
 * @param file - The record.
 * @param fault - Why nothing was written.
 * @returns The words.
 */
export function describePublishFault(file: string, fault: PublishFault): string {
  if (fault.kind === 'timeout') {
    return `the publish of ${file} waited ${Math.round(fault.waitedMs / 1000)} s for its publish lock (${fault.lock}), held by another load of this session, an earlier publish of this load that has not ended, or a session sharing that lock, so nothing was written; each tick tries again, and this row stays while the lock is held; a host lock is held exactly while its holder process lives: \`${fault.check}\` lists its queue, each hold named by its session`
  }
  if (fault.kind === 'unknown') return `the publish of ${file} asked its publish lock's holder (${fault.lock}) to rename it into place, and the holder ended before it answered, so whether ${file} was written is unknown: inspect it; each tick publishes it again`
  if (fault.kind === 'lost') return `the publish of ${file} lost its publish lock (${fault.lock}) before its rename, as its holder process ended, so nothing was written; each tick tries again`
  if (fault.kind === 'write') return `the publish of ${file} failed under its publish lock (${fault.lock}): ${fault.cause}; each tick tries again`
  return `the publish of ${file} could not take its publish lock (${fault.lock}): ${fault.cause}; nothing was written, and each tick tries again`
}

