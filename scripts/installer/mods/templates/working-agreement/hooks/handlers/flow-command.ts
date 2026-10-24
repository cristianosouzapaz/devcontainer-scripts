import type { Args, Frozen } from 'claude-code'

import { declareFlow } from '../core/declaration'
import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { refreshView } from '../core/pane-view'
import { findFlow } from '../domain/flow-definitions'
import { readSession, updateUnits } from '../core/record-store'
import { approveVerify } from '../core/verify'
import { withRecordLock } from '../core/session-memory'
import { markForAgent } from '../domain/messages'
import { applyApproval } from '../features/approve'
import { runFollowUpCommand } from '../features/follow-up'
import { runHandoffCommand } from '../features/handoff'
import type { Result } from '../lib/result'
import { renderStatusText } from '../ui/status-text'
import { renderFlowStatus } from '../core/status'

const noFlowMessage = 'No flow declared (talk). The agent declares one before writing; you can run /flow trivial or /flow follow-up #n.'

const humanOnly = ['trivial', 'follow-up', 'approve', 'handoff', 'skip']

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
  if (subcommand === 'skip') return withRecordLock(async () => {
    const session = await readSession(port)
    const flow = findFlow(session.flow)
    if (!flow) return 'No flow declared — declare a flow before skipping a step.'
    const match = flow.steps.find(step => [step.id, step.label].some(name => tail.toLowerCase() === name.toLowerCase() || tail.toLowerCase().startsWith(`${name.toLowerCase()} `)))
    if (!match) return 'Unknown step — use a step id or label from this flow.'
    const reason = tail.slice(tail.toLowerCase().startsWith(`${match.id.toLowerCase()} `) ? match.id.length : match.label.length).trim()
    if (!reason) return 'A skip needs a non-empty reason.'
    await updateUnits(port, session, unit => ({ ...unit, skips: [...(unit.skips ?? []), { step: match.id, reason }] }))
    await refreshView(port, true, true)
    return `Skipped ${match.label}: ${reason}`
  })
  if (subcommand === 'handoff') return runHandoffCommand(createFeaturePort(port), tail)
  if (subcommand === 'trivial') return unwrap(await withRecordLock(() => declareFlow(port, 'trivial', [], 'human')))
  if (subcommand === 'follow-up') return unwrap(await runFollowUpCommand(createFeaturePort(port), tail))
  if (subcommand === 'approve' && rest[0] === 'verify') {
    if (rest.length > 2) return 'Usage: /flow approve verify [blob id].'
    const text = await withRecordLock(() => approveVerify(port, rest[1]))
    await refreshView(port, true, true)
    return text
  }
  if (subcommand === 'approve') return unwrap(await applyApproval(createFeaturePort(port), tail))
  const session = await readSession(port)
  if (subcommand === 'status') {
    const facts = await renderFlowStatus(port)
    const view = await port.readView()
    const pane = session.flow && view ? renderStatusText(view) : noFlowMessage
    return `${pane}\n\n${facts}`
  }
  if (!session.flow) return noFlowMessage
  await refreshView(port)
  await port.openPane()
  return 'Flow pane opened.'
}

// The user reads a refusal as plainly as an answer.
/**
 * Exposes both successful command replies and failures as user-facing text.
 * @param result - The command result.
 * @returns The reply or failure text.
 */
function unwrap(result: Result<string>): string {
  return result.isOk ? result.value : result.error
}
