import { humanOnlyFlowCommands } from './coordinator'
import { markForAgent } from './messages'

// why: An accident guard, not a sandbox: each word names a way a command moves or rewrites a ref other than the unit's own commit,
// or runs a command the raw text cannot show.
const deniedWords = new Set(['push', 'rebase', 'reset', 'update-ref', 'filter-branch', 'merge', 'eval'])
const deniedText = [/\bGIT_(DIR|WORK_TREE|CONFIG\w*)\b/, /--git-dir\b/, /--work-tree\b/, /-c\s*alias\./, /-c\s*core\.hooksPath/i, /\b(ba)?sh\s+-\w*c/]
const readOnlyPr = new Set(['view', 'list', 'checks', 'diff'])
// why: The records, the mailbox among them, live in the working-agreement directory of the git common directory, which is named .git or ends in .git.
const recordsPath = /\.git\/working-agreement(\/|\b)/
const mailboxPath = /\/working-agreement\/mail(\/|\b)/
// why: Reading mail is harmless; these are the ways a command creates, moves, changes or removes a file.
const fileWrite = /(^|[^<>&\d])>|\b(mv|cp|rm|ln|touch|tee|mkdir|rmdir|install|rsync|truncate|dd|unlink|chmod|chown)\b|\bsed\b[^|;&]*\s-i/
const recordsDeny = markForAgent('The mod\'s records, the mailbox among them, are written only by the mod: send messages and take steps with the mod\'s tools, '
  + 'and never write, move or remove a file under the working-agreement records directory directly.')
/** The names of the shells a command may run, as a pattern source. */
export const shellNames = '(ba|z|da|k)?sh'
// why: A script file hides its words from the guard; an interpreter's first operand that is a file is the script it runs.
const interpreter = new RegExp(`^(${shellNames}|python[\\d.]*|node|perl|ruby|deno|bun|tsx|ts-node|source)$`)
// why: Words that run the next word as the command, so the test runner they start is that word.
const commandWrappers = new Set(['npx', 'pnpm', 'exec', 'env', 'time', 'nice', 'nohup', 'timeout', 'sudo', 'command'])

/** Where an issue write is told to go instead of a raw gh call, with the tool each third-party skill uses. */
const issueBashDeny = markForAgent('Raw GitHub issue, label, milestone and dependency writes are denied — use the mod\'s tools: ' +
  'issue_create (to-spec: kind spec; to-tickets: kind ticket with parent and blockedBy; wayfinder: labels wayfinder:* with kind decision; triage: kind bug), ' +
  'issue_edit (triage label, type, priority, assignees, parent, blockedBy, title, body, reopen), issue_comment (triage briefs, wayfinder resolutions), ' +
  'issue_close (state reason); missing labels come from /flow setup-labels, which the user runs.')

/** The file name of the script, shipped in the mod, that approves a Verify config from the user's own terminal. */
export const approvalScript = 'approve-verify.sh'

// why: The approval is the user's alone, and herdr lets any agent type into any pane: a pane holding a shell gives an agent the
// terminal the script asks for, and a pane holding a session takes its prompt; the socket API and a workspace started with a
// command reach a session the same way. Like every guard here it is an accident guard.
const herdrTyping = /\bherdr\b[\s\S]*\b(pane\s+(send-text|send-keys|run)\b|agent\s+prompt\b|api\b|workspace\s+create\b[\s\S]*\s--(\s|$))/
const approvalBashDeny = markForAgent(`The Verify config approval is the user's alone: ${approvalScript} runs only from the user's own terminal, ` +
  'never from an agent session, and no agent command may name it. Stop and tell the user the command the pane and the refusal name.')
const reservedFlow = new RegExp(`/flow\\s+(${humanOnlyFlowCommands.join('|')})\\b`, 'g')
// why: A live probe plays the user's setup in its own throwaway herdr session; only these two subcommands set one up.
const probeSetupCommands = new Set(['coordinate', 'delegate'])
// why: The exemption holds only for one whole command that names its probe target outside the typed text: no chaining, no
// substitution, one literal quoted prompt, so neither the target nor a second command can hide in it.
const probePrompt = /^\s*(?:HERDR_SOCKET_PATH=(\S+)\s+)?herdr\s+(?:--session(?:=|\s+)(\S+)\s+)?agent\s+prompt\s+[\w:.-]+\s+("[^"`$\\]*"|'[^']*')\s*$/
const probeSession = /^probe-[\w-]+$/
const probeSocket = /^[^\s'"]*\/sessions\/(probe-[\w-]+)\/[^/\s'"]+$/
const herdrApprovalDeny = markForAgent('The Verify config approval is the user\'s alone: no agent types it into a pane through herdr. ' +
  'Stop and tell the user the command the pane and the refusal name.')

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
 * Tells whether a word runs a Verify runner: the same program, or the same script by any path that ends in the runner's.
 * @param word - A command word or an interpreter's script operand.
 * @param runner - The first word of a Verify command.
 * @returns Whether the word runs that runner.
 */
function runsRunner(word: string, runner: string): boolean {
  const [path, target] = [word, runner].map(text => text.replace(/^(\.\/)+/, ''))
  return target!.includes('/') ? path === target || path!.endsWith(`/${target}`) : commandName(path!) === target
}

/**
 * Names the first heavy test run a command starts, which outside the Verify queue would share the host with a queued run:
 * Bats, the engine's plugin test, or a runner of the project's Verify config.
 * @param command - The raw Bash command.
 * @param runners - The first words of the Verify config's commands.
 * @returns The runner as written, or undefined when the command starts none.
 */
export function findHeavyTestRun(command: string, runners: readonly string[] = []): string | undefined {
  const isHeavyRunner = (word: string): boolean => commandName(word) === 'bats' || runners.some(runner => runsRunner(word, runner))
  for (const words of command.split(/[;&|()`\n]+/).map(splitWords)) {
    const start = words.findIndex(word => !/^\w+=/.test(word) && !commandWrappers.has(word) && !/^-/.test(word) && !/^\d+[smh]?$/.test(word))
    const head = words[start]
    if (head === undefined) continue
    if (commandName(head) === 'claude' && words.slice(start + 1).join(' ').includes('plugin test')) return 'claude plugin test'
    const script = interpreter.test(commandName(head)) ? words.slice(start + 1).find(word => !word.startsWith('-')) : head
    if (script !== undefined && isHeavyRunner(script)) return script
  }
  return undefined
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

/**
 * Refuses an agent command that names the approval script, run directly or typed through herdr into a pane or an agent's prompt.
 * @param command - The raw Bash command.
 * @returns The deny reason, or undefined when the command does not name the script.
 */
export function judgeApprovalBash(command: string): string | undefined {
  if (!command.includes(approvalScript)) return undefined
  return herdrTyping.test(command) ? herdrApprovalDeny : approvalBashDeny
}

/**
 * Names the probe session a command prompts, when it targets exactly one explicit probe session that is not the caller's own.
 * @param command - The raw Bash command.
 * @param callerSocket - The caller's own HERDR_SOCKET_PATH, if any.
 * @returns The probe session's name, or undefined when the command is not one agent prompt into another probe session.
 */
function findProbeTarget(command: string, callerSocket: string | undefined): string | undefined {
  const [, socket, session] = probePrompt.exec(command) ?? []
  if ((socket === undefined) === (session === undefined)) return undefined
  const name = socket === undefined ? probeSession.exec(session!)?.[0] : socket.includes('..') ? undefined : probeSocket.exec(socket)?.[1]
  const own = callerSocket === undefined ? undefined : probeSocket.exec(callerSocket)?.[1]
  return name === undefined || name === own || socket === callerSocket ? undefined : name
}

/**
 * Refuses an agent command that types one of the user's `/flow` subcommands into a pane or an agent's prompt through herdr: a coordinator
 * takes a user's step for a unit only through its checked tools, and never lifts its own cancel. One agent prompt that sets up another
 * explicit probe session, with coordinate or delegate only, is exempt.
 * @param command - The raw Bash command.
 * @param callerSocket - The caller's own HERDR_SOCKET_PATH, which no exemption reaches.
 * @returns The deny reason, or undefined when the command types no reserved subcommand or only sets up another probe session.
 */
export function judgeReservedFlowBash(command: string, callerSocket?: string): string | undefined {
  const names = herdrTyping.test(command) ? [...command.matchAll(reservedFlow)].map(match => match[1]!) : []
  const step = names.find(name => !probeSetupCommands.has(name))
  if (names.length === 0 || (step === undefined && findProbeTarget(command, callerSocket) !== undefined)) return undefined
  const typed = step ?? names[0]!
  return markForAgent(`/flow ${typed} is the user's alone, typed in their own prompt: no agent types it into a pane through herdr. `
    + (typed === 'lift' ? 'The unit replies to its cancel with send instead.'
      : 'A coordinator takes a delegated approve, skip or follow-up only with approve_unit, skip_unit or follow_up_unit, after its delegated decision; anything else is the user\'s.'))
}

/**
 * Refuses a command that writes under the records directory, as a best effort: a shell can always reach the file some other way.
 * @param command - The raw Bash command.
 * @returns The deny reason, or undefined when the command does not write there.
 */
export function judgeRecordsBash(command: string): string | undefined {
  return recordsPath.test(command) && fileWrite.test(command) ? recordsDeny : undefined
}

/**
 * Refuses a file tool's write under the mailbox directory; the file tools' own judgement refuses the rest of the records directory.
 * @param path - The path the tool writes.
 * @returns The deny reason, or undefined when the path is elsewhere.
 */
export function judgeMailboxWrite(path: string): string | undefined {
  return mailboxPath.test(path) ? recordsDeny : undefined
}
