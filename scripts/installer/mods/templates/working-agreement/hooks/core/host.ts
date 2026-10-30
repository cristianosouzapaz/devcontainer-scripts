import { executeProcess } from '../lib/process'
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
