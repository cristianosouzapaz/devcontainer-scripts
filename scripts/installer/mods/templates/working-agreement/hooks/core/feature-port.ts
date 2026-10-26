import type { ApprovePort } from '../features/approve'
import type { FollowUpPort } from '../features/follow-up'
import type { HandoffPort } from '../features/handoff'
import type { EnginePort } from './engine-port'
import { declareFlow } from './declaration'
import { logEvent } from './flow-log'
import { createReadPort } from './read-port'
import { refreshView } from './pane-view'
import { locatePosition } from './position'
import { readSession, readUnit, updateSession, updateUnits } from './record-store'
import { readRepositoryRoot } from './repository'
import { withRecordLock } from './session-memory'
import { readIssueComments } from '../lib/github'

/** The engine and core calls every feature module makes. */
type FeaturePort = HandoffPort & ApprovePort & FollowUpPort

/**
 * Builds the engine and core calls used by feature modules.
 *
 * @param port - The engine calls.
 * @returns The feature calls.
 */
export function createFeaturePort(port: EnginePort): FeaturePort {
  return {
    readSession: () => readSession(port),
    updateSession: async change => (await updateSession(port, change))?.session ?? null,
    readComments: issue => readIssueComments(port.processes, issue),
    readUnit: key => readUnit(port, key),
    updateUnits: (session, change) => updateUnits(port, session, change),
    locate: session => locatePosition(createReadPort(port), session),
    refresh: (isQuiet?: boolean) => refreshView(port, isQuiet),
    readRoot: () => readRepositoryRoot(port),
    readCwd: () => port.readCwd(),
    readSessionId: () => port.readSessionId(),
    readContext: () => port.readContext(),
    declareFollowUp: issue => withRecordLock(() => declareFlow(port, 'follow-up', [issue], 'human')),
    runSlashCommand: (command, args) => port.runSlashCommand(command, args),
    submitPrompt: text => port.submitPrompt(text),
    defer: work => { port.defer(work) },
    openPane: () => { void port.openPane() },
    withLock: work => withRecordLock(work),
    log: (session, event, detail) => { logEvent(port, session, event, detail) },
  }
}
