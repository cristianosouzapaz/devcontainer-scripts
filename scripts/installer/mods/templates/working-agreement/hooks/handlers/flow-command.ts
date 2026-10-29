import type { Args, Frozen } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { declareFlow } from '../core/declaration'
import { composeSigningReturn, readPushGuard } from '../core/delegated-commits'
import { findDelegation, readOwnScope, recordDelegatedStep, runDelegate } from '../core/delegation'
import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { setUpLabels } from '../core/issue-write'
import { logEvent } from '../core/flow-log'
import { refreshView } from '../core/pane-view'
import { locatePosition, readUnitFlow } from '../core/position'
import { createReadPort } from '../core/read-port'
import { readSession, updateSession, updateUnits } from '../core/record-store'
import { composeReport } from '../core/report'
import { approveVerify } from '../core/verify'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { isCoordinatorSession, refuseModulesAhead } from '../domain/coordinator'
import { describeSigning } from '../domain/delegated-commits'
import { describeScope, parseDelegateRequest } from '../domain/delegation'
import { composeStart } from '../domain/instruction'
import type { DeclaredFlow } from '../domain/instruction'
import { markForAgent } from '../domain/messages'
import { applyApproval } from '../features/approve'
import { runFollowUpCommand } from '../features/follow-up'
import { runHandoffCommand } from '../features/handoff'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { keyedLine, renderStatusText } from '../ui/status-text'
import { renderFlowStatus } from '../core/status'

const noFlowMessage = 'No flow declared (talk). The agent declares one before writing; you can run /flow trivial or /flow follow-up #n.'

const coordinatorMessage = 'Coordinator: this session never writes in the repository, nor do its subagents — writes happen in unit sessions, each in its own herdr worktree.'

// why: The coordinator types into a unit through herdr exactly as the user does, so in a delegated unit the approval cannot be told
// from the coordinator's; it decides which commands the mod runs on the machine, so it is taken only where nothing is delegated.
const delegatedVerifyRefusal = 'The Verify config approval stays the user\'s and is never taken in a delegated unit: approve it from a session whose unit is not delegated (approval holds for the whole repository), or after /flow delegate stop.'

const humanOnly = ['coordinate', 'delegate', 'setup-labels', 'trivial', 'follow-up', 'approve', 'handoff', 'skip']

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
  if (subcommand === 'skip') return startAfter(port, await recordIfDelegated(port, `/flow skip ${rest[0]?.toLowerCase() ?? ''}`.trim(), await withRecordLock(async () => {
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
  const outerRefusal = refuseModulesAhead(sessionMemory.modulesAhead)
  if (subcommand === 'coordinate' && outerRefusal) return outerRefusal
  if (subcommand === 'coordinate') return unwrap(await withRecordLock(async () => {
    if ((await readSession(port)).flow) return fail('This session has a declared flow — a coordinator starts from a session with none; open a fresh one.')
    if (await updateSession(port, session => isCoordinatorSession(session) ? null : { ...session, role: 'coordinator' })) await refreshView(port, { isQuiet: true })
    return succeed(coordinatorMessage)
  }))
  if (subcommand === 'delegate') {
    const request = parseDelegateRequest(rest)
    if (!request.isOk) return request.error
    if (request.value.kind !== 'stop' && outerRefusal) return outerRefusal
    const isPushGuarded = request.value.kind === 'stop' || await bestEffort(port, 'ruleset read', () => readPushGuard(port), false)
    const result = await runDelegate(port, request.value, isPushGuarded)
    if (result.isOk) await refreshView(port, { isQuiet: true })
    // The user is back once they stop the delegation: they get the commands that sign and push what the units committed.
    const signing = result.isOk && request.value.kind === 'stop' ? await bestEffort(port, 'signing commands', () => composeSigningReturn(port), []) : []
    return `${unwrap(result)}${describeSigning(signing)}`
  }
  if (subcommand === 'setup-labels') return unwrap(await setUpLabels(port))
  if (subcommand === 'handoff') return runHandoffCommand(createFeaturePort(port), tail)
  if (subcommand === 'trivial') return startStep(port, await withRecordLock(() => declareFlow(port, 'trivial', [], 'human')))
  if (subcommand === 'follow-up') return startStep(port, await recordIfDelegated(port, '/flow follow-up', await runFollowUpCommand(createFeaturePort(port), tail)))
  if (subcommand === 'approve' && rest[0] === 'verify') {
    if (rest.length > 2) return 'Usage: /flow approve verify [blob id].'
    if (rest[1] !== undefined && await findDelegation(port, (await readSession(port)).issues, true).catch(() => true)) return delegatedVerifyRefusal
    const result = await withRecordLock(() => approveVerify(port, rest[1]))
    await refreshView(port, { isQuiet: true, isSynced: true })
    // The preview without an id only shows the config.
    return rest[1] === undefined ? unwrap(result) : startAfter(port, result)
  }
  if (subcommand === 'approve') return startAfter(port, await recordIfDelegated(port, '/flow approve', await applyApproval(createFeaturePort(port), tail)))
  const session = await readSession(port)
  if (subcommand === 'report') {
    return isCoordinatorSession(session) ? composeReport(port) : '/flow report runs only in a coordinator session.'
  }
  if (subcommand === 'status') {
    const facts = await renderFlowStatus(port)
    const view = await port.readView()
    const scope = isCoordinatorSession(session) ? await readOwnScope(port) : null
    const pane = session.flow && view ? renderStatusText(view)
      : isCoordinatorSession(session) ? `${coordinatorMessage}${scope ? `\n${keyedLine('Delegating', describeScope(scope))}` : ''}${describeSigning(await bestEffort(port, 'signing commands', () => composeSigningReturn(port), []))}` : noFlowMessage
    return `${pane}\n\n${facts}`
  }
  if (!session.flow && !isCoordinatorSession(session)) return noFlowMessage
  await refreshView(port)
  await port.openPane()
  return 'Flow pane opened.'
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
