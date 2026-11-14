import { isCoordinatorSession } from '../domain/coordinator'
import { describeEmptyScope } from '../domain/delegation'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { readSession, readSessionMirrors } from './record-store'
import { describeBase, describeDeclaring, describeLevel, findDeclaringSession, judgeSlot, readPlanCapacity, readRecordedBase, readSpawnStart } from './spawn'
import type { Slot } from './spawn'
import { findUnitBranch, readDefaultBase, readIssueStart, readUnitState } from './unit-state'
import type { UnitState } from './unit-state'

/** One in-scope issue's line and whether spawn would start it now. */
interface PlanLine { issue: number; canStart: boolean; text: string }

/**
 * Lists, for each issue this coordinator delegates, its native parent and that parent's unit branch, its open blockers with their unit states, its own unit state, and whether spawn would start it now and from where.
 * @param port - The engine calls.
 * @returns The plan, issues spawn would start now first, each group in number order; the same records and GitHub state give the same text.
 */
export async function composePlan(port: EnginePort): Promise<Result<string>> {
  if (!isCoordinatorSession(await readSession(port))) return fail('only a coordinator session plans delegated work — the user makes one with /flow coordinate')
  const scope = await readOwnScope(port)
  if (!scope?.issues.length) return succeed(describeEmptyScope(scope))
  const base = await readDefaultBase(port)
  if (!base) return fail('the repository state is unreadable')
  const mirrors = await readSessionMirrors(port)
  const capacity = await readPlanCapacity(port)
  const states = new Map<number, Promise<UnitState>>()
  const stateOf = (issue: number): Promise<UnitState> => {
    const known = states.get(issue) ?? readUnitState(port, issue, base, mirrors)
    states.set(issue, known)
    return known
  }
  const lines: PlanLine[] = []
  for (const issue of [...scope.issues].sort((a, b) => a - b)) {
    const start = await readIssueStart(port, issue)
    const own = await stateOf(issue)
    if (!start.isOk) {
      lines.push({ issue, canStart: false, text: `#${issue} · unit ${own} · ${start.error}` })
      continue
    }
    const { title, blockers, parent, parentBranch, base: from } = start.value
    const ofParent = parent === undefined ? '' : ` · parent #${parent} (${parentBranch?.isOk ? `unit branch ${parentBranch.value}` : parentBranch?.error ?? 'no unit branch'})`
    const blocked = blockers.length ? (await Promise.all(blockers.map(async blocker => `#${blocker} (${await stateOf(blocker)})`))).join(', ') : 'none'
    const declaring = await findDeclaringSession(port, issue)
    const slot = judgeSlot(capacity, issue)
    const verdict = declaring ? describeDeclaring(issue, declaring) : own !== 'none' ? describeOwnUnit(slot) : !from.isReady ? from.reason : describeStart(from.parent, slot)
    const level = (await readSpawnStart(port, [issue]))?.level
    const recorded = await readRecordedBase(port, issue)
    const branch = recorded && recorded.kind !== 'cut' ? await findUnitBranch(port, issue) : null
    const runsOn = `${level ? ` · ${describeLevel(level)}` : ''}${recorded ? ` · ${describeBase(recorded, branch?.isOk ? branch.value : undefined)}` : ''}`
    lines.push({ issue, canStart: !declaring && own === 'none' && from.isReady && (slot.kind === 'reuse' || slot.kind === 'free'), text: `#${issue} ${title} · unit ${own}${runsOn}${ofParent} · blocked by ${blocked} · ${verdict}` })
  }
  return succeed([...lines.filter(line => line.canStart), ...lines.filter(line => !line.canStart)].map(line => line.text).join('\n'))
}

/**
 * Words what the cap showed for an issue that has its unit: spawn reuses it, or waits for a slot to reopen its closed workspace.
 * @param slot - The slot verdict.
 * @returns The verdict, an observation that spawn checks again under its lock.
 */
function describeOwnUnit(slot: Slot): string {
  if (slot.kind === 'unknown') return `has its unit; whether spawn can reuse it now is unknown: ${slot.reason}`
  if (slot.kind === 'full') return `has its unit, its workspace closed: waits for a free slot (${describeCount(slot)})`
  return `has its unit: spawn reuses it (${slot.kind === 'reuse' ? 'its workspace is open' : describeCount(slot)})`
}

/**
 * Words what the cap showed for an issue spawn would start from a base.
 * @param from - The branch spawn would cut the unit from.
 * @param slot - The slot verdict.
 * @returns The verdict, an observation that spawn checks again under its lock.
 */
function describeStart(from: string, slot: Slot): string {
  if (slot.kind === 'unknown') return `would start from ${from}, but running units unknown: ${slot.reason}`
  if (slot.kind === 'full') return `waits for a free slot (${describeCount(slot)})`
  return `can start now from ${from} (${slot.kind === 'reuse' ? 'its workspace is open' : describeCount(slot)})`
}

/**
 * Words the running units the cap counted.
 * @param slot - A counted slot verdict.
 * @param slot.running - The units holding a slot.
 * @param slot.limit - The cap.
 * @returns The count.
 */
function describeCount({ running, limit }: { running: unknown[]; limit: number }): string {
  return `${running.length}/${limit} units running; spawn rechecks under its lock`
}
