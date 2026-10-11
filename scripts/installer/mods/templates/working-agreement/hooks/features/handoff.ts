import { composeInstruction, formatIssueReferences } from '../domain/instruction'
import { createEmptySession } from '../domain/records'
import type { Session, Unit } from '../domain/records'
import { isUnitFinished } from '../domain/step-states'
import type { Position } from '../domain/step-states'
import { deny } from '../domain/verdicts'
import type { Verdict } from '../domain/verdicts'
import { statFile } from '../lib/files'
import type { FilePort } from '../lib/files'
import { normalizePath, toRepoRelative } from '../lib/paths'
import { runCommand } from '../lib/process'
import type { ProcessPort } from '../lib/process'
import { formatError, unwrapOr } from '../lib/result'
import type { ClockPort, Result } from '../lib/result'
import type { WriteTarget } from '../lib/shell-parser'

/** A running handoff: when it started, the document it wrote, whether its /handoff turn is under way, and how that turn ended. */
interface RunningHandoff {
  startedAt: number
  isFinished: boolean
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
  processes: ProcessPort
  files: FilePort
  clock: ClockPort
  readSession: () => Promise<Session>
  writeSession: (session: Session) => Promise<void>
  readUnit: (key: string) => Promise<Unit>
  writeStored: (key: string, value: unknown) => Promise<void>
  findUnitKey: (session: Session) => Promise<string>
  locate: (session: Session) => Promise<Position | null>
  refresh: (isQuiet?: boolean) => Promise<void>
  readRoot: () => Promise<string | null>
  readCwd: () => Promise<string>
  readRepoSlug: () => Promise<string>
  readSessionId: () => Promise<string>
  readContextTokens: () => Promise<number>
  now: () => Promise<number>
  runSlashCommand: (command: string, args?: string) => Promise<void>
  submitPrompt: (text: string) => Promise<void>
  defer: (work: () => void) => void
  toast: (text: string) => void
  openPane: () => void
  startFollowUp: (issue: number) => Promise<Result<string>>
  /** Runs a read-modify-write of the records under the store lock; the work must not refresh the pane, whose GitHub sync takes the lock too. */
  withLock: <T>(work: () => Promise<T>) => Promise<T>
}

const handoff: HandoffRuntime = { current: null, tokenThreshold: 150000 }

/**
 * Sets the context size from which a session counts as long, when the user's configuration gives a usable one.
 *
 * @param tokens - The configured threshold.
 */
export function setHandoffThreshold(tokens: unknown): void {
  if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) handoff.tokenThreshold = tokens
}

async function failHandoff(port: HandoffPort, reason: string): Promise<void> {
  handoff.current = null
  const session = await port.withLock(async () => {
    const saved = await port.readSession()
    await port.writeSession({ ...saved, handoff: { state: 'failed', reason } })
    return saved
  })
  await port.refresh()
  if (!session.flow) port.toast(`Handoff not completed — ${reason}. Nothing cleared.`)
}

/**
 * Marks a handoff the stored session still shows as running as failed when no run is in memory: a reload ended it.
 *
 * @param port - The engine and core calls.
 */
export async function recoverHandoff(port: HandoffPort): Promise<void> {
  if ((await port.readSession()).handoff?.state === 'running' && !handoff.current) await failHandoff(port, 'interrupted by a mod reload')
}

async function findDocument(port: HandoffPort, running: RunningHandoff, root: string | null): Promise<string | null> {
  if (running.documentPath) return running.documentPath
  const since = `@${Math.floor(running.startedAt / 1000)}`
  const found = await runCommand(port.processes, ['sh', '-c',
    'for d in "${TMPDIR:-/tmp}" /tmp; do find "$d" -maxdepth 6 -type f -name "*.md" -newermt "$1" 2>/dev/null; done | sort -u', 'sh', since])
  const documents = unwrapOr(found, null)?.stdout.split('\n').filter(file => file && !(root && file.startsWith(`${root}/`))) ?? []
  return documents.length === 1 ? documents[0]! : null
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
  const isFinished = !!session.flow && isUnitFinished(session, position)
  const pullRequest = position?.unit.pr?.number
  const next = !session.flow ? 'The next session continues this work.'
    : isFinished && session.issues.length === 1 ? `Next session: follow-up on #${session.issues[0]}${pullRequest ? ` (PR #${pullRequest})` : ''}.`
    : isFinished ? `Next session: follow-up on one of ${formatIssueReferences(session.issues, ', ')}.`
    : 'The next session continues this unit.'
  const args = [position ? `Flow: ${composeInstruction(position, session)}` : '', next].filter(Boolean).join(' ')
  // The end of the /handoff turn carries the handoff on from where it waits.
  const running: RunningHandoff = {
    startedAt: await port.now(), isFinished, documentPath: null, isArmed: false,
    end: reason => void finishHandoff(port, running, reason).catch(error => failHandoff(port, formatError(error))),
  }
  handoff.current = running
  await port.withLock(async () => port.writeSession({ ...(await port.readSession()), handoff: { state: 'running' } }))
  await port.refresh()
  // A hook the turn waits on cannot run a command: leave the caller first.
  port.defer(() => void port.runSlashCommand('handoff', args).catch(error => failHandoff(port, formatError(error))))
}

// Carries a handoff on once its /handoff turn ended: checks the document, clears, and starts the new session from it.
async function finishHandoff(port: HandoffPort, running: RunningHandoff, reason: string): Promise<void> {
  if (handoff.current !== running) return
  if (reason !== 'answer') return failHandoff(port, reason === 'aborted' ? 'turn interrupted' : `turn ended with ${reason}`)
  const path = await findDocument(port, running, await port.readRoot())
  if (!path) return failHandoff(port, 'no single handoff document found')
  const stat = await statFile(port.files, port.clock, path)
  if (!stat.isOk || stat.value.size === 0) return failHandoff(port, 'handoff document is empty')
  if (stat.value.mtimeMs < running.startedAt) return failHandoff(port, 'handoff document was not written by this run')

  const previous = await port.withLock(async () => {
    const saved = await port.readSession()
    await port.writeSession({ ...saved, handoff: undefined })
    return saved
  })
  const previousUnitKey = await port.findUnitKey(previous)
  await port.writeStored(`handoff:${await port.readRepoSlug()}`, { path, sid: await port.readSessionId(), at: running.startedAt })
  handoff.current = null
  await port.runSlashCommand('clear')
  try {
    const text = await carryOver(port, running, previous, previousUnitKey, path)
    await port.refresh()
    await port.submitPrompt(text)
  } catch (error) {
    port.toast(`Cleared, but the new session could not be set up (${formatError(error)}).`)
  }
}

// Sets up the new session from the old one and words the prompt that starts it.
async function carryOver(port: HandoffPort, running: RunningHandoff, previous: Session, previousUnitKey: string, path: string): Promise<string> {
  const resume = `Continue from the handoff document at ${path}. Read it first, then follow its suggested skills.`
  if (running.isFinished && previous.issues.length === 1) {
    const issue = previous.issues[0]!
    const result = await port.startFollowUp(issue)
    if (result.isOk) {
      return `Continue from the handoff document at ${path}. This session is a follow-up on #${issue}; ask me what to change.`
    }
    port.toast(result.error)
    return resume
  }
  if (running.isFinished && previous.issues.length > 1) {
    return `Continue from the handoff document at ${path}. The previous unit closed ${formatIssueReferences(previous.issues, ', ')}: ask me which one this session follows up on, so I can run /flow follow-up #n.`
  }
  if (previous.flow) {
    const carried: Session = {
      ...createEmptySession(), flow: previous.flow, issues: previous.issues, info: previous.info,
      output: previous.output, gh: previous.gh, followUp: previous.followUp,
    }
    await port.withLock(async () => {
      await port.writeSession(carried)
      // Units without an issue are keyed by session id: move them to the new one.
      const unitKey = await port.findUnitKey(carried)
      if (unitKey !== previousUnitKey) await port.writeStored(unitKey, await port.readUnit(previousUnitKey))
    })
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
    await port.withLock(async () => port.writeSession({ ...(await port.readSession()), handoff: undefined }))
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
 * Records whether the session is long, and suggests a handoff the first time it becomes so. The caller holds the lock.
 *
 * @param port - The engine and core calls.
 */
export async function trackSessionLength(port: HandoffPort): Promise<void> {
  const session = await port.readSession()
  if (!session.flow) return
  const isLong = (await port.readContextTokens()) >= handoff.tokenThreshold
  if (isLong === session.isLong) return
  await port.writeSession({ ...session, isLong, isToasted: session.isToasted || isLong })
  await port.refresh(true)
  if (isLong && !session.isToasted) port.toast('Long session — continue in a new session from the Flow pane, or run /flow handoff.')
}

/**
 * Refuses a shell write during the /handoff turn: the document must come from the Write tool, which tells the handoff its path.
 *
 * @param tool - The tool's name.
 * @param writes - The files the Bash call writes, as the observation layer lists them; empty for any other tool.
 * @returns The deny verdict, or null when the call is not a shell write during a handoff.
 */
export function judgeHandoffCall(tool: string, writes: WriteTarget[]): Verdict | null {
  return handoff.current?.isArmed && tool === 'Bash' && writes.length
    ? deny('handoff', 'write the document with the Write tool')
    : null
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
