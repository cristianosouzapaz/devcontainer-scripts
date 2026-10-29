import type { Args, EventResult, Frozen } from 'claude-code'

import type { EnginePort } from '../core/engine-port'
import { isInsideHerdr, runHerdrText } from '../core/herdr-worktrees'
import { readSession } from '../core/record-store'
import { spawnUnit, unitAgent } from '../core/spawn'
import { isCoordinatorSession, unitTools } from '../domain/coordinator'
import { markForAgent } from '../domain/messages'
import { isIssueNumber, isSafeInteger } from '../lib/guards'
import { fail, succeed } from '../lib/result'
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
  const result = await runUnitTool(port, tool, { ...event })
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
  if (tool === 'spawn') return spawnUnit(port, issue)
  if (!await isInsideHerdr(port)) return fail('this session does not run inside herdr, which hosts every unit session')
  if (tool === 'unit_read') {
    const lines = args.lines ?? 40
    if (!isSafeInteger(lines) || lines < 1 || lines > 500) return fail('lines must be a whole number from 1 to 500')
    return succeed(await runHerdrText(port, ['agent', 'read', unitAgent(issue), '--source', 'recent', '--lines', String(lines)]))
  }
  if (typeof args.text !== 'string' || !args.text.trim()) return fail('text must be the message to send')
  // why: text starting with a dash would reach herdr as an option.
  await runHerdrText(port, ['agent', 'prompt', unitAgent(issue), '--', args.text])
  return succeed(markForAgent(`Sent to ${unitAgent(issue)}; read its answer with unit_read once it is idle.`))
}
