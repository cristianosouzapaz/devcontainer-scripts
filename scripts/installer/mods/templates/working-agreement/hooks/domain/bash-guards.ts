import { markForAgent } from './messages'

// why: An accident guard, not a sandbox: each word names a way a command moves or rewrites a ref other than the unit's own commit,
// or runs a command the raw text cannot show.
const deniedWords = new Set(['push', 'rebase', 'reset', 'update-ref', 'filter-branch', 'merge', 'eval'])
const deniedText = [/\bGIT_(DIR|WORK_TREE|CONFIG\w*)\b/, /--git-dir\b/, /--work-tree\b/, /-c\s*alias\./, /-c\s*core\.hooksPath/i, /\b(ba)?sh\s+-\w*c/]
const readOnlyPr = new Set(['view', 'list', 'checks', 'diff'])
/** The names of the shells a command may run, as a pattern source. */
export const shellNames = '(ba|z|da|k)?sh'
// why: A script file hides its words from the guard; an interpreter's first operand that is a file is the script it runs.
const interpreter = new RegExp(`^(${shellNames}|python[\\d.]*|node|perl|ruby|deno|bun|tsx|ts-node|source)$`)

/** Where an issue write is told to go instead of a raw gh call, with the tool each third-party skill uses. */
const issueBashDeny = markForAgent('Raw GitHub issue, label, milestone and dependency writes are denied — use the mod\'s tools: ' +
  'issue_create (to-spec: kind spec; to-tickets: kind ticket with parent and blockedBy; wayfinder: labels wayfinder:* with kind decision; triage: kind bug), ' +
  'issue_edit (triage label, type, priority, assignees, parent, blockedBy, title, body, reopen), issue_comment (triage briefs, wayfinder resolutions), ' +
  'issue_close (state reason); missing labels come from /flow setup-labels, which the user runs.')

/**
 * Names the command a word runs, without its directory.
 * @param word - The command word, a bare name or a path.
 * @returns The part after its last slash.
 */
export function commandName(word: string): string {
  return word.split('/').pop() ?? ''
}

/**
 * Splits a command into its words, dropping quotes and shell separators.
 * @param command - The raw command.
 * @returns The words.
 */
const splitWords = (command: string): string[] => command.split(/[\s;&|()`'"<>]+/).filter(Boolean)

/**
 * Tells whether a position of a command falls inside a quoted string; escaped quotes are not read, as befits an accident guard.
 * @param command - The raw command.
 * @param index - The position.
 * @returns Whether an opened quote is still unclosed at that position.
 */
function isQuoted(command: string, index: number): boolean {
  const open = [...command.slice(0, index)].reduce<string | undefined>((quote, char) => {
    if (quote) return char === quote ? undefined : quote
    return char === '"' || char === '\'' ? char : undefined
  }, undefined)
  return open !== undefined
}

/**
 * Explains a deny caused by issue-write words inside a quoted argument, which may be only text such as a message.
 * @param words - The matched words.
 * @returns The deny reason.
 */
const quotedIssueBashDeny = (words: string): string => markForAgent(`"${words.replace(/\s+/g, ' ')}" inside a quoted argument matched the raw GitHub issue write guard, ` +
  'which reads the whole command line. If it is only text (a message, a body), pass that text from a file so the command line does not carry the words; ' +
  'a real issue write goes through the mod\'s issue_create, issue_edit, issue_comment and issue_close tools.')

/**
 * Tells a `gh api` call that writes: an explicit method other than GET, or, since gh then sends POST, any field or input.
 * @param command - The raw command.
 * @returns Whether the call writes.
 */
function isGhApiWrite(command: string): boolean {
  const method = /(?:^|[\s'"])(?:-X|--method)[\s=]*['"]?([A-Za-z]+)/.exec(command)?.[1]?.toUpperCase()
  if (method) return method !== 'GET'
  return splitWords(command).some(word => /^(-f|-F|--field|--raw-field|--input)(=|$)|^-[fF]./.test(word))
}

/**
 * Tells whether a Bash command writes issues, labels, milestones, sub-issues or dependencies on GitHub.
 * @param command - The command line as the model wrote it.
 * @returns The deny reason, or undefined when it writes none of them.
 */
export function judgeIssueBash(command: string): string | undefined {
  const write = /\bgh\s+issue\s+(create|edit|close|reopen|comment|develop|transfer|delete)\b/.exec(command) ?? /\bgh\s+label\s+(create|edit|delete|clone)\b/.exec(command)
  if (write) return isQuoted(command, write.index) ? quotedIssueBashDeny(write[0]) : issueBashDeny
  if (!/\bgh\s+api\b/.test(command)) return undefined
  if (/\bgraphql\b/.test(command)) return /\bmutation\b/.test(command) && /issue|label|milestone/i.test(command) ? issueBashDeny : undefined
  if (!/\b(issues|labels|milestones|sub_issues?|dependencies)\b/.test(command)) return undefined
  return isGhApiWrite(command) ? issueBashDeny : undefined
}

/**
 * Tells a git command that commits, however its options are spelled.
 * @param command - The raw Bash command.
 * @returns Whether it names both git and commit.
 */
export function isGitCommit(command: string): boolean {
  const words = splitWords(command)
  return words.includes('git') && words.includes('commit')
}

/**
 * Lists, for each simple command that runs an interpreter, the words after it that are not options: the first of them that is a file is its script.
 * @param command - The raw Bash command.
 * @returns One candidate list per interpreter run.
 */
export function listScriptCandidates(command: string): string[][] {
  return command.split(/[;&|()`\n]+/).map(splitWords).flatMap(words => {
    // why: `.` reads as source only where a command starts, unlike the `.` of `find . -name`.
    const index = words[0] === '.' ? 0 : words.findIndex(word => interpreter.test(commandName(word)))
    return index < 0 ? [] : [words.slice(index + 1).filter(word => !word.startsWith('-'))]
  })
}

/**
 * Names the first word or phrase of a command that a delegated unit may not run.
 * @param command - The raw Bash command.
 * @param aliases - The configured git alias names, or null when they could not be read.
 * @returns The offending word, or undefined when the command may run.
 */
export function findDeniedWord(command: string, aliases: string[] | null): string | undefined {
  const words = splitWords(command)
  const after = (word: string): string[] => words.slice(words.indexOf(word) + 1)
  const word = words.find(entry => deniedWords.has(entry))
  if (word) return word
  const text = deniedText.map(pattern => pattern.exec(command)?.[0]).find(Boolean)
  if (text) return text
  if (words.includes('branch') && after('branch').some(entry => /^-[a-zA-Z]*[fDM]/.test(entry) || entry === '--force')) return 'branch -f/-D/-M'
  if (words.includes('checkout') && after('checkout').includes('-B')) return 'checkout -B'
  if (words.includes('switch') && after('switch').includes('-C')) return 'switch -C'
  const gh = words.indexOf('gh')
  if (gh >= 0 && words[gh + 1] === 'pr' && !readOnlyPr.has(words[gh + 2] ?? '')) return 'gh pr'
  if (gh >= 0 && words[gh + 1] === 'api' && isGhApiWrite(command)) return 'gh api with a method or fields'
  if (!words.includes('git')) return undefined
  // An unreadable alias list could hide any of the words above, so it refuses every git command.
  if (aliases === null) return 'git (its aliases are unreadable)'
  return words.find(entry => aliases.includes(entry))
}
