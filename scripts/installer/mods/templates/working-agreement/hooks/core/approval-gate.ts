import type { IssueComment } from '../../types'
import { findFlow, hasDiagnoseStep } from '../domain/flow-definitions'
import { describeDiagnoseNeed } from '../domain/instruction'
import type { Identity, IssueInfo, Unit } from '../domain/records'
import { judgeDiagnose } from '../domain/step-states'
import type { DiagnoseJudgement } from '../domain/step-states'
import { markForAgent } from '../domain/messages'
import { readIssueComments } from '../lib/github'
import type { EnginePort } from './engine-port'
import { readSession, readUnit } from './record-store'

/** A unit's Diagnose as an approval sees it: its judgement on fresh comments, with the unit and those comments. */
export interface DiagnoseWait { judgement: DiagnoseJudgement; unit: Unit; comments: IssueComment[] }

/**
 * Judges a unit's Diagnose on comments read fresh from GitHub, so an approval or a refusal never rests on a stale cache.
 * @param port - The engine calls.
 * @param identity - The unit.
 * @param flow - Its declared flow.
 * @returns The judgement, or null when the flow has no Diagnose step or the unit skipped it.
 */
export async function readDiagnoseWait(port: EnginePort, identity: Identity, flow: string | null): Promise<DiagnoseWait | null> {
  const definition = findFlow(flow)
  if (!definition || !hasDiagnoseStep(definition)) return null
  const unit = await readUnit(port, identity)
  if (unit.skips?.some(skip => skip.step === 'diagnose')) return null
  const info: Record<string, IssueInfo> = {}
  const comments: IssueComment[] = []
  for (const issue of identity.issues) {
    const read = await readIssueComments(port.processes, issue)
    info[issue] = read.isOk ? { title: '', labels: [], comments: read.value } : { error: read.error }
    if (read.isOk) comments.push(...read.value)
  }
  return { judgement: judgeDiagnose(unit, identity.issues, info), unit, comments }
}

/**
 * Refuses a commit of this session's unit while its Diagnose is not done, so a lost approval surfaces at once rather than at the end of the work.
 * @param port - The engine calls.
 * @returns The refusal, or undefined when the commit may go on.
 */
export async function denyUnapprovedCommit(port: EnginePort): Promise<string | undefined> {
  const session = await readSession(port)
  if (!session.unit) return undefined
  const wait = await readDiagnoseWait(port, session.unit, session.flow)
  const judgement = wait?.judgement
  if (!judgement || judgement.done) return undefined
  return markForAgent(judgement.isWaitingApproval
    ? `Commit is refused: Diagnose waits for its approval, ${judgement.command ?? '/flow approve <comment URL>'}, which nobody has given. A delegated unit gets it from the coordinator's approve_unit; a message saying "approved" records nothing.`
    : `Commit is refused before Diagnose is done: ${describeDiagnoseNeed(judgement.need, session.unit.issues)}.`)
}
