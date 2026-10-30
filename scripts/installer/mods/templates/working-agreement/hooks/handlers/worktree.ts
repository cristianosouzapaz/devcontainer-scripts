import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import type { EnginePort } from '../core/engine-port'
import { createHerdrWorktree, removeHerdrWorktree, sweepHerdrWorktrees } from '../core/herdr-worktrees'
import { describeStaleVerify } from '../core/stale-verify'

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
 * Blocks the main turn's stop once while the unit's passing Verify no longer matches its tree, and otherwise sweeps this
 * session's idle herdr worktrees when no subagent still runs in the background.
 * Claude Code runs no removal for a subagent's worktree, and a background subagent's worktree cannot be told apart.
 * @param port - The engine calls.
 * @param event - The main agent's stop.
 * @param next - The rest of the chain.
 * @returns The chain's answer, carrying the stale Verify's reason as a block.
 */
export async function handleStop(port: EnginePort, event: Frozen<Args<'classic.Stop'>>, next: Next<'classic.Stop'>): Promise<EventResult<'classic.Stop'>> {
  const result = await next(event)
  // why: A stop continuing from this block is let through, so an agent that cannot rerun Verify is never held in a loop.
  const stale = event.stop_hook_active ? null : await bestEffort(port, 'stale Verify check', () => describeStaleVerify(port), null)
  if (stale) return { ...result, block: stale }
  if (!event.background_tasks?.some(task => task.type === 'subagent')) {
    // A sweep of several herdr and git calls can outlast the hook's budget, so it runs on a timer's dispatch.
    port.defer(() => { void bestEffort(port, 'worktree sweep', () => sweepHerdrWorktrees(port), undefined) })
  }
  return result
}
