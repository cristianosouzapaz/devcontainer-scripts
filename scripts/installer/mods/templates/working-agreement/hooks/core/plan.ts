import { isCoordinatorSession } from '../domain/coordinator'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { readSession, readSessionMirrors } from './record-store'
import { describeDeclaring, describeLevel, findDeclaringSession, readSpawnLevel } from './spawn'
import { readDefaultBase, readIssueStart, readUnitState } from './unit-state'
import type { UnitState } from './unit-state'

/** One in-scope issue's line and whether spawn would start it now. */
interface PlanLine { issue: number; canStart: boolean; text: string }

/**
 * Lists, for each issue this coordinator delegates, its open blockers with their unit states, its own unit state, and whether spawn would start it now and from where.
 * @param port - The engine calls.
 * @returns The plan, issues spawn would start now first, each group in number order; the same records and GitHub state give the same text.
 */
export async function composePlan(port: EnginePort): Promise<Result<string>> {
  if (!isCoordinatorSession(await readSession(port))) return fail('only a coordinator session plans delegated work — the user makes one with /flow coordinate')
  const scope = await readOwnScope(port)
  if (!scope?.issues.length) return succeed('This coordinator delegates no issue.')
  const base = await readDefaultBase(port)
  if (!base) return fail('the repository state is unreadable')
  const mirrors = await readSessionMirrors(port)
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
    const { title, blockers, base: from } = start.value
    const blocked = blockers.length ? (await Promise.all(blockers.map(async blocker => `#${blocker} (${await stateOf(blocker)})`))).join(', ') : 'none'
    const declaring = await findDeclaringSession(port, issue)
    const verdict = declaring ? describeDeclaring(issue, declaring) : own !== 'none' ? 'has its unit: spawn reuses it' : from.isReady ? `can start now from ${from.parent}` : from.reason
    const level = await readSpawnLevel(port, [issue])
    const runsOn = level ? ` · ${describeLevel(level)}` : ''
    lines.push({ issue, canStart: !declaring && own === 'none' && from.isReady, text: `#${issue} ${title} · unit ${own}${runsOn} · blocked by ${blocked} · ${verdict}` })
  }
  return succeed([...lines.filter(line => line.canStart), ...lines.filter(line => !line.canStart)].map(line => line.text).join('\n'))
}
