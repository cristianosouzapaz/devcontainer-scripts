import type { Args, EventResult, Frozen } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import type { EnginePort } from '../core/engine-port'
import { checksGuarantees, describeViolation, judgeGuarantees, snapshotGuarantees } from '../core/guarantees'
import { isJudgedTool } from '../core/judged-tools'
import { readRepositoryRoot } from '../core/repository'
import { refreshView } from '../core/pane-view'
import { forgetCandidates } from '../core/unit-github'
import { readDismissals, recordViolations } from '../core/violation-store'
import { markForAgent } from '../domain/messages'

interface ToolCallResult { value?: EventResult<'tool.call'> }

/**
 * Wraps the complete tool chain with fail-open observations, including interrupted calls.
 * @param port - The engine calls.
 * @param event - The call with its loop and tool-use identities.
 * @param run - The gated chain, called even when the opening snapshot fails.
 * @returns The original result with non-dismissed violation context for this call's agent.
 */
export async function handleGuarantees(port: EnginePort, event: Frozen<Args<'tool.call'>>, run: () => Promise<EventResult<'tool.call'>>): Promise<EventResult<'tool.call'>> {
  if (!checksGuarantees(event.tool)) return run()
  const start = await bestEffort(port, 'guarantee clock read', () => port.now(), 0)
  const before = await snapshotGuarantees(port, event.tool)
  const context: string[] = []
  const result: ToolCallResult = {}
  try {
    result.value = await run()
  } finally {
    // A Bash or MCP call can open or close a PR without moving a local ref, which would otherwise wait out the cache.
    if (!isJudgedTool(event.tool)) forgetCandidates()
    // Observation never changes whether this or a later call can run.
    await bestEffort(port, 'guarantee observation', async () => {
      const after = await snapshotGuarantees(port, event.tool, before)
      const facts = await judgeGuarantees(port, before, after, event.tool_use_id)
      if (facts.length) {
        const records = await recordViolations(port, facts, { toolUseId: event.tool_use_id, agentId: event.agentId, start, end: await port.now() })
        const dismissed = await readDismissals(port)
        const root = await readRepositoryRoot(port)
        context.push(...records.filter(record => record.kind !== 'unchecked' && !dismissed.has(record.factId)).map(record => markForAgent(describeViolation(record, 'agent', root ?? undefined))))
        await refreshView(port, true)
      }
    }, undefined)
  }
  const ran = result.value!
  return ran.deny !== undefined || !context.length ? ran : { ...ran, context: [...(ran.context ?? []), ...context] }
}
