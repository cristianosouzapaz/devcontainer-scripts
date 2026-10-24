import { describeCiBlocker } from './ci-blocker'
import type { Session } from './records'
import { describeRequirement } from './requirements'
import { formatStepLabel, isCiWait } from './step-states'
import type { DiagnoseNeed, Position } from './step-states'

/**
 * Formats issue numbers as references.
 *
 * @param issues - The issue numbers.
 * @param separator - What goes between two references.
 * @returns The `#n` references, joined.
 */
export const formatIssueReferences = (issues: number[], separator: string): string => issues.map(number => `#${number}`).join(separator)

/**
 * Names the agent's next Diagnose requirement independently of the pane wording.
 * @param need - The first unmet Diagnose requirement, or undefined after completion.
 * @param issues - The declared issues that can receive the diagnosis comment.
 * @returns The agent-facing sentence without its final period.
 */
export function describeDiagnoseNeed(need: DiagnoseNeed | undefined, issues: number[]): string {
  if (need === undefined) return 'Diagnose is done'
  switch (need) {
    case 'red': return 'Diagnose next needs a failing red run through the run tool'
    case 'issue': return 'Diagnose next needs the issue to exist, for the diagnosis comment'
    case 'comments': return `Diagnose cannot read the comments on ${formatIssueReferences(issues, ' or ')} yet; retry, and if it keeps failing, stop and tell the user`
    case 'comment': return `Diagnose next needs a diagnosis comment on ${formatIssueReferences(issues, ' or ')} after the red run, then the user's /flow approve <comment URL>`
    case 'approval': return "Diagnose next needs the user's /flow approve <comment URL> naming the diagnosis comment after the red run"
  }
}

/**
 * Writes the line that tells the agent its current step and next action.
 *
 * @param position - The unit's position.
 * @param session - The session.
 * @returns The instruction, without the `[working-agreement]` prefix the agent reads it with.
 */
export function composeInstruction(position: Position, session: Session): string {
  const checkout = session.unit && position.git && session.unit.branch !== position.git.branch
    ? ` checked out: ${position.git.branch} (not this unit's branch).` : ''
  return composeUnitInstruction(position, session) + checkout
}

/**
 * Directs the agent to the unit's next unmet requirement and any following human handover.
 * @param position - The unit's judged position.
 * @param session - The session's declared issues and facts.
 * @returns The flow instruction, including completion or blocked-state notices.
 */
function composeUnitInstruction(position: Position, session: Session): string {
  const { flow, pullRequest, current } = position
  const issue = session.issues.length ? ` ${formatIssueReferences(session.issues, ' ')}` : ''
  if (position.isConcluded) return `${flow.label}${issue} — Unit finished.`
  if (position.slice?.isRewritten) return `${flow.label}${issue} — branch history rewritten since this unit was declared — re-declare.`
  if (!current) return `${flow.label}${issue} — all steps done.`
  if (isCiWait(position)) {
    const { reason, action } = describeCiBlocker(position.checks, `#${pullRequest?.number ?? ''}`)
    return `${flow.label}${issue} — current step: ${formatStepLabel(current.step, pullRequest, true)}. ${current.fact ?? reason}: ${action}; do not report the unit as done before every check passes.`
  }
  // Name a following human step now: otherwise the agent closes this step by offering to run it itself.
  const next = position.states.slice(position.states.indexOf(current) + 1).find(state => state.state === 'pending')
  const handover = next?.step.isHuman && next.step.skill
    ? ` When it is done, do not run or offer ${next.step.skill} yourself: the next step is the user's — tell them to run /${next.step.skill}.`
    : ''
  const requirement = describeRequirement(current, session, position)
  const detail = current.step.isInWorktree ? describeDiagnoseNeed(current.need, session.issues) : current.fact
  const fact = detail && detail !== requirement ? ` ${detail}.` : ''
  return `${flow.label}${issue} — current step: ${formatStepLabel(current.step, pullRequest, true)}.${fact} Next action: ${requirement}.${handover}`
}
