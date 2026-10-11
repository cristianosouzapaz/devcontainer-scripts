import { startFollowUp } from '../features/follow-up'
import type { FollowUpPort } from '../features/follow-up'
import type { HandoffPort } from '../features/handoff'
import type { OverridePort } from '../features/override'
import type { EnginePort } from './engine-port'
import { readGithubStatus } from './github-sync'
import { refreshView } from './pane-view'
import { locatePosition } from './position'
import { findIssueKey, findUnitKey, readRepositorySlug, readSession, readUnit, updateUnits, writeSession, writeStored } from './record-store'
import { readGit, readHeadCommit, readRepositoryRoot } from './repository'
import { withRecordLock } from './session-memory'

/** The engine and core calls every feature module makes. */
type FeaturePort = HandoffPort & OverridePort & FollowUpPort

/**
 * Builds the calls the feature modules reach the engine and the core through; handoff gets follow-up as one of them,
 * so no feature imports another.
 *
 * @param port - The engine calls.
 * @returns The feature calls.
 */
export function createFeaturePort(port: EnginePort): FeaturePort {
  const featurePort: FeaturePort = {
    processes: port.processes,
    files: port.files,
    clock: port.clock,
    readSession: () => readSession(port),
    writeSession: session => writeSession(port, session),
    readUnit: key => readUnit(port, key),
    writeStored: (key, value) => writeStored(port, key, value),
    findUnitKey: session => findUnitKey(port, session),
    findIssueKey: issue => findIssueKey(port, issue),
    updateUnits: (session, change) => updateUnits(port, session, change),
    locate: session => locatePosition(port, session),
    refresh: (isQuiet?: boolean) => refreshView(port, isQuiet),
    readGit: () => readGit(port),
    readHead: () => readHeadCommit(port),
    readRoot: () => readRepositoryRoot(port),
    readCwd: () => port.readCwd(),
    readRepoSlug: () => readRepositorySlug(port),
    readSessionId: () => port.readSessionId(),
    readContextTokens: () => port.readContextTokens(),
    readGithubStatus: isForced => readGithubStatus(port, isForced),
    now: () => port.now(),
    runSlashCommand: (command, args) => port.runSlashCommand(command, args),
    submitPrompt: text => port.submitPrompt(text),
    defer: work => { port.defer(work) },
    toast: text => { port.toast(text) },
    openPane: () => { void port.openPane() },
    startFollowUp: issue => startFollowUp(featurePort, issue),
    withLock: work => withRecordLock(work),
  }
  return featurePort
}
