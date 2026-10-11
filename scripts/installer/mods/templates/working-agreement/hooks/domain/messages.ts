/**
 * Marks a text as the working agreement's, for text the agent reads (prompt context, denies, tool results).
 *
 * @param text - The sentence the agent reads.
 * @returns The text, prefixed with `[working-agreement]`.
 */
export const markForAgent = (text: string): string => `[working-agreement] ${text}`
