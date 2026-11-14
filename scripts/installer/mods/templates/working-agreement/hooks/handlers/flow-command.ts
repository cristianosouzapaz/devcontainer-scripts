import type { Args, Frozen } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { liftCancels } from '../core/cancel-gate'
import { declareFlow } from '../core/declaration'
import { composeSigningReturn, readPushGuard } from '../core/delegated-commits'
import { findDelegation, readOwnScope, runDelegate } from '../core/delegation'
import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { logEvent } from '../core/flow-log'
import { findMissingReviewLabel, setUpLabels } from '../core/issue-write'
import { refreshView } from '../core/pane-view'
import { readSession, updateSession } from '../core/record-store'
import { composeReport } from '../core/report'
import { describeRetirement, planRetirement, retireUnit } from '../core/retire'
import { previewVerify } from '../core/verify'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { humanOnlyFlowCommands, isCoordinatorSession, refuseModulesAhead } from '../domain/coordinator'
import { describeSigning } from '../domain/delegated-commits'
import type { SigningPlan } from '../domain/delegated-commits'
import { describeScope, parseDelegateRequest } from '../domain/delegation'
import { triageLabels } from '../domain/issue-fields'
import { markForAgent } from '../domain/messages'
import { describeOutcome } from '../domain/outcome'
import { refuseOrigin, remoteNote } from '../domain/remote-commands'
import { runHandoffCommand } from '../features/handoff'
import { readIssue } from '../lib/github'
import { isLinkedWorktree, readWorktrees } from '../lib/git'
import { isIssueNumber } from '../lib/guards'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { keyedLine, renderStatusText } from '../ui/status-text'
import { renderFlowStatus } from '../core/status'
import { runInboxCommand } from '../core/user-inbox'
import { refuseWithoutStartRoom } from '../core/process-state'
import { runApproveStep, runFollowUpStep, runSkipStep, startStep, submitStart, withUnkept } from '../core/user-steps'

const noFlowMessage = 'No flow declared (talk). The agent declares one before writing; you can run /flow trivial or /flow follow-up #n.'

const coordinatorMessage = 'Coordinator: this session never writes in the repository, nor do its subagents — writes happen in unit sessions, each in its own herdr worktree.'

// why: Text typed into a unit's pane through herdr reads as the user's, so in a delegated unit a typed retire cannot be told from the coordinator's, and retiring is the user's step.
const delegatedRetireRefusal = 'Retiring a unit is the user\'s and is never taken in a delegated unit: run /flow retire from a session whose unit is not delegated, such as the coordinator.'

/**
 * Runs `/flow`: opens the pane, prints its status, or runs one of the subcommands only the user may issue, at the local terminal or,
 * while the user allows it, through Remote Control.
 *
 * @param port - The engine calls.
 * @param event - The command run.
 * @returns The text the command answers.
 */
export async function handleFlowCommand(port: EnginePort, event: Frozen<Args<'command.run'>>): Promise<string> {
  const [subcommand = ''] = event.args.trim().split(/\s+/)
  const isHumanOnly = humanOnlyFlowCommands.includes(subcommand)
  const refusal = isHumanOnly ? await refuseOrigin(subcommand, event.origin, () => port.readAllowRemoteCommands()) : null
  if (refusal) return markForAgent(refusal)
  if (!isHumanOnly || event.origin.kind !== 'bridge') return runSubcommand(port, event, '')
  const answer = await runSubcommand(port, event, remoteNote)
  // why: logged after the run, so a command that declares the unit is logged in that unit's own log.
  logEvent(port, await readSession(port), 'remote-command', { command: `/flow ${subcommand}`, origin: 'bridge' })
  return `${answer}${remoteNote}`
}

/**
 * Runs one `/flow` subcommand once its origin was accepted.
 *
 * @param port - The engine calls.
 * @param event - The command run.
 * @param via - What a delegated-step record adds after the command, such as the Remote Control note.
 * @returns The text the command answers.
 */
async function runSubcommand(port: EnginePort, event: Frozen<Args<'command.run'>>, via: string): Promise<string> {
  const [subcommand = '', ...rest] = event.args.trim().split(/\s+/)
  const tail = rest.join(' ')
  // why: free text is passed on verbatim, so it is cut from the raw arguments rather than rejoined from the split words.
  const text = event.args.trim().slice(subcommand.length).trim()
  if (subcommand === 'skip') return unwrap(await runSkipStep(port, tail, via))
  const outerRefusal = refuseModulesAhead(sessionMemory.modulesAhead)
  if (subcommand === 'coordinate' && outerRefusal) return outerRefusal
  // why: a command whose start prompt could not be kept is refused before it applies, so nothing changes.
  const full = ['coordinate', 'trivial'].includes(subcommand) ? await refuseWithoutStartRoom(port) : null
  if (full) return full
  if (subcommand === 'coordinate') {
    // why: herdr starts worktree actions only from the repo parent workspace, so a coordinator in a linked worktree could not spawn a unit.
    if (await isLinkedWorktree(port.processes)) {
      const main = (await readWorktrees(port.processes))?.[0]?.root ?? 'the first checkout git worktree list names'
      return `Refused: this session runs in a linked worktree, where spawn cannot create unit worktrees. Start the coordinator from the main checkout: ${main}`
    }
    const result = await withRecordLock(async () => {
      if ((await readSession(port)).flow) return fail('This session has a declared flow — a coordinator starts from a session with none; open a fresh one.')
      if (await updateSession(port, session => isCoordinatorSession(session) ? null : { ...session, role: 'coordinator' })) await refreshView(port, { isQuiet: true })
      return succeed(coordinatorMessage)
    })
    const unkept = result.isOk ? await submitStart(port, { kind: 'coordinate', text }) : null
    return withUnkept(unwrap(result), unkept)
  }
  if (subcommand === 'delegate') {
    const request = parseDelegateRequest(text)
    if (!request.isOk) return request.error
    if (request.value.kind !== 'stop' && outerRefusal) return outerRefusal
    const isFull = request.value.kind === 'add' ? await refuseWithoutStartRoom(port) : null
    if (isFull) return isFull
    const isPushGuarded = request.value.kind === 'stop' || await bestEffort(port, 'ruleset read', () => readPushGuard(port), false)
    const result = await runDelegate(port, request.value, isPushGuarded)
    if (result.isOk) await refreshView(port, { isQuiet: true })
    const added = request.value
    const isAdded = result.isOk && added.kind === 'add'
    const unready = isAdded && !added.isTriage ? await listUnready(port, added.issues) : ''
    const missing = isAdded ? await findMissingReviewLabel(port.processes) : undefined
    // why: the user is back once they stop the delegation, so they get the commands that sign and push what the units committed.
    const signing = result.isOk && added.kind === 'stop' ? await readSigning(port) : null
    // why: The engine refuses a submit while this hook is pending, so no await may follow the deferral the start prompt waits on.
    const unkept = isAdded ? await submitStart(port, { kind: 'delegate', issues: added.issues, instructions: added.instructions }) : null
    return withUnkept(`${unwrap(result)}${unready}${missing ? `\n${missing}` : ''}${describeSigning(signing)}`, unkept)
  }
  if (subcommand === 'retire') return runRetireCommand(port, rest)
  // why: the lift is the user's own step in the unit's terminal, never a delegated one, so it is not recorded as delegated.
  if (subcommand === 'lift') return unwrap(await liftCancels(port))
  if (subcommand === 'inbox') return runInboxCommand(port, rest, text)
  if (subcommand === 'setup-labels') return unwrap(await setUpLabels(port))
  if (subcommand === 'handoff') return runHandoffCommand(createFeaturePort(port), tail)
  if (subcommand === 'trivial') return unwrap(await startStep(port, await withRecordLock(() => declareFlow(port, 'trivial', [], 'human'))))
  if (subcommand === 'follow-up') return unwrap(await runFollowUpStep(port, tail, via))
  // why: Any agent can type into any pane through herdr, so no command typed in a session approves the config: it only shows it and the terminal command that does, whatever id it is given.
  if (subcommand === 'approve' && rest[0] === 'verify') return rest.length > 2 ? 'Usage: /flow approve verify [blob id].' : unwrap(await previewVerify(port))
  if (subcommand === 'approve') return unwrap(await runApproveStep(port, tail, via))
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
 * Reads the plan that signs what the delegated units committed, best effort.
 * @param port - The engine calls.
 * @returns The plan, or null when nothing is left to sign or it could not be composed.
 */
async function readSigning(port: EnginePort): Promise<SigningPlan | null> {
  return bestEffort(port, 'signing plan', () => composeSigningReturn(port), null)
}

/**
 * Runs the user's `/flow retire`: without an id it shows what retiring the issue's unit keeps, moves aside and removes; with the id it
 * showed, the branch tip the preview read, it retires the unit, refusing when the branch has moved since.
 * @param port - The engine calls.
 * @param words - The arguments after the subcommand.
 * @returns The preview, the retirement, the refusal, or where a retirement under way stopped and how to finish it.
 */
async function runRetireCommand(port: EnginePort, words: string[]): Promise<string> {
  const [number = '', id, ...extra] = words
  const issue = Number(number.replace(/^#/, ''))
  if (!isIssueNumber(issue) || extra.length) return 'Usage: /flow retire #n [id].'
  if (await isMaybeDelegated(port)) return delegatedRetireRefusal
  if (id === undefined) {
    const plan = await planRetirement(port, issue).catch((error: unknown) => fail(formatErrorLine(error)))
    return plan.isOk ? `${describeRetirement(plan.value)}\nRun /flow retire ${issue} ${plan.value.tip.slice(0, 7)} to retire it.` : describeOutcome('/flow retire', plan)
  }
  const retired = await retireUnit(port, issue, plan => id.length >= Math.min(7, plan.tip.length) && plan.tip.startsWith(id.toLowerCase()) ? succeed(undefined)
    : fail(`${plan.branch} is at ${plan.tip.slice(0, 7)}, not ${id}: run /flow retire ${issue} to review it again`), async () => succeed(''))
  return describeOutcome('/flow retire', retired)
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
