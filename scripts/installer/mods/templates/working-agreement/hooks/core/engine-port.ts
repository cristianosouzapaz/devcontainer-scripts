import type { SessionContextUsage, HookStream, PluginState, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import type { FlowView, RunView } from '../../types'
import type { FilePort } from '../lib/files'
import type { ProcessPort } from '../lib/process'
import type { SessionRecord } from '../domain/records'

/** The engine clock a timeout waits on; the signal ends the wait once the call has settled. */
interface ClockPort { sleep: (durationMs: number, signal: AbortSignal) => Promise<void> }

interface HerdrEnv { environment: string | undefined; paneId: string | undefined }

interface StreamingProcesses extends ProcessPort { spawn: (request: ProcessSpawnRequest) => HookStream<ProcessSpawnChunk, ProcessSpawnResult> }
/** A versioned authoritative session value. */
interface SessionSnapshot { value: SessionRecord | undefined; version: number }
/** The content currently drawn inside the persistent Flow pane. */
export type PaneView = PluginState['working-agreement']['paneView']

/** The engine calls the core and the handlers make, each a closure over `$` that the entry file builds: `$` cannot be passed across an import. */
export interface EnginePort {
  /** The engine event the port was built for, which the transition log names as a refresh's cause. */
  cause: string
  processes: StreamingProcesses
  files: FilePort
  clock: ClockPort
  readSessionState: () => Promise<SessionSnapshot>
  writeSessionState: (value: SessionRecord, version: number) => Promise<boolean>
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
  readView: () => Promise<FlowView | null>
  writeView: (view: FlowView | null) => Promise<void>
  /** The run the pane shows live, kept apart from the view so its once-a-second writes never rewrite the view. */
  readLiveRun: () => Promise<RunView | null>
  writeLiveRun: (run: RunView | null) => Promise<void>
  readPaneView: () => Promise<PaneView>
  writePaneView: (view: PaneView) => Promise<void>
  openPane: (closeOnEscape?: true) => Promise<void>
  runSlashCommand: (command: string, args?: string) => Promise<void>
  submitPrompt: (text: string) => Promise<void>
  /** Proposes a prompt box suggestion; resolves whether the engine showed it. */
  suggestPrompt: (text: string) => Promise<boolean>
  /** Registers `/flow` and the mod's tools, whose specs the entry file holds. */
  registerSurface: () => Promise<void>
}
