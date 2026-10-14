import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { recordAnchor } from '../core/anchor'
import type { EnginePort } from '../core/engine-port'
import { toastFailure } from '../core/failure-toast'
import { syncIssues } from '../core/github-sync'
import { observeTaskNotification } from '../core/observation-recording'
import { refreshView } from '../core/pane-view'
import { locatePosition } from '../core/position'
import { readSession } from '../core/record-store'
import { hasDetachedRuns, readTaskEnds, settleDetachedTask } from '../core/runs-in-flight'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { absorbTree } from '../core/tree-record'
import { readVerifyConfig } from '../core/verify-config'
import { composeInstruction } from '../domain/instruction'
import { markForAgent } from '../domain/messages'
import { isUnitFinished } from '../domain/step-states'
import { armHandoff } from '../features/handoff'

const noFlowLine = markForAgent('No flow is declared. Reading and talking need none, but before the first flow step (grilling, to-spec, triage…) or the first write in the repository, ' +
  'classify the work per AGENTS.md and call declare_flow; if unsure, ask the user with a multiple-choice question.')

/**
 * Records the background runs a task notification reports the end of, takes the tree into the record at a prompt the user
 * submitted while no writer a call left running is known, then adds the flow's instruction, or the reminder
 * to declare one, to a submitted prompt's context, with the notice of an ignored verify file; a finished unit's prompt
 * passes unchanged.
 *
 * @param port - The engine calls.
 * @param event - The submitted prompt.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export async function handlePromptSubmit(port: EnginePort, event: Frozen<Args<'prompt.submit'>>, next: Next<'prompt.submit'>): Promise<EventResult<'prompt.submit'>> {
  armHandoff(event.origin, event.text)
  // The engine stamps the origin, so a typed envelope settles nothing; settling first lets this turn's instruction see the outcome.
  if (event.origin.kind === 'task-notification') {
    for (const end of readTaskEnds(event.text)) settleDetachedTask(end.id)
    await withRecordLock(async () => {
      if (await observeTaskNotification(port, await readSession(port), event.text)) await refreshView(port, true)
    }).catch(toastFailure(port, 'record the task notification'))
  }
  // The tree changed since the turn end is the user's own work, unless a writer a call left running may have changed it.
  if (event.origin.kind === 'composer' && !hasDetachedRuns()) {
    await withRecordLock(async () => absorbTree(port, await readSession(port))).catch(toastFailure(port, 'take in the working tree'))
  }
  const saved = await readSession(port)
  if (saved.flow) await withRecordLock(() => recordAnchor(port, saved)).catch(toastFailure(port, "record the unit's commit"))
  const session = saved.flow ? await syncIssues(port, saved) : saved
  const position = session.flow ? await locatePosition(port, session) : null
  if (isUnitFinished(session, position)) return next(event)
  const line = position ? markForAgent(composeInstruction(position, session)) : noFlowLine
  const verifyConfig = await readVerifyConfig(port)
  return next({ ...event, context: [...(event.context ?? []), line, ...(verifyConfig.kind === 'ignored' ? [verifyConfig.notice] : [])] })
}

/**
 * Records the permission mode the classic prompt submission reports.
 *
 * @param event - The classic prompt submission.
 * @param next - The rest of the chain.
 * @returns What the chain answers.
 */
export function handleClassicPromptSubmit(event: Frozen<Args<'classic.UserPromptSubmit'>>, next: Next<'classic.UserPromptSubmit'>): Promise<EventResult<'classic.UserPromptSubmit'>> {
  sessionMemory.permissionMode = event.permission_mode ?? sessionMemory.permissionMode
  return next(event)
}
