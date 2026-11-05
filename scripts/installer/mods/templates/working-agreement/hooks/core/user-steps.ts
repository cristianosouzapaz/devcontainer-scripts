import { composeStart } from '../domain/instruction'
import type { DeclaredFlow } from '../domain/instruction'
import { applyApproval } from '../features/approve'
import { runFollowUpCommand } from '../features/follow-up'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { bestEffort } from './best-effort'
import { findLiveDelegation, recordDelegatedStep } from './delegation'
import type { EnginePort } from './engine-port'
import { createFeaturePort } from './feature-port'
import { logEvent } from './flow-log'
import { refreshView } from './pane-view'
import { locatePosition, readUnitFlow } from './position'
import { createReadPort } from './read-port'
import { readSession, updateUnits } from './record-store'
import { withRecordLock } from './session-memory'

/**
 * Runs `/flow skip <step> <reason>`: records the skip, as delegated in a delegated unit, then starts a turn on the new current step.
 * The typed command and a coordinator's checked step both run it.
 * @param port - The engine calls.
 * @param tail - The words after `skip`.
 * @returns The reply, or the refusal.
 */
export async function runSkipStep(port: EnginePort, tail: string): Promise<Result<string>> {
  const id = tail.split(/\s+/)[0]?.toLowerCase() ?? ''
  return startAfter(port, await recordIfDelegated(port, `/flow skip ${id}`.trim(), await withRecordLock(async () => {
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
  })))
}

/**
 * Runs `/flow approve <diagnosis URL>`: approves the diagnosis, as delegated in a delegated unit, then starts a turn on the new current step.
 * @param port - The engine calls.
 * @param tail - The words after `approve`.
 * @returns The reply, or the refusal.
 */
export async function runApproveStep(port: EnginePort, tail: string): Promise<Result<string>> {
  return startAfter(port, await recordIfDelegated(port, '/flow approve', await applyApproval(createFeaturePort(port), tail)))
}

/**
 * Runs `/flow follow-up #n`: declares the Follow-up flow, as delegated in a delegated unit, then starts a turn on its first step.
 * @param port - The engine calls.
 * @param tail - The words after `follow-up`.
 * @returns The reply, or the refusal.
 */
export async function runFollowUpStep(port: EnginePort, tail: string): Promise<Result<string>> {
  return startStep(port, await recordIfDelegated(port, '/flow follow-up', await runFollowUpCommand(createFeaturePort(port), tail)))
}

/**
 * Records a reserved step that succeeded in a delegated unit as delegated, and repaints the pane when it was.
 * @param port - The engine calls.
 * @param command - The step's command.
 * @param result - The step's outcome.
 * @returns The outcome, unchanged.
 */
async function recordIfDelegated<T>(port: EnginePort, command: string, result: Result<T>): Promise<Result<T>> {
  if (result.isOk && await bestEffort(port, 'delegated step record', () => recordDelegatedStep(port, command), false)) await refreshView(port, { isQuiet: true, isSynced: true })
  return result
}

/**
 * Starts an agent turn on the current step once a declaration succeeded.
 * @param port - The engine calls.
 * @param result - The declaration.
 * @returns The declaration's reply, or its refusal.
 */
export function startStep(port: EnginePort, result: Result<DeclaredFlow>): Result<string> {
  if (!result.isOk) return result
  const { reply, start } = result.value
  if (start) submitStart(port, async () => start)
  return succeed(reply)
}

/**
 * Starts an agent turn on the new current step once a command that moved the unit succeeded; its reply leads the prompt.
 * @param port - The engine calls.
 * @param result - The command's reply, or its refusal.
 * @returns The result, unchanged.
 */
function startAfter(port: EnginePort, result: Result<string>): Result<string> {
  if (result.isOk) submitStart(port, async () => {
    const session = await readSession(port)
    const position = await locatePosition(createReadPort(port), session)
    const isDelegated = position ? !!await bestEffort(port, 'delegation read', () => findLiveDelegation(port, session.issues), null) : false
    return position ? composeStart(position, session, result.value, isDelegated) : null
  })
  return result
}

/**
 * Submits the start prompt once the command has answered.
 * The prompt waits for the session to go idle, which the command holds, so it is submitted after the reply;
 * a failure leaves the command's effect standing and is logged to debug only.
 * @param port - The engine calls.
 * @param compose - Writes the prompt, or null when there is no current step to start.
 */
export function submitStart(port: EnginePort, compose: () => Promise<string | null>): void {
  port.defer(() => void bestEffort(port, 'start prompt', async () => {
    const start = await compose()
    if (start) await port.submitPrompt(start)
  }, undefined))
}
