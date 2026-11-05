import { identifyDialog } from '../domain/dialogs'
import type { Identification } from '../domain/dialogs'
import { composeStallKey, composeStallReport, composeUnknownDialogQuestion, judgeUnit, parseActivity, parseStallRecord, turnStallMs } from '../domain/liveness'
import type { Activity, StallRecord, UnitWatch } from '../domain/liveness'
import { unitAddress, userAddress } from '../domain/mail'
import { removeFile } from '../lib/files'
import { readJson } from '../lib/json'
import { hasExitedZero } from '../lib/process'
import { settle } from '../lib/result'
import type { EnginePort } from './engine-port'
import { logFailure } from './best-effort'
import { readOwnScope } from './delegation'
import { readMailbox, sendMail } from './mailbox'
import { atomicReplace, readCommonDir, recordsPath } from './record-store'
import { readSessionHost, readSessionLiveness } from './session-host'
import { sessionMemory } from './session-memory'
import { isUnitStarting, readSpawnedSession } from './spawn'
import { tickMs } from './timing'
import { askUser } from './user-inbox'
import { readUnitHost } from './unit-host'
import type { UnitHost, UnitWorkspace } from './unit-host'
import { defaultVerifyTimeoutMinutes, readWorkingTreeConfig } from './verify-config'

/** A change to this session's activity: a turn starting or ending, a tool event, or a permission dialog. */
type ActivityEvent = 'turn.start' | 'turn.complete' | 'tool' | 'dialog'

// why: beside the host bucket, which tells a coordinator whether the process runs; this one tells it whether the session moves.
const bucket = 'activity'
/** The choices of the question an unknown dialog becomes: the user answers the dialog in the unit's pane, never through the mod. */
const unknownDialogOptions = ['I answered the dialog in the unit\'s pane', 'Leave it: the unit stays stalled']

/**
 * Names a session's activity record.
 * @param common - The git common directory.
 * @param sessionId - The session.
 * @returns The file path.
 */
const activityPath = (common: string, sessionId: string): string => recordsPath(common, bucket, `${sessionId}.json`)

/**
 * Names the record of the stall last reported for a unit.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @returns The file path.
 */
export const stallPath = (common: string, issue: number): string => recordsPath(common, 'stalls', `${issue}.json`)

/**
 * Records that this session's turn started, ended or moved, or that a permission dialog holds it; a tool event that changes nothing is
 * written at most once a tick, since a silent turn is measured in minutes.
 * @param port - The engine calls.
 * @param event - What happened.
 * @returns Once recorded, or at once outside a repository.
 */
export async function recordActivity(port: EnginePort, event: ActivityEvent): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  const now = await port.now()
  const activity: Activity = { v: 1, isTurn: event === 'turn.start' || (event !== 'turn.complete' && sessionMemory.isTurnLive), at: now, isDialog: event === 'dialog' }
  const key = `${activity.isTurn}:${activity.isDialog}`
  if (event === 'tool' && key === sessionMemory.activity.key && now - sessionMemory.activity.at < tickMs) return
  sessionMemory.activity = { key, at: now }
  await atomicReplace(port, activityPath(common, await port.readSessionId()), JSON.stringify(activity))
}

/**
 * Reports to the user's mailbox each unit of this coordinator's scope that is dead or stalled, once per stall until the unit recovers.
 * @param port - The engine calls.
 * @returns Once every running unit was judged; at once without a scope or a host.
 */
export async function reportStalledUnits(port: EnginePort): Promise<void> {
  const scope = await readOwnScope(port)
  const host = scope ? await readUnitHost(port) : null
  const common = await readCommonDir(port)
  if (!scope || !host || !common) return
  const config = await readWorkingTreeConfig(port)
  const limit = turnStallMs(config?.kind === 'valid' ? config.config.timeoutMinutes : defaultVerifyTimeoutMinutes)
  for (const workspace of (await host.list(port)).filter(each => scope.issues.includes(each.issue))) {
    const issue = workspace.issue
    const session = await isUnitStarting(port, issue) ? null : await readSpawnedSession(port, issue, false)
    const watch = session ? await watchUnit(port, host, common, workspace, session) : null
    const stall = watch ? judgeUnit(watch, await port.now(), limit) : null
    if (!session || !watch || !stall) {
      // why: a blocked unit is not yet recovered, even while one tick is too few to count it, so its report is kept.
      if (!watch?.isBlockedNow) await clearStallRecord(port, common, issue)
      continue
    }
    const key = composeStallKey(session, stall, watch)
    // why: a record that cannot be read counts as none, so a doubt reports again rather than losing a report.
    const recorded = sessionMemory.stallReports.get(issue) ?? parseStallRecord(await readJson(port.files, stallPath(common, issue)).catch(() => undefined))?.key
    if (recorded === key) continue
    // why: the pane is read only here, once per reported episode, to name what holds the unit; no stall clause ever reads it.
    const seen: Identification = stall === 'dead' ? { kind: 'none' } : await readDialog(port, host, workspace)
    const dialog = seen.kind === 'known' ? seen.entry : undefined
    const sent = seen.kind === 'unknown' && stall !== 'dead'
      ? await askUser(port, issue, composeUnknownDialogQuestion([issue], stall, limit, seen.excerpt), unknownDialogOptions, [])
      : await sendMail(port, { kind: 'inform', author: 'mod', to: userAddress, issue, body: composeStallReport([issue], stall, limit, dialog) })
    logFailure(port, 'stall report', sent)
    if (!sent.isOk) continue
    // why: written after the send, so a crash between the two repeats a report and never loses one; memory holds it if the write fails.
    sessionMemory.stallReports.set(issue, key)
    const record: StallRecord = { v: 1, session, stall, key, ...dialog ? { dialog: dialog.id } : {} }
    logFailure(port, 'stall record', await settle(atomicReplace(port, stallPath(common, issue), JSON.stringify(record))))
  }
}

/**
 * Identifies the dialog a unit's visible screen shows; a screen herdr does not read names none, so the report goes out unnamed.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param workspace - The unit's workspace.
 * @returns The identification.
 */
export async function readDialog(port: EnginePort, host: UnitHost, workspace: UnitWorkspace): Promise<Identification> {
  const screen = await settle(host.screen(port, workspace))
  logFailure(port, 'unit screen read', screen)
  return screen.isOk ? identifyDialog(screen.value) : { kind: 'none' }
}

/**
 * Forgets the stall reported for a unit, in memory and on disk, so its next stall is reported again.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @returns Once forgotten.
 */
export async function clearStallRecord(port: EnginePort, common: string, issue: number): Promise<void> {
  sessionMemory.stallReports.delete(issue)
  if (await port.files.exists(stallPath(common, issue)).catch(() => false)) logFailure(port, 'stall record delete', hasExitedZero(await removeFile(port.processes, stallPath(common, issue))))
}

/**
 * Reads what judging a unit needs: whether its recorded process ended, its activity, its oldest unread mail and herdr's blocked on two ticks in a row.
 * @param port - The engine calls.
 * @param host - The session host.
 * @param common - The git common directory.
 * @param workspace - The unit's workspace.
 * @param session - The unit's session.
 * @returns The watch, or null while the unit's process cannot be judged.
 */
async function watchUnit(port: EnginePort, host: UnitHost, common: string, workspace: UnitWorkspace, session: string): Promise<UnitWatch | null> {
  const liveness = await readSessionLiveness(port, session)
  if (liveness === 'unknown') return null
  if (liveness === 'gone') return { isGone: true, pidStart: (await readSessionHost(port, session))?.pidStart ?? '', activity: null, oldestUnread: null, isBlockedNow: false, isBlocked: false }
  const now = await port.now()
  // why: herdr shows a permission dialog blocked seconds before the engine's notification marks it in the activity record, so herdr's
  // blocked counts only once a tick has passed for that notification to arrive.
  const isHerdrBlocked = await host.isBlocked(port, workspace)
  const wasBlocked = sessionMemory.blockedUnits.has(workspace.issue)
  if (isHerdrBlocked) sessionMemory.blockedUnits.add(workspace.issue)
  else sessionMemory.blockedUnits.delete(workspace.issue)
  const unread = (await readMailbox(port, common, unitAddress(workspace.issue))).flatMap(({ box, envelope }) => box === 'new' ? [{ id: envelope.id, at: Date.parse(envelope.created_at) }] : [])
  const oldest = unread.reduce<typeof unread[number] | null>((first, each) => !first || each.at < first.at ? each : first, null)
  return { isGone: false, pidStart: '', activity: parseActivity(await readJson(port.files, activityPath(common, session)).catch(() => undefined)),
    oldestUnread: oldest ? { id: oldest.id, ageMs: now - oldest.at } : null, isBlockedNow: isHerdrBlocked, isBlocked: isHerdrBlocked && wasBlocked }
}
