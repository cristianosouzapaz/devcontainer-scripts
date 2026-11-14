import { identifyDialog } from '../domain/dialogs'
import type { Identification } from '../domain/dialogs'
import { composeStallKey, composeStallReport, composeUnknownDialogQuestion, judgeUnit, parseActivity, parseStallRecord, turnStallMs } from '../domain/liveness'
import type { Activity, StallRecord, UnitWatch } from '../domain/liveness'
import { unitAddress, userAddress } from '../domain/mail'
import { removeFile } from '../lib/files'
import { readJson } from '../lib/json'
import { hasExitedZero } from '../lib/process'
import { settle } from '../lib/result'
import type { ProcessState } from '../../types'
import type { EnginePort } from './engine-port'
import { bestEffort, logFailure } from './best-effort'
import { readOwnScope } from './delegation'
import { readMailbox, sendMail } from './mailbox'
import { publishFenced } from './session-publish'
import { readProcessState, settleLegacyReading, updateProcessState } from './process-state'
import type { LegacyReading } from './process-state'
import { atomicReplace, readCommonDir, recordsPath } from './record-store'
import { stampHost } from './host'
import { readSessionHost, readSessionHostStrictly, readSessionLiveness } from './session-host'
import { sessionMemory } from './session-memory'
import { isSpawnLockHeld, isUnitStarting, readSpawnedSession } from './spawn'
import { endedTurnLimit, tickMs } from './timing'
import { askUser } from './user-inbox'
import { readUnitHost } from './unit-host'
import type { UnitHost, UnitWorkspace } from './unit-host'
import { readFault } from './fault-registry'
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
 * Records at a session start whether a turn runs, from the process state: a new process holds no turn, so a turn its crashed
 * predecessor left recorded as running is recorded idle, while a reload in the middle of a turn keeps it running.
 * @param port - The engine calls.
 * @param state - The process state the start adopted, or null when unknown, which leaves the record as it is.
 * @returns Once recorded, or at once when the record already says so, holds a newer observation, or outside a repository.
 */
export async function resetActivity(port: EnginePort, state: ProcessState | null): Promise<void> {
  const common = await readCommonDir(port)
  if (!state || !common) return
  // why: an earlier version's record that could not be read is never written over until it is read, as it may hold the turn running now.
  if (state.legacy) return
  const path = activityPath(common, await port.readSessionId())
  const toolsError = readFault('tools') ?? undefined
  // why: a load a reload started cannot know a turn change the load it replaced heard and never recorded, so a coordinator reads its turn state as unknown until it hears one itself, never as idle.
  const isUncertain = sessionMemory.isActivityUnchecked
  await publishFenced(port, path, async held => {
    if (isUncertain) {
      const activity = await readActivity(port, path)
      if (activity?.isUnknown) return
      // why: a record with no epoch, as an earlier version's, takes this one, or no later tool event of its turn could move its time.
      await atomicReplace(port, path, JSON.stringify({ ...activity ?? { v: 1, isTurn: false, isDialog: false, ...state.generation ? { generation: state.generation } : {} },
        epoch: activity?.epoch ?? state.epoch, at: await port.now(), ...toolsError ? { toolsError } : {}, isUnknown: true } satisfies Activity), undefined, held)
      return
    }
    const source = await readFresher(port, state)
    const isTurn = !!source.turn
    const activity = await readActivity(port, path)
    // why: an idle start writes no record where none is, and a record already saying so at this epoch is left; one with no epoch, as the version before the process state wrote, gets this epoch, or no later tool event could move its time.
    if (!activity && !isTurn && !toolsError) return
    const isSameProcess = isOfProcess(activity, source.generation)
    if (activity && isSameProcess && activity.generation === (source.generation || undefined) && activity.isTurn === isTurn && activity.toolsError === toolsError && activity.epoch === source.epoch) return
    // why: a record another process wrote is never newer than this process's state, whatever its epoch.
    if (isSameProcess && isOlderThan(source.epoch, activity, source.turn?.id ?? '')) return
    await atomicReplace(port, path, JSON.stringify({ v: 1, isTurn, at: await port.now(), isDialog: false, ...toolsError ? { toolsError } : {}, epoch: source.epoch,
      ...source.turn ? { turnId: source.turn.id } : {}, ...source.generation ? { generation: source.generation } : {} } satisfies Activity), undefined, held)
  })
}

/**
 * Records whether this process's tools failed to register, so the coordinator's stall check names that cause; the turn the record
 * holds is left as it is, since a registration that settles late may land in a turn.
 * @param port - The engine calls.
 * @returns Once recorded, or at once when the record already holds this outcome, or outside a repository.
 */
export async function recordToolsOutcome(port: EnginePort): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  const path = activityPath(common, await port.readSessionId())
  const toolsError = readFault('tools') ?? undefined
  // why: a record this check cannot read leaves the publish to decide under its lock, where an unreadable record writes nothing and is shown.
  const seen = await readActivity(port, path).then(activity => ({ activity }), () => null)
  if (seen && seen.activity?.toolsError === toolsError) return
  await publishFenced(port, path, async held => {
    const activity = await readActivity(port, path)
    if (activity?.toolsError === toolsError) return
    // why: only the registration outcome changes; every other field, the reload's uncertainty among them, stays as the record holds it.
    const next: Activity = { ...activity ?? { v: 1, isTurn: false, at: await port.now(), isDialog: false }, toolsError }
    if (!toolsError) delete next.toolsError
    await atomicReplace(port, path, JSON.stringify(next), undefined, held)
  })
}

/**
 * Reads what the records an earlier module left say, for a session start that finds no process state held, and to settle them later.
 * @param port - The engine calls.
 * @returns The process the host record names, null for none, the activity record's turn and epoch, null for none, each `unread` when its
 * record could not be read, and this process's own identity, null when it could not be read.
 */
export async function readLegacyReading(port: EnginePort): Promise<LegacyReading> {
  const common = await readCommonDir(port)
  if (!common) return { host: null, activity: null, own: null }
  const sessionId = await port.readSessionId()
  // why: a record that cannot be read is unknown, never absent: it may hold the turn running now, so it is never read as idle.
  const activity = await readJson(port.files, activityPath(common, sessionId)).then(value => {
    const parsed = parseActivity(value)
    return parsed ? { isTurn: parsed.isTurn, epoch: parsed.epoch ?? 0, ...parsed.turnId ? { turnId: parsed.turnId } : {} } : null
  }, () => 'unread' as const)
  const [recorded, own] = await Promise.all([readSessionHostStrictly(port, sessionId), stampHost(port).catch(() => null)])
  return { host: recorded === null ? 'unread' : recorded.value, activity, own }
}

/**
 * Brings the process state up to a turn change only the activity record holds: a turn start or end whose process-state write failed
 * still records its activity, so the record runs ahead, and adopting it carries the missing change over a reload. A record of a newer
 * epoch is adopted, and so is one of the same epoch naming a running turn the state does not hold, as the two histories then disagree and
 * only the running one is safe. With nothing to adopt while a write fault stands, a plain write tests the host again.
 * @param port - The engine calls.
 * @returns The process state to decide on now, or null when it is unknown.
 */
export async function reconcileProcessState(port: EnginePort): Promise<ProcessState | null> {
  const read = await readProcessState(port)
  const common = await readCommonDir(port)
  if (!read || !common) return read
  const state = read.legacy ? await resolveLegacy(port, read) : read
  // why: a record that cannot be read adopts nothing; a reload that has not read it yet holds the session, and the next tick reads it again.
  const seen = await readActivity(port, activityPath(common, await port.readSessionId())).then(activity => ({ activity }), () => null)
  if (!seen) return state
  const { activity } = seen
  const recorded = activity?.epoch
  // why: a start always reaches the record unless it names a turn already ended there, so a record of a newer epoch holds every change the state lacks, and is adopted whole; only a second fault, a start whose state write landed and whose publish failed, escapes it.
  // why: a record that shows running a turn the state saw end is one whose end failed to publish, never newer; one another process wrote is never newer than this process's state.
  const isAhead = (held: ProcessState): boolean => !!activity && recorded !== undefined && isOfProcess(activity, held.generation) && !(activity.isTurn && activity.turnId && held.endedTurns?.includes(activity.turnId))
    && (recorded > held.epoch || recorded === held.epoch && activity.isTurn && activity.turnId !== undefined && held.turn?.id !== activity.turnId)
  if (activity && recorded !== undefined && isAhead(state)) {
    const carried = { id: activity.turnId ?? '', hasSent: true, isInformOnly: false, isEmptyDoorbell: false }
    const adopted = await bestEffort(port, 'process state adoption', () => updateProcessState(port, held => !isAhead(held) ? held
      : { ...held, epoch: recorded, ...activity.isTurn ? { turn: held.turn?.id === carried.id ? held.turn : carried } : { turn: null, prompt: null, ...withEnded(held, activity.turnId) } }), null)
    return adopted
  }
  // why: a turn the record shows ended stays ended in the state too, so a start of it written late never sets it running; and one a replaced load's late start set running again is ended, as a turn never runs after its end.
  if (activity && !activity.isTurn && activity.turnId && (!state.endedTurns?.includes(activity.turnId) || state.turn?.id === activity.turnId)) {
    const turnId = activity.turnId
    const ended = await bestEffort(port, 'ended turn', () => updateProcessState(port, held => ({ ...held, ...withEnded(held, turnId),
      ...held.turn?.id === turnId ? { turn: null, prompt: null } : {} })), null)
    if (ended) return ended
  }
  if (readFault('process-write') === null) return state
  return bestEffort(port, 'process state write test', () => updateProcessState(port, held => held), null)
}

/**
 * Tells whether a record is of the process whose state has this generation, or cannot tell processes apart: a record or a state that names
 * no generation, as an earlier version's or one whose state was unknown, is compared by its epoch.
 * @param activity - The record.
 * @param generation - The state's generation.
 * @returns Whether its epoch is comparable.
 */
const isOfProcess = (activity: Activity | null, generation: string | undefined): boolean => !activity?.generation || !generation || activity.generation === generation

/**
 * Adds a turn the record shows ended to the state's ended turns.
 * @param held - The state.
 * @param turnId - The turn, or undefined for none.
 * @returns The field to write, empty when there is nothing to add.
 */
const withEnded = (held: ProcessState, turnId: string | undefined): Pick<ProcessState, 'endedTurns'> => !turnId || held.endedTurns?.includes(turnId) ? {}
  : { endedTurns: [...held.endedTurns ?? [], turnId].slice(-endedTurnLimit) }

/**
 * Reads again what an earlier version's records left unknown at the process state's seeding, and, once every record and this process's
 * identity can be read, settles whether a turn runs as the seeding would have: a turn of this very process is carried, any other is
 * none. What the seeding read is kept, so a record this process wrote since never stands in for the one it replaced; a turn change written
 * meanwhile settled it already, and is kept.
 * @param port - The engine calls.
 * @param state - The process state, still unresolved.
 * @returns The state to decide on now: settled, or still unresolved, with what was read now kept.
 */
async function resolveLegacy(port: EnginePort, state: ProcessState): Promise<ProcessState> {
  const legacy = state.legacy
  if (!legacy) return state
  const settled = settleLegacyReading(await readLegacyReading(port), legacy)
  const carried = { id: '', hasSent: true, isInformOnly: false, isEmptyDoorbell: false }
  return await bestEffort(port, 'legacy activity adoption', () => updateProcessState(port, held => {
    if (!held.legacy) return held
    if (settled.kind === 'unresolved') return { ...held, legacy: settled.evidence }
    return { ...held, legacy: undefined, epoch: Math.max(held.epoch, settled.epoch + 1), turn: held.turn ?? (settled.isSameProcess && settled.isTurn ? carried : null) }
  }), null) ?? state
}

/**
 * Records that this session's turn started or ended, that a tool moved it, or that a permission dialog holds it. A turn's start or end
 * is written at the epoch its own write reached, unless the record already holds a newer observation; a tool event or a dialog only moves a
 * record that holds the very turn it saw, so a call an interrupt abandoned, ending after its turn did, never records that turn again.
 * A tool event that changes nothing is written at most once a tick, since a silent turn is measured in minutes.
 * @param port - The engine calls.
 * @param event - What happened.
 * @param state - The process state this dispatch holds, null when unknown, which writes nothing but a turn's start or end; for a turn's
 * start or end, the state its own write reached, or would have.
 * @param turnId - The turn a start or end is about, which fences the record by turn identity.
 * @returns Once recorded, or at once outside a repository.
 */
export async function recordActivity(port: EnginePort, event: ActivityEvent, state: ProcessState | null, turnId?: string): Promise<void> {
  const common = await readCommonDir(port)
  const isTurnChange = event === 'turn.start' || event === 'turn.complete'
  if (!common || !state && !isTurnChange) return
  const path = activityPath(common, await port.readSessionId())
  const now = await port.now()
  const tools = readFault('tools')
  const toolsError = tools ? { toolsError: tools } : {}
  if (isTurnChange) {
    await publishFenced(port, path, async held => {
      // why: a turn change is published at the epoch of its own write, never at a newer one read meanwhile, which a later change reached, so a late publish of an earlier change never reads as newer; one whose state is unknown, its read and its write both failed, is published past the record, which then carries it for the tick to adopt.
      const epochOf = state?.epoch ?? -1
      const record = await readActivity(port, path)
      // why: a record another process wrote is never newer than a change of this one.
      if (isOfProcess(record, state?.generation) && !acceptsTurnChange(record, event, turnId, epochOf)) return
      // why: a change of a known state is published at that state's epoch, so the record never runs ahead of the state but by a change whose state write failed; one whose state is unknown steps past the record, which the tick then adopts.
      const epoch = state ? epochOf : (record?.epoch ?? -1) + 1
      sessionMemory.activity = { key: `${epoch}:false`, at: now }
      await atomicReplace(port, path, JSON.stringify({ v: 1, isTurn: event === 'turn.start', at: now, isDialog: false, ...toolsError, epoch,
        ...turnId === undefined ? {} : { turnId }, ...state?.generation ? { generation: state.generation } : {} } satisfies Activity), undefined, held)
    })
    return
  }
  if (!state) return
  const isDialog = event === 'dialog'
  const key = `${state.epoch}:${isDialog}`
  if (!isDialog && key === sessionMemory.activity.key && now - sessionMemory.activity.at < tickMs) return
  // why: the record is read and replaced under the session's publish lock, from the process state read under it, so a turn end landing between the two cannot be written over.
  await publishFenced(port, path, async held => {
    const source = await readProcessState(port)
    const activity = await readActivity(port, path)
    const isSameTurn = !!source?.turn && !!activity?.isTurn && (activity.turnId === undefined ? activity.epoch === source.epoch : activity.turnId === source.turn.id)
    if (!isSameTurn) return
    sessionMemory.activity = { key, at: now }
    await atomicReplace(port, path, JSON.stringify({ ...activity, at: now, isDialog, ...toolsError } satisfies Activity), undefined, held)
  })
}

/**
 * Reads the process state under a publish's lock and keeps the fresher of it and the state the caller holds: the caller's is fresher
 * only when its own write of that change failed, which the record then carries ahead for the tick to adopt.
 * @param port - The engine calls.
 * @param state - The state the caller holds.
 * @returns The state to publish from.
 */
async function readFresher(port: EnginePort, state: ProcessState): Promise<ProcessState> {
  const authority = await readProcessState(port)
  return authority && authority.epoch >= state.epoch ? authority : state
}

/**
 * Reads this session's activity record, the fence its publishes write against: a record that cannot be read is never taken for none,
 * or an older observation would replace a newer one, so the read throws and the publish writes nothing, which the pane shows.
 * @param port - The engine calls.
 * @param path - The record.
 * @returns The record, or null when it is missing or not a record of this shape.
 * @throws When the record cannot be read.
 */
const readActivity = async (port: EnginePort, path: string): Promise<Activity | null> => parseActivity(await readJson(port.files, path))

/**
 * Tells whether an observation must never replace the one the record holds: the record is of a newer epoch, or of the same epoch with a
 * running turn other than the one the observation names.
 * @param epoch - The epoch the observation was made at.
 * @param activity - The record.
 * @param turnId - The turn the observation names, if any.
 * @returns Whether the record holds a newer one.
 */
const isOlderThan = (epoch: number, activity: Activity | null, turnId?: string): boolean => activity?.epoch !== undefined
  && (activity.epoch > epoch || activity.epoch === epoch && activity.isTurn && activity.turnId !== undefined && turnId !== undefined && activity.turnId !== turnId)

/**
 * Tells whether a turn's start or end may be written over the record: a start, unless the record shows that very turn ended, as a start
 * heard after its own end, or holds a newer observation of any later change, as a start whose publish landed late, though one of the
 * same turn still running is refreshed; an end, by turn
 * identity, unless the record shows another turn running, as an end of an earlier turn heard after a later one started. A record that names no turn, as an earlier version's, or the carried turn, is fenced by its epoch.
 * @param record - The record.
 * @param event - The change.
 * @param turnId - The turn it is about.
 * @param epoch - The epoch the change was made at.
 * @returns Whether it may.
 */
function acceptsTurnChange(record: Activity | null, event: 'turn.start' | 'turn.complete', turnId: string | undefined, epoch: number): boolean {
  if (!record || turnId === undefined) return !isOlderThan(epoch, record)
  // why: a record that names no turn, or the carried turn whose id no load saw, cannot tell turns apart, so any end ends its turn.
  if (record.turnId === undefined || record.turnId === '') return !isOlderThan(epoch, record) || event === 'turn.complete' && record.isTurn
  if (event === 'turn.complete') return !record.isTurn || record.turnId === turnId
  return !(!record.isTurn && record.turnId === turnId) && (!isOlderThan(epoch, record) || record.isTurn && record.turnId === turnId)
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
    const starting = await isUnitStarting(port, issue)
    // why: a unit spawn may be starting is not judged, so the user is told once why, and the next tick judges it once the doubt is gone.
    if (starting.kind === 'unknown') {
      await reportCannotTell(port, common, issue, 'starting', `The mod cannot tell whether spawn is starting #${issue} (${starting.reason}), so its stall `
        + `check skips #${issue} until it can. Check that no spawn of #${issue} is still running, and that the file named, if any, can be read.`)
      continue
    }
    const session = starting.kind === 'yes' ? null : await readSpawnedSession(port, issue, false)
    const watch = session ? await watchUnit(port, host, common, workspace, session) : null
    const stall = watch ? judgeUnit(watch, await port.now(), limit) : null
    // why: a close or retirement ends the process under the spawn lock and frees it once herdr no longer lists the workspace, so the list read at the sweep's start can predate a close that has since ended the unit on purpose; a held lock waits a tick, never longer.
    const lock = stall === 'dead' ? await isSpawnLockHeld(port, common) : null
    if (lock && !lock.isOk) {
      await reportCannotTell(port, common, issue, 'lock', `#${issue}'s session process has ended, but the mod cannot tell whether a close or retirement `
        + `ended it on purpose, since the spawn lock cannot be read (${lock.error}); #${issue} is not reported dead until it can. Check that lock file.`)
      continue
    }
    if (lock?.value) continue
    const isClosed = stall === 'dead' && !(await host.list(port)).some(each => each.issue === issue)
    if (!session || !watch || !stall || isClosed) {
      // why: a blocked unit is not yet recovered, even while one tick is too few to count it, so its report is kept.
      if (!watch?.isBlockedNow) await clearStallRecord(port, common, issue)
      continue
    }
    const key = composeStallKey(session, stall, watch)
    // why: a record that cannot be read counts as none, so a doubt reports again rather than losing a report.
    const recorded = sessionMemory.stallReports.get(issue) ?? parseStallRecord(await readJson(port.files, stallPath(common, issue)).catch(() => undefined))?.key
    if (recorded === key) continue
    // why: the pane is read only here, once per reported episode, to name what holds the unit; no stall clause ever reads it.
    const seen: Identification = stall === 'dead' || stall === 'tools' ? { kind: 'none' } : await readDialog(port, host, workspace)
    const dialog = seen.kind === 'known' ? seen.entry : undefined
    const sent = seen.kind === 'unknown' && stall !== 'dead'
      ? await askUser(port, issue, composeUnknownDialogQuestion([issue], stall, limit, activityPath(common, session), seen.excerpt), unknownDialogOptions, [])
      : await sendMail(port, { kind: 'inform', author: 'mod', to: userAddress, issue, body: composeStallReport([issue], stall, limit, activityPath(common, session), dialog) })
    logFailure(port, 'stall report', sent)
    if (!sent.isOk) continue
    // why: written after the send, so a crash between the two repeats a report and never loses one; memory holds it if the write fails.
    sessionMemory.stallReports.set(issue, key)
    const record: StallRecord = { v: 1, session, stall, key, ...dialog ? { dialog: dialog.id } : {} }
    logFailure(port, 'stall record', await settle(atomicReplace(port, stallPath(common, issue), JSON.stringify(record))))
  }
}

/**
 * Tells the user once that the sweep cannot judge a unit, keyed by the unit and the reason's kind through the stall record, so a reload
 * does not tell it again; the record is cleared, as any stall's, once the sweep judges the unit again.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The unit's issue.
 * @param kind - What could not be read: whether spawn starts the unit, or the spawn lock behind a dead unit.
 * @param body - The inform: what cannot be told, why, and how to check.
 * @returns Once the user was told, or the doubt was told before; a failed send is retried at the next tick.
 */
async function reportCannotTell(port: EnginePort, common: string, issue: number, kind: 'starting' | 'lock', body: string): Promise<void> {
  const key = `cannot-tell:${issue}:${kind}`
  // why: a record that cannot be read counts as none, so a doubt reports again rather than losing a report.
  const recorded = sessionMemory.stallReports.get(issue) ?? parseStallRecord(await readJson(port.files, stallPath(common, issue)).catch(() => undefined))?.key
  if (recorded === key) return
  const sent = await sendMail(port, { kind: 'inform', author: 'mod', to: userAddress, issue, body })
  logFailure(port, 'cannot-tell report', sent)
  if (!sent.isOk) return
  sessionMemory.stallReports.set(issue, key)
  const record: StallRecord = { v: 1, session: 'cannot-tell', stall: 'cannot-tell', key }
  logFailure(port, 'stall record', await settle(atomicReplace(port, stallPath(common, issue), JSON.stringify(record))))
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
 * @returns The watch.
 */
async function watchUnit(port: EnginePort, host: UnitHost, common: string, workspace: UnitWorkspace, session: string): Promise<UnitWatch> {
  // why: a unit stopped by a dialog shown before its mod loads never records its process, so unknown is judged as running.
  const liveness = await readSessionLiveness(port, session)
  if (liveness === 'gone') return { isGone: true, pidStart: (await readSessionHost(port, session))?.pidStart ?? '', activity: null, oldestUnread: null, isBlockedNow: false, isBlocked: false }
  const now = await port.now()
  // why: herdr shows a permission dialog blocked seconds before the engine's notification marks it in the activity record, so herdr's blocked counts only once a tick has passed for that notification to arrive.
  const isHerdrBlocked = await host.isBlocked(port, workspace)
  const wasBlocked = sessionMemory.blockedUnits.has(workspace.issue)
  if (isHerdrBlocked) sessionMemory.blockedUnits.add(workspace.issue)
  else sessionMemory.blockedUnits.delete(workspace.issue)
  const unread = (await readMailbox(port, common, unitAddress(workspace.issue))).flatMap(({ box, envelope }) => box === 'new' ? [{ id: envelope.id, at: Date.parse(envelope.created_at) }] : [])
  const oldest = unread.reduce<typeof unread[number] | null>((first, each) => !first || each.at < first.at ? each : first, null)
  // why: a unit's record this coordinator cannot read is reported with its turn state unknown, never read as idle.
  return { isGone: false, pidStart: '', activity: parseActivity(await readJson(port.files, activityPath(common, session)).catch(() => undefined)),
    oldestUnread: oldest ? { id: oldest.id, ageMs: now - oldest.at } : null, isBlockedNow: isHerdrBlocked, isBlocked: isHerdrBlocked && wasBlocked }
}
