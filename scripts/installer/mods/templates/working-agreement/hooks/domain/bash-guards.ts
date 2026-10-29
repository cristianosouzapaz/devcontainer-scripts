import { markForAgent } from './messages'

// why: An accident guard, not a sandbox: each word names a way a command moves or rewrites a ref other than the unit's own commit,
// or runs a command the raw text cannot show.
const deniedWords = new Set(['push', 'rebase', 'reset', 'update-ref', 'filter-branch', 'merge', 'eval'])
const deniedText = [/\bGIT_(DIR|WORK_TREE|CONFIG\w*)\b/, /--git-dir\b/, /--work-tree\b/, /-c\s*alias\./, /-c\s*core\.hooksPath/i, /\b(ba)?sh\s+-\w*c/]
const readOnlyPr = new Set(['view', 'list', 'checks', 'diff'])

/** Where an issue write is told to go instead of a raw gh call, with the tool each third-party skill uses. */
const issueBashDeny = markForAgent('Raw GitHub issue, label, milestone and dependency writes are denied — use the mod\'s tools: ' +
  'issue_create (to-spec: kind spec; to-tickets: kind ticket with parent and blockedBy; wayfinder: labels wayfinder:* with kind decision; triage: kind bug), ' +
  'issue_edit (triage label, type, priority, assignees, parent, blockedBy, title, body, reopen), issue_comment (triage briefs, wayfinder resolutions), ' +
  'issue_close (state reason); missing labels come from /flow setup-labels, which the user runs.')

/**
 * Splits a command into its words, dropping quotes and shell separators.
 * @param command - The raw command.
 * @returns The words.
 */
const splitWords = (command: string): string[] => command.split(/[\s;&|()`'"<>]+/).filter(Boolean)

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
  if (/\bgh\s+issue\s+(create|edit|close|reopen|comment|develop|transfer|delete)\b/.test(command)) return issueBashDeny
  if (/\bgh\s+label\s+(create|edit|delete|clone)\b/.test(command)) return issueBashDeny
  if (!/\bgh\s+api\b/.test(command)) return undefined
  if (/\bgraphql\b/.test(command)) return /\bmutation\b/.test(command) && /issue|label|milestone/i.test(command) ? issueBashDeny : undefined
  if (!/\b(issues|labels|milestones|sub_issues?|dependencies)\b/.test(command)) return undefined
  return isGhApiWrite(command) ? issueBashDeny : undefined
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
