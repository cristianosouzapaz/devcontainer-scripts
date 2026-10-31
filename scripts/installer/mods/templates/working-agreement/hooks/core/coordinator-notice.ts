import { composePermissionNotice, composeTurnNotice, isNoticeOwed, parseNoticeRecord, recordNotice } from '../domain/notice'
import type { Notice, NoticeRecord, UnitTurn } from '../domain/notice'
import type { Session } from '../domain/records'
import { facts } from '../domain/facts'
import { readJson } from '../lib/json'
import { formatErrorLine } from '../lib/result'
import { findLiveDelegation } from './delegation'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { isInsideHerdr, runHerdrText } from './herdr-worktrees'
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
 * Tells the coordinator holding this delegated unit's scope what its turn ended on, once per changed state;
 * a failed send stays owed and is sent again at the next turn end.
 * @param port - The engine calls.
 * @param turn - How the turn ended.
 * @returns Once the notice is sent, skipped or held.
 */
export function noticeTurnEnd(port: EnginePort, turn: Pick<UnitTurn, 'reason' | 'answer'>): Promise<void> {
  return notify(port, async session => {
    const position = await locatePosition(port, session)
    const current = position?.current?.step
    return record => composeTurnNotice({ ...turn, issues: session.issues, step: current ? { id: current.id, label: current.label, isHuman: !!current.isHuman } : null,
      tree: position?.slice?.tree ?? null, verifyFact: position?.verify.isVerified ? null : position?.verify.fact || facts.verifyNotRun, last: record })
  })
}

/**
 * Tells the coordinator holding this delegated unit's scope that a permission dialog blocks the unit.
 * @param port - The engine calls.
 * @param message - The dialog's notification text.
 * @returns Once the notice is sent, skipped or held.
 */
export function noticePermission(port: EnginePort, message: string): Promise<void> {
  return notify(port, async session => () => composePermissionNotice(session.issues, message))
}

/**
 * Sends a delegated unit's owed notice to its coordinator's pane and records the outcome.
 * @param port - The engine calls.
 * @param compose - Reads the unit's session state, off the lock, into a composer of the notice from its last notice record.
 * @returns Once done; nothing is sent outside a delegated unit, outside herdr, or to a scope that names no pane.
 */
async function notify(port: EnginePort, compose: (session: Session) => Promise<(record: NoticeRecord | null) => Notice | null>): Promise<void> {
  const session = await readSession(port)
  const branch = session.unit?.branch
  const common = await readCommonDir(port)
  if (!branch || !common || !await isInsideHerdr(port)) return
  const paneId = (await findLiveDelegation(port, session.issues))?.paneId
  if (!paneId) return
  const composeFrom = await compose(session)
  await withRecordLock(async () => {
    const record = await readNotices(port, branch)
    const notice = composeFrom(record)
    if (!notice || !isNoticeOwed(record, notice)) return
    // herdr 0.9.5 takes the text as a positional argument and rejects `--` before it.
    const error = await runHerdrText(port, ['agent', 'prompt', paneId, notice.text]).then(() => null, formatErrorLine)
    await atomicReplace(port, noticePath(common, branch), JSON.stringify(recordNotice(record, notice, error === null)))
    logEvent(port, session, 'notice', { text: notice.text, ...error === null ? {} : { error } })
  })
}
