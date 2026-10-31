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
 * Reads a file's text, telling a missing file from a failed read.
 * @param files - The engine's file reader.
 * @param path - The file to read.
 * @returns The text, or undefined when the file is confirmed missing.
 * @throws When the read rejects and the file is not confirmed missing: a failed read is never absence.
 */
export async function readText(files: FilePort, path: string): Promise<string | undefined> {
  return files.read(path).catch(async (error: unknown) => {
    // why: The engine's read rejection carries no documented missing-file code, so only exists can confirm absence.
    if (await files.exists(path)) throw error
    return undefined
  })
}

/**
 * Reads external JSON strictly: a file that is not JSON is a failed read, never absence.
 *
 * Callers keep their meaning for absence and treat a throw under their own failure policy: this session's own records
 * (its seed mirror, declarations, Verify approvals) fail the read; the observed slice ends become a failed result; best-effort
 * and display-only reads (the stored end before its write, run sidecars, the manifest, dismissals) fall back to their
 * safe direction. Only readSessionMirrors, the non-strict scan of other sessions' mirrors, reads their text with readText
 * and skips one that is not JSON; the strict readers (readEntriesStrictly, readDeclarations) throw on it.
 * @param files - The engine's file reader.
 * @param path - The file to read.
 * @returns The decoded value, or undefined when the file is confirmed missing.
 * @throws When the read fails, or the text is not JSON.
 */
export async function readJson(files: FilePort, path: string): Promise<unknown> {
  const text = await readText(files, path)
  if (text === undefined) return undefined
  const parsed = parseJson(text)
  if (!parsed.isOk) throw new Error(`${path}: ${parsed.error}`)
  return parsed.value
}

/**
 * Reads external JSON strictly when the caller asks for it, else falls back on a failed read.
 * @param files - The engine's file reader.
 * @param path - The file to read.
 * @param strict - Whether a failed read throws.
 * @param fallback - What a failed read gives unless strict.
 * @returns The decoded value, undefined when the file is confirmed missing, or the fallback.
 * @throws When strict and the read fails or the text is not JSON.
 */
export async function readJsonUnlessStrict(files: FilePort, path: string, strict: boolean, fallback: unknown): Promise<unknown> {
  return readJson(files, path).catch((error: unknown) => { if (strict) throw error; return fallback })
}
