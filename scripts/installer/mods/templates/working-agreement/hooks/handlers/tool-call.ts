import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { judgeToolCall } from '../core/call-judgement'
import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { logEvent } from '../core/flow-log'
import { isJudgedTool } from '../core/judged-tools'
import { refreshView } from '../core/pane-view'
import { readSession, updateSession } from '../core/record-store'
import { withRecordLock } from '../core/session-memory'
import { flowDefinitions } from '../domain/flow-definitions'
import { markForAgent } from '../domain/messages'
import { recordHandoffDocument } from '../features/handoff'
import { toStringOrEmpty } from '../lib/json'
import { handleGuarantees } from './guarantees'

const agentWorktreeNote = 'a subagent with isolation: worktree does not see the unit\'s uncommitted changes (with worktree.baseRef: "head" it sees only the committed HEAD); bring its changes back as an uncommitted patch (git -C <wt> diff --binary | git apply), never as a commit; with agent teams on, pass isolation on the Agent call itself, even for a subagent with a name.'

/**
 * Checks a tool call, runs it, and records what it did for the unit.
 *
 * @param port - The engine calls.
 * @param event - The tool call.
 * @param next - The rest of the chain, which runs the tool.
 * @returns The tool's result, or a deny.
 */
export async function handleToolCall(port: EnginePort, event: Frozen<Args<'tool.call'>>, next: Next<'tool.call'>): Promise<EventResult<'tool.call'>> {
  return handleGuarantees(port, event, () => handleGatedCall(port, event, next))
}

/**
 * Enforces flow prerequisites before dispatch and records successful handoff writes.
 * @param port - The engine calls.
 * @param event - The tool call being gated.
 * @param next - The remaining tool dispatch chain.
 * @returns The refusal or dispatched tool result.
 */
async function handleGatedCall(port: EnginePort, event: Frozen<Args<'tool.call'>>, next: Next<'tool.call'>): Promise<EventResult<'tool.call'>> {
  if (event.tool.startsWith('mcp__working-agreement__')) return next(event)
  const args: Record<string, unknown> = { ...event }
  if (event.tool === 'Skill' && !event.agentId) {
    const name = toStringOrEmpty(args.skill).split(':').pop()
    const steps = Object.values(flowDefinitions.flows).flatMap(flow => flow.steps.map(step => step.skill))
    if (steps.includes(name) && !(await readSession(port)).flow) {
      return { deny: markForAgent(`${name} is a flow step and no flow is declared — classify the work per AGENTS.md (read the issue if there is one), call declare_flow, then run ${name} again.`) }
    }
    return next(event)
  }
  if (!isJudgedTool(event.tool)) return event.tool === 'Agent' ? appendAgentWorktreeNote(args, await next(event)) : next(event)
  const verdict = await judgeToolCall(port, args)
  if (verdict.decision === 'deny') {
    // The deny never waits for the lock: a hook past its budget fails, and its .catch denies without the verdict's reason.
    void bestEffort(port, 'blocked edit record', () => withRecordLock(async () => {
      const written = await updateSession(port, session => ({ ...session, blocked: { ...session.blocked, edits: session.blocked.edits + 1 } }))
      if (written) logEvent(port, written.session, 'deny', { tool: event.tool, reason: verdict.reason })
      await refreshView(port, true)
    }), undefined)
    return { deny: verdict.reason }
  }
  const ran = await next(event)
  if (ran.deny !== undefined) return ran
  await bestEffort(port, 'handoff document record', () => recordHandoffDocument(createFeaturePort(port), event.tool, toStringOrEmpty(args.file_path), ran.isError === true), undefined)
  return ran
}

/**
 * Adds worktree ownership guidance when an agent starts in an isolated checkout.
 * @param args - The agent call arguments.
 * @param result - The dispatched tool result.
 * @returns The result with guidance when a worktree was requested or created.
 */
function appendAgentWorktreeNote(args: Record<string, unknown>, result: EventResult<'tool.call'>): EventResult<'tool.call'> {
  if (result.deny !== undefined) return result
  const isTeammateStart = typeof result.result === 'object' && result.result !== null
    && 'status' in result.result && result.result.status === 'teammate_spawned'
  if (args.isolation !== 'worktree' && !(args.isolation === undefined && isTeammateStart)) return result
  return { ...result, context: [...(result.context ?? []), markForAgent(agentWorktreeNote)] }
}
