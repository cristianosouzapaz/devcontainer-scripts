import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { findLiveDelegation } from '../core/delegation'
import type { EnginePort } from '../core/engine-port'
import { escalateIdleUnits } from '../core/escalation'
import { readOwedCancels } from '../core/mailbox'
import { closeIdleUnits } from '../core/unit-close'
import { createReadPort } from '../core/read-port'
import { readWorkingTreeConfig } from '../core/verify-config'
import { syncIssues } from '../core/github-sync'
import { locatePosition } from '../core/position'
import { readVersionedSession } from '../core/record-store'
import { composeDelegatedLine } from '../domain/delegated-decision'
import { composeFlowLine, isStartPrompt } from '../domain/instruction'
import { doorbellText, emptyDoorbell } from '../domain/mail'
import { markForAgent } from '../domain/messages'
import { isUnitFinished, withStates } from '../domain/step-states'
import { wakePrompt } from '../core/approval-wake'
import { handoffResumeLead } from '../features/handoff'
import { isCoordinatorSession } from '../domain/coordinator'

const noFlowLine = markForAgent('No flow is declared. Reading and talking need none, but before the first flow step (grilling, to-spec, triage…) or the first write in the repository, ' +
  'classify the work per AGENTS.md and call declare_flow; if unsure, ask the user with a multiple-choice question. ' +
  'If the user asks for a manager or coordinator session, call suggest_coordinate instead.')
const coordinatorLine = markForAgent('This session is the coordinator: it and its subagents never write in the repository — read, plan and route; ' +
  'every write happens in a unit session in its own herdr worktree. The mod\'s issue tools are its only way to write to GitHub. ' +
  'If the user says they delegate, call suggest_delegate with the issues they named; delegation is set only when they submit /flow delegate. ' +
  'A delegated unit session sends each decision it meets as a question, and each stop only you or the user can lift as a blocked: answer it with send, kind answer and in_reply_to its id, with the choice, the reason and the cost of going back (low/medium/high). ' +
  'A question only the user can answer, such as a ⛳, you forward with send, to user and forward its id, never answer yourself: the user answers it in /flow inbox, and the answer goes to the unit. ' +
  'Take a user\'s step for a unit only with its tool, after a delegated decision you posted with issue_comment that names the step in its Choice: approve_unit (/flow approve; ' +
  'its Choice or Reason cites the diagnosis comment URL and the unit\'s red command), skip_unit (/flow skip <step>; it cites the reason) or follow_up_unit (/flow follow-up #n). ' +
  'A prose approval records nothing, unit_prompt refuses every slash command, and no agent types a /flow step through herdr.')
const delegatedLine = markForAgent('This unit is delegated: the user\'s steps /to-spec, /to-tickets, /flow approve <comment URL>, /flow skip and /flow follow-up are the coordinator\'s — ' +
  'where the flow says to ask the user for one, ask the coordinator for it with send; it relays the step with its own tools, and this session\'s mod checks the delegated decision and applies it itself, so you never type it. The commit tool waits for a diagnosis approval. The Verify config approval stays the user\'s, from their own terminal with the command the pane names. ' +
  'At Commit, once Verify passes on the tip tree, stage the finished work with git add and commit it with the commit tool, without stopping; never push. ' +
  'This overrides the Commit step\'s and AGENTS.md\'s rule that commits are the user\'s.')

/**
 * Words the notice of a repository config the installed mod rejects, so the agent tells the user.
 * @param error - The validation error, naming the field.
 * @returns The context line.
 */
const composeConfigLine = (error: string): string => markForAgent(`The repository config .claude/working-agreement.json is invalid for the installed mod (${error}). ` +
  'Tell the user; /flow status shows the error, and Verify refuses until the file is fixed.')

/**
 * Adds the flow's instruction or declaration reminder to a prompt the user submits, and a delegated unit's decision routing, and the
 * coordinator's escalation lines; a line the text already carries is not added again. The engine skips the calling hook, so the mod's
 * own prompts never pass here: handleOwnPromptEntry adds the same lines to them as they enter.
 *
 * @param engine - The engine calls.
 * @param event - The submitted prompt.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handlePromptSubmit(engine: EnginePort, event: Frozen<Args<'prompt.submit'>>, next: Next<'prompt.submit'>): Promise<EventResult<'prompt.submit'>> {
  const lines = (await composePromptLines(engine)).filter(line => !event.text.includes(line))
  return lines.length ? next({ ...event, context: [...(event.context ?? []), ...lines] }) : next(event)
}

/**
 * Adds to the mod's own prompt, as it enters, the lines handlePromptSubmit adds to the user's, from the position at entry: a start the mod
 * submitted gets the step it starts then; a doorbell that carries mail, the approval wake and a handoff's continuation get the flow line. A doorbell that found no mail keeps only its no-mail
 * line, and the user's prompts pass unchanged.
 *
 * @param engine - The engine calls.
 * @param event - The classic prompt submit, which fires for the mod's own prompts too.
 * @param next - The rest of the chain, which delivers the mail.
 * @returns What the chain answers, with the lines its text and context do not already carry.
 */
export async function handleOwnPromptEntry(engine: EnginePort, event: Frozen<Args<'classic.UserPromptSubmit'>>,
  next: (event: Frozen<Args<'classic.UserPromptSubmit'>>) => Promise<EventResult<'classic.UserPromptSubmit'>>): Promise<EventResult<'classic.UserPromptSubmit'>> {
  const result = await next(event)
  const isOwn = event.prompt === doorbellText || event.prompt === wakePrompt || isStartPrompt(event.prompt) || event.prompt.startsWith(handoffResumeLead)
  if (!isOwn || result.block || result.additionalContext?.includes(emptyDoorbell)) return result
  const carried = [event.prompt, ...result.additionalContext ?? []]
  const lines = (await bestEffort(engine, 'own prompt lines', () => composePromptLines(engine), []))
    .filter(line => !carried.some(text => text.includes(line)))
  return lines.length ? { ...result, additionalContext: [...result.additionalContext ?? [], ...lines] } : result
}

/**
 * Composes the lines a prompt enters with: a finished unit's only an invalid config's notice; otherwise the flow line, or the declaration
 * reminder or coordinator line with no flow, a delegated unit's decision routing, and the coordinator's escalation and close notices.
 * While the unit owes a cancel, its flow line names that cancel's done instead of the step's next action.
 *
 * @param engine - The engine calls.
 * @returns The lines.
 */
async function composePromptLines(engine: EnginePort): Promise<string[]> {
  const port = createReadPort(engine)
  const config = await readWorkingTreeConfig(port)
  const configLines = config?.kind === 'invalid' ? [composeConfigLine(config.fact)] : []
  const held = await readVersionedSession(port)
  const saved = held.session
  const located = saved.flow ? await locatePosition(port, saved) : null
  if (located?.isConcluded) return configLines
  const session = saved.flow ? (await syncIssues(port, held)).session : saved
  const position = located ? withStates(located, session) : null
  if (isUnitFinished(position) && !position?.slice?.isRewritten) return configLines
  const isDelegated = position ? !!await bestEffort(port, 'delegation read', () => findLiveDelegation(port, session.issues), null) : false
  const cancels = position ? (await bestEffort(port, 'cancel read', () => readOwedCancels(engine), [])).map(envelope => envelope.id) : []
  const line = position ? composeFlowLine(position, session, isDelegated, cancels) : isCoordinatorSession(session) ? coordinatorLine : noFlowLine
  // why: a unit's turn-end notice arrives here as a prompt, the first moment its coordinator's process sees it idle.
  const escalated = !position && isCoordinatorSession(session) ? await bestEffort(engine, 'escalation', async () => (await escalateIdleUnits(engine)).map(each => each.notice), []) : []
  const closed = !position && isCoordinatorSession(session) ? await bestEffort(engine, 'unit close', () => closeIdleUnits(engine), []) : []
  return [line, ...[...escalated, ...closed].map(markForAgent), ...(isDelegated ? [delegatedLine, composeDelegatedLine(session.issues)] : []), ...configLines]
}
