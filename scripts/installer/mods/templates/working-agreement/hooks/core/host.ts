import { executeProcess } from '../lib/process'
import type { ProcessHost } from '../../types'
import type { SessionLiveness } from '../domain/process-host'
import type { EnginePort } from './engine-port'

/** Holds what tells a live process from a dead one or a reused pid: each field is null where the host does not expose it. */
interface Host { pidns: string | null; pid: number | null; pidStart: string | null; bootId: string | null }

/** A session judged running or ended. */
interface KnownLiveness { liveness: 'live' | 'gone' }

/** A session whose state could not be judged, with why. */
interface UnknownLiveness { liveness: 'unknown'; why: string }

/** A session's liveness, with why it is unknown when it is. */
export type LivenessJudgement = KnownLiveness | UnknownLiveness

/**
 * Reads this process's pid namespace, pid, start time and boot id; a host without /proc yields nulls.
 * @param port - The engine calls.
 * @returns The host identity.
 */
async function readHost(port: EnginePort): Promise<Host> {
  const stat = await port.files.read('/proc/self/stat').catch(() => '')
  const ns = await executeProcess(port.processes, ['readlink', '/proc/self/ns/pid']).catch(() => null)
  const boot = await port.files.read('/proc/sys/kernel/random/boot_id').catch(() => '')
  return { pidns: ns?.exitCode === 0 && ns.stdout.trim() ? ns.stdout.trim() : null, pid: Number(stat.split(' ')[0]) || null,
    pidStart: readStartTime(stat), bootId: boot.trim() || null }
}

/**
 * Reads a process's start time from its /proc stat line, whose second field may hold spaces inside parentheses.
 * @param stat - The stat line, empty when the process is gone.
 * @returns The start time in clock ticks, or null.
 */
function readStartTime(stat: string): string | null {
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || null
}

/**
 * Reads this process's full identity, the one a record names so another session can judge whether it still runs.
 * @param port - The engine calls.
 * @returns The identity, or null where the host does not expose all of it.
 */
export async function stampHost(port: EnginePort): Promise<ProcessHost | null> {
  const { pidns, pid, pidStart, bootId } = await readHost(port)
  return pidns && pid && pidStart && bootId ? { pidns, pid, pidStart, bootId } : null
}

/**
 * Judges whether a recorded process still runs.
 * @param port - The engine calls.
 * @param recorded - The process a record names, if any.
 * @returns `live` for a running recorded process, `gone` once its stat file is absent or its pid was reused, and `unknown`, with why,
 * without a recorded process, outside its pid namespace and boot, or when its stat file is present but cannot be read.
 */
async function judgeHost(port: EnginePort, recorded: ProcessHost | undefined): Promise<LivenessJudgement> {
  const host = await readHost(port)
  if (!recorded) return { liveness: 'unknown', why: 'no process is recorded for it' }
  if (recorded.pidns !== host.pidns || recorded.bootId !== host.bootId) {
    return { liveness: 'unknown', why: 'its recorded process cannot be matched to this session\'s pid namespace and boot' }
  }
  const path = `/proc/${recorded.pid}/stat`
  const stat = await port.files.read(path).then(text => text, () => null)
  if (stat === null) return await isAbsent(port, path) ? { liveness: 'gone' } : { liveness: 'unknown', why: `${path} cannot be read and is not proven absent` }
  return { liveness: readStartTime(stat) === recorded.pidStart ? 'live' : 'gone' }
}

/**
 * Tells whether a file is absent, after its read failed.
 * @param port - The engine calls.
 * @param path - The file.
 * @returns True only when an exists says no and a stat finds nothing; a failed exists leaves it present.
 */
async function isAbsent(port: EnginePort, path: string): Promise<boolean> {
  // why: the engine's rejection carries no documented missing-path code, so only an exists that says no and a stat that finds nothing confirm the exit.
  const isPresent = await port.files.exists(path).then(exists => exists || port.files.stat(path).then(() => true, () => false), () => true)
  return !isPresent
}

/**
 * Judges whether a session still runs: this session always does, another one by the process it recorded.
 * @param port - The engine calls.
 * @param sessionId - The session.
 * @param recorded - Reads the process the session's record names, if any; never read for this session.
 * @returns `live` for this session or a running recorded process, else as judgeHost judges it.
 */
export async function judgeSession(port: EnginePort, sessionId: string, recorded: () => Promise<ProcessHost | undefined>): Promise<SessionLiveness> {
  return (await explainSession(port, sessionId, recorded)).liveness
}

/**
 * Judges whether a session still runs, as judgeSession does, keeping why the judgement is unknown when it is.
 * @param port - The engine calls.
 * @param sessionId - The session.
 * @param recorded - Reads the process the session's record names, if any; never read for this session.
 * @returns The judgement, with why when it is unknown.
 */
export async function explainSession(port: EnginePort, sessionId: string, recorded: () => Promise<ProcessHost | undefined>): Promise<LivenessJudgement> {
  return sessionId === await port.readSessionId() ? { liveness: 'live' } : judgeHost(port, await recorded())
}
