import type { FlowStep } from '../../types'
import type { Identity, Session } from '../domain/records'
import type { UnitSlice } from '../domain/step-states'
import { removeFile } from '../lib/files'
import { hasExitedZero, runProcess } from '../lib/process'
import { createQueue } from '../lib/queue'
import { formatError } from '../lib/result'
import { bestEffort } from './best-effort'
import type { EnginePort } from './engine-port'
import { sameIdentity, unitLogPath } from './record-store'
import { holdError, sessionMemory } from './session-memory'

/** The step states this module last logged, for one chat's unit lifetime. */
interface StepBaseline { key: string; states: Record<string, FlowStep['state']> }

/** The baseline the next painted view is compared against, null before the first. */
interface StepMemory { baseline: StepBaseline | null }

/** A logged event's own fields; the line adds when, which chat and which unit. */
type Detail = Record<string, unknown>

// A longer free-text field is cut so a line keeps its detail under the byte cap.
const maxDetailLength = 500
// PIPE_BUF on Linux: a write this small reaches tee through its stdin pipe whole, and tee appends it with one
// O_APPEND write, which no other session's append can split.
const maxWriteBytes = 4096
const encoder = new TextEncoder()
const queueLog = createQueue()
const steps: StepMemory = { baseline: null }

/**
 * Appends one event to the session unit's log in the background; a session with no unit logs nothing.
 *
 * Nothing reads the log back, and a failure never reaches the caller: it is held for `/flow status` and the debug log.
 * @param port - The engine calls.
 * @param session - The session the event belongs to, as written when the event is backed by a record write.
 * @param event - The event name.
 * @param detail - The event's own fields.
 */
export function logEvent(port: EnginePort, session: Session, event: string, detail: Detail = {}): void {
  const unit = session.unit
  if (!unit) return
  const fields = Object.fromEntries(Object.entries(detail).map(([key, value]) =>
    [key, typeof value === 'string' && value.length > maxDetailLength ? `${value.slice(0, maxDetailLength)}…` : value]))
  enqueue(port, async () => {
    const bounded = { at: await port.now(), session: session.sessionId, generation: readGeneration(session) }
    const line = `${JSON.stringify({ ...bounded, branch: unit.branch, issues: unit.issues, event, ...fields })}\n`
    // A line past the cap keeps only its bounded fields rather than risk a split write; the file still names the unit.
    await append(port, await unitLogPath(port, unit), isWhole(line) ? line : `${JSON.stringify({ ...bounded, event, isTruncated: true })}\n`)
  })
}

/**
 * Logs the painted steps whose state changed since the last painted view of the same chat and unit lifetime,
 * or every step as a snapshot when there is no such view, with the fact a current or done step shows and the slice base and tree
 * the steps were judged on.
 * @param port - The engine calls.
 * @param session - The painted session.
 * @param painted - The painted steps.
 * @param slice - The slice the steps were judged on, null when unreadable.
 * @param causes - The signals the refresh answered.
 */
export function logSteps(port: EnginePort, session: Session, painted: FlowStep[], slice: UnitSlice | null, causes: string[]): void {
  const states = Object.fromEntries(painted.map(step => [step.id, step.state]))
  const key = JSON.stringify([session.sessionId, session.unit, readGeneration(session)])
  const previous = steps.baseline
  steps.baseline = { key, states }
  // A null would read as a judged empty value, so a slice part the judgement lacked is left out.
  const judged = { ...(slice?.base ? { base: slice.base } : {}), ...(slice?.tree ? { tree: slice.tree } : {}) }
  if (previous?.key !== key) return logEvent(port, session, 'snapshot', { steps: states, ...judged, cause: causes })
  for (const step of painted) {
    const from = previous.states[step.id]
    // A skipped step's detail is its reason, which the skip line already holds.
    const fact = step.detail && (step.state === 'current' || step.state === 'done') ? { fact: step.detail } : {}
    if (from !== step.state) logEvent(port, session, 'step', { step: step.id, from: from ?? null, to: step.state, ...fact, ...judged, cause: causes })
  }
}

/**
 * Moves a re-keyed unit's log under its new identity, after the lines already queued for it.
 * @param port - The engine calls.
 * @param from - The identity the unit had.
 * @param to - The identity the unit now has.
 */
export function carryLog(port: EnginePort, from: Identity, to: Identity): void {
  enqueue(port, async () => {
    const source = await unitLogPath(port, from)
    // The unit may have no log yet.
    const text = await port.files.read(source).catch(() => '')
    const target = await unitLogPath(port, to)
    for (const chunk of chunkLines(text)) await append(port, target, chunk)
    await removeFile(port.processes, source)
  })
}

/**
 * Tells whether text fits in one write that concurrent appends cannot split.
 * @param text - The text to append.
 * @returns Whether it is under the byte cap.
 */
function isWhole(text: string): boolean {
  return encoder.encode(text).length < maxWriteBytes
}

/**
 * Groups whole lines into appends that each fit the byte cap; a line past the cap goes alone.
 * @param text - Complete lines.
 * @returns The appends, in order.
 */
function chunkLines(text: string): string[] {
  return text.split(/(?<=\n)/).filter(Boolean).reduce<string[]>((chunks, line) => {
    const last = chunks.at(-1)
    return last !== undefined && isWhole(last + line) ? [...chunks.slice(0, -1), last + line] : [...chunks, line]
  }, [])
}

/**
 * Reads the declared lifetime of the session's unit.
 * @param session - The session.
 * @returns The generation, if the session holds the unit's entry.
 */
function readGeneration(session: Session): string | undefined {
  return session.units.find(entry => session.unit && sameIdentity(entry.identity, session.unit))?.generation
}

/**
 * Runs log work in order behind earlier lines, holding a failure instead of passing it on.
 * @param port - The engine calls.
 * @param work - The write.
 */
function enqueue(port: EnginePort, work: () => Promise<void>): void {
  void queueLog(() => bestEffort(port, 'log append', async () => {
    try { await work() } catch (error) {
      sessionMemory.logError = holdError(sessionMemory.logError, formatError(error), await port.now())
      throw error
    }
    sessionMemory.logError = null
  }, undefined))
}

/**
 * Appends text to a file through the process boundary, creating its directory on a first failure.
 * @param port - The engine calls.
 * @param path - The log file.
 * @param text - Whole lines.
 */
async function append(port: EnginePort, path: string, text: string): Promise<void> {
  const write = async () => hasExitedZero(await runProcess(port.processes, ['tee', '-a', '--', path], undefined, { stdin: text }))
  if ((await write()).isOk) return
  // The log bucket does not exist before a clone's first line.
  await runProcess(port.processes, ['mkdir', '-p', '--', path.slice(0, path.lastIndexOf('/'))])
  const retried = await write()
  if (!retried.isOk) throw new Error(retried.error)
}
