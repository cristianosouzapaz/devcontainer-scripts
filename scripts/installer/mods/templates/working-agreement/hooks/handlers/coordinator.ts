import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { mergeChild } from '../core/child-merge'
import { composePlan } from '../core/plan'
import type { EnginePort } from '../core/engine-port'
import { readSession } from '../core/record-store'
import { coordinatorDeny, explainCoordinatorDeny, isAllowedForCoordinator, isCoordinatorSession, judgeCoordinatorCall } from '../domain/coordinator'
import { answerTool, markForAgent } from '../domain/messages'
import { isIssueNumber } from '../lib/guards'
import { fail, formatErrorLine } from '../lib/result'

/**
 * Tells whether this session holds the coordinator role; a read that fails rejects, which every caller turns into a deny.
 * @param port - The engine calls.
 * @returns True once the user ran `/flow coordinate` in this session.
 */
async function isCoordinator(port: EnginePort): Promise<boolean> {
  return isCoordinatorSession(await readSession(port))
}

/**
 * Denies, in a coordinator session, every call that is neither read-only by the tool's own word nor allowlisted, in any loop.
 * @param port - The engine calls.
 * @param event - The permission question.
 * @param next - The rest of the chain, which decides any other call.
 * @returns The deny, or what the chain decides.
 */
export async function handleToolCheck(port: EnginePort, event: Frozen<Args<'tool.check'>>, next: Next<'tool.check'>): Promise<EventResult<'tool.check'>> {
  if (event.isReadOnly || !await isCoordinator(port) || isAllowedForCoordinator(event.tool, event.input)) return next(event)
  return { decision: 'deny', reason: explainCoordinatorDeny(event.tool, event.input) }
}

/**
 * Names the deny of a coordinator call no permission check reaches: the mod's own tools, MCP tools, isolated agents and workflows.
 * @param port - The engine calls.
 * @param event - The tool call.
 * @returns The deny reason, or undefined when the call goes on.
 */
export async function denyCoordinatorCall(port: EnginePort, event: Frozen<Args<'tool.call'>>): Promise<string | undefined> {
  const reason = judgeCoordinatorCall(event.tool, { ...event })
  return reason && await isCoordinator(port) ? reason : undefined
}

/**
 * Refuses a teammate started from a coordinator session: it would run outside the session's checks.
 * @param port - The engine calls.
 * @param event - The spawn.
 * @param next - The rest of the chain, which starts the agent.
 * @returns The deny, or the started agent.
 */
export async function handleAgentSpawn(port: EnginePort, event: Frozen<Args<'agent.spawn'>>, next: Next<'agent.spawn'>): Promise<EventResult<'agent.spawn'>> {
  if (event.isTeammate && await isCoordinator(port)) return { deny: coordinatorDeny }
  return next(event)
}

/**
 * Proposes `/flow coordinate` in the prompt box, which only the user's submit turns into the role.
 * @param port - The engine calls.
 * @returns The tool result the agent reads.
 */
export async function handleSuggestCall(port: EnginePort): Promise<EventResult<'tool.call'>> {
  const session = await readSession(port)
  if (isCoordinatorSession(session)) return { result: markForAgent('This session is already the coordinator.') }
  if (session.flow) return { result: markForAgent('This session has a declared flow, so it cannot become the coordinator — the user starts a fresh session for that.'), isError: true }
  return await port.suggestPrompt('/flow coordinate')
    ? { result: markForAgent('/flow coordinate is in the prompt box: tell the user to submit it to make this session the coordinator; the role is not set until they do.') }
    : { result: markForAgent('The suggestion was not shown — tell the user to type /flow coordinate to make this session the coordinator.') }
}

/**
 * Proposes `/flow delegate` for the named issues in the prompt box; only the user's submit delegates anything.
 * @param port - The engine calls.
 * @param event - The tool call, whose `issues` are the ones the user said they delegate.
 * @returns The tool result the agent reads.
 */
export async function handleSuggestDelegateCall(port: EnginePort, event: Frozen<Args<'tool.call'>>): Promise<EventResult<'tool.call'>> {
  if (!isCoordinatorSession(await readSession(port))) {
    return { result: markForAgent('Only a coordinator delegates — call suggest_coordinate first; the user submits /flow coordinate, then /flow delegate.'), isError: true }
  }
  const issues: unknown = ({ ...event } as Record<string, unknown>).issues ?? []
  if (!Array.isArray(issues) || !issues.every(isIssueNumber)) {
    return { result: markForAgent('issues must be a list of issue numbers.'), isError: true }
  }
  const command = ['/flow delegate', ...issues.map(issue => `#${String(issue)}`)].join(' ')
  return await port.suggestPrompt(command)
    ? { result: markForAgent(`${command} is in the prompt box: tell the user to submit it to delegate; nothing is delegated until they do.`) }
    : { result: markForAgent(`The suggestion was not shown — tell the user to type ${command} to delegate.`) }
}

/**
 * Runs the coordinator's merge of a finished child unit into its parent branch, which the mod refuses for any pair it does not know.
 * @param port - The engine calls.
 * @param event - The tool call, whose `child` is the child branch.
 * @returns The merge, or the refusal the agent reports to the user.
 */
export async function handleMergeChildCall(port: EnginePort, event: Frozen<Args<'tool.call'>>): Promise<EventResult<'tool.call'>> {
  const child: unknown = ({ ...event } as Record<string, unknown>).child
  // why: A name starting with a dash would reach git as an option.
  if (typeof child !== 'string' || !/^[\w.][\w./-]*$/.test(child)) return { result: markForAgent('child must be a branch name.'), isError: true }
  const merged = await mergeChild(port, child)
  return answerTool('merge_child', merged)
}

/**
 * Answers the coordinator's plan: each delegated issue's blockers and unit states, and which ones spawn would start now.
 * @param port - The engine calls.
 * @returns The plan, or the refusal.
 */
export async function handlePlanCall(port: EnginePort): Promise<EventResult<'tool.call'>> {
  const plan = await composePlan(port).catch((error: unknown) => fail(formatErrorLine(error)))
  return plan.isOk ? { result: plan.value } : { result: markForAgent(`plan refused: ${plan.error}`), isError: true }
}
