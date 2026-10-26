import type { Args, EventResult, Frozen, Next } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import { createReadPort } from '../core/read-port'
import { syncIssues } from '../core/github-sync'
import { locatePosition } from '../core/position'
import { readVersionedSession } from '../core/record-store'
import { composeFlowLine } from '../domain/instruction'
import { markForAgent } from '../domain/messages'
import { isUnitFinished, withStates } from '../domain/step-states'
import { armHandoff } from '../features/handoff'

const noFlowLine = markForAgent('No flow is declared. Reading and talking need none, but before the first flow step (grilling, to-spec, triage…) or the first write in the repository, ' +
  'classify the work per AGENTS.md and call declare_flow; if unsure, ask the user with a multiple-choice question.')

/**
 * Adds the flow's instruction or declaration reminder to a prompt.
 * A finished unit's prompt, or one whose text already carries the line, passes unchanged.
 *
 * @param engine - The engine calls.
 * @param event - The submitted prompt.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handlePromptSubmit(engine: EnginePort, event: Frozen<Args<'prompt.submit'>>, next: Next<'prompt.submit'>): Promise<EventResult<'prompt.submit'>> {
  const port = createReadPort(engine)
  armHandoff(event.origin, event.text)
  const held = await readVersionedSession(port)
  const saved = held.session
  const located = saved.flow ? await locatePosition(port, saved) : null
  if (located?.isConcluded) return next(event)
  const session = saved.flow ? (await syncIssues(port, held)).session : saved
  const position = located ? withStates(located, session) : null
  if (isUnitFinished(position) && !position?.slice?.isRewritten) return next(event)
  const line = position ? composeFlowLine(position, session) : noFlowLine
  // The mod's start prompt already carries the line.
  if (event.text.includes(line)) return next(event)
  return next({ ...event, context: [...(event.context ?? []), line] })
}
