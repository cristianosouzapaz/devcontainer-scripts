import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { readCommonDir, readSessionMirrors, readUnit } from './record-store'
import { busyWaitMs, escalateUnit, isTopLevel, isUnitIdle, readProgressFile, readSpawnProgress, writeProgress } from './spawn'

/** The signal two red Verifies in a row give. */
const redSignal = 'two consecutive red Verifies'
// why: a unit's turn-end notice reaches the coordinator while herdr may still report that turn as working.
const idleWaitMs = 5000

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
    if (!progress?.isStarted || isTopLevel(progress)) continue
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
 * @returns The notice, which says the resumed unit waits for a prompt.
 */
function describeEscalation(issue: number, signal: string): string {
  return `#${issue} escalated: ${signal}. It resumed on the user's default model with effort high, idle: prompt it with unit_prompt.`
}

/**
 * Tells whether the last two Verify runs of an issue's unit, across its sessions, both failed or timed out.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @returns Whether they did; false with fewer than two runs.
 */
async function hasTwoRedVerifies(port: EnginePort, issue: number): Promise<boolean> {
  const identity = (await readSessionMirrors(port)).map(mirror => mirror.session.unit).find(unit => unit?.issues.includes(issue))
  if (!identity) return false
  const runs = (await readUnit(port, identity)).verifyRuns
  return runs.length >= 2 && runs.slice(0, 2).every(run => run.outcome.kind !== 'pass')
}
