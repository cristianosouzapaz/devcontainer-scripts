import type { Args, EventResult, Frozen } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import { readOwnScope } from '../core/delegation'
import { isInsideHerdr, outsideHerdr, runHerdrText } from '../core/herdr-worktrees'
import { commentIssue } from '../core/issue-write'
import { readSession } from '../core/record-store'
import { retireUnit } from '../core/retire'
import type { Archive, RetirementPlan } from '../core/retire'
import { escalateOrRequest } from '../core/escalation'
import { efforts, parseEffort, spawnUnit, unitAgent } from '../core/spawn'
import type { UnitLevel } from '../core/spawn'
import { isCoordinatorSession, unitTools } from '../domain/coordinator'
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
    return level.isOk ? spawnUnit(port, issue, instructions.trim(), level.value) : level
  }
  if (tool === 'retire_unit') return retireDelegated(port, issue, args.reason)
  if (!await isInsideHerdr(port)) return fail(outsideHerdr)
  if (tool === 'escalate_unit') return escalateDelegated(port, issue, args.reason)
  if (tool === 'unit_read') {
    const lines = args.lines ?? 40
    if (!isSafeInteger(lines) || lines < 1 || lines > 500) return fail('lines must be a whole number from 1 to 500')
    return succeed(await runHerdrText(port, ['agent', 'read', unitAgent(issue), '--source', 'recent', '--lines', String(lines)]))
  }
  if (typeof args.text !== 'string' || !args.text.trim()) return fail('text must be the message to send')
  // herdr 0.9.5 rejects `--` before the text and parses text starting with a dash as the text.
  await runHerdrText(port, ['agent', 'prompt', unitAgent(issue), args.text])
  return succeed(markForAgent(`Sent to ${unitAgent(issue)}; read its answer with unit_read once it is idle.`))
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
      + `its workspace, worktree, branch, records and transcript are removed. Restore with \`${archive.restore}\`.`, '',
    '### Reason', reason, '', '### Cost of going back', 'low'].join('\n')
}
