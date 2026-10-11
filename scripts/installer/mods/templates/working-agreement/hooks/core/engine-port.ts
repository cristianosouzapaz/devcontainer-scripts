import type { SessionRepo } from 'claude-code'

import type { FlowView } from '../../types'
import type { FilePort } from '../lib/files'
import type { ProcessPort } from '../lib/process'
import type { ClockPort } from '../lib/result'
import type { StorePort } from '../lib/store'

/** The engine calls the core and the handlers make, each a closure over `$` that the entry file builds: `$` cannot be passed across an import. */
export interface EnginePort {
  processes: ProcessPort
  files: FilePort
  clock: ClockPort
  store: StorePort
  now: () => Promise<number>
  repeat: (delayMs: number, work: () => Promise<void>) => void
  defer: (work: () => void) => void
  readRepository: () => Promise<SessionRepo | null>
  readCwd: () => Promise<string>
  /** Reads $HOME, undefined when it is unset. */
  readHome: () => Promise<string | undefined>
  readSessionId: () => Promise<string>
  readContextTokens: () => Promise<number>
  readView: () => Promise<FlowView | null>
  writeView: (view: FlowView | null) => Promise<void>
  openPane: () => Promise<void>
  toast: (text: string) => void
  runSlashCommand: (command: string, args?: string) => Promise<void>
  submitPrompt: (text: string) => Promise<void>
  /** Registers `/flow` and `declare_flow`, whose specs the entry file holds so the mod's surface reads there. */
  registerSurface: () => Promise<void>
}
