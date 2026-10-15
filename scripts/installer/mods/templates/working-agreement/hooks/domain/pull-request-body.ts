import { flowDefinitions } from './flow-definitions'
import type { Step } from './flow-definitions'
import type { Session, Unit } from './records'
import { findDiagnoseStep, isApproved } from './step-states'

/**
 * Lists the lines a PR body must carry but does not.
 *
 * @param requires - What the PR step requires of the body.
 * @param session - The session, which holds the declared issues and the followed-up issue.
 * @param body - The PR body text.
 * @param unit - The unit, whose approved diagnosis comment a Fix PR body must link.
 * @returns The missing lines as displayed, empty when the body is complete.
 */
export function listMissingLines(requires: Step['requires'], session: Session, body: string, unit: Unit): string[] {
  const hasLine = (word: string, number: number) => new RegExp(`\\b${word}\\s+#${number}\\b`, 'i').test(body)
  const flow = session.flow ? flowDefinitions.flows[session.flow] : undefined
  const link = flow && findDiagnoseStep(flow) && isApproved(unit) ? unit.approval : undefined
  const issues = requires === 'closes' ? session.issues.filter(number => !hasLine('Closes', number)).map(number => `Closes #${number}`) : []
  const followUp = session.followUp === undefined || requires === 'closes' || requires === 'none' ? []
    : requires === 'refs' ? (hasLine('Refs', session.followUp) ? [] : [`Refs #${session.followUp}`])
    : hasLine('(?:closes|refs|fixes|resolves)', session.followUp) ? [] : [`Closes|Refs|Fixes|Resolves #${session.followUp}`]
  return [...issues, ...followUp, ...(link && !body.includes(link) ? [`the approved diagnosis comment link ${link}`] : [])]
}
