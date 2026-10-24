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
