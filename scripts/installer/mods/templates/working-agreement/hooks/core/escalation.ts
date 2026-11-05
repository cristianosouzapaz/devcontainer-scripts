import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { readOwnScope } from './delegation'
import type { Unit } from '../domain/records'
import type { EnginePort } from './engine-port'
import { readCommonDir, readSession, readSessionMirrors, readUnit } from './record-store'
import { busyWaitMs, escalateUnit, isTopLevel, isUnitIdle, readProgressFile, readSpawnProgress, writeProgress } from './spawn'

/** The signal two red Verifies in a row give. */
const redSignal = 'two consecutive red Verifies'
// why: a unit's turn-end notice reaches the coordinator while herdr may still report that turn as working.
const idleWaitMs = 5000

/**
 * Words why this session's Verify is refused: the unit was spawned below the top level and its last two own Verify calls ran red,
 * so it must end its turn for the sweep, which escalates only an idle unit.
 * @param port - The engine calls.
 * @returns The refusal with its move, or null when Verify may run.
 */
export async function describeEscalationStop(port: EnginePort): Promise<string | null> {
  const identity = (await readSession(port)).unit
  if (!identity?.issues.length || !isRed(await readUnit(port, identity))) return null
  for (const issue of identity.issues) {
    const progress = await readSpawnProgress(port, issue)
    if (progress?.isStarted && !isTopLevel(progress)) {
      return `Verify refused: ${redSignal}. End the turn now: the mod resumes this session on the user's default model with effort high, keeping the conversation.`
    }
  }
  return null
}

/**
 * Escalates every unit of this coordinator's scope that has a signal and is idle now: a coordinator request recorded while it worked,
 * or its last two Verify runs red. A unit that works keeps its signal for a later sweep.
 * @param port - The engine calls.
 * @returns One notice per unit escalated, or per escalation that failed.
 */
export async function escalateIdleUnits(port: EnginePort): Promise<string[]> {
  const scope = await readOwnScope(port)
  const notices: string[] = []
  for (const issue of [...scope?.issues ?? []].sort((a, b) => a - b)) {
    const progress = await readSpawnProgress(port, issue)
    if (!progress?.isStarted) continue
    if (isTopLevel(progress)) {
      // why: a request left on a unit already at the top level would raise it again if it were later respawned lower.
      if (progress.escalation) await clearEscalation(port, issue)
      continue
    }
    const signal = progress.escalation ? coordinatorSignal(progress.escalation) : await hasTwoRedVerifies(port, issue) ? redSignal : null
    if (!signal || !await isUnitIdle(port, issue, idleWaitMs)) continue
    const done = await escalateUnit(port, issue, signal)
    notices.push(done.isOk ? describeEscalation(issue, signal) : `#${issue} not escalated: ${done.error}`)
  }
  return notices
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
  if (isTopLevel(progress)) return fail(`#${issue} already runs on the user's default model and effort, so it is not escalated`)
  const signal = coordinatorSignal(reason)
  if (!await isUnitIdle(port, issue, busyWaitMs)) {
    await requestEscalation(port, issue, reason)
    return succeed(`#${issue}'s unit works, so the escalation is recorded and applied once it is idle, at one of this session's next prompts.`)
  }
  const done = await escalateUnit(port, issue, signal)
  return done.isOk ? succeed(`${describeEscalation(issue, signal)}\n${done.value}`) : done
}

/**
 * Records a coordinator's escalation request on a unit that works, so the next sweep applies it once the unit is idle.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param reason - Why the coordinator raises the unit.
 */
async function requestEscalation(port: EnginePort, issue: number, reason: string): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  const progress = await readProgressFile(port, common, issue, true)
  if (progress.isStarted) await writeProgress(port, common, issue, { ...progress, escalation: reason })
}

/**
 * Drops a pending escalation request from a unit's spawn record.
 * @param port - The engine calls.
 * @param issue - The issue.
 */
async function clearEscalation(port: EnginePort, issue: number): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  const { escalation, ...rest } = await readProgressFile(port, common, issue, true)
  await writeProgress(port, common, issue, rest)
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
 * Words the notice of an escalation.
 * @param issue - The issue.
 * @param signal - What triggered it.
 * @returns The notice, which says how the resumed unit learned of it.
 */
function describeEscalation(issue: number, signal: string): string {
  return `#${issue} escalated: ${signal}. It resumed on the user's default model with effort high, and its mailbox told it so.`
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
