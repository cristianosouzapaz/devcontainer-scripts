import type { FilePort } from './files'
import { isRecord } from './guards'
import { fail, formatError, succeed } from './result'
import type { Result } from './result'

/**
 * Reads a string field, falling back to empty.
 *
 * @param value - The value to read.
 * @returns The value when it is a string, otherwise ''.
 */
export const toStringOrEmpty = (value: unknown): string => (typeof value === 'string' ? value : '')

/**
 * Reads a list of objects, dropping every entry that is not one.
 *
 * @param value - The value to read.
 * @returns The value's object entries, or none when it is not an array.
 */
export const filterRecords = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter(isRecord) : [])

/**
 * Parses JSON from a command's output or a file; neither is the mod's own data, so callers narrow it field by field.
 *
 * @param text - The raw text.
 * @returns The parsed value, or a failure when the text is not JSON.
 */
export function parseJson(text: string): Result<unknown> {
  try {
    return succeed(JSON.parse(text))
  } catch (error) {
    return fail(`not JSON: ${formatError(error)}`)
  }
}

/**
 * Reads external JSON, retaining absence and malformed content as an undefined value.
 * @param files - The engine's file reader.
 * @param path - The file to read.
 * @returns The decoded value, or undefined when reading or parsing fails.
 */
export async function readJson(files: FilePort, path: string): Promise<unknown> {
  // Absence is part of the readJson contract.
  try {
    const parsed = parseJson(await files.read(path))
    return parsed.isOk ? parsed.value : undefined
  } catch { return undefined }
}
