import type { Args, Frozen } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { declareFlow } from '../core/declaration'
import { composeSigningReturn, readPushGuard } from '../core/delegated-commits'
import { findDelegation, readOwnScope, recordDelegatedStep, runDelegate } from '../core/delegation'
import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { findMissingReviewLabel, setUpLabels } from '../core/issue-write'
import { logEvent } from '../core/flow-log'
import { refreshView } from '../core/pane-view'
import { locatePosition, readUnitFlow } from '../core/position'
import { createReadPort } from '../core/read-port'
import { readSession, updateSession, updateUnits } from '../core/record-store'
import { composeReport } from '../core/report'
import { describeRetirement, planRetirement, retireUnit } from '../core/retire'
import { approveVerify } from '../core/verify'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { composeCoordinatePrompt, isCoordinatorSession, refuseModulesAhead } from '../domain/coordinator'
import { describeSigning } from '../domain/delegated-commits'
import { composeDelegatePrompt, describeScope, parseDelegateRequest } from '../domain/delegation'
import { triageLabels } from '../domain/issue-fields'
import { composeStart } from '../domain/instruction'
import type { DeclaredFlow } from '../domain/instruction'
import { markForAgent } from '../domain/messages'
import { applyApproval } from '../features/approve'
import { runFollowUpCommand } from '../features/follow-up'
import { runHandoffCommand } from '../features/handoff'
import { readIssue } from '../lib/github'
import { isIssueNumber } from '../lib/guards'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { keyedLine, renderStatusText } from '../ui/status-text'
import { renderFlowStatus } from '../core/status'

const noFlowMessage = 'No flow declared (talk). The agent declares one before writing; you can run /flow trivial or /flow follow-up #n.'

const coordinatorMessage = 'Coordinator: this session never writes in the repository, nor do its subagents — writes happen in unit sessions, each in its own herdr worktree.'

// why: The coordinator types into a unit through herdr exactly as the user does, so in a delegated unit the approval cannot be told
// from the coordinator's; it decides which commands the mod runs on the machine, so it is taken only where nothing is delegated.
const delegatedVerifyRefusal = 'The Verify config approval stays the user\'s and is never taken in a delegated unit: approve it from a session whose unit is not delegated (approval holds for the whole repository), or after /flow delegate stop.'

// why: The same reason as the Verify approval: in a delegated unit the coordinator's typing reads as the user's, and retiring is the user's step.
const delegatedRetireRefusal = 'Retiring a unit is the user\'s and is never taken in a delegated unit: run /flow retire from a session whose unit is not delegated, such as the coordinator.'

const humanOnly = ['coordinate', 'delegate', 'retire', 'setup-labels', 'trivial', 'follow-up', 'approve', 'handoff', 'skip']

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
  // Free text is passed on verbatim, so it is cut from the raw arguments rather than rejoined from the split words.
  const text = event.args.trim().slice(subcommand.length).trim()
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
  if (subcommand === 'coordinate') {
    const result = await withRecordLock(async () => {
      if ((await readSession(port)).flow) return fail('This session has a declared flow — a coordinator starts from a session with none; open a fresh one.')
      if (await updateSession(port, session => isCoordinatorSession(session) ? null : { ...session, role: 'coordinator' })) await refreshView(port, { isQuiet: true })
      return succeed(coordinatorMessage)
    })
    if (result.isOk) submitStart(port, async () => composeCoordinatePrompt(text))
    return unwrap(result)
  }
  if (subcommand === 'delegate') {
    const request = parseDelegateRequest(text)
    if (!request.isOk) return request.error
    if (request.value.kind !== 'stop' && outerRefusal) return outerRefusal
    const isPushGuarded = request.value.kind === 'stop' || await bestEffort(port, 'ruleset read', () => readPushGuard(port), false)
    const result = await runDelegate(port, request.value, isPushGuarded)
    if (result.isOk) await refreshView(port, { isQuiet: true })
    const added = request.value
    const isAdded = result.isOk && added.kind === 'add'
    if (isAdded) submitStart(port, async () => composeDelegatePrompt(added.issues, added.instructions))
    const unready = isAdded && !added.isTriage ? await listUnready(port, added.issues) : ''
    const missing = isAdded ? await findMissingReviewLabel(port.processes) : undefined
    // The user is back once they stop the delegation: they get the commands that sign and push what the units committed.
    const signing = result.isOk && added.kind === 'stop' ? await readSigning(port) : []
    return `${unwrap(result)}${unready}${missing ? `\n${missing}` : ''}${describeSigning(signing)}`
  }
  if (subcommand === 'retire') return runRetireCommand(port, rest)
  if (subcommand === 'setup-labels') return unwrap(await setUpLabels(port))
  if (subcommand === 'handoff') return runHandoffCommand(createFeaturePort(port), tail)
  if (subcommand === 'trivial') return startStep(port, await withRecordLock(() => declareFlow(port, 'trivial', [], 'human')))
  if (subcommand === 'follow-up') return startStep(port, await recordIfDelegated(port, '/flow follow-up', await runFollowUpCommand(createFeaturePort(port), tail)))
  if (subcommand === 'approve' && rest[0] === 'verify') {
    if (rest.length > 2) return 'Usage: /flow approve verify [blob id].'
    if (rest[1] !== undefined && await isMaybeDelegated(port)) return delegatedVerifyRefusal
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
      : isCoordinatorSession(session) ? `${coordinatorMessage}${scope ? `\n${keyedLine('Delegating', describeScope(scope))}` : ''}${describeSigning(await readSigning(port))}` : noFlowMessage
    return `${pane}\n\n${facts}`
  }
  if (!session.flow && !isCoordinatorSession(session)) return noFlowMessage
  await refreshView(port)
  await port.openPane()
  return 'Flow pane opened.'
}

/**
 * Tells whether the session's unit is delegated, counting an unreadable delegation as delegated: the commands it guards are the user's alone.
 * @param port - The engine calls.
 * @returns Whether a scope covers the unit, or the delegation could not be read.
 */
async function isMaybeDelegated(port: EnginePort): Promise<boolean> {
  const { issues } = await readSession(port)
  return !!await findDelegation(port, issues, true).catch(() => true)
}

/**
 * Reads the commands that sign and push what the delegated units committed, best effort.
 * @param port - The engine calls.
 * @returns The commands, or none when they could not be composed.
 */
async function readSigning(port: EnginePort): Promise<string[]> {
  return bestEffort(port, 'signing commands', () => composeSigningReturn(port), [])
}

/**
 * Runs the user's `/flow retire`: without an id it shows what retiring the issue's unit archives and removes; with the id it showed, the
 * branch tip the preview read, it retires the unit, refusing when the branch has moved since.
 * @param port - The engine calls.
 * @param words - The arguments after the subcommand.
 * @returns The preview, the retirement, or the refusal.
 */
async function runRetireCommand(port: EnginePort, words: string[]): Promise<string> {
  const [number = '', id, ...extra] = words
  const issue = Number(number.replace(/^#/, ''))
  if (!isIssueNumber(issue) || extra.length) return 'Usage: /flow retire #n [id].'
  if (await isMaybeDelegated(port)) return delegatedRetireRefusal
  if (id === undefined) {
    const plan = await planRetirement(port, issue).catch((error: unknown) => fail(formatErrorLine(error)))
    return plan.isOk ? `${describeRetirement(plan.value)}\nRun /flow retire ${issue} ${plan.value.tip.slice(0, 7)} to retire it.` : `Not retired: ${plan.error}`
  }
  const retired = await retireUnit(port, issue, plan => id.length >= Math.min(7, plan.tip.length) && plan.tip.startsWith(id.toLowerCase()) ? succeed(undefined)
    : fail(`${plan.branch} is at ${plan.tip.slice(0, 7)}, not ${id}: run /flow retire ${issue} to review it again`), async () => succeed(''))
  return retired.isOk ? retired.value : `Not retired: ${retired.error}`
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

/**
 * Exposes both successful command replies and failures as user-facing text: the user reads a refusal as plainly as an answer.
 * @param result - The command result.
 * @returns The reply or failure text.
 */
function unwrap(result: Result<string>): string {
  return result.isOk ? result.value : result.error
}

/**
 * Names the delegated issues that are not ready-for-agent, which spawn refuses until the user triages them.
 * @param port - The engine calls.
 * @param issues - The issues just delegated.
 * @returns One line per such issue, each after a newline, or empty when all are ready.
 */
async function listUnready(port: EnginePort, issues: number[]): Promise<string> {
  const lines = await Promise.all(issues.map(async issue => {
    const read = await readIssue(port.processes, issue)
    if (!read.isOk) return `#${issue}: its triage cannot be read (${read.error})`
    const triage = read.value.labels.find(label => triageLabels.includes(label))
    return triage === 'ready-for-agent' ? '' : `#${issue} ${triage ?? 'has no triage label'}: not started until you triage it`
  }))
  return lines.filter(Boolean).map(line => `\n${line}`).join('')
}
