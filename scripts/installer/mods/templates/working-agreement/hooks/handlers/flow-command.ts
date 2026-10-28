import type { Args, Frozen } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { declareFlow } from '../core/declaration'
import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { logEvent } from '../core/flow-log'
import { refreshView } from '../core/pane-view'
import { locatePosition, readUnitFlow } from '../core/position'
import { createReadPort } from '../core/read-port'
import { readSession, updateUnits } from '../core/record-store'
import { approveVerify } from '../core/verify'
import { withRecordLock } from '../core/session-memory'
import { composeStart } from '../domain/instruction'
import type { DeclaredFlow } from '../domain/instruction'
import { markForAgent } from '../domain/messages'
import { applyApproval } from '../features/approve'
import { runFollowUpCommand } from '../features/follow-up'
import { runHandoffCommand } from '../features/handoff'
import { fail, succeed } from '../lib/result'
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
  if (subcommand === 'skip') return startAfter(port, await withRecordLock(async () => {
    const session = await readSession(port)
    // A skip names a step the unit runs: Integrate for a child unit, PR for any other.
    const flow = (await readUnitFlow(createReadPort(port), session))?.flow
    if (!flow) return fail('No flow declared — declare a flow before skipping a step.')
    const match = flow.steps.find(step => [step.id, step.label].some(name => tail.toLowerCase() === name.toLowerCase() || tail.toLowerCase().startsWith(`${name.toLowerCase()} `)))
    if (!match) return fail('Unknown step — use a step id or label from this flow.')
    const reason = tail.slice(tail.toLowerCase().startsWith(`${match.id.toLowerCase()} `) ? match.id.length : match.label.length).trim()
    if (!reason) return fail('A skip needs a non-empty reason.')
    await updateUnits(port, session, unit => ({ ...unit, skips: [...(unit.skips ?? []), { step: match.id, reason }] }))
    logEvent(port, session, 'skip', { step: match.id, reason })
    await refreshView(port, { isQuiet: true, isSynced: true })
    return succeed(`Skipped ${match.label}: ${reason}`)
  }))
  if (subcommand === 'handoff') return runHandoffCommand(createFeaturePort(port), tail)
  if (subcommand === 'trivial') return startStep(port, await withRecordLock(() => declareFlow(port, 'trivial', [], 'human')))
  if (subcommand === 'follow-up') return startStep(port, await runFollowUpCommand(createFeaturePort(port), tail))
  if (subcommand === 'approve' && rest[0] === 'verify') {
    if (rest.length > 2) return 'Usage: /flow approve verify [blob id].'
    const result = await withRecordLock(() => approveVerify(port, rest[1]))
    await refreshView(port, { isQuiet: true, isSynced: true })
    // The preview without an id only shows the config.
    return rest[1] === undefined ? unwrap(result) : startAfter(port, result)
  }
  if (subcommand === 'approve') return startAfter(port, await applyApproval(createFeaturePort(port), tail))
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

/**
 * Answers a user declaration and, once it succeeded, starts an agent turn on its current step.
 *
 * @param port - The engine calls.
 * @param result - The declaration.
 * @returns The declaration's reply or refusal.
 */
function startStep(port: EnginePort, result: Result<DeclaredFlow>): string {
  if (!result.isOk) return result.error
  const { reply, start } = result.value
  if (start) submitStart(port, async () => start)
  return reply
}

/**
 * Answers a user command that moved the unit and, once it succeeded, starts an agent turn on the new current step.
 *
 * @param port - The engine calls.
 * @param result - The command's reply, which leads the prompt, or its refusal.
 * @returns The reply or refusal.
 */
function startAfter(port: EnginePort, result: Result<string>): string {
  if (result.isOk) submitStart(port, async () => {
    const session = await readSession(port)
    const position = await locatePosition(createReadPort(port), session)
    return position ? composeStart(position, session, result.value) : null
  })
  return unwrap(result)
}

/**
 * Submits the start prompt once the command has answered.
 * The prompt waits for the session to go idle, which the command holds, so it is submitted after the reply;
 * a failure leaves the command's effect standing and is logged to debug only.
 *
 * @param port - The engine calls.
 * @param compose - Writes the prompt, or null when there is no current step to start.
 */
function submitStart(port: EnginePort, compose: () => Promise<string | null>): void {
  port.defer(() => void bestEffort(port, 'start prompt', async () => {
    const start = await compose()
    if (start) await port.submitPrompt(start)
  }, undefined))
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
