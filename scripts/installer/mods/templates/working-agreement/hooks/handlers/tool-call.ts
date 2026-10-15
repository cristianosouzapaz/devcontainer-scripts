import type { Args, EventResult, Frozen, Next } from 'claude-code'

import { recordAnchor } from '../core/anchor'
import { judgeToolCall } from '../core/call-judgement'
import { endDirectRun, startDirectRun } from '../core/command-observation'
import type { EnginePort } from '../core/engine-port'
import { toastFailure } from '../core/failure-toast'
import { createFeaturePort } from '../core/feature-port'
import { isJudgedTool } from '../core/judged-tools'
import { observeCommand } from '../core/observation-recording'
import { refreshView } from '../core/pane-view'
import { listUnitKeys, readSession, readUnit, updateUnits, writeSession } from '../core/record-store'
import { readGit } from '../core/repository'
import { settleBackgroundRun, settleDetachedTask, trackDetachedTask } from '../core/runs-in-flight'
import { compareTree } from '../core/tree-record'
import { withRecordLock } from '../core/session-memory'
import { adoptWorktree, excludeWorktrees } from '../core/worktree-setup'
import { flowDefinitions } from '../domain/flow-definitions'
import { markForAgent } from '../domain/messages'
import type { Session, Unit } from '../domain/records'
import { isOnBase } from '../domain/step-states'
import { recordHandoffDocument } from '../features/handoff'
import { isRecord, toStringOrEmpty } from '../lib/json'

/**
 * Gates a tool call against the declared flow, runs it, and records what it did for the unit.
 *
 * @param port - The engine calls.
 * @param event - The tool call.
 * @param next - The rest of the chain, which runs the tool.
 * @returns The tool's result, or a deny.
 */
export async function handleToolCall(port: EnginePort, event: Frozen<Args<'tool.call'>>, next: Next<'tool.call'>): Promise<EventResult<'tool.call'>> {
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
  if (event.tool === 'TaskStop') return handleTaskStop(port, args, next(event))
  if (event.tool === 'EnterWorktree') return handleEnterWorktree(port, args, () => next(event))
  if (!isJudgedTool(event.tool, args)) return next(event)
  // Compared before the verdict, so a change no call made holds this very call back.
  await withRecordLock(async () => compareTree(port, await readSession(port))).catch(toastFailure(port, 'compare the working tree'))
  const verdict = await judgeToolCall(port, event.tool, args)
  if (verdict.decision === 'deny') {
    const kind = verdict.write?.isDenied ? verdict.write.kind : undefined
    // The deny never waits for the lock: a hook past its budget fails, and its .catch denies without the verdict's reason.
    if (kind) {
      void withRecordLock(async () => {
        const session = await readSession(port)
        await writeSession(port, { ...session, blocked: { ...session.blocked, [kind]: session.blocked[kind] + 1 } })
        await refreshView(port, true)
      }).catch(toastFailure(port, 'count the blocked write'))
    }
    return { deny: verdict.reason }
  }
  const launchSession = event.tool === 'Bash' ? await readSession(port) : null
  const launch = launchSession ? await startDirectRun(port, launchSession, toStringOrEmpty(args.command)) : null
  const isInFlight = !!launch?.isInFlight
  if (isInFlight) await withRecordLock(() => refreshView(port, true)).catch(toastFailure(port, 'show the run'))
  const ran = await (async () => {
    try {
      const done = await next(event)
      endDirectRun(launch, done)
      trackLeftTask(done)
      return done
    } catch (error) {
      endDirectRun(launch, null)
      if (isInFlight) void withRecordLock(() => refreshView(port, true)).catch(toastFailure(port, 'end the run'))
      throw error
    }
  })()
  if (isInFlight && ran.deny !== undefined) void withRecordLock(() => refreshView(port, true)).catch(toastFailure(port, 'end the run'))
  if (ran.deny !== undefined) return ran
  try {
    await recordHandoffDocument(createFeaturePort(port), event.tool, toStringOrEmpty(args.file_path), ran.isError === true)
    await withRecordLock(async () => {
      const saved = await readSession(port)
      if (!saved.flow) return
      const hasWritten = !!verdict.write && ran.isError !== true
      const session = hasWritten ? await markWrite(port, saved) : saved
      const git = hasWritten ? await readGit(port) : null
      if (git) {
        const isNewBranch = (unit: Unit): boolean => !isOnBase(git) && (!unit.branch || unit.branch === git.base)
        await updateUnits(port, session, unit => ({ ...unit, branch: isNewBranch(unit) ? git.branch : unit.branch }))
      }
      // Compared before the command is observed, so a red this run records does not open the gate its own writes are judged by.
      await compareTree(port, session, verdict.decision === 'ask')
      if (event.tool === 'Bash') await observeCommand(port, session, toStringOrEmpty(args.command), ran, launch)
      // A write leaves the tree dirty, so a marked write has nothing to anchor.
      if (session === saved) await recordAnchor(port, await readSession(port))
      await refreshView(port, true)
    })
    // GitHub (PR state, gh status) is refreshed off the lock and off the tool result's path.
    void refreshView(port).catch(toastFailure(port, 'refresh GitHub'))
  } catch (error) {
    toastFailure(port, `record ${event.tool}`)(error)
  }
  return ran
}

// Marks the session as having written a repository file after the unit's anchor, which reopens the unit's finished steps.
async function markWrite(port: EnginePort, session: Session): Promise<Session> {
  const [key] = await listUnitKeys(port, session)
  const anchor = key && (await readGit(port)) ? (await readUnit(port, key)).anchor : undefined
  if (!anchor) return session
  const marked = { ...session, wroteAfter: anchor }
  await writeSession(port, marked)
  return marked
}

// Keeps the worktrees out of git status before Claude Code creates one, then takes in the worktree the call entered.
async function handleEnterWorktree(port: EnginePort, args: Record<string, unknown>, entering: () => Promise<EventResult<'tool.call'>>): Promise<EventResult<'tool.call'>> {
  await excludeWorktrees(port).catch(toastFailure(port, 'keep the worktrees out of git status'))
  const ran = await entering()
  if (ran.deny !== undefined || ran.isError === true) return ran
  await withRecordLock(async () => {
    await adoptWorktree(port, await readSession(port), args, ran.result)
    await refreshView(port, true)
  }).catch(toastFailure(port, 'set up the worktree'))
  return ran
}

// Settles the background run a TaskStop ended: the engine sends no notification for a task the agent stops.
async function handleTaskStop(port: EnginePort, args: Record<string, unknown>, stopping: Promise<EventResult<'tool.call'>>): Promise<EventResult<'tool.call'>> {
  const ran = await stopping
  const id = toStringOrEmpty(args.task_id) || toStringOrEmpty(args.shell_id)
  if (ran.deny === undefined && ran.isError !== true) settleDetachedTask(id)
  if (ran.deny === undefined && ran.isError !== true && settleBackgroundRun({ id, status: 'killed' })) {
    await withRecordLock(() => refreshView(port, true)).catch(toastFailure(port, 'end the stopped run'))
  }
  return ran
}

// Knows the background task a call left running, a Bash call's or a Monitor's, as a writer that may change the tree between
// calls; one that ends with its caller's final response is over by the turn end, whose comparison judges what it wrote.
function trackLeftTask(ran: EventResult<'tool.call'>): void {
  const result = isRecord(ran.result) ? ran.result : {}
  const taskId = toStringOrEmpty(result.backgroundTaskId ?? result.taskId)
  if (taskId && !result.backgroundEndsWithFinalResponse) trackDetachedTask(taskId)
}
