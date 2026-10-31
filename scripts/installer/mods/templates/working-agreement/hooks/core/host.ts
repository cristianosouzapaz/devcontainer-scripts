import { executeProcess } from '../lib/process'
import type { ProcessHost } from '../../types'
import type { SessionLiveness } from '../domain/process-host'
import type { EnginePort } from './engine-port'

/** Holds what tells a live process from a dead one or a reused pid: each field is null where the host does not expose it. */
export interface Host { pidns: string | null; pid: number | null; pidStart: string | null; bootId: string | null }

/**
 * Reads this process's pid namespace, pid, start time and boot id; a host without /proc yields nulls.
 * @param port - The engine calls.
 * @returns The host identity.
 */
export async function readHost(port: EnginePort): Promise<Host> {
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
export function readStartTime(stat: string): string | null {
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
 * @returns `live` for a running recorded process, `gone` once it ended or its pid was reused, and `unknown` without a recorded
 * process or outside its pid namespace and boot.
 */
async function judgeHost(port: EnginePort, recorded: ProcessHost | undefined): Promise<SessionLiveness> {
  const host = await readHost(port)
  if (!recorded || recorded.pidns !== host.pidns || recorded.bootId !== host.bootId) return 'unknown'
  return readStartTime(await port.files.read(`/proc/${recorded.pid}/stat`).catch(() => '')) === recorded.pidStart ? 'live' : 'gone'
}

/**
 * Judges whether a session still runs: this session always does, another one by the process it recorded.
 * @param port - The engine calls.
 * @param sessionId - The session.
 * @param recorded - Reads the process the session's record names, if any; never read for this session.
 * @returns `live` for this session or a running recorded process, else as judgeHost judges it.
 */
export async function judgeSession(port: EnginePort, sessionId: string, recorded: () => Promise<ProcessHost | undefined>): Promise<SessionLiveness> {
  return sessionId === await port.readSessionId() ? 'live' : judgeHost(port, await recorded())
}
