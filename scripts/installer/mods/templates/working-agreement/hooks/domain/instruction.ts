import { describeCiBlocker } from './ci-blocker'
import { writePolicy } from './messages'
import type { Session } from './records'
import { describeRequirement } from './requirements'
import { formatStepLabel, isCiWait } from './step-states'
import type { Position } from './step-states'

/**
 * Formats issue numbers as references.
 *
 * @param issues - The issue numbers.
 * @param separator - What goes between two references.
 * @returns The `#n` references, joined.
 */
export const formatIssueReferences = (issues: number[], separator: string): string => issues.map(number => `#${number}`).join(separator)

/**
 * Writes the line that tells the agent its current step and next action.
 *
 * @param position - The unit's position.
 * @param session - The session.
 * @returns The instruction, without the `[working-agreement]` prefix the agent reads it with.
 */
export function composeInstruction(position: Position, session: Session): string {
  const { flow, unit, current } = position
  const issue = session.issues.length ? ` ${formatIssueReferences(session.issues, ' ')}` : ''
  if (!current) return `${flow.label}${issue} — all steps done.`
  // Nothing tells what was done on a branch that is gone: the agent asks rather than redoing the work.
  if (position.isSubjectUnknown) {
    return `${flow.label}${issue} — state unknown: the unit's branch ${position.judgedOn} is gone and no PR head or anchor of it is here. Next action: stop and ask the user where the work is (or to run /flow override branch <reason>) before writing.`
  }
  if (isCiWait(position)) {
    const { reason, action } = describeCiBlocker(position.checks, `#${unit.pr?.number ?? ''}`)
    return `${flow.label}${issue} — current step: ${formatStepLabel(current.step, unit.pr)}. ${reason}: ${action}; do not report the unit as done before every check passes.`
  }
  // Name a following human step now: otherwise the agent closes this step by offering to run it itself.
  const next = position.states.slice(position.states.indexOf(current) + 1).find(state => state.state === 'pending')
  const handover = next?.step.isHuman && next.step.skill
    ? ` When it is done, do not run or offer ${next.step.skill} yourself: the next step is the user's — tell them to run /${next.step.skill}.`
    : ''
  // Off the unit's branch the steps are its branch's: the work resumes there, not on the checkout.
  const back = position.judgedOn ? `switch back to the unit's branch (git switch ${position.judgedOn}) before writing, then ` : ''
  const requirement = back + describeRequirement(current, session, position)
  const policy = current.step.isWriteGated ? ` ${writePolicy}` : ''
  return `${flow.label}${issue} — current step: ${formatStepLabel(current.step, unit.pr)}. Next action: ${requirement}.${handover}${policy}`
}
