import type { Args, EventResult, Frozen } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import { approveUnit, parseApproveMessage } from '../core/approve-unit'
import { readOwnScope } from '../core/delegation'
import { HerdrError, isInsideHerdr, outsideHerdr, runHerdrText } from '../core/herdr-worktrees'
import { relayStep } from '../core/delegated-step'
import { commentIssue } from '../core/issue-write'
import { readSession } from '../core/record-store'
import { describeMail, retireUnit } from '../core/retire'
import type { Archive, RetirementPlan } from '../core/retire'
import { escalateOrRequest } from '../core/escalation'
import { dismissDialog } from '../core/dialog-dismissal'
import { efforts, isUnitStarting, parseEffort, readSpawnedSession, spawnUnit } from '../core/spawn'
import { readUnitTarget } from '../core/unit-host'
import { sendMail } from '../core/mailbox'
import { refuseCancel } from '../core/cancel-gate'
import { judgeExpects } from '../core/mail-expects'
import { unitAddress } from '../domain/mail'
import type { UnitLevel } from '../core/spawn'
import { isCoordinatorSession } from '../domain/coordinator'
import type { unitTools } from '../domain/coordinator'
import { coversIssues } from '../domain/delegation'
import { markForAgent } from '../domain/messages'
import { isIssueNumber, isSafeInteger } from '../lib/guards'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'

/** One unit tool's name. */
type UnitTool = (typeof unitTools)[number]

/**
 * Runs a unit tool for a coordinator session, refusing it in any other session.
 * @param port - The engine calls.
 * @param tool - The unit tool called.
 * @param event - The tool call.
 * @returns What the tool did, or an error result naming why it did not.
 */
export async function handleUnitCall(port: EnginePort, tool: UnitTool, event: Frozen<Args<'tool.call'>>): Promise<EventResult<'tool.call'>> {
  // why: an escaping throw becomes the register's generic check failure, which hides herdr's own error.
  const result = await runUnitTool(port, tool, { ...event }).catch((error: unknown) => fail(formatErrorLine(error)))
  return result.isOk ? { result: result.value } : { result: markForAgent(`${tool} refused: ${result.error}`), isError: true }
}

/**
 * Checks the role and the call's fields, then runs the tool.
 * @param port - The engine calls.
 * @param tool - The unit tool called.
 * @param args - The call's arguments.
 * @returns The tool's output, or the refusal.
 */
async function runUnitTool(port: EnginePort, tool: UnitTool, args: Record<string, unknown>): Promise<Result<string>> {
  if (!isCoordinatorSession(await readSession(port))) return fail('only a coordinator session starts and messages unit sessions — the user makes one with /flow coordinate')
  const issue = args.number
  if (!isIssueNumber(issue)) return fail('number must be an issue number')
  if (tool === 'spawn') {
    const instructions = args.instructions ?? ''
    if (typeof instructions !== 'string') return fail('instructions must be text')
    const level = readLevel(args)
    if (!level.isOk) return level
    const scope = await readOwnScope(port)
    if (!scope || !coversIssues(scope, [issue])) return fail(`#${issue} is not in this coordinator's delegation scope, so starting its unit is the user's: /flow delegate ${issue}`)
    return spawnUnit(port, issue, instructions.trim(), level.value)
  }
  if (tool === 'retire_unit') return retireDelegated(port, issue, args.reason)
  if (tool === 'dismiss_dialog') return dismissDialog(port, issue, args.dialog, args.key)
  if (tool === 'unit_prompt') return promptUnit(port, issue, args.text, args.kind, args.expects)
  if (tool === 'skip_unit' || tool === 'follow_up_unit') return relayUserStep(port, issue, tool, args)
  if (tool === 'approve_unit') {
    const message = parseApproveMessage(args)
    return message.isOk ? approveUnit(port, issue, message.value) : message
  }
  if (!await isInsideHerdr(port)) return fail(outsideHerdr)
  if (tool === 'escalate_unit') return escalateDelegated(port, issue, args.reason)
  const lines = args.lines ?? 40
  if (!isSafeInteger(lines) || lines < 1 || lines > 500) return fail('lines must be a whole number from 1 to 500')
  return succeed(await readUnitScreen(port, await readUnitTarget(port, issue), lines))
}

/**
 * Reads a unit's recent terminal text; a unit that is not idle under the fullscreen renderer gives only its visible screen, which the reply says.
 * @param port - The engine calls.
 * @param target - The unit's herdr agent.
 * @param lines - How many lines were asked for.
 * @returns The text herdr read, after a note line when it is only the visible screen.
 */
async function readUnitScreen(port: EnginePort, target: string, lines: number): Promise<string> {
  try {
    return await runHerdrText(port, ['agent', 'read', target, '--source', 'recent', '--lines', String(lines)])
  } catch (error) {
    // why: on the alternate screen herdr scrolls the history only while the unit is idle, and refuses a longer read otherwise.
    if (!(error instanceof HerdrError) || error.code !== 'agent_not_idle') throw error
    const screen = await runHerdrText(port, ['agent', 'read', target, '--source', 'visible'])
    return `Unit not idle: returned only its visible screen (${lines} lines requested); read again once it is idle for the full history.\n${screen}`
  }
}

/**
 * Sends the coordinator's text to a spawned unit's mailbox, as an inform unless it opens new work as an assign or stops it as a cancel; refuses a slash
 * command, which a message cannot run: a user's step goes through approve_unit, skip_unit or follow_up_unit.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @param text - The call's text.
 * @param kind - The call's kind.
 * @param expects - The step the message is written for, if any.
 * @returns Where it went, or why it was not sent.
 */
async function promptUnit(port: EnginePort, issue: number, text: unknown, kind: unknown, expects: unknown): Promise<Result<string>> {
  if (typeof text !== 'string' || !text.trim()) return fail('text must be the message to send')
  if (kind !== undefined && kind !== 'inform' && kind !== 'assign' && kind !== 'cancel') return fail('kind must be inform, assign or cancel')
  const command = text.trim()
  // why: anything reaching the unit while its host waits to see it ready would start its first turn and fail that start.
  if (await isUnitStarting(port, issue)) {
    return fail(`#${issue}'s session is being started by spawn right now, and a message reaching it before its host reports it ready would make that start fail. `
      + 'Nothing was sent: retry unit_prompt once spawn has returned')
  }
  // why: a message is never an approval; a user's step reaches a unit only as a step message after its decision's checks.
  const step = /^\/flow\s+(approve|skip|follow-up)\b/.exec(command)?.[1]
  if (step) return fail(`a /flow ${step} goes only through ${step === 'approve' ? 'approve_unit' : step === 'skip' ? 'skip_unit' : 'follow_up_unit'}, which checks its delegated decision before the unit's mod applies it`)
  if (command.startsWith('/')) return fail('a message cannot run a slash command: send a skill as plain text asking the unit to run it (a text that does not start with /)')
  if (!await readSpawnedSession(port, issue, false)) return fail(`#${issue} has no unit spawn started, so it has no mailbox: start it with spawn`)
  const refusal = await judgeExpects(port, issue, kind ?? 'inform', expects) ?? (kind === 'cancel' ? await refuseCancel(port, issue) : null)
  if (refusal) return fail(refusal)
  const sent = await sendMail(port, { kind: kind ?? 'inform', to: unitAddress(issue), issue, body: text, ...typeof expects === 'string' ? { expects } : {} })
  return sent.isOk ? succeed(markForAgent(`Sent to #${issue}'s mailbox as message ${sent.value}: its session reads it at its next prompt or turn end, `
    + 'and starts a turn for it when idle. Read its answer with unit_read once it is idle.')) : sent
}

/**
 * Relays a user's skip or follow-up step to a delegated unit, resting on the delegated decision that names it.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @param tool - skip_unit or follow_up_unit.
 * @param args - The call's arguments.
 * @returns What was sent, or the first unmet check.
 */
async function relayUserStep(port: EnginePort, issue: number, tool: 'skip_unit' | 'follow_up_unit', args: Record<string, unknown>): Promise<Result<string>> {
  const { decision, step, reason, issue: followed } = args
  if (typeof decision !== 'string' || !/^https:\/\/\S+#issuecomment-\d+$/.test(decision)) return fail('decision must be the delegated decision comment\'s URL')
  if (tool === 'follow_up_unit') return isIssueNumber(followed) ? relayStep(port, issue, decision, { kind: 'follow-up', issue: followed }) : fail('issue must be the follow-up\'s issue number')
  if (typeof step !== 'string' || !/^[a-z-]+$/i.test(step.trim())) return fail('step must be the id of a step of the unit\'s flow, such as diagnose')
  if (typeof reason !== 'string' || !reason.trim()) return fail('reason must say why the step is skipped')
  return relayStep(port, issue, decision, { kind: 'skip', step: step.trim().toLowerCase(), reason: reason.trim() })
}

/**
 * Reads the model, effort and reason a spawn call picks.
 * @param args - The call's arguments.
 * @returns The level, empty when neither model nor effort is given, or why it is refused.
 */
function readLevel(args: Record<string, unknown>): Result<UnitLevel> {
  const { model, effort, reason } = args
  if (model === undefined && effort === undefined) return succeed({})
  // why: the name reaches claude as an argument value; one starting with a dash would read as an option.
  if (model !== undefined && (typeof model !== 'string' || !/^[\w.][\w.:@/[\]-]*$/.test(model))) return fail('model must be a model name or alias the claude CLI accepts')
  const level = parseEffort(effort)
  if (effort !== undefined && !level) return fail(`effort must be one of ${efforts.join(', ')}`)
  if (typeof reason !== 'string' || !reason.trim()) return fail('reason must say in one line why this unit gets that model or effort')
  return succeed({ ...typeof model === 'string' ? { model } : {}, ...level ? { effort: level } : {}, reason: reason.trim().split('\n')[0] ?? '' })
}

/**
 * Raises a unit of this coordinator's scope to the user's default model with effort high, now when it is idle, else once it is.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param reason - Why the coordinator raises the unit.
 * @returns The escalation, the recorded request, or the refusal.
 */
async function escalateDelegated(port: EnginePort, issue: number, reason: unknown): Promise<Result<string>> {
  const delegated = await requireDelegated(port, issue, reason, 'reason must say why the unit needs more capability', `#${issue} is not in this coordinator's delegation scope`)
  return delegated.isOk ? escalateOrRequest(port, issue, delegated.value) : delegated
}

/**
 * Retires a unit of an issue this coordinator delegates, recording the retirement as a delegated decision on the issue before anything is removed.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param reason - Why the unit is redone, the decision's reason.
 * @returns What was archived and removed, or the refusal.
 */
async function retireDelegated(port: EnginePort, issue: number, reason: unknown): Promise<Result<string>> {
  const delegated = await requireDelegated(port, issue, reason, 'reason must say why the unit is redone',
    `#${issue} is not in this coordinator's delegation scope, so retiring its unit is the user's: /flow retire ${issue}`)
  if (!delegated.isOk) return delegated
  return retireUnit(port, issue, () => succeed(undefined), async (plan, archive) => {
    const posted = await commentIssue(port, { number: issue, body: composeRetirementDecision(plan, archive, delegated.value) })
    return posted.isOk ? succeed(posted.value) : fail(`the delegated decision was not posted: ${posted.error}`)
  })
}

/**
 * Checks that a call gives a reason and that its issue is in this coordinator's delegation scope.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param reason - The call's reason.
 * @param missing - The refusal of a call without a reason.
 * @param outside - The refusal of an issue outside the scope.
 * @returns The trimmed reason, or the refusal.
 */
async function requireDelegated(port: EnginePort, issue: number, reason: unknown, missing: string, outside: string): Promise<Result<string>> {
  if (typeof reason !== 'string' || !reason.trim()) return fail(missing)
  const scope = await readOwnScope(port)
  return scope && coversIssues(scope, [issue]) ? succeed(reason.trim()) : fail(outside)
}

/**
 * Writes the delegated decision a coordinator's retirement posts on the issue.
 * @param plan - The retirement.
 * @param archive - What the archive kept.
 * @param reason - Why the unit is redone.
 * @returns The comment body.
 */
function composeRetirementDecision(plan: RetirementPlan, archive: Archive, reason: string): string {
  return ['## Delegated decision', '', '### Question', `Retire #${plan.issue}'s unit on ${plan.branch} and respawn it?`, '',
    '### Alternatives considered', '- Keep the unit and steer it with unit_prompt.', '- Leave it for the user\'s /flow retire.', '',
    '### Choice', `Retired: ${plan.branch} (${plan.tip.slice(0, 7)}) is archived as \`${archive.ref}\`${archive.patch ? `, its uncommitted changes as \`${archive.patch}\`` : ''}; `
      + `its workspace, worktree, branch, records and transcript are removed; its mailbox's ${describeMail(plan.mail)} move into the archive. Restore with \`${archive.restore}\`.`, '',
    '### Reason', reason, '', '### Cost of going back', 'low'].join('\n')
}
