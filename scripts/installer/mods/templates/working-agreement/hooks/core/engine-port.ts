import type { SessionContextUsage, HookStream, PluginState, ProcessSpawnChunk, ProcessSpawnRequest, ProcessSpawnResult } from 'claude-code'
import type { FlowView } from '../../types'
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
  processes: StreamingProcesses
  files: FilePort
  clock: ClockPort
  clearLegacyStore: () => Promise<void>
  readSessionState: () => Promise<SessionSnapshot>
  writeSessionState: (value: SessionRecord, version: number) => Promise<boolean>
  /** Writes only to the engine debug log. */
  logDebug: (text: string) => void
  now: () => Promise<number>
  repeat: (delayMs: number, work: () => Promise<void>) => void
  defer: (work: () => void) => void
  readHerdrEnv: () => Promise<HerdrEnv>
  readCwd: () => Promise<string>
  readPluginRoot: () => Promise<string>
  readSessionId: () => Promise<string>
  readContext: () => Promise<SessionContextUsage>
  readView: () => Promise<FlowView | null>
  writeView: (view: FlowView | null) => Promise<void>
  readPaneView: () => Promise<PaneView>
  writePaneView: (view: PaneView) => Promise<void>
  openPane: (closeOnEscape?: true) => Promise<void>
  runSlashCommand: (command: string, args?: string) => Promise<void>
  submitPrompt: (text: string) => Promise<void>
  /** Proposes a prompt box suggestion; resolves whether the engine showed it. */
  suggestPrompt: (text: string) => Promise<boolean>
  /** Registers `/flow` and the `declare_flow`, `verify`, and `run` tools, whose specs the entry file holds. */
  registerSurface: () => Promise<void>
}
