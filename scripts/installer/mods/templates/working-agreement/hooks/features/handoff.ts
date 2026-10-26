import type { SessionContextUsage } from 'claude-code'

import { composeInstruction } from '../domain/instruction'
import { createEmptySession } from '../domain/records'
import type { Session } from '../domain/records'
import type { Position } from '../domain/step-states'
import { normalizePath, toRepoRelative } from '../lib/paths'
import { isFiniteNumber } from '../lib/guards'
import { formatError } from '../lib/result'

/** A running handoff: the document it wrote, whether its /handoff turn is under way, and how that turn ended. */
interface RunningHandoff {
  documentPath: string | null
  isArmed: boolean
  end: (reason: string) => void
}

/** The handoff state kept for the life of one module load; a reload evaluates the module again, so it starts over. */
interface HandoffRuntime {
  current: RunningHandoff | null
  tokenThreshold: number
}

/** Where a prompt came from, as the engine reports it. */
interface PromptOrigin { kind: string; name?: string }

/** The engine and core calls the handoff feature makes, each a closure the entry file builds. */
export interface HandoffPort {
  readSession: () => Promise<Session>
  /** Applies a change to the fresh session; the change may run more than once, so it has no side effects. */
  updateSession: (change: (session: Session) => Session | null) => Promise<Session | null>
  locate: (session: Session) => Promise<Position | null>
  refresh: (isQuiet?: boolean) => Promise<void>
  readRoot: () => Promise<string | null>
  readCwd: () => Promise<string>
  readSessionId: () => Promise<string>
  readContext: () => Promise<SessionContextUsage>
  runSlashCommand: (command: string, args?: string) => Promise<void>
  submitPrompt: (text: string) => Promise<void>
  defer: (work: () => void) => void
  openPane: () => void
  /** Runs a read-modify-write of the records under the store lock; the work must not refresh the pane, whose GitHub sync takes the lock too. */
  withLock: <T>(work: () => Promise<T>) => Promise<T>
  /** Appends an event to the unit's transition log in the background. */
  log: (session: Session, event: string, detail: Record<string, unknown>) => void
}

/** Reserves room for the handoff turn before auto-compaction. */
const handoffRoomTokens = 25000

const handoff: HandoffRuntime = { current: null, tokenThreshold: 150000 }

/**
 * Sets the context size from which a session counts as long, when the user's configuration gives a usable one.
 *
 * @param tokens - The configured threshold.
 */
export function setHandoffThreshold(tokens: unknown): void {
  if (isFiniteNumber(tokens) && tokens > 0) handoff.tokenThreshold = tokens
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
 * Marks a handoff the stored session still shows as running as failed when no run is in memory: a reload ended it.
 *
 * @param port - The engine and core calls.
 */
export async function recoverHandoff(port: HandoffPort): Promise<void> {
  if ((await port.readSession()).handoff?.state === 'running' && !handoff.current) await failHandoff(port, 'interrupted by a mod reload')
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
  const args = [position ? `Flow: ${composeInstruction(position, session)}` : '', next].filter(Boolean).join(' ')
  // The end of the /handoff turn carries the handoff on from where it waits.
  const running: RunningHandoff = {
    documentPath: null, isArmed: false,
    end: reason => void finishHandoff(port, running, reason).catch(error => failHandoff(port, formatError(error))),
  }
  handoff.current = running
  const written = await port.withLock(() => port.updateSession(saved => ({ ...saved, handoff: { state: 'running' } })))
  if (written) port.log(written, 'handoff', { state: 'started' })
  await port.refresh()
  // A hook the turn waits on cannot run a command: leave the caller first.
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

  const previous = await port.withLock(() => port.updateSession(saved => ({ ...saved, handoff: undefined }))) ?? await port.readSession()
  handoff.current = null
  await port.runSlashCommand('clear')
  try {
    const text = await carryOver(port, previous, path)
    await port.refresh()
    await port.submitPrompt(text)
    port.log(previous, 'handoff', { state: 'completed', document: path })
  } catch (error) { await failHandoff(port, formatError(error)) }
}

/**
 * Creates the continuation prompt and restores the prior unit in the new session.
 * @param port - The engine and core calls.
 * @param previous - The previous session.
 * @param path - The handoff document.
 * @returns The continuation prompt.
 */
async function carryOver(port: HandoffPort, previous: Session, path: string): Promise<string> {
  const resume = `Continue from the handoff document at ${path}. Read it first, then follow its suggested skills.`
  if (previous.unit) {
    const carried: Session = {
      ...createEmptySession(await port.readSessionId()), unit: previous.unit, info: previous.info,
      gh: previous.gh,
    }
    // The cleared chat starts its own record, which the carried unit replaces whole.
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
 * Arms the running handoff when the mod's own /handoff prompt is submitted, so the turn's end reports to it.
 *
 * @param origin - Where the prompt came from.
 * @param text - The prompt.
 */
export function armHandoff(origin: PromptOrigin, text: string): void {
  if (handoff.current && !handoff.current.isArmed && origin.kind === 'plugin' && origin.name === 'working-agreement' && text.startsWith('/handoff')) {
    handoff.current.isArmed = true
  }
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
  const isLong = isLongSession(await port.readContext(), handoff.tokenThreshold)
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
