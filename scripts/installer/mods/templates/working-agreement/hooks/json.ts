/**
 * Parses JSON from a command's output; gh output is not the mod's own data, so callers narrow it field by field.
 *
 * @param text - The raw output.
 * @returns The parsed value, or null when the text is not JSON.
 */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Tells a plain object from an array, null or a primitive.
 *
 * @param v - The value to test.
 * @returns Whether the value is a plain object.
 */
export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Reads a string field, falling back to empty.
 *
 * @param v - The value to read.
 * @returns The value when it is a string, otherwise ''.
 */
export const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Reads a list of objects, dropping every entry that is not one.
 *
 * @param v - The value to read.
 * @returns The value's object entries, or none when it is not an array.
 */
export const asRecords = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : [])
