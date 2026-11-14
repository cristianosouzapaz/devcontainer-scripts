import type { Args, EventResult, Frozen, Next } from 'claude-code'

import type { ProcessState } from '../../types'
import { bestEffort } from '../core/best-effort'
import type { EnginePort } from '../core/engine-port'
import { createHerdrWorktree, removeHerdrWorktree, sweepHerdrWorktrees } from '../core/herdr-worktrees'
import { describeEscalationStop } from '../core/escalation'
import { describeStaleVerify } from '../core/stale-verify'
import { takeMailBlock } from '../core/mail-delivery'
import { judgeTurnEnd } from '../core/turn-end'
import { readProcessState } from '../core/process-state'
import { readTurnFlags, recordTurnFact } from '../core/turn-evidence'

/**
 * Creates Claude Code's worktree through herdr inside herdr; outside it, or when herdr fails, git creates it as unhooked.
 * @param port - The engine calls.
 * @param event - The worktree creation.
 * @param next - The rest of the chain.
 * @returns The herdr checkout as the worktree path, or the chain's answer.
 */
export async function handleWorktreeCreate(port: EnginePort, event: Frozen<Args<'classic.WorktreeCreate'>>, next: Next<'classic.WorktreeCreate'>): Promise<EventResult<'classic.WorktreeCreate'>> {
  const path = await createHerdrWorktree(port, event.name, event.cwd)
  return path ? { worktreePath: path } : next(event)
}

/**
 * Removes a mod-created herdr worktree through herdr; any other worktree is left to the chain.
 * @param port - The engine calls.
 * @param event - The worktree removal.
 * @param next - The rest of the chain.
 * @returns The chain's answer, once the herdr worktree is gone.
 */
export async function handleWorktreeRemove(port: EnginePort, event: Frozen<Args<'classic.WorktreeRemove'>>, next: Next<'classic.WorktreeRemove'>): Promise<EventResult<'classic.WorktreeRemove'>> {
  return await removeHerdrWorktree(port, event.worktree_path) ? {} : next(event)
}

/**
 * Blocks the main turn's stop once while the unit's passing Verify no longer matches its tree, or with the session's unread mail, which
 * the model then reads before the turn ends; else once per state for a delegated unit that ends its turn with no message; otherwise sweeps
 * this session's idle herdr worktrees when no subagent still runs in the background. A kept start is never carried by a Stop's block: it
 * waits for an idle window after the turn, where its entry is established.
 * Claude Code runs no removal for a subagent's worktree, and a background subagent's worktree cannot be told apart.
 * @param port - The engine calls.
 * @param event - The main agent's stop.
 * @param next - The rest of the chain.
 * @returns The chain's answer, carrying the stale Verify's reason and the mail, or the request for a message, as a block.
 */
export async function handleStop(port: EnginePort, event: Frozen<Args<'classic.Stop'>>, next: Next<'classic.Stop'>): Promise<EventResult<'classic.Stop'>> {
  const result = await next(event)
  // why: A stop continuing from this block is let through, so an agent that cannot rerun Verify is never held in a loop; a failed read holds nothing; a unit refused Verify for its escalation cannot rerun it, and must end its turn for the sweep to raise it, so neither block holds it; a unit given only a note can rerun it.
  const isEscalating = await bestEffort(port, 'escalation stop', async () => (await describeEscalationStop(port))?.kind === 'refused', true)
  // why: a stop that continues from an earlier block still delivers mail, since each delivery marks it read and so cannot loop.
  const mail = await bestEffort(port, 'mail delivery', () => takeMailBlock(port), null)
  const read = await readProcessState(port)
  const worked = (held: ProcessState): ProcessState => held.turn ? { ...held, turn: { ...held.turn, isEmptyDoorbell: false } } : held
  // why: mail a Stop delivers is work, so the turn no longer counts as an empty doorbell, written or not.
  if (mail && read?.turn) await recordTurnFact(port, 'worked', read.turn.id, worked)
  const state = mail && read ? worked(read) : read
  if (next.signal?.aborted) return result
  const stale = event.stop_hook_active || isEscalating || !!readTurnFlags(state)?.isEmptyDoorbell ? null
    : await bestEffort(port, 'stale Verify check', () => describeStaleVerify(port), null)
  if (next.signal?.aborted) return result
  if (stale || mail) return { ...result, block: [stale, mail].filter(Boolean).join('\n\n') }
  // why: asked only once nothing else continues the turn, since mail or a stale Verify may lead the agent to its message on its own.
  const turnEnd = isEscalating ? null : await bestEffort(port, 'turn end', () => judgeTurnEnd(port, state), null)
  if (turnEnd) return { ...result, block: turnEnd }
  if (!event.background_tasks?.some(task => task.type === 'subagent')) {
    // why: a sweep of several herdr and git calls can outlast the hook's budget, so it runs on a timer's dispatch.
    port.defer(() => { void bestEffort(port, 'worktree sweep', () => sweepHerdrWorktrees(port), undefined) })
  }
  return result
}
