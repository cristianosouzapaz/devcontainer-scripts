import type { RenderSurface, SessionContextUsage, HookStream, PluginState, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import type { FlowView, MergeCopy, ProcessState, RunView } from '../../types'
import type { FilePort } from '../lib/files'
import type { ProcessPort } from '../lib/process'
import type { SessionRecord } from '../domain/records'

/** The engine clock a timeout waits on; the signal ends the wait once the call has settled. */
interface ClockPort { sleep: (durationMs: number, signal: AbortSignal) => Promise<void> }

interface HerdrEnv { environment: string | undefined; paneId: string | undefined; socketPath: string | undefined }

interface StreamingProcesses extends ProcessPort { spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult> }
/** A versioned authoritative session value. */
interface SessionSnapshot { value: SessionRecord | undefined; version: number }
/** The content currently drawn inside the persistent Flow pane. */
export type PaneView = PluginState['working-agreement']['paneView']

/** The engine calls the core and the handlers make, each a closure over `$` that the entry file builds: `$` cannot be passed across an import. */
export interface EnginePort {
  /** The engine event the port was built for, which the transition log names as a refresh's cause. */
  cause: string
  /** Set on an observation's port when it answers from cached GitHub facts alone: a fact the cache lacks is never read. */
  isGithubCacheOnly?: true
  /** Set on a long tool dispatch's port: how much of the hook's budget is left, in ms, after what the guard above it used. */
  budgetLeft?: () => number
  processes: StreamingProcesses
  files: FilePort
  clock: ClockPort
  readSessionState: () => Promise<SessionSnapshot>
  writeSessionState: (value: SessionRecord, version: number) => Promise<boolean>
  /** The host-held process state as stored, undefined when the host holds none. */
  readProcessState: () => Promise<unknown>
  /** Writes the host-held process state from the stored value, retrying the compare-and-set on a miss; resolves to the value written. */
  updateProcessState: (change: (current: unknown) => ProcessState) => Promise<ProcessState>
  /** Writes only to the engine debug log. */
  logDebug: (text: string) => void
  now: () => Promise<number>
  repeat: (delayMs: number, work: () => Promise<void>) => void
  defer: (work: () => void) => void
  readHerdrEnv: () => Promise<HerdrEnv>
  readCwd: () => Promise<string>
  /** Claude Code's configuration directory, which holds every session transcript; undefined when the environment names none. */
  readClaudeDir: () => Promise<string | undefined>
  readPluginRoot: () => Promise<string>
  readSessionId: () => Promise<string>
  readContext: () => Promise<SessionContextUsage>
  /** When the session began, in clock milliseconds: its first launch, kept across a reload and a resume, restarted by `/clear`. */
  readSessionStart: () => Promise<number>
  /** The model the engine's `/config` Model row holds, as `--model` takes it; null while the row reads as the default or is absent. */
  readModel: () => Promise<string | null>
  /** Whether the user's human-only `/flow` commands may arrive through Remote Control, read live; null when the read fails. */
  readAllowRemoteCommands: () => Promise<boolean | null>
  readView: () => Promise<FlowView | null>
  /** Publishes a view as the load of this number, unless a load of a higher number published one; resolves whether it was published. */
  writeView: (view: FlowView | null, seq: number) => Promise<boolean>
  /** Changes the view published now, inside the write that replaces it, so a change made after an await never brings back an older view. */
  patchView: (change: (view: FlowView) => FlowView) => Promise<void>
  /** Takes the next load number of this session, rising across the loads of its process, as a reload starts each. */
  claimLoadSeq: () => Promise<number>
  /** The run the pane shows live, kept apart from the view so its once-a-second writes never rewrite the view. */
  readLiveRun: () => Promise<RunView | null>
  writeLiveRun: (run: RunView | null) => Promise<void>
  readPaneView: () => Promise<PaneView>
  writePaneView: (view: PaneView) => Promise<void>
  openPane: (closeOnEscape?: true) => Promise<void>
  /** Puts text on the clipboard of the surface a press came from. */
  copy: (text: string, surface: RenderSurface) => Promise<MergeCopy>
  runSlashCommand: (command: string, args?: string) => Promise<void>
  /** Submits a prompt; rejects with a DroppedPromptError only when the engine answered that it dropped it, so it never entered. */
  submitPrompt: (text: string) => Promise<void>
  /** Raises a native notification through the person's own channel; it never reaches the model. */
  notify: (text: string) => Promise<void>
  /** Shows a short line to the person for a few seconds; it never reaches the model. */
  toast: (text: string) => void
  /** Proposes a prompt box suggestion; resolves whether the engine showed it. */
  suggestPrompt: (text: string) => Promise<boolean>
  /** Registers `/flow` and the mod's tools, whose specs the entry file holds. */
  registerSurface: () => Promise<void>
}

/** The engine's answer that it dropped a submitted prompt, which therefore never entered: the one submit failure that proves no entry. */
export class DroppedPromptError extends Error {
  /**
   * Names why the engine dropped the prompt.
   * @param reason - The engine's reason.
   */
  constructor(reason: string) {
    super(`the engine dropped the prompt: ${reason}`)
  }
}
