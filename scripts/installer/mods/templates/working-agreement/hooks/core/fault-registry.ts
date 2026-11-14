import { sessionMemory } from './session-memory'

/** The row a fault is shown on, on the pane and in `/flow status`. */
export type FaultRow = 'Mail' | 'Process' | 'Tools'

/** A fault this load holds: the row it is shown on, its words, and the cause its callers read. */
export interface FaultEntry { row: FaultRow; text: string; cause: string }

/**
 * Holds a fault of this load under its key until it resolves: a newer fault of the same key replaces it. Unlike a start notice, which
 * stays until a render of the Flow view showed it, a fault clears as soon as the operation it is about succeeds again, since it then no longer holds.
 * @param key - The fault, such as `process-write` or `publish:<file>`.
 * @param entry - Its row, words and cause.
 */
export function raiseFault(key: string, entry: FaultEntry): void {
  sessionMemory.faults.set(key, entry)
}

/**
 * Clears a fault once the operation it is about succeeded again.
 * @param key - The fault.
 */
export function clearFault(key: string): void {
  sessionMemory.faults.delete(key)
}

/**
 * Reads the cause of a fault this load holds.
 * @param key - The fault.
 * @returns Its cause, or null while none holds.
 */
export function readFault(key: string): string | null {
  return sessionMemory.faults.get(key)?.cause ?? null
}

/**
 * Lists the keys of the faults this load holds under a prefix.
 * @param prefix - The prefix, such as `publish:`.
 * @returns The keys, oldest first.
 */
export function listFaults(prefix: string): string[] {
  return [...sessionMemory.faults.keys()].filter(key => key.startsWith(prefix))
}

/**
 * Words the faults this load holds as the pane and `/flow status` show them, in the order of the prefixes given.
 * @param prefixes - The keys or key prefixes to show, in order.
 * @returns Each fault's row and words.
 */
export function describeFaultRows(prefixes: readonly string[]): { row: FaultRow; text: string }[] {
  return prefixes.flatMap(prefix => [...sessionMemory.faults].filter(([key]) => key.startsWith(prefix)).map(([, entry]) => ({ row: entry.row, text: entry.text })))
}
