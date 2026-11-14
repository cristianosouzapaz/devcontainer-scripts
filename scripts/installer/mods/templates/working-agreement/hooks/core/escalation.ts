import { fail, formatErrorLine, settle, succeed } from '../lib/result'
import { describeOutcome, isStopped, stop, unknown } from '../domain/outcome'
import type { Result } from '../lib/result'
import { judgeEscalator, readOwnScope } from './delegation'
import type { Unit } from '../domain/records'
import type { EnginePort } from './engine-port'
import { coordinatorAddress, userAddress } from '../domain/mail'
import { logFailure } from './best-effort'
import { UnansweredRenameError } from './host-lock'
import { sendMail } from './mailbox'
import { readCommonDir, readSession, readSessionMirrors, readUnit } from './record-store'
import { sessionMemory } from './session-memory'
import { outsideHerdr } from './herdr-worktrees'
import { readUnitHost } from './unit-host'
import { busyWaitMs, describeMessage, describeUnsent, escalateUnit, isTopLevel, isUnitIdle, progressPath, readProgressFile, readSpawnProgress, withSpawnLock,
  writeProgress } from './spawn'
import type { Escalation, SessionSeen } from './spawn'

/** What the sweep did for one unit: its notice, and whether the escalation went through. */
interface Escalated { issue: number; notice: string; isOk: boolean }

/** Verify refused so a live coordinator's sweep can escalate the unit once its turn ends. */
interface EscalationRefusal { kind: 'refused'; text: string }

/** Verify runs, and its result carries why no escalation is awaited. */
interface EscalationNote { kind: 'note'; text: string }

/** What two red Verifies below the top level mean for this session's next Verify. */
export type EscalationStop = EscalationRefusal | EscalationNote

/** What a write through the spawn lock's fenced rename established: written, or unknown when its rename went unanswered. */
type FencedWrite = { kind: 'written' } | { kind: 'unknown'; error: string }

/** The signal two red Verifies in a row give. */
const redSignal = 'two consecutive red Verifies'
// why: a unit's turn-end notice reaches the coordinator while herdr may still report that turn as working.
const idleWaitMs = 5000

/**
 * Judges this session's Verify once the unit was spawned below the top level and its last two own Verify calls ran red: refused while
 * a live coordinator's sweep can escalate it, which it does only for an idle unit; otherwise Verify runs, with a note saying why no
 * escalation is awaited.
 * @param port - The engine calls.
 * @returns The refusal or the note, or null when the unit is not red below the top level.
 */
export async function describeEscalationStop(port: EnginePort): Promise<EscalationStop | null> {
  const identity = (await readSession(port)).unit
  if (!identity?.issues.length || !isRed(await readUnit(port, identity))) return null
  const signal = `${redSignal} below the top level`
  const unknowns: string[] = []
  const unescalated: number[] = []
  for (const issue of identity.issues) {
    const progress = await readSpawnProgress(port, issue)
    if (!progress?.isStarted || isTopLevel(progress)) continue
    const escalator = await judgeEscalator(port, issue)
    if (escalator.liveness === 'live') {
      return { kind: 'refused', text: `Verify refused: ${signal}. End the turn now: the coordinator's mod will try to resume this session on the user's `
        + 'default model with effort high, keeping the conversation. If it cannot, the coordinator is told, not this session: while this '
        + 'session stays below the top level and that coordinator runs, its next Verify is refused again.' }
    }
    if (escalator.liveness === 'unknown') unknowns.push(escalator.why)
    else unescalated.push(issue)
  }
  if (unknowns.length) {
    return { kind: 'note', text: `Note: ${signal}, but the mod cannot tell whether a coordinator is running (${unknowns.join('; ')}), so it does not wait for an escalation.` }
  }
  if (!unescalated.length) return null
  const commands = unescalated.map(issue => `\`escalate_unit ${issue}\``).join(' or ')
  return { kind: 'note', text: `Note: ${signal}, but no live coordinator can escalate this session. Tell the user, who can run \`/flow coordinate\`, then `
    + `\`/flow delegate ${unescalated.join(' ')}\` there, then ${commands} (its sweep also escalates this session on its own while two Verifies are red), `
    + 'or resume this session on a stronger model.' }
}

/**
 * Escalates every unit of this coordinator's scope that has a signal and is idle now: a coordinator request recorded while it worked,
 * or its last two Verify runs red. A unit that works keeps its signal for a later sweep.
 * @param port - The engine calls.
 * @returns One notice per unit escalated, or per escalation that failed.
 */
export async function escalateIdleUnits(port: EnginePort): Promise<Escalated[]> {
  const scope = await readOwnScope(port)
  const notices: Escalated[] = []
  for (const issue of [...scope?.issues ?? []].sort((a, b) => a - b)) {
    const progress = await readSpawnProgress(port, issue)
    if (!progress?.isStarted) continue
    if (isTopLevel(progress)) {
      // why: a request left on a unit already at the top level would raise it again if it were later respawned lower.
      const cleared = progress.escalation ? await clearEscalation(port, issue) : null
      // why: a request left on the record would raise a later lower respawn, so a clear not proven reaches the coordinator; the next sweep clears it again.
      if (cleared && !cleared.isOk) notices.push({ issue, isOk: false, notice: `#${issue} is at the top level, but its escalation request could not be cleared `
        + `(${cleared.error}); the next sweep tries again; check the escalation field of its spawn record` })
      if (cleared?.isOk && cleared.value) notices.push({ issue, isOk: false, notice: `#${issue} is at the top level, and whether its escalation request was cleared `
        + `is unknown (${cleared.value}); the next sweep clears it again if it remains; check the escalation field of its spawn record` })
      continue
    }
    const signal = progress.escalation ? coordinatorSignal(progress.escalation) : await hasTwoRedVerifies(port, issue) ? redSignal : null
    if (!signal) continue
    // why: without a host the unit is never seen idle, so a silent skip would leave a refused unit waiting on an attempt never made.
    if (!await readUnitHost(port)) {
      notices.push({ issue, notice: `#${issue} not escalated (${signal}): ${outsideHerdr}, so the mod cannot see whether its session is idle or `
        + 'restart it. Run this coordinator inside herdr, or have the user resume that session on a stronger model.', isOk: false })
      continue
    }
    if (!await isUnitIdle(port, issue, idleWaitMs)) continue
    const done = await escalateUnit(port, issue, signal)
    if (!done.isOk) {
      // why: a close that did not end changed the session, so only a plain refusal says the unit was not escalated.
      const notice = isStopped(done) || 'isUnknown' in done ? describeOutcome(`#${issue}'s escalation`, done) : `#${issue} not escalated: ${done.error}`
      notices.push({ issue, notice, isOk: false })
      continue
    }
    // why: a prompt's sweep and the tick's can both see the unit idle; the one that runs second finds it already raised, which is no failure.
    if (!done.value) continue
    notices.push({ issue, notice: describeEscalation(issue, signal, done.value), isOk: isResumed(done.value) })
  }
  return notices
}

/**
 * Runs the escalation sweep on the coordinator's tick, where no prompt carries its notices: a failure goes to the coordinator's own
 * mailbox once until another failure takes its place, sent again at each tick until a send succeeds, and a success needs no word, since
 * the unit's pane shows its restart.
 * @param port - The engine calls.
 * @returns Once every failure was kept and every kept one sent, or left for the next tick.
 */
export async function escalateIdleUnitsOnTick(port: EnginePort): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  for (const { issue, notice } of (await escalateIdleUnits(port)).filter(each => !each.isOk)) await keepNotice(port, common, issue, notice)
  const to = coordinatorAddress(await port.readSessionId())
  for (const issue of (await readOwnScope(port))?.issues ?? []) await sendKeptNotice(port, common, issue, to)
}

/**
 * Keeps an escalation failure notice for the tick to send: in memory, and on the unit's spawn record before any send, so a failed send,
 * a reload or a crash leaves it for a later tick. A notice already told or kept is left alone.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue.
 * @param notice - The failure notice.
 * @returns Once it is kept, or its record write left for the next tick.
 */
async function keepNotice(port: EnginePort, common: string, issue: number, notice: string): Promise<void> {
  // why: the tick retries a failed escalation every period, so each failure is told once, until another takes its place.
  if (sessionMemory.escalationNotices.get(issue)?.notice === notice) return
  const progress = await settle(readProgressFile(port, common, issue, true))
  if (progress.isOk && (progress.value.escalationFailure === notice || progress.value.escalationUndelivered === notice)) {
    sessionMemory.escalationNotices.set(issue, { notice, isRecorded: true, isSent: progress.value.escalationFailure === notice, isWarned: false })
    return
  }
  sessionMemory.escalationNotices.set(issue, { notice, isRecorded: false, isSent: false, isWarned: false })
  await recordNotice(port, common, issue)
}

/**
 * Writes a kept, unsent notice to the unit's spawn record under the spawn lock, merged into the record read there so no concurrent spawn
 * write is lost; a write that fails is retried at each tick, and the user is told once that the notice lives only in memory meanwhile.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue.
 * @returns Once it is recorded, or its failure told.
 */
async function recordNotice(port: EnginePort, common: string, issue: number): Promise<void> {
  const kept = sessionMemory.escalationNotices.get(issue)
  if (!kept || kept.isRecorded || kept.isSent) return
  const written = await withSpawnLock(port, async () => {
    await writeProgress(port, common, issue, { ...await readProgressFile(port, common, issue, true), escalationUndelivered: kept.notice })
    return succeed(undefined)
  })
  if (written.isOk) {
    sessionMemory.escalationNotices.set(issue, { ...kept, isRecorded: true })
    return
  }
  logFailure(port, 'escalation failure notice record', written)
  if (kept.isWarned) return
  const warned = await sendMail(port, { kind: 'inform', author: 'mod', to: userAddress, issue, body: `The coordinator could not record #${issue}'s `
    + `escalation failure notice on its spawn record (${written.error}). It retries at each tick; until the notice is recorded or sent, it lives `
    + `only in this session's memory and is lost if the session ends. Check ${progressPath(common, issue)}. The notice: ${kept.notice}` })
  logFailure(port, 'escalation failure notice warning', warned)
  if (warned.isOk) sessionMemory.escalationNotices.set(issue, { ...kept, isWarned: true })
}

/**
 * Sends a unit's kept escalation failure notice to the coordinator's mailbox, then records it as told under the spawn lock; memory keeps
 * it told when that record cannot be written, so a failed clear is retried but the notice is never sent again in this process.
 * @param port - The engine calls.
 * @param common - The git common directory.
 * @param issue - The issue.
 * @param to - The coordinator's address.
 * @returns Once it was sent and recorded, or left for the next tick.
 */
async function sendKeptNotice(port: EnginePort, common: string, issue: number, to: string): Promise<void> {
  await recordNotice(port, common, issue)
  const progress = await settle(readProgressFile(port, common, issue, true))
  const remembered = sessionMemory.escalationNotices.get(issue)
  const notice = (progress.isOk ? progress.value.escalationUndelivered : undefined) ?? (remembered && !remembered.isSent ? remembered.notice : undefined)
  if (!notice) return
  if (!(remembered?.notice === notice && remembered.isSent)) {
    const sent = await sendMail(port, { kind: 'inform', author: 'mod', to, issue, body: notice })
    logFailure(port, 'escalation failure notice', sent)
    if (!sent.isOk) return
    sessionMemory.escalationNotices.set(issue, { notice, isRecorded: true, isWarned: false, ...remembered?.notice === notice ? remembered : {}, isSent: true })
  }
  const cleared = await withSpawnLock(port, async () => {
    const { escalationUndelivered, ...rest } = await readProgressFile(port, common, issue, true)
    // why: a later notice kept while this one was sent stays for its own send.
    const later = escalationUndelivered && escalationUndelivered !== notice ? { escalationUndelivered } : {}
    await writeProgress(port, common, issue, { ...rest, ...later, escalationFailure: notice })
    return succeed(undefined)
  })
  logFailure(port, 'escalation failure notice record', cleared)
}

/**
 * Raises a unit to the user's default model with effort high, now when it is idle, else once it is.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param reason - Why the coordinator raises the unit.
 * @returns The escalation, the recorded request, or the refusal.
 */
export async function escalateOrRequest(port: EnginePort, issue: number, reason: string): Promise<Result<string>> {
  const progress = await readSpawnProgress(port, issue)
  if (!progress?.isStarted) return fail(`#${issue} has no unit spawn started`)
  if (isTopLevel(progress)) return fail(alreadyRaised(issue))
  const signal = coordinatorSignal(reason)
  if (!await isUnitIdle(port, issue, busyWaitMs)) {
    const requested = await requestEscalation(port, issue, reason)
    if (!requested.isOk) return fail(`#${issue}'s unit works, and its escalation request was not recorded: ${requested.error}; nothing was changed, so run escalate_unit again`)
    if (requested.value.kind === 'raised') return fail(alreadyRaised(issue))
    if (requested.value.kind === 'gone') {
      return fail(`#${issue} has no unit spawn started any more: its spawn record was removed, or no longer names a started unit, since escalate_unit first `
        + 'read it, so no escalation request was recorded; check it with plan')
    }
    if (requested.value.kind === 'unknown') {
      return unknown(`#${issue}'s unit works, and whether its escalation request was recorded is unknown: its write was not answered (${requested.value.error})`,
        'the escalation field of its spawn record, then run escalate_unit again if it is missing')
    }
    return succeed(`#${issue}'s unit works, so the escalation is recorded and applied once it is idle, at one of this session's next prompts.`)
  }
  const done = await escalateUnit(port, issue, signal)
  if (!done.isOk) return done
  if (!done.value) return fail(alreadyRaised(issue))
  // why: a resume whose outcome is not established did not finish, with its check, which the answer then names once; any other incomplete resume stopped part-way, never refused.
  const check = readCheck(done.value.resumed)
  const notice = describeEscalation(issue, signal, done.value, !!check)
  if (check) return unknown(notice, check)
  return isResumed(done.value) && done.value.resumed.isOk ? succeed(`${notice}\n${done.value.resumed.value.text}`) : stop(notice)
}

/**
 * Records a coordinator's escalation request on a unit that works, so the next sweep applies it once the unit is idle; under the spawn
 * lock, from the record read there and through the lock's fenced rename, so a handoff's rebind or a spawn writing the record meanwhile,
 * or after this process lost the lock, keeps its change.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param reason - Why the coordinator raises the unit.
 * @returns Written; gone when the record no longer holds a started unit; raised when it is already at the top level, which the sweep would
 * clear unapplied; unknown when the rename went unanswered; a failure when the lock, the read or the write failed before the record was replaced.
 */
function requestEscalation(port: EnginePort, issue: number, reason: string): Promise<Result<FencedWrite | { kind: 'gone' | 'raised' }>> {
  return withSpawnLock(port, async (common, _root, lock): Promise<Result<FencedWrite | { kind: 'gone' | 'raised' }>> => {
    const progress = await readProgressFile(port, common, issue, true)
    if (!progress.isStarted) return succeed({ kind: 'gone' })
    if (isTopLevel(progress)) return succeed({ kind: 'raised' })
    return judgeFencedWrite(writeProgress(port, common, issue, { ...progress, escalation: reason }, lock))
  })
}

/**
 * Drops a pending escalation request from a unit's spawn record, under the spawn lock, from the record read there and through the
 * lock's fenced rename.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @returns Null once dropped or with none to drop, or the error of a rename that went unanswered, whose outcome is unknown; a failure
 * when the lock, the read or the write failed before the record was replaced.
 */
async function clearEscalation(port: EnginePort, issue: number): Promise<Result<string | null>> {
  const cleared = await withSpawnLock(port, async (common, _root, lock): Promise<Result<FencedWrite>> => {
    const { escalation, ...rest } = await readProgressFile(port, common, issue, true)
    return escalation ? judgeFencedWrite(writeProgress(port, common, issue, rest, lock)) : succeed({ kind: 'written' })
  })
  return cleared.isOk ? succeed(cleared.value.kind === 'unknown' ? cleared.value.error : null) : fail(cleared.error)
}

/**
 * Judges a write through the spawn lock's fenced rename by what is established of it.
 * @param write - The write.
 * @returns Written; unknown when the holder never answered the rename; a failure when the write was refused before or by the rename.
 */
async function judgeFencedWrite(write: Promise<void>): Promise<Result<FencedWrite>> {
  const error = await write.then(() => null, (thrown: unknown) => thrown)
  if (error === null) return succeed({ kind: 'written' })
  // why: a rename asked for and left unanswered may have landed; a lost lock or an answered failure left the record as it was.
  if (error instanceof UnansweredRenameError) return succeed({ kind: 'unknown', error: error.message })
  return fail(formatErrorLine(error))
}

/**
 * Words the signal of an escalation the coordinator asked for.
 * @param reason - The coordinator's reason.
 * @returns The signal, recorded as the escalated level's reason.
 */
function coordinatorSignal(reason: string): string {
  return `coordinator request: ${reason}`
}

/**
 * Words the refusal of an escalation whose unit already runs at the top level.
 * @param issue - The issue.
 * @returns The refusal.
 */
function alreadyRaised(issue: number): string {
  return `#${issue} already runs on the user's default model and effort, so it is not escalated`
}

/**
 * Words the notice of an escalation.
 * @param issue - The issue.
 * @param signal - What triggered it.
 * @param escalated - The escalation: the model its resume passed, null for the account's default, whether it closed the session, and how the resume ended.
 * @param isCheckNamed - Whether the answer around the notice names a resume's check already, as escalate_unit's did-not-finish answer does.
 * @returns The notice, which says whether the unit resumed and whether a message told it of the escalation.
 */
function describeEscalation(issue: number, signal: string, escalated: Escalation, isCheckNamed = false): string {
  const { model, isClosed, isLevelRecorded, resumed, seen } = escalated
  const level = `${model ? `model ${model}` : 'the account\'s default model'} with effort high`
  if (!resumed.isOk && !isLevelRecorded) {
    return `#${issue}'s ${isClosed ? 'session was closed for its escalation' : 'escalation found no session running'} (${signal}), but its new level could not be recorded: `
      + `${resumed.error}. \`spawn ${issue}\` resumes it on its old level; run escalate_unit for #${issue} again to raise it.`
  }
  // why: a resume that stopped only on an unread mailbox, its session seen running, resumed; any other failure, an unresolved start included, did not.
  const shown = resumed.isOk ? resumed.value : 'spawned' in resumed && seen.kind === 'runs' ? resumed.spawned : null
  if (!shown) {
    const failure = resumed.isOk ? '' : resumed.error
    const check = readCheck(resumed)
    return check ? `#${issue}'s escalation to ${level} was recorded (${signal}), but its resume did not finish, and its session ${describeSeen(seen)}: ${failure}. `
      + `${isCheckNamed ? 'Then' : `Check ${check}, then`} run \`spawn ${issue}\` to resume it.`
      : `#${issue}'s escalation to ${level} was recorded (${signal}), but its session ${describeSeen(seen)}: ${failure}. Run \`spawn ${issue}\` to resume it.`
  }
  const { disposition, unprovenStart } = shown
  // why: only the resume inform names the new level; a start assignment carries the issue's work, not the escalation.
  const mail = disposition.kind === 'sent' && disposition.message.kind === 'inform' ? `, and its ${describeMessage(disposition.message)} told it so`
    : disposition.kind === 'sent' ? `; its ${describeMessage(disposition.message)} was sent, which does not name the escalation`
    : disposition.kind === 'unknown' ? `${unprovenStart ? ';' : ', but'} ${disposition.detail}` : `; ${describeUnsent(disposition)}`
  // why: a host start that failed with nothing after it proving the session runs leaves the resume unproven, so it is not said to have resumed.
  const started = unprovenStart ? `Its resume on ${level} may not run (the host's start said: ${unprovenStart})` : `It resumed on ${level}`
  return `#${issue} escalated: ${signal}. ${started}${mail}.`
}

/**
 * Words the session an escalation's failed resume left, as the mod saw it.
 * @param seen - What was seen.
 * @returns The predicate, such as `was closed`.
 */
function describeSeen(seen: SessionSeen): string {
  if (seen.kind === 'unknown') return `is in a state that could not be read (${seen.reason})`
  return seen.kind === 'closed' ? 'was closed' : seen.kind === 'runs' ? 'runs' : 'is not running'
}

/**
 * Reads what to check before retrying a resume that did not finish.
 * @param resumed - How the resume ended.
 * @returns The check, or null for a resume whose outcome is established.
 */
function readCheck(resumed: Escalation['resumed']): string | null {
  return !resumed.isOk && 'isUnknown' in resumed && 'check' in resumed && typeof resumed.check === 'string' ? resumed.check : null
}

/**
 * Tells whether an escalation's resume completed with its start message settled.
 * @param escalated - The escalation.
 * @returns Whether the resume completed, proved its session runs and knows its mailbox state.
 */
function isResumed(escalated: Escalation): boolean {
  return escalated.resumed.isOk && escalated.resumed.value.disposition.kind !== 'unknown' && !escalated.resumed.value.unprovenStart
}

/**
 * Tells whether an issue's unit ran its own Verify red twice in a row since its last pass.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @returns Whether it did; false without a declared unit.
 */
async function hasTwoRedVerifies(port: EnginePort, issue: number): Promise<boolean> {
  const identity = (await readSessionMirrors(port)).map(mirror => mirror.session.unit).find(unit => unit?.issues.includes(issue))
  if (!identity) return false
  return isRed(await readUnit(port, identity))
}

/**
 * Tells whether a unit's own Verify calls ran red twice in a row.
 * @param unit - The unit's merged evidence.
 * @returns Whether its red count reached two.
 */
function isRed(unit: Pick<Unit, 'redVerifies'>): boolean {
  return (unit.redVerifies ?? 0) >= 2
}
