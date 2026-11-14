import type { Args, EventResult, Frozen } from 'claude-code'

import { denyUnapprovedCommit } from '../core/approval-gate'
import { bestEffort } from '../core/best-effort'
import { denyCancelledCall } from '../core/cancel-gate'
import { judgeToolCall } from '../core/call-judgement'
import { denyDelegatedCommand } from '../core/delegated-commits'
import type { EnginePort } from '../core/engine-port'
import { createFeaturePort } from '../core/feature-port'
import { logEvent } from '../core/flow-log'
import { recordActivity } from '../core/liveness'
import { isJudgedTool } from '../core/judged-tools'
import { refreshView, reread, rereadAtCallStart } from '../core/pane-view'
import { readProcessState } from '../core/process-state'
import { recordTurnFact } from '../core/turn-evidence'
import { readSession, updateSession } from '../core/record-store'
import { sessionMemory, withRecordLock } from '../core/session-memory'
import { isInsideHerdr, spawnGuide } from '../core/herdr-worktrees'
import { flowDefinitions } from '../domain/flow-definitions'
import { isGitCommit, judgeApprovalBash, judgeHeredocBash, judgeIssueBash, judgeMailboxWrite, judgeRecordsBash, judgeReservedFlowBash } from '../domain/bash-guards'
import { markForAgent, modToolPrefix } from '../domain/messages'
import { recordHandoffDocument } from '../features/handoff'
import { toStringOrEmpty } from '../lib/json'
import { denyCoordinatorCall } from './coordinator'
import { handleGuarantees } from './guarantees'

/** The chain beneath the guard, which runs the tool: the hook's `next`, or a guard retry's stand-in for it. */
type ToolChain = (event: Frozen<Args<'tool.call'>>) => Promise<EventResult<'tool.call'>>

const agentWorktreeNote = 'a subagent with isolation: worktree does not see the unit\'s uncommitted changes (inside herdr, or with worktree.baseRef: "head", it sees only the committed HEAD); bring its changes back as an uncommitted patch (git -C <wt> diff --binary | git apply), never as a commit; with agent teams on, pass isolation on the Agent call itself, even for a subagent with a name.'

/**
 * Checks a tool call, runs it, and records what it did for the unit.
 *
 * @param port - The engine calls.
 * @param event - The tool call.
 * @param next - The rest of the chain, which runs the tool.
 * @returns The tool's result, or a deny.
 */
export async function handleToolCall(port: EnginePort, event: Frozen<Args<'tool.call'>>, next: ToolChain): Promise<EventResult<'tool.call'>> {
  // why: a tool event proves no turn, as a subagent's or a hook's that an interrupt left running would not; it only moves the time of a record that holds the turn read here, so a call that ends after its turn did records nothing.
  const state = await readProcessState(port)
  // why: a coordinator's tick reads a turn with no tool event for long as stalled, so each call's start and end both count as one.
  await bestEffort(port, 'activity', () => recordActivity(port, 'tool', state), undefined)
  // why: a model that works after an empty doorbell makes it a work turn, which its Stop holds like any other.
  if (!event.agentId && state?.turn?.isEmptyDoorbell) await recordTurnFact(port, 'worked', state.turn.id, held => held.turn ? { ...held, turn: { ...held.turn, isEmptyDoorbell: false } } : held)
  try {
    return await handleGuarantees(port, event, () => handleGatedCall(port, event, next))
  } finally {
    await bestEffort(port, 'activity', () => recordActivity(port, 'tool', state), undefined)
  }
}

/**
 * Enforces flow prerequisites before dispatch and records successful handoff writes.
 * @param port - The engine calls.
 * @param event - The tool call being gated.
 * @param next - The remaining tool dispatch chain.
 * @returns The refusal or dispatched tool result.
 */
async function handleGatedCall(port: EnginePort, event: Frozen<Args<'tool.call'>>, next: ToolChain): Promise<EventResult<'tool.call'>> {
  // why: the mod's own tools answer without next, so no permission check reaches them, and the coordinator guard must run first.
  const coordinatorDeny = await denyCoordinatorCall(port, event)
  if (coordinatorDeny) return { deny: coordinatorDeny }
  // why: a cancel gates every tool but send, the mod's own included, until the unit replies or the user lifts it.
  const cancelDeny = await denyCancelledCall(port, event.tool, event.agentId)
  if (cancelDeny) return { deny: cancelDeny }
  if (event.tool.startsWith(modToolPrefix)) return next(event)
  const args: Record<string, unknown> = { ...event }
  if (event.tool === 'Skill' && !event.agentId) {
    const name = toStringOrEmpty(args.skill).split(':').pop()
    const steps = Object.values(flowDefinitions.flows).flatMap(flow => flow.steps.map(step => step.skill))
    if (steps.includes(name) && !(await readSession(port)).flow) {
      return { deny: markForAgent(`${name} is a flow step and no flow is declared — classify the work per AGENTS.md (read the issue if there is one), call declare_flow, then run ${name} again.`) }
    }
    return next(event)
  }
  // why: the Verify config approval and the user's /flow steps are the user's, from their own terminal, in every session: no agent command names the script or types a step.
  const approvalDeny = event.tool === 'Bash'
    ? judgeApprovalBash(toStringOrEmpty(args.command)) ?? judgeReservedFlowBash(toStringOrEmpty(args.command), (await port.readHerdrEnv()).socketPath)
    : undefined
  if (approvalDeny) return { deny: approvalDeny }
  // why: a heredoc that ends early runs the rest of its body as shell, in any session.
  const heredocDeny = event.tool === 'Bash' ? judgeHeredocBash(toStringOrEmpty(args.command)) : undefined
  if (heredocDeny) return { deny: heredocDeny }
  // why: every GitHub issue write goes through the issue tools, which check its fields; a raw one is refused before it runs.
  const issueDeny = event.tool === 'Bash' ? judgeIssueBash(toStringOrEmpty(args.command)) : undefined
  if (issueDeny) return { deny: issueDeny }
  // why: the records, the mailbox among them, are written only through the mod's own code; this guard is a best effort.
  const mailDeny = event.tool === 'Bash' ? judgeRecordsBash(toStringOrEmpty(args.command))
    : isJudgedTool(event.tool) ? judgeMailboxWrite(toStringOrEmpty(args.file_path ?? args.notebook_path)) : undefined
  if (mailDeny) return { deny: mailDeny }
  const delegatedDeny = event.tool === 'Bash' ? await denyDelegatedCommand(port, toStringOrEmpty(args.command)) : undefined
  if (delegatedDeny) return { deny: delegatedDeny }
  const unapprovedDeny = event.tool === 'Bash' && isGitCommit(toStringOrEmpty(args.command)) ? await denyUnapprovedCommit(port) : undefined
  if (unapprovedDeny) return { deny: unapprovedDeny }
  const herdrDeny = await denyOutsideHerdr(port, event.tool)
  if (herdrDeny) return { deny: herdrDeny }
  // why: a Bash command may change the tree, so the view is recomputed before it runs, from the tree as it stands, unless a read is in flight.
  if (event.tool === 'Bash') await bestEffort(port, 'call start reread', () => rereadAtCallStart(port), undefined)
  if (!isJudgedTool(event.tool)) return event.tool === 'Agent' ? appendAgentWorktreeNote(args, await next(event)) : next(event)
  const verdict = await judgeToolCall(port, args)
  if (verdict.decision === 'deny') {
    // why: the deny never waits for the lock: a hook past its budget fails, and its .catch denies without the verdict's reason.
    void bestEffort(port, 'blocked edit record', () => withRecordLock(async () => {
      const written = await updateSession(port, session => ({ ...session, blocked: { ...session.blocked, edits: session.blocked.edits + 1 } }))
      if (written) logEvent(port, written.session, 'deny', { tool: event.tool, reason: verdict.reason })
      await refreshView(port, { isQuiet: true })
    }), undefined)
    return { deny: verdict.reason }
  }
  const ran = await runWrite(port, () => next(event))
  if (ran.deny !== undefined) return ran
  await bestEffort(port, 'handoff document record', () => recordHandoffDocument(createFeaturePort(port), event.tool, toStringOrEmpty(args.file_path), ran.isError === true), undefined)
  return ran
}

/**
 * Runs a file write with the view already showing its tree as changed, then lets the real tree decide again, so a failed or no-op write goes back.
 * @param port - The engine calls.
 * @param write - The dispatched write.
 * @returns The write's result.
 */
async function runWrite(port: EnginePort, write: () => Promise<EventResult<'tool.call'>>): Promise<EventResult<'tool.call'>> {
  sessionMemory.pendingWrites += 1
  try {
    await bestEffort(port, 'call start reread', () => rereadAtCallStart(port), undefined)
    return await write()
  } finally {
    sessionMemory.pendingWrites -= 1
    // why: deferred so the next call starts without waiting on this read.
    port.defer(() => { void bestEffort(port, 'call end reread', () => reread(port, false), undefined) })
  }
}

/**
 * Refuses, inside herdr, the chat moving into a worktree herdr would not own.
 * @param port - The engine calls.
 * @param tool - The called tool.
 * @returns The deny reason, or undefined when the call may run.
 */
async function denyOutsideHerdr(port: EnginePort, tool: string): Promise<string | undefined> {
  if (tool !== 'EnterWorktree' || !await isInsideHerdr(port)) return undefined
  return markForAgent(`EnterWorktree is refused inside herdr: a parallel unit never runs in this chat — ${spawnGuide}.`)
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
