/** States how files change while a step holds writes back: a hook sees a write by another program only once it is made. */
export const writePolicy = 'Change files only through Edit or Write, and never work around a blocked write with another tool (a script, an interpreter, a generator).'

/**
 * Marks a text as the working agreement's, for text the agent reads (prompt context, denies, tool results).
 *
 * @param text - The sentence the agent reads.
 * @returns The text, prefixed with `[working-agreement]`.
 */
export const markForAgent = (text: string): string => `[working-agreement] ${text}`
