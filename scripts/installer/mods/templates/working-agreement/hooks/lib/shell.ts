/**
 * Single-quotes a word for a shell.
 * @param word - The word.
 * @returns The word as a shell reads it back.
 */
export function quoteWord(word: string): string {
  return `'${word.replace(/'/g, '\'\\\'\'')}'`
}

/**
 * Quotes a word for a shell unless it holds only safe characters.
 * @param word - The word.
 * @returns The word as a shell reads it back.
 */
export function quoteIfNeeded(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : quoteWord(word)
}
