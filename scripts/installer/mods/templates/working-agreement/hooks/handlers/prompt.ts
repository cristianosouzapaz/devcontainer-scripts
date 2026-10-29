import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { findDelegation } from '../core/delegation'
import type { EnginePort } from '../core/engine-port'
import { createReadPort } from '../core/read-port'
import { readWorkingTreeConfig } from '../core/verify-config'
import { syncIssues } from '../core/github-sync'
import { locatePosition } from '../core/position'
import { readVersionedSession } from '../core/record-store'
import { composeDelegatedLine } from '../domain/delegated-decision'
import { composeFlowLine } from '../domain/instruction'
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
  'A delegated unit session ends its turn on each decision it meets: answer it with unit_prompt (read its question with unit_read) with the choice, the reason and the cost of going back (low/medium/high).')
const delegatedLine = markForAgent('This unit is delegated: the user\'s steps /to-spec, /to-tickets, /flow approve <comment URL>, /flow skip and /flow follow-up are the coordinator\'s — ' +
  'where the flow says to ask the user for one, ask the coordinator through herdr agent prompt to type it here. The Verify config approval (/flow approve verify) stays the user\'s.')

/**
 * Words the notice of a repository config the installed mod rejects, so the agent tells the user.
 * @param error - The validation error, naming the field.
 * @returns The context line.
 */
const composeConfigLine = (error: string): string => markForAgent(`The repository config .claude/working-agreement.json is invalid for the installed mod (${error}). ` +
  'Tell the user; /flow status shows the error, and Verify refuses until the file is fixed.')

/**
 * Adds the flow's instruction or declaration reminder to a prompt, and a delegated unit's decision routing.
 * A finished unit's prompt carries only an invalid config's notice; a line the text already carries is not added again.
 *
 * @param engine - The engine calls.
 * @param event - The submitted prompt.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handlePromptSubmit(engine: EnginePort, event: Frozen<Args<'prompt.submit'>>, next: Next<'prompt.submit'>): Promise<EventResult<'prompt.submit'>> {
  const port = createReadPort(engine)
  armHandoff(event.origin, event.text)
  const config = await readWorkingTreeConfig(port)
  const configLines = config?.kind === 'invalid' ? [composeConfigLine(config.fact)] : []
  /** Hands the prompt on with the lines its text does not already carry. */
  const pass = (added: string[]): ReturnType<typeof next> => {
    const lines = added.filter(text => !event.text.includes(text))
    return lines.length ? next({ ...event, context: [...(event.context ?? []), ...lines] }) : next(event)
  }
  const held = await readVersionedSession(port)
  const saved = held.session
  const located = saved.flow ? await locatePosition(port, saved) : null
  if (located?.isConcluded) return pass(configLines)
  const session = saved.flow ? (await syncIssues(port, held)).session : saved
  const position = located ? withStates(located, session) : null
  if (isUnitFinished(position) && !position?.slice?.isRewritten) return pass(configLines)
  const line = position ? composeFlowLine(position, session) : isCoordinatorSession(session) ? coordinatorLine : noFlowLine
  // The mod's start prompt already carries the line.
  const isDelegated = position ? !!await bestEffort(port, 'delegation read', () => findDelegation(port, session.issues), null) : false
  return pass([line, ...(isDelegated ? [delegatedLine, composeDelegatedLine(session.issues)] : []), ...configLines])
}
