import type { Args, EventResult, Frozen } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import { readOwnScope } from '../core/delegation'
import { isInsideHerdr, runHerdrText } from '../core/herdr-worktrees'
import { commentIssue } from '../core/issue-write'
import { readSession } from '../core/record-store'
import { retireUnit } from '../core/retire'
import type { Archive, RetirementPlan } from '../core/retire'
import { spawnUnit, unitAgent } from '../core/spawn'
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
    return spawnUnit(port, issue, instructions.trim())
  }
  if (tool === 'retire_unit') return retireDelegated(port, issue, args.reason)
  if (!await isInsideHerdr(port)) return fail('this session does not run inside herdr, which hosts every unit session')
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
 * Retires a unit of an issue this coordinator delegates, recording the retirement as a delegated decision on the issue before anything is removed.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param reason - Why the unit is redone, the decision's reason.
 * @returns What was archived and removed, or the refusal.
 */
async function retireDelegated(port: EnginePort, issue: number, reason: unknown): Promise<Result<string>> {
  if (typeof reason !== 'string' || !reason.trim()) return fail('reason must say why the unit is redone')
  const scope = await readOwnScope(port)
  if (!scope || !coversIssues(scope, [issue])) return fail(`#${issue} is not in this coordinator's delegation scope, so retiring its unit is the user's: /flow retire ${issue}`)
  return retireUnit(port, issue, () => succeed(undefined), async (plan, archive) => {
    const posted = await commentIssue(port, { number: issue, body: composeRetirementDecision(plan, archive, reason.trim()) })
    return posted.isOk ? succeed(posted.value) : fail(`the delegated decision was not posted: ${posted.error}`)
  })
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
