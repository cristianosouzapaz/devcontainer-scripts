/**
 * Tells a plain object from an array, null or a primitive.
 *
 * @param value - The value to test.
 * @returns Whether the value is a plain object.
 */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Accepts objects containing only allowed keys.
 * @param value - The object to inspect.
 * @param keys - The allowed keys.
 * @returns Whether every present key is allowed.
 */
export const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key))

/**
 * Rejects fields a config section does not define, so a typo fails instead of silently changing intent.
 * @param value - The object read.
 * @param allowed - The defined fields.
 * @param path - The section's JSON path, empty at the root.
 * @throws With the first unknown field's JSON path.
 */
export function rejectUnknownFields(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key))
  if (extra !== undefined) throw new Error(`${path ? `${path}.` : ''}${extra}: unknown field`)
}

/**
 * Identifies arrays containing only strings.
 * @param value - The value to inspect.
 * @returns Whether the value is a string array.
 */
export const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string')

/**
 * Identifies finite numeric values.
 * @param value - The value to inspect.
 * @returns Whether the value is a finite number.
 */
export const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Identifies strings containing at least one character.
 * @param value - The value to inspect.
 * @returns Whether the value is a non-empty string.
 */
export const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && !!value

/**
 * Identifies safe integer values.
 * @param value - The value to inspect.
 * @returns Whether the value is a safe integer.
 */
export const isSafeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value)

/**
 * Identifies a GitHub issue number.
 * @param value - The value to inspect.
 * @returns Whether the value is a positive safe integer.
 */
export const isIssueNumber = (value: unknown): value is number => isSafeInteger(value) && value > 0
