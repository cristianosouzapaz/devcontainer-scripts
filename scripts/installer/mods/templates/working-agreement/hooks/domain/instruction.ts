import { describeCiBlocker } from './ci-blocker'
import { formatIssueReferences, markForAgent } from './messages'
import type { Session } from './records'
import { describeRequirement } from './requirements'
import { describeUnknownEnd, formatStepLabel, isCiWait } from './step-states'
import type { DiagnoseNeed, Position } from './step-states'

/** A successful declaration: the reply that lists its steps, and the prompt that starts its current step, null when none is current. */
export interface DeclaredFlow { reply: string; start: string | null }

/** Separates a start prompt's lead from the step it starts, so the prompt can be rebuilt from its lead. */
const startMarker = ' Start the current step ('

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
 * @param isDelegated - Whether a live coordinator delegates the unit.
 * @returns The instruction, without the `[working-agreement]` prefix the agent reads it with.
 */
export function composeInstruction(position: Position, session: Session, isDelegated = false): string {
  const checkout = session.unit && position.git && session.unit.branch !== position.git.branch
    ? ` checked out: ${position.git.branch} (not this unit's branch).` : ''
  return composeUnitInstruction(position, session, isDelegated) + checkout
}

/**
 * Writes the prompt that starts the current step after a user command moved the unit; it carries the flow line itself,
 * because the mod's own deferred submission is not certain to pass through its prompt hook.
 *
 * @param position - The unit's position after the command.
 * @param session - The session with the declared issues.
 * @param lead - What the command did, as the prompt's first sentence.
 * @param isDelegated - Whether a live coordinator delegates the unit.
 * @returns The prompt, or null when the unit has no current step to start.
 */
export function composeStart(position: Position, session: Session, lead: string, isDelegated = false): string | null {
  const { pullRequest, current } = position
  if (position.isConcluded || position.slice?.isRewritten || position.integration?.state === 'unknown-end' || !current) return null
  const stop = /[.!?]$/.test(lead) ? '' : '.'
  const source = session.issues.length ? ' from the issue' : ''
  return `${lead}${stop}${startMarker}${formatStepLabel(current.step, pullRequest)})${source}. ${composeFlowLine(position, session, isDelegated)}`
}

/**
 * Reads the lead of a start prompt composeStart wrote.
 *
 * @param text - A prompt's text.
 * @returns The lead with its closing stop, or undefined when the text is no start prompt.
 */
export function readStartLead(text: string): string | undefined {
  const index = text.indexOf(startMarker)
  return index > 0 ? text.slice(0, index) : undefined
}

/**
 * Writes the flow line a prompt carries for the agent.
 *
 * @param position - The unit's position.
 * @param session - The session.
 * @param isDelegated - Whether a live coordinator delegates the unit.
 * @returns The instruction, marked as the working agreement's.
 */
export const composeFlowLine = (position: Position, session: Session, isDelegated = false): string => markForAgent(composeInstruction(position, session, isDelegated))

/**
 * Directs the agent to the unit's next unmet requirement and any following human handover.
 * @param position - The unit's judged position.
 * @param session - The session's declared issues and facts.
 * @param isDelegated - Whether a live coordinator delegates the unit.
 * @returns The flow instruction, including completion or blocked-state notices.
 */
function composeUnitInstruction(position: Position, session: Session, isDelegated: boolean): string {
  const { flow, pullRequest, current } = position
  const issue = session.issues.length ? ` ${formatIssueReferences(session.issues, ' ')}` : ''
  if (position.isConcluded) return `${flow.label}${issue} — Unit finished.`
  if (position.slice?.isRewritten) return `${flow.label}${issue} — branch history rewritten since this unit was declared — re-declare.`
  // why: A deleted branch empties every slice fact, so the step it leaves current would send the agent to work that cannot land.
  if (position.integration?.state === 'unknown-end') return `${flow.label}${issue} — ${describeUnknownEnd(position.integration.end)}; stop and tell the user.`
  if (!current && position.integration?.state === 'delivered') return `${flow.label}${issue} — Unit finished.`
  if (!current) return position.integration?.state === 'integrated'
    ? `${flow.label}${issue} — integrated into ${position.integration.parent}; delivered by the Close out on ${position.integration.parent}.`
    : `${flow.label}${issue} — all steps done.`
  if (isCiWait(position)) {
    const { reason, action } = describeCiBlocker(position.checks, `#${pullRequest?.number ?? ''}`)
    return `${flow.label}${issue} — current step: ${formatStepLabel(current.step, pullRequest)}. ${current.detail ?? current.fact ?? reason}: ${action}; do not report the unit as done before every check passes.`
  }
  // Name a following human step now: otherwise the agent closes this step by offering to run it itself.
  const next = position.states.slice(position.states.indexOf(current) + 1).find(state => state.state === 'pending')
  const handover = next?.step.isHuman && next.step.skill
    ? ` When it is done, do not run or offer ${next.step.skill} yourself: the next step is the user's — tell them to run /${next.step.skill}.`
    : ''
  const requirement = describeRequirement(current, session, position, isDelegated)
  const detail = current.step.isInWorktree ? describeDiagnoseNeed(current.need, session.issues) : current.detail ?? current.fact
  const fact = detail && detail !== requirement ? ` ${detail}.` : ''
  return `${flow.label}${issue} — current step: ${formatStepLabel(current.step, pullRequest)}.${fact} Next action: ${requirement}.${handover}`
}
