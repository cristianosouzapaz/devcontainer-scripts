import type { ApprovePort } from '../features/approve'
import type { FollowUpPort } from '../features/follow-up'
import type { HandoffPort } from '../features/handoff'
import type { EnginePort } from './engine-port'
import { bestEffort } from './best-effort'
import { declareFlow } from './declaration'
import { findLiveDelegation } from './delegation'
import { carryAudit } from './issue-audit'
import { logEvent } from './flow-log'
import { createReadPort } from './read-port'
import { refreshView } from './pane-view'
import { locatePosition } from './position'
import { rebindUnitSession } from './rebind'
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
    // why: a write that landed is the session's new state though its mirror lags, which the pane's Process row shows until the tick publishes it.
    updateSession: async change => {
      const written = await updateSession(port, change)
      if (written?.kind === 'unmirrored') port.logDebug(`working-agreement: the session record was written, but its mirror was not updated: ${written.error}`)
      return written?.session ?? null
    },
    readComments: issue => readIssueComments(port.processes, issue),
    readUnit: key => readUnit(port, key),
    updateUnits: (session, change) => updateUnits(port, session, change),
    locate: session => locatePosition(createReadPort(port), session),
    readIsDelegated: async session => !!await bestEffort(port, 'delegation read', () => findLiveDelegation(port, session.issues), null),
    refresh: (isQuiet?: boolean) => refreshView(port, { isQuiet }),
    readRoot: () => readRepositoryRoot(port),
    readCwd: () => port.readCwd(),
    readSessionId: () => port.readSessionId(),
    readContext: () => port.readContext(),
    readCarriedAudit: session => carryAudit(port, session),
    declareFollowUp: issue => withRecordLock(() => declareFlow(port, 'follow-up', [issue], 'human')),
    runSlashCommand: (command, args) => port.runSlashCommand(command, args),
    submitPrompt: text => port.submitPrompt(text),
    defer: work => { port.defer(work) },
    openPane: () => { void port.openPane() },
    withLock: work => withRecordLock(work),
    log: (session, event, detail) => { logEvent(port, session, event, detail) },
    rebind: async (issues, previous) => rebindUnitSession(port, issues, previous, await port.readSessionId()),
  }
}
