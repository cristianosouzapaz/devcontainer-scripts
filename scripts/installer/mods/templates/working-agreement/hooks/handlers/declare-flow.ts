import type { Args, EventResult, Frozen } from 'claude-code'

import { declareFlow } from '../core/declaration'
import type { EnginePort } from '../core/engine-port'
import { withRecordLock } from '../core/session-memory'
import { markForAgent } from '../domain/messages'
import { toStringOrEmpty } from '../lib/json'

/**
 * Runs the agent's `declare_flow` call; a subagent inherits the session's flow and cannot declare one.
 *
 * @param port - The engine calls.
 * @param event - The tool call.
 * @returns The declaration as the tool's result, or its refusal as a deny.
 */
export async function handleDeclareFlowCall(port: EnginePort, event: Frozen<Args<'tool.call'>>): Promise<EventResult<'tool.call'>> {
  if (event.agentId) return { deny: markForAgent('Subagents inherit the session flow and cannot declare one — return to the main agent.') }
  const args: Record<string, unknown> = { ...event }
  if (args.issues !== undefined && (!Array.isArray(args.issues) || !args.issues.every(issue => typeof issue === 'number'))) return { deny: markForAgent('Issue numbers must be positive integers.') }
  const issues = args.issues ?? []
  const declared = await withRecordLock(() => declareFlow(port, toStringOrEmpty(args.flow), issues, 'agent'))
  return declared.isOk ? { result: markForAgent(declared.value.reply) } : { deny: markForAgent(declared.error) }
}
