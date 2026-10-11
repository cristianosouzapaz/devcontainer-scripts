import { fail, formatError, succeed } from './result'
import type { Result } from './result'

/** The engine's key-value store; it lives in the engine, with no I/O of the mod's to time out. */
export interface StorePort { get: (key: string) => Promise<unknown>; set: (key: string, value: unknown) => Promise<void> }

/**
 * Reads a stored record.
 *
 * @param store - The engine's store.
 * @param key - The record's key.
 * @returns The raw record, undefined when absent, or a failure when the store cannot be read.
 */
export async function readRecord(store: StorePort, key: string): Promise<Result<unknown>> {
  try {
    return succeed(await store.get(key))
  } catch (error) {
    return fail(`store read ${key}: ${formatError(error)}`)
  }
}

/**
 * Writes a record whole, replacing what was stored under its key.
 *
 * @param store - The engine's store.
 * @param key - The record's key.
 * @param value - The record.
 * @returns Success, or a failure when the store cannot be written.
 */
export async function writeRecord(store: StorePort, key: string, value: unknown): Promise<Result<undefined>> {
  try {
    await store.set(key, value)
    return succeed(undefined)
  } catch (error) {
    return fail(`store write ${key}: ${formatError(error)}`)
  }
}
