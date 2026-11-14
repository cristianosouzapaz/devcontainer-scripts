import { describeCiBlocker } from './ci-blocker'
import { formatIssueReferences, markForAgent } from './messages'
import type { Session } from './records'
import { describeRequirement } from './requirements'
import { describeUnknownEnd, formatStepLabel, isCiWait } from './step-states'
import type { DiagnoseNeed, Position } from './step-states'

/**
 * A start prompt that was not delivered: keeping it failed, its composition failed while it was first in line, or the engine dropped its
 * submit, so it never entered; why, which kind of start it was, which decides how it is started by hand, the command and target that name
 * it, and, for a keep failure, whether a completed paint showed it yet.
 */
export interface StartFault { stage: 'compose' | 'dropped' | 'keep' | 'keep-unknown'; cause: string; kind: 'step' | 'coordinate' | 'delegate'; label?: string; isShown?: boolean }

/** How the hold row names one obligation: what it is, how to check it, and how to resolve it by hand. */
export interface HoldNote { what: string; check: string; byHand: string }

/** A successful declaration: the reply that lists its steps, and the prompt that starts its current step, null when none is current. */
export interface DeclaredFlow { reply: string; start: string | null }

/** A start prompt composed, or why none could be: a refusal that is final ends the start, any other holds it until the step is known. */
export type StartComposition = { kind: 'prompt'; text: string } | { kind: 'refused'; isFinal: boolean; reason: string }

/** Separates a composed start's lead from the step it starts, so the prompt the mod submits can carry the lead alone. */
const startMarker = ' Start the current step ('
/** Ends the start prompt the mod submits; its step instruction, when the unit has one, is added only as it enters. */
const startTail = ' Start the current step.'

/** Says this mod load stands down, as another load recorded itself in the process state after it first looked. */
export const loadSuperseded = 'this mod load stands down for good: another load recorded itself in the process state after this one first looked, and may be newer, so this load submits, settles and releases nothing; if that load is newer it delivers the start prompts, and if this row stays while start prompts wait, the load recorded is one a reload replaced, so run /reload-plugins: the load it starts records itself, and delivers them once it hears a turn start or end, or a prompt you type'

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
 * Writes what a unit that owes cancels does instead of its step's next action.
 * @param ids - The owed cancels' ids.
 * @returns The sentence.
 */
export const describeOwedCancels = (ids: readonly string[]): string => `The coordinator cancelled this unit's open work (cancel ${ids.join(', ')}): `
  + `reply ${ids.map(id => `send with kind done and in_reply_to ${id}`).join(', then ')}, saying where you stopped, then end the turn; `
  + 'do not resume the cancelled work unless the coordinator assigns it again.'

/**
 * Writes the line that tells the agent its current step and next action, or the done its owed cancels need instead.
 *
 * @param position - The unit's position.
 * @param session - The session.
 * @param isDelegated - Whether a live coordinator delegates the unit.
 * @param cancels - The ids of the cancels the unit owes a done, lifted or not.
 * @returns The instruction, without the `[working-agreement]` prefix the agent reads it with.
 */
export function composeInstruction(position: Position, session: Session, isDelegated = false, cancels: readonly string[] = []): string {
  const checkout = session.unit && position.git && session.unit.branch !== position.git.branch
    ? ` checked out: ${position.git.branch} (not this unit's branch).` : ''
  return composeUnitInstruction(position, session, isDelegated, cancels) + checkout
}

/**
 * Writes the text that starts the current step after a user command moved the unit, the flow line in it, as a Stop's block carries it,
 * or says why none can be written: a unit that concluded or has no current step has nothing to start, while one whose history was
 * rewritten or whose integration end is unknown has a step that is not known yet.
 *
 * @param position - The unit's position after the command.
 * @param session - The session with the declared issues.
 * @param lead - What the command did, as the prompt's first sentence.
 * @param isDelegated - Whether a live coordinator delegates the unit.
 * @param cancels - The ids of the cancels the unit owes a done.
 * @returns The prompt, or the refusal with its reason and whether it ends the start rather than holding it.
 */
export function composeStart(position: Position, session: Session, lead: string, isDelegated = false, cancels: readonly string[] = []): StartComposition {
  const { pullRequest, current } = position
  if (position.isConcluded) return { kind: 'refused', isFinal: true, reason: 'the unit concluded before its turn came' }
  if (position.slice?.isRewritten) return { kind: 'refused', isFinal: false, reason: 'the branch history it was declared on was rewritten, so which step is current is not known yet' }
  if (position.integration?.state === 'unknown-end') return { kind: 'refused', isFinal: false, reason: 'whether its integration ended is not known yet, so which step is current is not known' }
  if (!current) return { kind: 'refused', isFinal: true, reason: 'the unit had no current step left to start when its turn came' }
  const stop = /[.!?]$/.test(lead) ? '' : '.'
  const source = session.issues.length ? ' from the issue' : ''
  return { kind: 'prompt', text: `${lead}${stop}${startMarker}${formatStepLabel(current.step, pullRequest)})${source}. ${composeFlowLine(position, session, isDelegated, cancels)}` }
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
 * Writes the prompt the mod submits for a start: a start composeStart wrote loses its step, which the prompt's entry adds from the
 * position then, since a prompt may queue past a turn that moves the unit; any other prompt is submitted as it is.
 *
 * @param start - The prompt composed.
 * @returns The prompt to submit.
 */
export function composeStartPrompt(start: string): string {
  const lead = readStartLead(start)
  return lead ? `${lead}${startTail}` : start
}

/**
 * Tells whether a prompt is a start the mod submitted.
 *
 * @param text - A prompt's text.
 * @returns True for a prompt composeStartPrompt wrote.
 */
export const isStartPrompt = (text: string): boolean => text.endsWith(startTail)

/**
 * Writes the flow line a prompt carries for the agent.
 *
 * @param position - The unit's position.
 * @param session - The session.
 * @param isDelegated - Whether a live coordinator delegates the unit.
 * @param cancels - The ids of the cancels the unit owes a done.
 * @returns The instruction, marked as the working agreement's.
 */
export const composeFlowLine = (position: Position, session: Session, isDelegated = false, cancels: readonly string[] = []): string =>
  markForAgent(composeInstruction(position, session, isDelegated, cancels))

/**
 * Directs the agent to the unit's next unmet requirement and any following human handover.
 * @param position - The unit's judged position.
 * @param session - The session's declared issues and facts.
 * @param isDelegated - Whether a live coordinator delegates the unit.
 * @param cancels - The ids of the cancels the unit owes a done.
 * @returns The flow instruction, including completion or blocked-state notices.
 */
function composeUnitInstruction(position: Position, session: Session, isDelegated: boolean, cancels: readonly string[]): string {
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
  // why: a cancel stops the unit's open work and the user's lift restores its tools only, so the step's action waits for the cancel's done.
  if (cancels.length) return `${flow.label}${issue} — current step: ${formatStepLabel(current.step, pullRequest)}. ${describeOwedCancels(cancels)}`
  if (isCiWait(position)) {
    const { reason, action } = describeCiBlocker(position.checks, `#${pullRequest?.number ?? ''}`)
    return `${flow.label}${issue} — current step: ${formatStepLabel(current.step, pullRequest)}. ${current.detail ?? current.fact ?? reason}: ${action}; do not report the unit as done before every check passes.`
  }
  // why: unless a following human step is named now, the agent closes this step by offering to run it itself.
  const next = position.states.slice(position.states.indexOf(current) + 1).find(state => state.state === 'pending')
  const handover = next?.step.isHuman && next.step.skill
    ? ` When it is done, do not run or offer ${next.step.skill} yourself: the next step is the user's — tell them to run /${next.step.skill}.`
    : ''
  const requirement = describeRequirement(current, session, position, isDelegated)
  const detail = current.step.isInWorktree ? describeDiagnoseNeed(current.need, session.issues) : current.detail ?? current.fact
  const fact = detail && detail !== requirement ? ` ${detail}.` : ''
  return `${flow.label}${issue} — current step: ${formatStepLabel(current.step, pullRequest)}.${fact} Next action: ${requirement}.${handover}`
}

/**
 * Words a failure to record this mod load in the process state, which every start delivery checks before it submits.
 * @param cause - Why the write failed.
 * @returns The words.
 */
export function describeLoadFailure(cause: string): string {
  return `the mod could not confirm that this load is recorded in its process state (${cause}); while it is not, it submits no prompt of its own and keeps its start prompts, and the tick records it again`
}

/**
 * Words the start prompts waiting for the session to be idle, as the pane and `/flow status` count them.
 * @param count - How many wait.
 * @returns The words.
 */
export function describeWaitingStarts(count: number): string {
  return `${count} start prompt${count === 1 ? '' : 's'} wait for this session to be idle; the tick or the turn end delivers them one at a time, in the order kept, each only once the one before it entered`
}

/**
 * Words how a prompt of the mod is started by hand, by what it is.
 * @param route - The route it was submitted on.
 * @param kind - The kind of start, for a start.
 * @returns The words.
 */
export function describeByHand(route: 'start' | 'wake' | 'doorbell', kind: 'step' | 'coordinate' | 'delegate'): string {
  if (route === 'wake') return 'tell the unit to call the verify tool'
  if (route === 'doorbell') return 'type any prompt, which delivers the waiting mail'
  // why: a step's start names the step current when it is composed, so it is started by hand from /flow status; a coordinate or delegate start is a fixed prompt, which the same command submits again, keeping the role or scope it set.
  return kind === 'step' ? 'start the current step by hand (/flow status names it)' : `run the same /flow ${kind} command again to submit its fixed prompt`
}

/**
 * Words the one row that says the session is held: every obligation that holds it, each with how to check it and how to resolve it by
 * hand, so resolving one never reveals another unexplained.
 * @param notes - The obligations.
 * @returns The words.
 */
export function describeHolds(notes: readonly HoldNote[]): string {
  const items = notes.map((note, index) => `${index + 1}) ${note.what}; check: ${note.check}; by hand: ${note.byHand}`)
  return `held: the mod submits no start, wake or doorbell prompt and asserts no missing message until ${notes.length === 1 ? 'this resolves' : `each of these ${notes.length} resolves`}: ${items.join(' ')}`
}

/**
 * Names a start by the command that kept it and its target, so a note tells one start from another of the same kind.
 * @param start - The start.
 * @returns The name.
 */
export function describeStartTarget(start: { kind: 'step'; lead: string } | { kind: 'coordinate' } | { kind: 'delegate'; issues: number[] }): string {
  if (start.kind === 'coordinate') return '/flow coordinate'
  if (start.kind === 'delegate') return `/flow delegate ${formatIssueReferences(start.issues, ' ')}`
  const lead = start.lead.split('\n')[0]?.trim() ?? ''
  return `the step start after "${lead.length > 80 ? `${lead.slice(0, 79)}…` : lead}"`
}

/**
 * Words a start prompt that was not delivered, as the unit's pane and `/flow status` show it.
 * @param fault - Which step failed and why.
 * @returns The words.
 */
export function describeStartFailure(fault: StartFault): string {
  const name = fault.label ? ` (${fault.label})` : ''
  const byHand = describeByHand('start', fault.kind)
  if (fault.stage === 'keep') {
    return `the command was applied, but its start prompt${name} was not kept (${fault.cause}); /flow status shows the process state on its Process row; ${byHand}`
  }
  if (fault.stage === 'keep-unknown') {
    return `the command was applied, but whether its start prompt${name} was kept is not known: the write that keeps it answered with a failure (${fault.cause}), and it may have landed; do not run the command again: the next tick reads the process state, and this note then says whether it waits, or how to start it by hand`
  }
  if (fault.stage === 'dropped') return `a kept start prompt${name} was not delivered: ${fault.cause}; it stays first in line, and the tick submits it again once the session is idle`
  return `a kept start prompt${name} was not delivered: its composition failed (${fault.cause}); it stays first in line, the starts kept after it wait for it, and the tick composes it again once the session is idle`
}
