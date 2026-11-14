import type { HookFailure } from 'claude-code'
import type { EnginePort } from './engine-port'
import type { RunRequest } from './run-command'
import type { RecordOutcome, ToolRunResult } from './tool-run'
import { abortCall, callKey, describeMirrorFailure, findRecordedRun } from './tool-run'
import { describeUnfinished } from './run-view'
import { describeHookError, markForAgent } from '../domain/messages'
import { formatErrorLine } from '../lib/result'
import { moduleState } from '../lib/module-state'

/** The command tools, by display name. */
export type CommandTool = 'Run' | 'Verify'

/** Names a call: its key from callKey, and whether that key is the engine's tool use id rather than the tool-name fallback. */
export interface CallRef { key: string; isOwnerKnown: boolean }

/** What a call's dispatch tells its ledger entry, each as it observes it. */
export interface CallFacts {
  /** The call asked for a Verify-queue turn. */
  queued: () => void
  /** A command of the call is starting: the listeners it runs with record its start, an unconfirmed start and a failed group kill. */
  command: (log: string) => Pick<RunRequest, 'onStarted' | 'onStartUnconfirmed' | 'onKillFailed'>
  /** The command the call asked to start has ended, after its spawn or with none, as a request already stopped has. */
  commandEnded: (isSpawned: boolean) => void
  /** The call's record write started under this run id. */
  recording: (runId: string) => void
  /** The call's record write resolved. */
  recorded: (outcome: RecordOutcome) => void
}

/** How a command tool's hook failed: past its budget, dropped by the engine after its hooks overran, or thrown. */
export interface CallFailure { kind: 'timeout' | 'dropped' | 'throw'; cause: string }

/** What a call's record write is known to have done: not started, started and not resolved, or resolved. */
type RecordFact = { kind: 'none' } | { kind: 'pending'; runId: string } | { kind: 'resolved'; outcome: RecordOutcome }
/** How a call's dispatch settled: with its own answer, or by a throw. */
type Settled = { kind: 'answer'; text: string } | { kind: 'thrown'; error: string }
/** Where a call's command stands: none started yet, starting, running once its wrapper said so, or ended. */
type CommandStage = 'none' | 'starting' | 'running' | 'ended'

/** A stop requested of a call: when, once the clock read came back, and when a retry first saw it withdrawing without that time. */
interface StopFact { at?: number; firstSeen?: number }

/** A command-tool call's ledger entry: each fact is set only once the dispatch observed it. */
interface CallEntry {
  tool: CommandTool
  sid: string
  call: CallRef
  task: Promise<unknown>
  startedAt?: number
  isQueued: boolean
  command: CommandStage
  /** The log of a command whose wrapper said it started, cited only from then on. */
  spawnedLog?: string
  startUnconfirmed?: string
  record: RecordFact
  stop?: StopFact
  killError?: string
  settled?: Settled
  /** Whether a timeout or drop answer already answered the call while it was in flight, so its own answer reaches no one. */
  isAnswered: boolean
}

/** How long a stopped call may withdraw before its retry is told that whether any of it still runs is unknown. */
export const withdrawBoundMs = 30_000
/** Why a call the engine dropped got no answer from its own hook. */
const dropCause = "the engine dropped this call after the mod's hooks ran past their time budget"

/** The command-tool calls, by session and call key, from their start until their answer is delivered or the session's next call: module memory, lost on a reload. */
const ledger = moduleState(() => ({ calls: new Map<string, CallEntry>() }))

/**
 * Names a call for the ledger and for its stop handle.
 * @param event - The call.
 * @returns Its key, the tool use id or the tool's name when the engine gave none, and whether the key names this call alone.
 */
export function callRef(event: { tool: string; tool_use_id?: string }): CallRef {
  return { key: callKey(event), isOwnerKnown: Boolean(event.tool_use_id) }
}

/**
 * Names a call's ledger entry.
 * @param sid - The calling session.
 * @param key - The call's key.
 * @returns The entry's key.
 */
const entryKey = (sid: string, key: string): string => `${sid}\n${key}`

/**
 * Runs a command-tool call under its ledger entry, refusing a second call of the session while one is in flight, and turns a throw
 * into the answer its observed facts allow. A settled entry keeps its answer and never blocks: since no return proves the engine
 * took it, a later timeout or drop answer delivers it once, the session's next command-tool call prunes it, and one whose call a
 * drop already answered in flight ends as it settles; a session holds at most one.
 * @param port - The engine calls.
 * @param tool - The tool's display name.
 * @param call - The call.
 * @param work - The dispatch, given the facts it reports.
 * @param signal - The dispatch's cancellation signal.
 * @returns The call's answer.
 */
export async function withToolRun(port: EnginePort, tool: CommandTool, call: CallRef, work: (sid: string, facts: CallFacts) => Promise<string>,
  signal?: AbortSignal): Promise<ToolRunResult> {
  const sid = await port.readSessionId()
  for (const [key, entry] of ledger.calls) if (entry.sid === sid && entry.settled) ledger.calls.delete(key)
  const live = [...ledger.calls.values()].find(entry => entry.sid === sid)
  if (live) {
    const now = await port.now()
    if (live.stop && live.stop.at === undefined && live.stop.firstSeen === undefined) live.stop.firstSeen = now
    return { result: describeBusy(tool, live, now) }
  }
  const key = entryKey(sid, call.key)
  const entry: CallEntry = { tool, sid, call, task: Promise.resolve(), isQueued: false, command: 'none', record: { kind: 'none' }, isAnswered: false }
  ledger.calls.set(key, entry)
  // why: the clock reads are not awaited, since a dropped hook's port may answer them late or never.
  void port.now().then(now => { entry.startedAt = now }, () => undefined)
  const onAbort = (): void => {
    if (entry.stop) return
    const stop: StopFact = {}
    entry.stop = stop
    void port.now().then(now => { stop.at = now }, () => undefined)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()
  const facts: CallFacts = {
    queued: () => { entry.isQueued = true },
    command: log => {
      entry.command = 'starting'
      return {
        onStarted: () => { entry.command = 'running'; entry.spawnedLog = log },
        onStartUnconfirmed: detail => { entry.startUnconfirmed = detail },
        onKillFailed: error => { entry.killError = error },
      }
    },
    commandEnded: isSpawned => { entry.command = isSpawned ? 'ended' : 'none' },
    recording: runId => { entry.record = { kind: 'pending', runId } },
    recorded: outcome => { entry.record = { kind: 'resolved', outcome } },
  }
  try {
    const task = work(sid, facts).then((text): Settled => ({ kind: 'answer', text }), (error: unknown): Settled => ({ kind: 'thrown', error: formatErrorLine(error) }))
    entry.task = task
    const settled = await task
    // why: a write the throw left unresolved is read back by its run id, so the answer says what reached the session state.
    if (entry.record.kind === 'pending') entry.record = { kind: 'resolved', outcome: await readWriteBack(port, entry.record.runId) }
    entry.settled = settled
    for (const [other, held] of ledger.calls) {
      if (held.sid === sid && held.settled && (held !== entry || entry.isAnswered)) ledger.calls.delete(other)
    }
    return { result: describeSettled(entry, settled) }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Reads back, by its run id, what a record write the dispatch's throw left unresolved reached.
 * @param port - The engine calls.
 * @param runId - The run's id.
 * @returns Written, not written, or unknown when the session state cannot be read.
 */
async function readWriteBack(port: EnginePort, runId: string): Promise<RecordOutcome> {
  const isWritten = await findRecordedRun(port, runId)
  if (isWritten === null) return { kind: 'unknown', error: 'its write did not finish, and the session state could not be read back' }
  return isWritten ? { kind: 'written' } : { kind: 'failed', error: 'its write did not finish' }
}

/**
 * Answers a command tool's failed hook: its .catch delegates here in one line.
 * @param tool - The tool's name, without the mod's prefix.
 * @param readSid - Reads the calling session.
 * @param call - The call.
 * @param error - The hook's failure.
 * @returns The error result the agent reads.
 */
export async function answerCommandHook(tool: 'run' | 'verify', readSid: () => Promise<string>, call: CallRef, error: HookFailure): Promise<{ result: string; isError: true }> {
  const sid = await readSid().then(value => value, () => null)
  const failure: CallFailure = error.kind === 'timeout'
    ? { kind: 'timeout', cause: `its hook ran past its time budget${error.message ? ` (${error.message})` : ''}` } : { kind: 'throw', cause: describeHookError(error) }
  return { result: markForAgent(answerFailedCommandCall(tool, sid, call, failure)), isError: true }
}

/**
 * Words the answer to a command-tool call whose hook failed, from this call's ledger entry alone: a failure before the dispatch
 * started, a settled answer delivered after the drop, a call still in flight, whose stop it requests first, or an unknown outcome.
 * @param tool - The tool's name, without the mod's prefix.
 * @param sid - The calling session, or null when it could not be read.
 * @param call - The call.
 * @param failure - How the hook failed.
 * @returns The answer's text.
 */
export function answerFailedCommandCall(tool: 'run' | 'verify', sid: string | null, call: CallRef, failure: CallFailure): string {
  const display: CommandTool = tool === 'run' ? 'Run' : 'Verify'
  // why: every throw inside the dispatch is already turned into its answer, so a hook that threw failed before its dispatch started.
  if (failure.kind === 'throw') return `${display} could not run: ${failure.cause}; it failed before its dispatch started, so nothing of it ran.`
  if (!call.isOwnerKnown) return describeUnknown(display, 'the run in flight could not be matched to this call')
  if (sid === null) return describeUnknown(display, 'the session could not be read to match it')
  const key = entryKey(sid, call.key)
  const entry = ledger.calls.get(key)
  if (!entry) return describeUnknown(display, 'the mod holds no record of it')
  if (entry.settled) {
    ledger.calls.delete(key)
    return `${display}: ${failure.cause}; its dispatch had already finished, and answered:\n${describeSettled(entry, entry.settled)}`
  }
  const stage = describeStage(entry)
  abortCall(call.key)
  entry.isAnswered = true
  const record = entry.record.kind === 'pending' ? '; whether its record was written is unknown' : ''
  return `${display} stopped: ${failure.cause}, while ${stage}; stop requested, still withdrawing${record}; call ${tool} again once it has withdrawn.${describeKill(entry)}`
}

/**
 * Answers a mod tool's call the engine dropped after the mod's hooks ran past their time budget: a command tool from its ledger
 * entry, any other tool by stopping the dispatch the guard can stop, or by saying it may still complete.
 * @param tool - The tool's name, without the mod's prefix.
 * @param sid - The calling session.
 * @param call - The call.
 * @returns The answer's text.
 */
export function stopDroppedCall(tool: string, sid: string, call: CallRef): string {
  if (tool === 'run' || tool === 'verify') return answerFailedCommandCall(tool, sid, call, { kind: 'dropped', cause: dropCause })
  if (!abortCall(call.key)) return `${tool} may still be running: ${dropCause}, and the mod cannot stop it; wait, check its effect, and only then call it again.`
  return `${tool} stopped: ${dropCause}; the mod stopped it, and it may have done part of its work, so read the parent branch before anything else; call it again.`
}

/**
 * Waits for the command-tool dispatches in flight, an abandoned one included, to finish their cleanup, so an exiting session leaves no
 * run half closed; the wait stops at the bound.
 * @param port - The engine calls.
 * @param ms - How long the wait may last.
 * @param signal - Ends the wait early.
 */
export async function settleToolRuns(port: EnginePort, ms: number, signal: AbortSignal): Promise<void> {
  const pending = [...ledger.calls.values()].filter(entry => !entry.settled).map(entry => entry.task)
  if (!pending.length || ms <= 0) return
  // why: an aborted sleep only ends the wait sooner, so its rejection is dropped.
  await Promise.race([Promise.allSettled(pending), port.clock.sleep(ms, signal).catch(() => {})])
}

/**
 * Counts the ledger's entries, so a test can tell how many settled calls it keeps.
 * @returns How many calls the ledger holds.
 */
export function countLedgerEntries(): number {
  return ledger.calls.size
}

/**
 * Words a second call made while a call of the session is in flight, or while a stopped one withdraws, within its bound or past it.
 * @param tool - The second call's tool.
 * @param live - The session's call in flight.
 * @param now - The clock.
 * @returns The answer.
 */
function describeBusy(tool: CommandTool, live: CallEntry, now: number): string {
  const name = tool.toLowerCase()
  const liveName = live.tool.toLowerCase()
  if (!live.stop) {
    const started = live.startedAt === undefined ? 'whose start time was not read' : `started at ${new Date(live.startedAt).toISOString()}`
    return `${name} refused: this session's ${liveName} call ${started} is still in flight (${describeStage(live)}); its result goes to that call. Wait for it to answer, then call ${name} again; /flow status shows it.`
  }
  const from = live.stop.at ?? live.stop.firstSeen ?? now
  const ago = `${live.stop.at === undefined ? 'at least ' : ''}${Math.max(0, Math.round((now - from) / 1000))} s ago`
  if (!live.killError && now - from < withdrawBoundMs) return `the previous ${liveName} call was stopped ${ago} and is still withdrawing; call it again in a few seconds`
  const log = live.spawnedLog ? `, its log ${live.spawnedLog},` : ''
  return `the previous ${liveName} call was stopped ${ago} and has not finished withdrawing, so whether any of it still runs is unknown; check its run in /flow status (Run log)${log} before you call ${name} again.${describeKill(live)}`
}

/**
 * Names where a call in flight stands, from what its dispatch observed.
 * @param entry - The call.
 * @returns The stage, such as `running its command (log: <log>)`.
 */
function describeStage(entry: CallEntry): string {
  const log = entry.spawnedLog ? ` (log: ${entry.spawnedLog})` : ''
  if (entry.record.kind === 'pending') return 'recording its result'
  if (entry.record.kind === 'resolved') return `finishing, ${describeRecord(entry.record)}`
  if (entry.command === 'running') return `running its command${log}`
  if (entry.command === 'starting') return entry.startUnconfirmed ? `starting its command, whose start could not be confirmed: ${entry.startUnconfirmed}` : 'starting its command'
  if (entry.command === 'ended') return `checking its command's result${log}`
  return entry.isQueued ? 'waiting in the Verify queue or for CI' : 'preparing'
}

/**
 * Words a settled call's answer: its own, or, for a throw, what was observed of it, with a failed group kill named.
 * @param entry - The call.
 * @param settled - How it settled.
 * @returns The answer.
 */
function describeSettled(entry: CallEntry, settled: Settled): string {
  return `${settled.kind === 'answer' ? settled.text : describeThrown(entry, settled.error)}${describeKill(entry)}`
}

/**
 * Words a dispatch that threw: it could not run while nothing of it started or was recorded, it stopped after its command started
 * or its record write began, or its outcome is unknown when its command's start could not be confirmed.
 * @param entry - The call.
 * @param error - What it threw.
 * @returns The answer.
 */
function describeThrown(entry: CallEntry, error: string): string {
  const { tool } = entry
  if (entry.startUnconfirmed && !entry.spawnedLog) return describeUnknown(tool, `the command's start could not be confirmed (${entry.startUnconfirmed}), and then ${error}`)
  if (!entry.spawnedLog && entry.record.kind === 'none') {
    return `${tool} could not run: ${error}; nothing of it ran${entry.isQueued ? '; it left the Verify queue' : ''}; no record written.`
  }
  const after = entry.spawnedLog ? `after ${tool === 'Run' ? 'the command' : 'the commands'} started` : 'after it ran no command'
  return `${tool} stopped: its dispatch failed, ${after}; ${describeRecord(entry.record)}. ${describeUnfinished(error, entry.spawnedLog)}`
}

/**
 * Words what a call's record write left.
 * @param record - The write's fact.
 * @returns `recorded`, `no record written`, or that whether it was written is unknown.
 */
function describeRecord(record: RecordFact): string {
  if (record.kind === 'none') return 'no record written'
  if (record.kind === 'pending') return 'whether its record was written is unknown: its write had not finished'
  const { outcome } = record
  if (outcome.kind === 'written') return outcome.mirrorError ? describeMirrorFailure(outcome.mirrorError) : 'recorded'
  return outcome.kind === 'unknown' ? `whether its record was written is unknown: ${outcome.error}` : 'no record written'
}

/**
 * Names a failed group kill, after which whether the command still runs is unknown.
 * @param entry - The call.
 * @returns The note, on its own line, or nothing.
 */
function describeKill(entry: CallEntry): string {
  if (!entry.killError) return ''
  return `\nwhether its command still runs is unknown: ${entry.killError}; check its process group and ${entry.spawnedLog ? `its log ${entry.spawnedLog}` : 'the Run log'}.`
}

/**
 * Words a call whose outcome the mod cannot establish.
 * @param tool - The tool's display name.
 * @param why - Why it cannot.
 * @returns The answer.
 */
function describeUnknown(tool: CommandTool, why: string): string {
  return `${tool}: the outcome of this call is unknown: ${why}; check /flow status (Run log) before you call ${tool.toLowerCase()} again.`
}
