import type { SessionContextUsage } from 'claude-code'
import type { IssueAudit } from '../../types'

import type { IssueRebind, RebindOutcome } from '../domain/delegation'
import { composeInstruction } from '../domain/instruction'
import { formatIssueReferences } from '../domain/messages'
import { createEmptySession } from '../domain/records'
import type { Session } from '../domain/records'
import type { Position } from '../domain/step-states'
import { normalizePath, toRepoRelative } from '../lib/paths'
import { isFiniteNumber } from '../lib/guards'
import { formatError } from '../lib/result'
import { moduleState } from '../lib/module-state'

/** A running handoff: the document it wrote, whether its /handoff turn is still to start or under way, and how that turn ended. */
interface RunningHandoff {
  documentPath: string | null
  isPending: boolean
  isArmed: boolean
  end: (reason: string) => void
}

/** The handoff state kept for the life of one module load; a reload evaluates the module again, so it starts over. */
interface HandoffRuntime {
  current: RunningHandoff | null
}

/** The engine and core calls the handoff feature makes, each a closure the entry file builds. */
export interface HandoffPort {
  readSession: () => Promise<Session>
  /** Applies a change to the fresh session; the change may run more than once, so it has no side effects. */
  updateSession: (change: (session: Session) => Session | null) => Promise<Session | null>
  locate: (session: Session) => Promise<Position | null>
  /** Whether a live coordinator delegates the session's unit; false when the delegation cannot be read. */
  readIsDelegated: (session: Session) => Promise<boolean>
  refresh: (isQuiet?: boolean) => Promise<void>
  readRoot: () => Promise<string | null>
  readCwd: () => Promise<string>
  readSessionId: () => Promise<string>
  readContext: () => Promise<SessionContextUsage>
  /** The issue audit a handoff carries from a chat, its window read now, before `/clear` restarts the session's start; it never throws. */
  readCarriedAudit: (session: Session) => Promise<IssueAudit>
  runSlashCommand: (command: string, args?: string) => Promise<void>
  submitPrompt: (text: string) => Promise<void>
  defer: (work: () => void) => void
  openPane: () => void
  /** Runs a read-modify-write of the records under the store lock; the work must not refresh the pane, whose GitHub sync takes the lock too. */
  withLock: <T>(work: () => Promise<T>) => Promise<T>
  /** Appends an event to the unit's transition log in the background. */
  log: (session: Session, event: string, detail: Record<string, unknown>) => void
  /** Rebinds the unit's spawn records from the previous session to this one under the spawn lock; never throws. */
  rebind: (issues: number[], previous: string) => Promise<RebindOutcome>
}

/** Opens the prompt that continues a handoff in the new session. */
export const handoffResumeLead = 'Continue from the handoff document at '

/** Why a running handoff has no continuation in this process, as far as the session start knows. */
const lossCauses = { reload: 'mod reload', process: 'the session\'s previous process ended', unknown: 'cause unknown' }

/** Reserves room for the handoff turn before auto-compaction. */
const handoffRoomTokens = 25000

const handoff = moduleState((): HandoffRuntime => ({ current: null }))
// why: set from the plugin's options when the module loads, which a reload does again, so it is configuration, not state a reload starts over.
const handoffConfig = { tokenThreshold: 150000 }

/**
 * Sets the context size from which a session counts as long, when the user's configuration gives a usable one.
 *
 * @param tokens - The configured threshold.
 */
export function setHandoffThreshold(tokens: unknown): void {
  if (isFiniteNumber(tokens) && tokens > 0) handoffConfig.tokenThreshold = tokens
}

/**
 * Detects a long session from used tokens or the room left before auto-compaction.
 * @param context - The engine's summary context estimate.
 * @param tokenThreshold - The configured used-token threshold.
 * @returns Whether either boundary has been reached.
 */
export function isLongSession(context: SessionContextUsage, tokenThreshold: number): boolean {
  const breakdown = context.breakdown
  const room = breakdown?.autoCompactThreshold !== undefined
    ? breakdown.autoCompactThreshold - breakdown.totalTokens
    : breakdown?.categories.find(category => category.kind === 'free')?.tokens
  return (context.tokens ?? 0) >= tokenThreshold || (room !== undefined && room <= handoffRoomTokens)
}

/**
 * Clears a finished unit's session without carrying it over, unless a handoff is running.
 * @param port - The engine and core calls.
 */
export async function startNewSession(port: HandoffPort): Promise<void> {
  if ((await port.readSession()).handoff?.state === 'running' || handoff.current) return
  port.defer(() => { void port.runSlashCommand('clear').then(() => port.refresh()) })
}

/**
 * Persists a failed handoff and refreshes its visible state.
 * @param port - The handoff's persistence and display calls.
 * @param reason - The failure shown to the user.
 */
async function failHandoff(port: HandoffPort, reason: string): Promise<void> {
  handoff.current = null
  const written = await port.withLock(() => port.updateSession(saved => ({ ...saved, handoff: { state: 'failed', reason } })))
  if (written) port.log(written, 'handoff', { state: 'failed', reason })
  await port.refresh()
}

/**
 * Marks a handoff the stored session still shows as running as failed when this module holds no run of it, naming only what is
 * established: the run has no continuation here, and how this module's process state began.
 *
 * @param port - The engine and core calls.
 * @param origin - Whether the mod reloaded in this process, the process is new, or neither is known.
 */
export async function recoverHandoff(port: HandoffPort, origin: 'reload' | 'process' | 'unknown'): Promise<void> {
  if (handoff.current) return
  const reason = `a handoff was running and has no continuation in this process (${lossCauses[origin]})`
  // why: claimed only while it still runs, as the replaced module's own end of the /handoff turn claims it, so never both act on it.
  const written = await port.withLock(() => port.updateSession(saved => saved.handoff?.state === 'running' ? { ...saved, handoff: { state: 'failed', reason } } : null))
  if (!written) return
  port.log(written, 'handoff', { state: 'failed', reason })
  await port.refresh()
}

/**
 * Starts a handoff: runs /handoff with the flow's next action, then clears and continues in a new session once the document is written.
 *
 * @param port - The engine and core calls.
 */
export async function startHandoff(port: HandoffPort): Promise<void> {
  const session = await port.readSession()
  if (session.handoff?.state === 'running' || handoff.current) return
  const position = session.flow ? await port.locate(session) : null
  const next = session.flow ? 'The next session continues this unit.' : 'The next session continues this work.'
  const args = [position ? `Flow: ${composeInstruction(position, session, await port.readIsDelegated(session))}` : '', next].filter(Boolean).join(' ')
  // why: the end of the /handoff turn carries the handoff on from this record, where it waits.
  const running: RunningHandoff = {
    documentPath: null, isPending: true, isArmed: false,
    end: reason => void finishHandoff(port, running, reason).catch(error => failHandoff(port, formatError(error))),
  }
  handoff.current = running
  const written = await port.withLock(() => port.updateSession(saved => ({ ...saved, handoff: { state: 'running' } })))
  if (written) port.log(written, 'handoff', { state: 'started' })
  await port.refresh()
  // why: a hook the turn waits on cannot run a command, so the command is deferred until the caller has returned.
  port.defer(() => void port.runSlashCommand('handoff', args).catch(error => failHandoff(port, formatError(error))))
}

/**
 * Continues a handoff after its `/handoff` turn ends.
 * @param port - The engine and core calls.
 * @param running - The active handoff state.
 * @param reason - The turn's end reason.
 * @returns Once the handoff continues or fails.
 */
async function finishHandoff(port: HandoffPort, running: RunningHandoff, reason: string): Promise<void> {
  if (handoff.current !== running) return
  if (reason !== 'answer') return failHandoff(port, reason === 'aborted' ? 'turn interrupted' : `turn ended with ${reason}`)
  const path = running.documentPath
  if (!path) return failHandoff(port, 'no single handoff document found')

  const written = await port.withLock(() => port.updateSession(saved => saved.handoff?.state === 'running' ? { ...saved, handoff: undefined } : null))
  handoff.current = null
  // why: a module that took over after a reload found no continuation of this run and marked it failed, so this load writes nothing and carries nothing on.
  if (!written) return
  const previous = written
  const audit = await port.readCarriedAudit(previous)
  await port.runSlashCommand('clear')
  try {
    const text = await carryOver(port, previous, audit, path)
    const unrebound = previous.unit ? await rebindCarried(port, previous, previous.unit.issues) : null
    await port.refresh()
    await port.submitPrompt(text)
    if (unrebound) port.log(previous, 'handoff', { state: 'failed', reason: unrebound, document: path })
    else port.log(previous, 'handoff', { state: 'completed', document: path })
  } catch (error) { await failHandoff(port, formatError(error)) }
}

/**
 * Rebinds the carried unit's spawn records to this session and records what was established on the carried session.
 * @param port - The engine calls.
 * @param previous - The previous session.
 * @param issues - The carried unit's issues.
 * @returns Null when no scope covers the unit or every record that named the previous session names this one; else the Handoff row's reason.
 */
async function rebindCarried(port: HandoffPort, previous: Session, issues: number[]): Promise<string | null> {
  const current = await port.readSessionId()
  const reason = describeRebind(await port.rebind(issues, previous.sessionId), issues, current)
  await port.withLock(() => port.updateSession(saved => ({ ...saved, handoff: reason ? { state: 'failed', reason } : undefined })))
  return reason
}

/**
 * Words what a handoff's rebind established, as the Handoff row shows it after `not completed · `.
 * @param outcome - The rebind's outcome.
 * @param issues - The carried unit's issues.
 * @param current - This session's id.
 * @returns Null for a unit no scope covers or one whose every record that named the previous session now names this one; else the reason.
 */
function describeRebind(outcome: RebindOutcome, issues: number[], current: string): string | null {
  if (outcome.kind === 'undelegated') return null
  const failed = outcome.issues.filter(entry => entry.kind === 'unchanged' || entry.kind === 'unknown')
  const rebound = outcome.issues.filter(entry => entry.kind === 'rebound')
  if (!failed.length && rebound.length) return null
  const isSingle = outcome.issues.length === 1
  const carried = `cleared and carried ${formatIssueReferences(issues, ', ')}`
  const clause = (entry: IssueRebind): string => {
    const record = isSingle ? `its spawn record ${entry.path}` : `#${entry.issue}'s spawn record ${entry.path}`
    if (entry.kind === 'rebound') return `${record} now names this session`
    if (entry.kind === 'unknown') return `whether ${record} names this session is unknown (${entry.error}); check its sessionId against this session's id ${current}`
    return `${record} was not changed (${entry.reason}), so this session is not #${entry.issue}'s delegated unit; check that file`
  }
  // why: with no record rebound, a record that names neither session is part of why this session is not the unit; beside a rebound one, it is no failure.
  const shown = rebound.length ? [...rebound, ...failed] : outcome.issues
  const scope = outcome.scopeError ? [`whether a coordinator's scope covers ${formatIssueReferences(issues, ', ')} is unknown (${outcome.scopeError}); `
    + 'check delegation/ under working-agreement in git rev-parse --git-common-dir'] : []
  return [carried, ...shown.map(clause), ...scope].join('; ')
}

/**
 * Creates the continuation prompt and restores the prior unit in the new session.
 * @param port - The engine and core calls.
 * @param previous - The previous session.
 * @param audit - The previous session's issue audit, with the window read before the clear.
 * @param path - The handoff document.
 * @returns The continuation prompt.
 */
async function carryOver(port: HandoffPort, previous: Session, audit: IssueAudit, path: string): Promise<string> {
  const resume = `${handoffResumeLead}${path}. Read it first, then follow its suggested skills.`
  if (previous.unit) {
    const sessionId = await port.readSessionId()
    // why: written before the rebind, so a reload or a process end before it finishes leaves this note, true then, and no completed handoff.
    const pending = `cleared and carried ${formatIssueReferences(previous.unit.issues, ', ')}; the rebind of ${previous.unit.issues.length > 1 ? 'their spawn records' : 'its spawn record'} `
      + 'to this session has not finished yet; if this row stays after the continuation prompt, it did not finish in the load that cleared the session; '
      + `check the sessionId of spawn/<issue>.json under working-agreement in git rev-parse --git-common-dir against this session's id ${sessionId}`
    const carried: Session = {
      ...createEmptySession(sessionId), unit: previous.unit, info: previous.info,
      gh: previous.gh, audit, handoff: { state: 'failed', reason: pending },
    }
    // why: the cleared chat starts its own record, so the carried unit replaces it whole.
    await port.withLock(() => port.updateSession(() => carried))
    port.openPane()
  }
  return resume
}

/**
 * Runs `/flow handoff [cancel]`.
 *
 * @param port - The engine and core calls.
 * @param args - The words after `handoff`.
 * @returns The message for the user.
 */
export async function runHandoffCommand(port: HandoffPort, args: string): Promise<string> {
  if (args === 'cancel') {
    handoff.current = null
    await port.withLock(() => port.updateSession(saved => ({ ...saved, handoff: undefined })))
    await port.refresh()
    return 'Handoff reset. Nothing was cleared.'
  }
  if ((await port.readSession()).handoff?.state === 'running') return 'A handoff is already running — /flow handoff cancel resets it (nothing is cleared).'
  await startHandoff(port)
  return 'Continuing in a new session: /handoff, then /clear once the document is written.'
}

/**
 * Arms a handoff whose /handoff run is still to start as the main agent's next turn starts: that run is queued until the session is
 * idle, so a turn live when the handoff started ends first and is not the handoff's, and no hook of the mod sees /handoff enter.
 */
export function armPendingHandoff(): void {
  if (!handoff.current?.isPending) return
  handoff.current.isPending = false
  handoff.current.isArmed = true
}

/**
 * Reports the end of the /handoff turn to the running handoff.
 *
 * @param reason - How the turn ended.
 * @returns True when the turn was the handoff's, so nothing else reacts to it.
 */
export function endHandoffTurn(reason: string): boolean {
  if (!handoff.current?.isArmed) return false
  handoff.current.isArmed = false
  handoff.current.end(reason)
  return true
}

/**
 * Records whether the session is long. The caller holds the lock.
 *
 * @param port - The engine and core calls.
 */
export async function trackSessionLength(port: HandoffPort): Promise<void> {
  if (!(await port.readSession()).flow) return
  const isLong = isLongSession(await port.readContext(), handoffConfig.tokenThreshold)
  const written = await port.updateSession(session => session.flow && isLong !== session.isLong ? { ...session, isLong } : null)
  if (written) await port.refresh(true)
}

/**
 * Takes a Markdown file the Write tool wrote outside the repository during the /handoff turn as the handoff document.
 *
 * @param port - The engine and core calls.
 * @param tool - The tool's name.
 * @param filePath - The path the tool wrote.
 * @param isError - Whether the call failed.
 */
export async function recordHandoffDocument(port: HandoffPort, tool: string, filePath: string, isError: boolean): Promise<void> {
  const running = handoff.current
  if (!running?.isArmed || tool !== 'Write' || isError || !filePath.endsWith('.md')) return
  const root = await port.readRoot()
  const path = normalizePath(filePath, await port.readCwd())
  if (!root || !toRepoRelative(path, root)) running.documentPath = path
}
