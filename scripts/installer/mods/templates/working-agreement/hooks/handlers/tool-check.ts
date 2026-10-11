import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { judgeCall } from '../core/call-judgement'
import type { EnginePort } from '../core/engine-port'
import { isJudgedTool } from '../core/judged-tools'
import { isRecord } from '../lib/json'

/**
 * Puts the agreement's ask in front of a judged tool call's permission check, unless a check beneath denies it.
 *
 * @param port - The engine calls.
 * @param event - The permission check.
 * @param next - The rest of the chain.
 * @returns What the chain answers, or the agreement's ask.
 */
export async function handleToolCheck(port: EnginePort, event: Frozen<Args<'tool.check'>>, next: Next<'tool.check'>): Promise<EventResult<'tool.check'>> {
  if (!isJudgedTool(event.tool)) return next(event)
  const verdict = await judgeCall(port, event.tool, isRecord(event.input) ? event.input : {})
  const below = await next(event)
  if (verdict.decision !== 'ask' || below.decision === 'deny') return below
  return { decision: 'ask', reason: verdict.reason }
}
