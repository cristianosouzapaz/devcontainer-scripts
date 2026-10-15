import { listMissingDiagnosis } from '../domain/diagnosis-comment'
import { flowDefinitions } from '../domain/flow-definitions'
import type { Session } from '../domain/records'
import { findDiagnoseStep, isRedGreenSettled } from '../domain/step-states'
import { viewLatestIssueComment } from '../lib/github'
import type { EnginePort } from './engine-port'
import { findIssueKey, findUnitKey, readUnit, writeStored } from './record-store'

/**
 * Records the diagnosis comment a `gh issue comment` posted, once the unit's Red and Green are settled: GitHub's latest comment
 * on the issue, when it holds everything a diagnosis comment must, becomes the unit's diagnosis. A comment that falls short, or
 * any newer comment, leaves the earlier one and its approval behind, since the approval names a comment URL.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @param issues - The declared issues the command named.
 */
export async function recordDiagnosis(port: EnginePort, session: Session, issues: number[]): Promise<void> {
  const flow = session.flow ? flowDefinitions.flows[session.flow] : undefined
  const step = flow && findDiagnoseStep(flow)
  if (!step) return
  for (const issue of issues) {
    const key = session.followUp ? await findUnitKey(port, session) : await findIssueKey(port, issue)
    const { diagnosis: earlier, ...unit } = await readUnit(port, key)
    if (!isRedGreenSettled(step, unit)) continue
    const comment = await viewLatestIssueComment(port.processes, issue)
    if (!comment.isOk || !comment.value || comment.value.url === earlier) continue
    const isValid = !listMissingDiagnosis(unit, comment.value.body).length
    await writeStored(port, key, isValid ? { ...unit, diagnosis: comment.value.url } : unit)
  }
}
