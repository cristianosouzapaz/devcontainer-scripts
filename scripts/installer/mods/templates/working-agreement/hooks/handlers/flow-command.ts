import type { Args, Frozen } from 'claude-code'

import { recordAnchor } from '../core/anchor'
import { declareFlow } from '../core/declaration'
import type { EnginePort } from '../core/engine-port'
import { toastFailure } from '../core/failure-toast'
import { createFeaturePort } from '../core/feature-port'
import { refreshView } from '../core/pane-view'
import { readSession } from '../core/record-store'
import { withRecordLock } from '../core/session-memory'
import { markForAgent } from '../domain/messages'
import { runFollowUpCommand } from '../features/follow-up'
import { runHandoffCommand } from '../features/handoff'
import { applyOverride } from '../features/override'
import type { Result } from '../lib/result'
import { renderStatusText } from '../ui/status-text'

const humanOnly = ['trivial', 'follow-up', 'override', 'handoff']

/**
 * Runs `/flow`: opens the pane, prints its status, or runs one of the subcommands only the user may type.
 *
 * @param port - The engine calls.
 * @param event - The command run.
 * @returns The text the command answers.
 */
export async function handleFlowCommand(port: EnginePort, event: Frozen<Args<'command.run'>>): Promise<string> {
  const [subcommand = '', ...rest] = event.args.trim().split(/\s+/)
  const tail = rest.join(' ')
  if (humanOnly.includes(subcommand) && event.origin.kind !== 'composer') return markForAgent(`/flow ${subcommand} is the user's to run from the prompt.`)
  if (subcommand === 'handoff') return runHandoffCommand(createFeaturePort(port), tail)
  if (subcommand === 'trivial') return unwrap(await withRecordLock(() => declareFlow(port, 'trivial', [], 'human')))
  if (subcommand === 'follow-up') return unwrap(await runFollowUpCommand(createFeaturePort(port), tail))
  if (subcommand === 'override') return unwrap(await applyOverride(createFeaturePort(port), tail))
  const session = await readSession(port)
  if (!session.flow) return 'No flow declared (talk). The agent declares one before writing; you can run /flow trivial or /flow follow-up #n.'
  await withRecordLock(() => recordAnchor(port, session)).catch(toastFailure(port, "record the unit's commit"))
  await refreshView(port)
  const view = await port.readView()
  if (subcommand === 'status') return view ? renderStatusText(view) : ''
  await port.openPane()
  return 'Flow pane opened.'
}

// The user reads a refusal as plainly as an answer.
function unwrap(result: Result<string>): string {
  return result.isOk ? result.value : result.error
}
