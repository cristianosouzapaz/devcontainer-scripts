import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { findLiveDelegation } from '../core/delegation'
import type { EnginePort } from '../core/engine-port'
import { escalateIdleUnits } from '../core/escalation'
import { hasUnreadMail } from '../core/mailbox'
import { closeIdleUnits } from '../core/unit-close'
import { createReadPort } from '../core/read-port'
import { readWorkingTreeConfig } from '../core/verify-config'
import { syncIssues } from '../core/github-sync'
import { locatePosition } from '../core/position'
import { readVersionedSession } from '../core/record-store'
import { composeDelegatedLine } from '../domain/delegated-decision'
import { composeFlowLine, composeStart, readStartLead } from '../domain/instruction'
import { doorbellText } from '../domain/mail'
import { markForAgent } from '../domain/messages'
import { isUnitFinished, withStates } from '../domain/step-states'
import { armHandoff } from '../features/handoff'
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
 * Adds the flow's instruction or declaration reminder to a prompt, and a delegated unit's decision routing; rebuilds the mod's
 * start prompt from its lead, and adds the coordinator's escalation lines. A finished unit's prompt carries only an invalid config's notice; a line the text already carries is not added again.
 * The mod's own doorbell prompt enters nothing when no unread mail is left for it to carry.
 *
 * @param engine - The engine calls.
 * @param event - The submitted prompt.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handlePromptSubmit(engine: EnginePort, event: Frozen<Args<'prompt.submit'>>, next: Next<'prompt.submit'>): Promise<EventResult<'prompt.submit'>> {
  // why: an injection point that ran after the ring delivered the mail already; answering without next enters no prompt and starts no
  // turn, where the classic hook's block would show an expected outcome in the error colour.
  if (event.origin?.kind === 'plugin' && event.origin.name === 'working-agreement' && event.text === doorbellText && !await hasUnreadMail(engine)) return { text: event.text }
  const port = createReadPort(engine)
  armHandoff(event.origin, event.text)
  const config = await readWorkingTreeConfig(port)
  const configLines = config?.kind === 'invalid' ? [composeConfigLine(config.fact)] : []
  // why: The mod's start prompt is written when its command answers but enters only once the session is idle, maybe
  // after the unit moved on, so only its lead is kept and the step it starts is rewritten from the position at entry.
  const lead = event.origin?.kind === 'plugin' && event.origin.name === 'working-agreement' ? readStartLead(event.text) : undefined
  // Hands the prompt on, its text rebuilt from a start prompt's lead, with the lines that text does not already carry.
  const pass = (added: string[], text = lead ?? event.text): ReturnType<typeof next> => {
    const lines = added.filter(line => !text.includes(line))
    return text !== event.text || lines.length ? next({ ...event, text, context: [...(event.context ?? []), ...lines] }) : next(event)
  }
  const held = await readVersionedSession(port)
  const saved = held.session
  const located = saved.flow ? await locatePosition(port, saved) : null
  if (located?.isConcluded) return pass(configLines)
  const session = saved.flow ? (await syncIssues(port, held)).session : saved
  const position = located ? withStates(located, session) : null
  if (isUnitFinished(position) && !position?.slice?.isRewritten) return pass(configLines)
  const isDelegated = position ? !!await bestEffort(port, 'delegation read', () => findLiveDelegation(port, session.issues), null) : false
  const line = position ? composeFlowLine(position, session, isDelegated) : isCoordinatorSession(session) ? coordinatorLine : noFlowLine
  const start = lead && position ? composeStart(position, session, lead, isDelegated) : null
  // why: a unit's turn-end notice arrives here as a prompt, the first moment its coordinator's process sees it idle.
  const escalated = !position && isCoordinatorSession(session) ? await bestEffort(engine, 'escalation', () => escalateIdleUnits(engine), []) : []
  const closed = !position && isCoordinatorSession(session) ? await bestEffort(engine, 'unit close', () => closeIdleUnits(engine), []) : []
  return pass([line, ...[...escalated, ...closed].map(markForAgent), ...(isDelegated ? [delegatedLine, composeDelegatedLine(session.issues)] : []), ...configLines], start ?? undefined)
}
