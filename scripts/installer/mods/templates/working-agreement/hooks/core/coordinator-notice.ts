import { composePermissionNotice, composeTurnNotice, isNoticeOwed, parseNoticeRecord, recordNotice } from '../domain/notice'
import type { Notice, NoticeRecord, UnitTurn } from '../domain/notice'
import type { Session } from '../domain/records'
import { readJson } from '../lib/json'
import { fail, formatErrorLine } from '../lib/result'
import { coordinatorAddress, userAddress } from '../domain/mail'
import { findLiveDelegation } from './delegation'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { sendMail } from './mailbox'
import { locatePosition } from './position'
import { atomicReplace, readCommonDir, readSession, recordsPath } from './record-store'
import { withRecordLock } from './session-memory'

// why: Beside the other records under the common directory, so the coordinator's /flow report reads every unit's notices.
const bucket = 'notices'

/**
 * Names a unit branch's notice record.
 * @param common - The git common directory.
 * @param branch - The unit branch.
 * @returns The file path.
 */
export const noticePath = (common: string, branch: string): string => recordsPath(common, bucket, `${encodeURIComponent(branch)}.json`)

/**
 * Reads the notices a unit branch sent its coordinator.
 * @param port - The engine calls.
 * @param branch - The unit branch.
 * @returns The record, or null when the unit sent none.
 */
export async function readNotices(port: EnginePort, branch: string): Promise<NoticeRecord | null> {
  const common = await readCommonDir(port)
  return common ? parseNoticeRecord(await readJson(port.files, noticePath(common, branch))) : null
}

/**
 * Reports what a delegated unit's turn ended on, once per changed state: to the coordinator holding its scope, or to the user at one of the user's steps;
 * a failed send stays owed and is sent again at the next turn end.
 * @param port - The engine calls.
 * @param turn - How the turn ended.
 * @returns Once the notice is sent, skipped or held.
 */
export function noticeTurnEnd(port: EnginePort, turn: Pick<UnitTurn, 'reason'>): Promise<void> {
  return notify(port, async session => {
    const position = await locatePosition(port, session)
    const current = position?.current?.step
    return composeTurnNotice({ ...turn, issues: session.issues, step: current ? { id: current.id, label: current.label, isHuman: !!current.isHuman } : null })
  })
}

/**
 * Tells the coordinator holding this delegated unit's scope that a permission dialog blocks the unit.
 * @param port - The engine calls.
 * @param message - The dialog's notification text.
 * @returns Once the notice is sent, skipped or held.
 */
export function noticePermission(port: EnginePort, message: string): Promise<void> {
  return notify(port, session => Promise.resolve(composePermissionNotice(session.issues, message)))
}

/**
 * Sends a delegated unit's owed notice as a mod-written inform, to its coordinator's mailbox or the user's, and records the outcome.
 * @param port - The engine calls.
 * @param compose - Composes the notice from the unit's session state, or null when none is owed.
 * @returns Once done; nothing is sent outside a delegated unit.
 */
async function notify(port: EnginePort, compose: (session: Session) => Promise<Notice | null>): Promise<void> {
  const session = await readSession(port)
  const branch = session.unit?.branch
  const common = await readCommonDir(port)
  if (!branch || !common) return
  const scope = await findLiveDelegation(port, session.issues)
  if (!scope) return
  const notice = await compose(session)
  // why: the mail send takes the record lock itself, so only the record write is under it; a unit's turn ends one at a time.
  const record = await readNotices(port, branch)
  if (!notice || !isNoticeOwed(record, notice)) return
  const error = await sendNoticeMail(port, notice.to === 'user' ? userAddress : coordinatorAddress(scope.sessionId), session.issues, notice.text)
  await withRecordLock(() => atomicReplace(port, noticePath(common, branch), JSON.stringify(recordNotice(record, notice, error === null))))
  logEvent(port, session, 'notice', { text: notice.text, ...error === null ? {} : { error } })
}

/**
 * Sends a notice the agent cannot report as a mod-written inform, which opens no conversation, so it is never retried or dead-lettered.
 * @param port - The engine calls.
 * @param to - The coordinator's address, or the user's.
 * @param issues - The unit's issues; the first is the conversation key.
 * @param text - The notice.
 * @returns Null once sent, else why not.
 */
async function sendNoticeMail(port: EnginePort, to: string, issues: number[], text: string): Promise<string | null> {
  const sent = await sendMail(port, { kind: 'inform', author: 'mod', to, issue: issues[0]!, body: text }).catch((error: unknown) => fail(formatErrorLine(error)))
  return sent.isOk ? null : sent.error
}
