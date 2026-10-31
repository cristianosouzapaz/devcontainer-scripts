import type { ProcessHost } from '../../types'

import { hasOnlyKeys, isNonEmptyString, isRecord, isSafeInteger } from '../lib/guards'

/** Whether a session still runs: `unknown` where its process cannot be judged, which counts as gone. */
export type SessionLiveness = 'live' | 'gone' | 'unknown'

/**
 * Validates a session's process identity with exactly its keys.
 * @param value - The decoded JSON.
 * @returns The identity, or null.
 */
export function parseHost(value: unknown): ProcessHost | null {
  return isRecord(value) && hasOnlyKeys(value, ['pidns', 'pid', 'pidStart', 'bootId']) && isNonEmptyString(value.pidns) && isSafeInteger(value.pid) && value.pid > 0
    && isNonEmptyString(value.pidStart) && isNonEmptyString(value.bootId) ? { pidns: value.pidns, pid: value.pid, pidStart: value.pidStart, bootId: value.bootId } : null
}
