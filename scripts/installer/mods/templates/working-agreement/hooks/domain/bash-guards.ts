import { humanOnlyFlowCommands } from './coordinator'
import { markForAgent } from './messages'
import { commandName, dropGhRepository, interpreter, parseShell } from './shell-parse'
import type { SimpleCommand, Word } from './shell-parse'
import { describeOutsideTable, findWriteCommand, listWrittenOperands, recordsPath } from './shell-table'

/** A heredoc whose body the command line is reading: where it opened, and where its body opened another with the same delimiter. */
interface Heredoc {
  delimiter: string
  isTabStripped: boolean
  opened: number
  reopened?: number
}

/** A field a gh api call sends: its option and pair as written, whether gh reads it typed, where a value starting with @ names a file, its key and its value. */
interface GhField {
  written: string
  isTyped: boolean
  key: string
  value: Word
}

// why: An accident guard, not a sandbox: each word names a way a command moves or rewrites a ref other than the unit's own commit, or runs a command the raw text cannot show.
const deniedWords = new Set(['push', 'rebase', 'reset', 'update-ref', 'filter-branch', 'merge', 'eval'])
const deniedText = [/\bGIT_(DIR|WORK_TREE|CONFIG\w*)\b/, /--git-dir\b/, /--work-tree\b/, /-c\s*alias\./, /-c\s*core\.hooksPath/i, /\b(ba)?sh\s+-\w*c/]
const readOnlyPr = new Set(['view', 'list', 'checks', 'diff', 'status'])
const issueWrites = new Set(['create', 'edit', 'close', 'reopen', 'comment', 'develop', 'transfer', 'delete'])
const labelWrites = new Set(['create', 'edit', 'delete', 'clone'])
const mailboxPath = /\/working-agreement\/mail(\/|\b)/
// why: These redirections open their target for writing; `>&` and `<&` with a descriptor only duplicate it.
const writeRedirect = /^(\d*(>|>>|>\||<>|>&)|&>|&>>)$/
const recordsRule = 'The mod\'s records, the mailbox among them, are written only by the mod: send messages and take steps with the mod\'s tools, '
  + 'and never write, move or remove a file under the working-agreement records directory directly.'
const recordsDeny = markForAgent(recordsRule)
// why: a shell construct the parser does not read can be split away from the commands that name the records; a program or form outside the table cannot, so the way out is a known reader.
const splitAdvice = 'If it only reads, split it so each command that names the records is a plain command with literal operands.'
const readAdvice = 'If it only reads, read the records with cat, grep or jq, or with the Read tool.'
// why: a form outside the table, such as git commit, may name the records only as text, which a file carries instead.
const formAdvice = 'If it only names the records as text, such as in a commit message, pass that text from a file (git commit -F) or split it '
  + 'onto a line of its own; if it reads them, use cat, grep or jq, or the Read tool.'
// why: Words that run the next word as the test runner; the parser already skips env, exec, time, nice, nohup, timeout, sudo and command.
const packageRunners = new Set(['npx', 'pnpx', 'bunx'])
// why: The raw-line rule skips these words where a command starts, so the test runner they start is the next word.
const lineWrappers = new Set(['npx', 'pnpm', 'exec', 'env', 'time', 'nice', 'nohup', 'timeout', 'sudo', 'command'])

/** Where an issue write is told to go instead of a raw gh call, with the tool each third-party skill uses. */
const issueBashDeny = markForAgent('Raw GitHub issue, label, milestone and dependency writes are denied — use the mod\'s tools: ' +
  'issue_create (to-spec: kind spec; to-tickets: kind ticket with parent and blockedBy; wayfinder: labels wayfinder:* with kind decision; triage: kind bug), ' +
  'issue_edit (triage label, type, priority, assignees, parent, blockedBy, title, body, reopen), issue_comment (triage briefs, wayfinder resolutions), ' +
  'issue_close (state reason); missing labels come from /flow setup-labels, which the user runs.')

/** The file name of the script, shipped in the mod, that approves a Verify config from the user's own terminal. */
export const approvalScript = 'approve-verify.sh'

// why: The approval is the user's alone, and herdr lets any agent type into any pane: a pane holding a shell gives an agent the terminal the script asks for, and a pane holding a session takes its prompt; the socket API and a workspace started with a command reach a session the same way. Like every guard here it is an accident guard.
const herdrTyping = /\bherdr\b[\s\S]*\b(pane\s+(send-text|send-keys|run)\b|agent\s+prompt\b|api\b|workspace\s+create\b[\s\S]*\s--(\s|$))/
const approvalBashDeny = markForAgent(`The Verify config approval is the user's alone: ${approvalScript} runs only from the user's own terminal, ` +
  'never from an agent session, and no agent command may name it. Stop and tell the user the command the pane and the refusal name.')
const reservedFlow = new RegExp(`/flow\\s+(${humanOnlyFlowCommands.join('|')})\\b`, 'g')
// why: A live probe plays the user's setup in its own throwaway herdr session; only these two subcommands set one up.
const probeSetupCommands = new Set(['coordinate', 'delegate'])
// why: The exemption holds only for one whole command that names its probe target outside the typed text: no chaining, no substitution, one literal quoted prompt, so neither the target nor a second command can hide in it.
const probePrompt = /^\s*(?:HERDR_SOCKET_PATH=(\S+)\s+)?herdr\s+(?:--session(?:=|\s+)(\S+)\s+)?agent\s+prompt\s+[\w:.-]+\s+("[^"`$\\]*"|'[^']*')\s*$/
const probeSession = /^probe-[\w-]+$/
const probeSocket = /^[^\s'"]*\/sessions\/(probe-[\w-]+)\/[^/\s'"]+$/
const herdrApprovalDeny = markForAgent('The Verify config approval is the user\'s alone: no agent types it into a pane through herdr. ' +
  'Stop and tell the user the command the pane and the refusal name.')
// why: `<<<` is a here-string, which has no body.
const heredocOperator = /(?<!<)<<(?!<)(-?)\s*(['"]?)\\?([^\s;&|<>()'"]+)\2/g

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
const quotedIssueBashDeny = (words: string): string => markForAgent(`\`${words.replace(/\s+/g, ' ')}\` inside a quoted argument matched the raw GitHub issue write guard, ` +
  'which reads the whole command line. If it is only text (a message, a body), pass that text from a file so the command line does not carry the words; ' +
  'a real issue write goes through the mod\'s issue_create, issue_edit, issue_comment and issue_close tools.')

/**
 * Tells a `gh api` call that writes: an explicit method other than GET, or, since gh then sends POST, any field or input.
 * @param words - The call's words.
 * @returns Whether the call writes.
 */
function isGhApiWrite(words: readonly string[]): boolean {
  const index = words.findIndex(word => /^(-X|--method)(=|$)|^-X./.test(word))
  if (index < 0) return words.some(word => /^(-f|-F|--field|--raw-field|--input)(=|$)|^-[fF]./.test(word))
  const method = /^(?:-X|--method)=?(.+)$/.exec(words[index]!)?.[1] ?? words[index + 1] ?? ''
  return method.toUpperCase() !== 'GET'
}

/**
 * Lists the words of a command as written, after quote removal.
 * @param words - The words.
 * @returns Their texts.
 */
const listTexts = (words: readonly Word[]): string[] => words.map(word => word.text)

/**
 * Names the program a simple command runs, without its directory.
 * @param entry - The command.
 * @returns The program's name, empty when the command runs none.
 */
const nameHead = (entry: SimpleCommand): string => commandName(entry.argv[0]?.text ?? '')

/**
 * Tells whether a parsed command is in the closed table of commands the guards judge by structure.
 * @param entry - The command.
 * @returns Whether the table holds it.
 */
const isInTable = (entry: SimpleCommand): boolean => describeOutsideTable(entry) === undefined

/**
 * Lists the simple commands a guard can judge by their structure; the parsed judgement only relaxes the raw-line rule, so it applies only
 * when every command is one the guard accepts, by default one in the closed table. A line outside the parsed subset, one that runs an
 * interpreter's inline code, whose words the guards do not read, one that types text through herdr, which then runs in another terminal,
 * or one with a command the guard does not accept gives none, so the guard falls back to its raw-line rule.
 * @param command - The raw Bash command.
 * @param accepts - Which commands the guard judges by structure.
 * @returns The commands, or undefined when the guard must read the raw line.
 */
function readCommands(command: string, accepts: (entry: SimpleCommand) => boolean = isInTable): SimpleCommand[] | undefined {
  if (herdrTyping.test(command)) return undefined
  const line = parseShell(command)
  return line.kind === 'parsed' && line.commands.every(entry => entry.inlineCode === undefined && accepts(entry)) ? line.commands : undefined
}

/**
 * Tells whether a raw Bash line writes issues, labels, milestones, sub-issues or dependencies, wherever its words stand.
 * @param command - The raw Bash command.
 * @returns The deny reason, or undefined when the line names no such write.
 */
function judgeIssueLine(command: string): string | undefined {
  // why: gh takes its repository option before and after the subcommand, so the raw rule skips it on both sides.
  const repo = String.raw`(?:(?:-R|--repo)(?:=|\s+)\S+\s+|-R\S+\s+)*`
  const write = new RegExp(String.raw`\bgh\s+${repo}issue\s+${repo}(create|edit|close|reopen|comment|develop|transfer|delete)\b`).exec(command)
    ?? new RegExp(String.raw`\bgh\s+${repo}label\s+${repo}(create|edit|delete|clone)\b`).exec(command)
  if (write) return isQuoted(command, write.index) ? quotedIssueBashDeny(write[0]) : issueBashDeny
  if (!/\bgh\s+api\b/.test(command)) return undefined
  if (/\bgraphql\b/.test(command)) return /\bmutation\b/.test(command) && /issue|label|milestone/i.test(command) ? issueBashDeny : undefined
  if (!/\b(issues|labels|milestones|sub_issues?|dependencies)\b/.test(command)) return undefined
  return isGhApiWrite(splitWords(command)) ? issueBashDeny : undefined
}

/**
 * Tells whether a simple command is a gh call that writes issues, labels, milestones, sub-issues or dependencies.
 * @param entry - The command.
 * @returns Whether it writes one of them.
 */
function isIssueWrite(entry: SimpleCommand): boolean {
  const subcommand = entry.subcommand?.text
  const action = dropGhRepository(entry.args)[0]?.text ?? ''
  if (nameHead(entry) !== 'gh') return false
  if (subcommand === 'issue') return issueWrites.has(action)
  if (subcommand === 'label') return labelWrites.has(action)
  if (subcommand !== 'api') return false
  const args = listTexts(entry.args)
  const text = args.join(' ')
  if (args.includes('graphql')) return /\bmutation\b/.test(text) && /issue|label|milestone/i.test(text)
  return /\b(issues|labels|milestones|sub_issues?|dependencies)\b/.test(text) && isGhApiWrite(args)
}

/**
 * Tells whether a Bash command writes issues, labels, milestones, sub-issues or dependencies on GitHub, judging gh only where it runs.
 * @param command - The command line as the model wrote it.
 * @returns The deny reason, or undefined when it writes none of them.
 */
export function judgeIssueBash(command: string): string | undefined {
  const commands = readCommands(command)
  if (commands === undefined) return judgeIssueLine(command)
  return commands.some(isIssueWrite) ? issueBashDeny : undefined
}

/**
 * Tells a git command that commits: on a line judged by the raw-line rule, both words anywhere. git commit runs hooks, so it is outside
 * the table, and a line in the table never commits.
 * @param command - The raw Bash command.
 * @returns Whether it commits.
 */
export function isGitCommit(command: string): boolean {
  if (readCommands(command) !== undefined) return false
  const words = splitWords(command)
  return words.includes('git') && words.includes('commit')
}

/**
 * Lists, on a raw line, the words after each interpreter that are not options.
 * @param command - The raw Bash command.
 * @returns One candidate list per interpreter run.
 */
function listLineScriptCandidates(command: string): string[][] {
  return command.split(/[;&|()`\n]+/).map(splitWords).flatMap(words => {
    // why: `.` reads as source only where a command starts, unlike the `.` of `find . -name`.
    const index = words[0] === '.' ? 0 : words.findIndex(word => interpreter.test(commandName(word)))
    return index < 0 ? [] : [words.slice(index + 1).filter(word => !word.startsWith('-'))]
  })
}

/**
 * Lists, for each simple command that runs an interpreter, its operands that are not options and the file it reads as stdin:
 * the first of them that is a file is its script.
 * @param command - The raw Bash command.
 * @returns One candidate list per interpreter run.
 */
export function listScriptCandidates(command: string): string[][] {
  const commands = readCommands(command)
  if (commands === undefined) return listLineScriptCandidates(command)
  return commands.filter(entry => nameHead(entry) === '.' || interpreter.test(nameHead(entry))).map(entry => [
    ...listTexts(entry.argv.slice(1)).filter(word => !word.startsWith('-')),
    ...entry.redirects.filter(redirect => /^0?<$/.test(redirect.operator)).map(redirect => redirect.target.text),
  ])
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
 * Names the first heavy test run a raw line starts, reading only the runners' first words.
 * @param command - The raw Bash command.
 * @param runners - The first words of the Verify config's commands.
 * @returns The runner as written, or undefined when the line starts none.
 */
function findLineHeavyTestRun(command: string, runners: readonly string[]): string | undefined {
  const isHeavyRunner = (word: string): boolean => commandName(word) === 'bats' || runners.some(runner => runsRunner(word, runner))
  for (const words of command.split(/[;&|()`\n]+/).map(splitWords)) {
    const start = words.findIndex(word => !/^\w+=/.test(word) && !lineWrappers.has(word) && !/^-/.test(word) && !/^\d+[smh]?$/.test(word))
    const head = words[start]
    if (head === undefined) continue
    if (commandName(head) === 'claude' && words.slice(start + 1).join(' ').includes('plugin test')) return 'claude plugin test'
    const script = interpreter.test(commandName(head)) ? words.slice(start + 1).find(word => !word.startsWith('-')) : head
    if (script !== undefined && isHeavyRunner(script)) return script
  }
  return undefined
}

/**
 * Lists the commands a run may start: the command itself, and the one a package runner runs from its next word, as npx, pnpm exec or
 * dlx, bun run or x, yarn exec or run, npm exec or run do, and as pnpm and yarn do with an unknown word, which they run as a script or binary.
 * @param argv - The command, head first.
 * @returns The command, and the command it may run, head first.
 */
function listRunVariants(argv: string[]): string[][] {
  const name = commandName(argv[0] ?? '')
  const operand = argv.findIndex((word, index) => index > 0 && !word.startsWith('-'))
  if (packageRunners.has(name)) return [operand < 0 ? [] : argv.slice(operand)]
  if (operand < 0) return [argv]
  const isRunWord = /^(exec|dlx|run|x|run-script)$/.test(argv[operand]!)
  if (['pnpm', 'yarn', 'bun', 'npm'].includes(name) && isRunWord) return [argv, argv.slice(operand + 1)]
  return name === 'pnpm' || name === 'yarn' ? [argv, argv.slice(operand)] : [argv]
}

/**
 * Lists the words that may stand in a command's subcommand position: its first operand, and the next one too while the word before it
 * is an option that may have taken it as its value, as `--prefix x` does, since no grammar of the runner is known.
 * @param words - The words after the program.
 * @returns The candidates, in order.
 */
function listSubcommandCandidates(words: readonly string[]): string[] {
  const takesValue = (word: string | undefined): boolean => word !== undefined && word.startsWith('-') && word !== '--' && !word.includes('=')
  const first = words.findIndex(word => !word.startsWith('-'))
  if (first < 0) return []
  const rest = words.slice(first + 1)
  return takesValue(words[first - 1]) ? [words[first]!, ...listSubcommandCandidates(rest)] : [words[first]!]
}

/**
 * Tells whether a run's words after the program match a configured invocation: an option as the configured next word, such as --tier,
 * may take any value, so any run matches; a configured subcommand matches only where a subcommand may stand, so `npm view test` is not
 * `npm test`; and a run with no operand runs the program's default.
 * @param words - The run's words after the program.
 * @param second - The configured word after the program, if any.
 * @returns Whether the run matches.
 */
function matchesInvocation(words: readonly string[], second: string | undefined): boolean {
  const candidates = listSubcommandCandidates(words)
  return second === undefined || second.startsWith('-') || candidates.length === 0 || candidates.includes(second)
}

/**
 * Names the heavy test run a simple command starts: Bats, the engine's plugin test, or a Verify command's program, matched as the head
 * first, so a configured interpreter such as `node --test` is caught, then as an interpreter's script, with the configured invocation.
 * @param argv - The command, head first.
 * @param runners - The Verify config's commands.
 * @returns The run as written, or undefined when the command starts none.
 */
function findCommandHeavyTestRun(argv: string[], runners: readonly (readonly string[])[]): string | undefined {
  const head = argv[0]
  if (head === undefined) return undefined
  if (commandName(head) === 'claude' && argv.slice(1).join(' ').includes('plugin test')) return 'claude plugin test'
  const scriptAt = interpreter.test(commandName(head)) ? argv.findIndex((word, index) => index > 0 && !word.startsWith('-')) : -1
  for (const at of [0, scriptAt].filter(index => index >= 0)) {
    const program = argv[at]!
    if (commandName(program) === 'bats') return program
    const words = argv.slice(at + 1)
    const runner = runners.find(([first, second]) => runsRunner(program, first!) && matchesInvocation(words, second))
    const second = runner?.[1]
    if (runner) return second !== undefined && !second.startsWith('-') && listSubcommandCandidates(words).includes(second) ? `${program} ${second}` : program
  }
  return undefined
}

/**
 * Names the first heavy test run a command starts, which outside the Verify queue would share the host with a queued run:
 * Bats, the engine's plugin test, or a command of the project's Verify config.
 * @param command - The raw Bash command.
 * @param runners - The Verify config's commands.
 * @returns The run as written, or undefined when the command starts none.
 */
export function findHeavyTestRun(command: string, runners: readonly (readonly string[])[] = []): string | undefined {
  // why: this guard only names the program a command runs, which the parse gives for any program, in the table or not.
  const commands = readCommands(command, () => true)
  if (commands === undefined) return findLineHeavyTestRun(command, runners.map(([runner]) => runner!))
  return commands.flatMap(entry => listRunVariants(listTexts(entry.argv))).map(argv => findCommandHeavyTestRun(argv, runners)).find(Boolean)
}

/**
 * Tells a git branch flag that moves or deletes a branch by force: -f, -D or -M, alone or in a cluster, or --force.
 * @param word - A word after `branch`.
 * @returns Whether the word is such a flag.
 */
const isForcedBranchFlag = (word: string): boolean => /^-[a-zA-Z]*[fDM]/.test(word) || word === '--force'

/**
 * Quotes a token the way every refusal names it.
 * @param token - The token as written.
 * @returns The token in backticks.
 */
const quoteToken = (token: string): string => `\`${token}\``

/**
 * Names the first word or phrase of a raw line that a delegated unit may not run, wherever it stands.
 * @param command - The raw Bash command.
 * @param aliases - The configured git alias names, or null when they could not be read.
 * @returns The offending word, its tokens in backticks, or undefined when the line may run.
 */
function findLineDeniedWord(command: string, aliases: string[] | null): string | undefined {
  const words = splitWords(command)
  const after = (word: string): string[] => words.slice(words.indexOf(word) + 1)
  const word = words.find(entry => deniedWords.has(entry))
  if (word) return quoteToken(word)
  const text = deniedText.map(pattern => pattern.exec(command)?.[0]).find(Boolean)
  if (text) return quoteToken(text)
  const force = words.includes('branch') ? after('branch').find(isForcedBranchFlag) : undefined
  if (force) return quoteToken(`branch ${force}`)
  if (words.includes('checkout') && after('checkout').includes('-B')) return quoteToken('checkout -B')
  if (words.includes('switch') && after('switch').includes('-C')) return quoteToken('switch -C')
  const gh = words.indexOf('gh')
  if (gh >= 0 && words[gh + 1] === 'pr' && !readOnlyPr.has(words[gh + 2] ?? '')) return quoteToken('gh pr')
  if (gh >= 0 && words[gh + 1] === 'api' && isGhApiWrite(words)) return `${quoteToken('gh api')} with a method or fields`
  if (!words.includes('git')) return undefined
  // why: an unreadable alias list could hide any of the words above, so it refuses every git command.
  if (aliases === null) return `${quoteToken('git')} (its aliases are unreadable)`
  const alias = words.find(entry => aliases.includes(entry))
  return alias === undefined ? undefined : quoteToken(alias)
}

/**
 * Lists the fields a gh api call sends, from -f, -F, --field and --raw-field.
 * @param args - The words after `gh api`.
 * @returns Each field as written, its key and value, and whether gh reads it typed, where a value starting with @ is a file.
 */
function listGhFields(args: readonly Word[]): GhField[] {
  return args.flatMap((word, index) => {
    const long = /^(-f|-F|--field|--raw-field)(?:=(.*))?$/.exec(word.text)
    const short = long ? null : /^(-[fF])(.+)$/.exec(word.text)
    const flag = long?.[1] ?? short?.[1]
    const pair = long ? (long[2] === undefined ? args[index + 1] : { ...word, text: long[2] }) : short ? { ...word, text: short[2]! } : undefined
    if (flag === undefined || pair === undefined) return []
    const equals = pair.text.indexOf('=')
    return [{
      written: `${flag} ${pair.text}`, isTyped: flag === '-F' || flag === '--field',
      key: equals < 0 ? pair.text : pair.text.slice(0, equals), value: { ...pair, text: pair.text.slice(equals + 1) },
    }]
  })
}

/**
 * Names why a gh api graphql call may write. It passes only with an inline literal query that is no mutation; a raw `-f` field is a literal
 * even when it starts with @, and other typed fields beside that query pass unless one reads a file.
 * @param args - The words after `gh api`.
 * @returns The call and its cause, tokens in backticks, or undefined when it only reads.
 */
function findGraphqlWrite(args: readonly Word[]): string | undefined {
  const call = quoteToken('gh api graphql')
  const fields = listGhFields(args)
  const query = fields.find(field => field.key === 'query')
  const fromFile = fields.find(field => field.isTyped && field.value.text.startsWith('@'))
  if (args.some(word => /^--input(=|$)/.test(word.text))) return `${call} with ${quoteToken('--input')}, whose body the guard cannot read`
  if (fromFile) return `${call} with a field read from a file (${quoteToken(fromFile.written)})`
  if (query === undefined) return `${call} with no inline ${quoteToken('query')} field`
  if (query.value.expansion !== undefined) return `${call} whose query holds ${quoteToken(query.value.expansion)}`
  return /\bmutation\b/.test(query.value.text) ? `${call} with a ${quoteToken('mutation')}` : undefined
}

/**
 * Names what a simple command runs that a delegated unit may not: a denied git subcommand or alias, a forced branch move, or a gh write.
 * @param entry - The command.
 * @param aliases - The configured git alias names, or null when they could not be read.
 * @returns The offending subcommand, its tokens in backticks, or undefined when the command may run.
 */
function findCommandDeniedWord(entry: SimpleCommand, aliases: string[] | null): string | undefined {
  const name = nameHead(entry)
  const subcommand = entry.subcommand?.text ?? ''
  const args = listTexts(entry.args)
  const force = subcommand === 'branch' ? args.find(isForcedBranchFlag) : undefined
  if (name === 'gh' && subcommand === 'pr') return readOnlyPr.has(dropGhRepository(entry.args)[0]?.text ?? '') ? undefined : quoteToken('gh pr')
  if (name === 'gh' && subcommand === 'api') {
    return args.includes('graphql') ? findGraphqlWrite(entry.args) : isGhApiWrite(args) ? `${quoteToken('gh api')} with a method or fields` : undefined
  }
  if (name !== 'git') return undefined
  // why: an unreadable alias list could hide any denied subcommand, so it refuses every git command.
  if (aliases === null) return `${quoteToken('git')} (its aliases are unreadable)`
  const files = args.includes('--') ? args.slice(args.indexOf('--') + 1) : []
  if (subcommand === 'reset' && files.length > 0) return `${quoteToken('reset')}; ${quoteToken(`git restore --staged ${files.join(' ')}`)} unstages without moving a ref`
  if (deniedWords.has(subcommand)) return quoteToken(subcommand)
  if (force) return quoteToken(`branch ${force}`)
  if (subcommand === 'checkout' && args.includes('-B')) return quoteToken('checkout -B')
  if (subcommand === 'switch' && args.includes('-C')) return quoteToken('switch -C')
  return aliases.includes(subcommand) ? quoteToken(`git alias ${subcommand}`) : undefined
}

/**
 * Names the first word or phrase of a command that a delegated unit may not run: a denied git or gh subcommand where it runs, or
 * a word that reaches git's state or runs hidden code anywhere in the line.
 * @param command - The raw Bash command.
 * @param aliases - The configured git alias names, or null when they could not be read.
 * @returns The offending word, its tokens in backticks, or undefined when the command may run.
 */
export function findDeniedWord(command: string, aliases: string[] | null): string | undefined {
  // why: a configured git alias stands outside the table but is named by its own refusal, which the raw rule would name only as a word.
  const isAlias = (entry: SimpleCommand): boolean => nameHead(entry) === 'git' && aliases !== null && aliases.includes(entry.subcommand?.text ?? '')
  const commands = readCommands(command, entry => isInTable(entry) || isAlias(entry))
  if (commands === undefined) return findLineDeniedWord(command, aliases)
  const text = deniedText.map(pattern => pattern.exec(command)?.[0]).find(Boolean)
  if (text) return quoteToken(text)
  if (splitWords(command).includes('eval')) return quoteToken('eval')
  return commands.map(entry => findCommandDeniedWord(entry, aliases)).find(Boolean)
}

/**
 * Tells whether a simple command runs the approval script: as its program, or as an operand or stdin of an interpreter.
 * @param entry - The command.
 * @returns Whether it runs the script.
 */
function runsApprovalScript(entry: SimpleCommand): boolean {
  const argv = listTexts(entry.argv)
  const name = nameHead(entry)
  const isInterpreter = name === '.' || interpreter.test(name)
  const stdin = entry.redirects.filter(redirect => /^0?<$/.test(redirect.operator)).map(redirect => redirect.target.text)
  // why: any operand of an interpreter may be its script, since an option before it can take a value.
  const scripts = isInterpreter ? [...argv.slice(1).filter(word => !word.startsWith('-')), ...stdin] : argv.slice(0, 1)
  return scripts.some(word => commandName(word) === approvalScript)
}

/**
 * Refuses an agent command that runs the approval script, or types it through herdr into a pane or an agent's prompt.
 * @param command - The raw Bash command.
 * @returns The deny reason, or undefined when the command does not run the script.
 */
export function judgeApprovalBash(command: string): string | undefined {
  if (!command.includes(approvalScript)) return undefined
  if (herdrTyping.test(command)) return herdrApprovalDeny
  const commands = readCommands(command)
  return commands === undefined || commands.some(runsApprovalScript) ? approvalBashDeny : undefined
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
 * Lists the heredocs a line opens.
 * @param text - The line.
 * @param line - Its 1-based number in the command.
 * @param isShell - Whether the line is shell, where a quoted operator is only text; a body line's quotes belong to another language.
 * @returns One heredoc per operator, in order.
 */
function listHeredocs(text: string, line: number, isShell: boolean): Heredoc[] {
  return [...text.matchAll(heredocOperator)].filter(match => !isShell || !isQuoted(text, match.index))
    .map(match => ({ delimiter: match[3]!, isTabStripped: match[1] === '-', opened: line }))
}

/**
 * Refuses a command whose heredoc body opens another heredoc with the same delimiter and goes on after its first closing line: the outer
 * heredoc closes at the first line that is its delimiter alone, so the lines after it are no longer its body. The guard reads `<<` line by
 * line, so an operator inside a multi-line string or an arithmetic shift may look like an opener Bash never sees; the refusal says so.
 * @param command - The raw Bash command.
 * @returns The deny reason, naming the line where the heredoc closes and the first non-empty line after it, or undefined when none follows.
 */
export function judgeHeredocBash(command: string): string | undefined {
  const lines = command.split('\n')
  const bodies: Heredoc[] = []
  for (const [index, text] of lines.entries()) {
    const body = bodies[0]
    if (body === undefined) {
      bodies.push(...listHeredocs(text, index + 1, true))
    } else if ((body.isTabStripped ? text.replace(/^\t+/, '') : text) === body.delimiter) {
      // why: Bash runs a line of any character but space and tab, a carriage return among them.
      const next = lines.findIndex((line, after) => after > index && /[^ \t]/.test(line))
      if (body.reopened !== undefined && next >= 0) {
        return markForAgent(`Line ${body.opened} reads as opening a heredoc with the delimiter ${body.delimiter}. If it does, that heredoc closes at line ${index + 1}, `
          + `the first line that is ${body.delimiter} alone, though its body opens another heredoc with the same delimiter on line ${body.reopened}; `
          + `non-empty lines follow from line ${next + 1}, and Bash no longer reads them as that heredoc's body. `
          + 'Write the file with the Edit or Write tool, or give the outer heredoc a delimiter its body does not contain.')
      }
      bodies.shift()
    } else if (body.reopened === undefined && listHeredocs(text, index + 1, false).some(inner => inner.delimiter === body.delimiter)) {
      body.reopened = index + 1
    }
  }
  return undefined
}

/**
 * Tells whether a path names the records directory, after collapsing the `//` and `/./` that would hide it.
 * @param path - The path as written.
 * @returns Whether it lies under the records directory.
 */
const namesRecords = (path: string): boolean => recordsPath.test(path.replace(/\/(\.?\/)+/g, '/'))

/**
 * Names what a word holds that the guard cannot resolve to a path: an expansion, or the word itself when it is a glob.
 * @param word - The word.
 * @returns The expansion or the glob as written, or undefined when the word is literal.
 */
const describeDynamic = (word: Word): string | undefined => word.expansion ?? (word.isGlob ? word.text : undefined)

/**
 * Explains a refusal of a write under the records that the parsed command makes.
 * @param token - The command or redirection that writes, as written.
 * @returns The deny reason.
 */
const writesRecordsDeny = (token: string): string => markForAgent(`${recordsRule} This command writes there through \`${token}\`.`)

/**
 * Explains a refusal of a line that names the records but holds what the guard does not analyse: it says no write was seen, only
 * that none can be ruled out.
 * @param reason - What the line holds, naming the construct.
 * @param advice - What to do instead, true for that construct.
 * @returns The deny reason.
 */
const unanalysedRecordsDeny = (reason: string, advice = splitAdvice): string => markForAgent(`${recordsRule} This line names the records directory and ${reason}, `
  + `so a write under the records cannot be ruled out. ${advice}`)

/**
 * Judges one parsed command against the records: a write redirection, or a written operand of a command in the table, under them is
 * refused, naming its token; an expansion or a glob there, any inline code, which may write wherever it likes, or a command outside the
 * closed table is refused as unanalysed, naming it.
 * @param entry - The command.
 * @returns The deny reason, or undefined when the command writes nothing under the records.
 */
function judgeRecordsCommand(entry: SimpleCommand): string | undefined {
  // why: only a literal path is known to be written; one the shell still expands may match nothing, so it is refused as unanalysed.
  const isLiteralRecord = (word: Word): boolean => describeDynamic(word) === undefined && namesRecords(word.text)
  for (const redirect of entry.redirects) {
    const isDuplicate = redirect.operator.endsWith('>&') && /^(\d+-?|-)$/.test(redirect.target.text)
    if (!writeRedirect.test(redirect.operator) || isDuplicate) continue
    if (isLiteralRecord(redirect.target)) return writesRecordsDeny(redirect.operator)
    const dynamic = describeDynamic(redirect.target)
    if (dynamic) return unanalysedRecordsDeny(`the target of \`${redirect.operator}\` holds \`${dynamic}\`, which the guard does not expand`)
  }
  const outside = describeOutsideTable(entry)
  const write = outside === undefined ? findWriteCommand(entry) : undefined
  const written = write === undefined ? [] : listWrittenOperands(entry)
  if (write !== undefined && written.some(isLiteralRecord)) return writesRecordsDeny(write)
  const dynamic = written.map(describeDynamic).find(Boolean)
  if (dynamic) return unanalysedRecordsDeny(`an operand of \`${write}\` holds \`${dynamic}\`, which the guard does not expand`)
  const inline = entry.inlineCode
  if (inline) return unanalysedRecordsDeny(`runs inline code through \`${inline.flag}\`, which the guard does not analyse`)
  if (outside === undefined) return undefined
  return outside.isProgram
    ? unanalysedRecordsDeny(`runs \`${outside.construct}\`, which is not in the guard's table of known commands`, readAdvice)
    : unanalysedRecordsDeny(`uses \`${outside.construct}\`, a form outside the guard's table of known commands`, formAdvice)
}

/**
 * Refuses a command that writes under the records directory, as a best effort: a shell can always reach the file some other way.
 * Only a line that names the records path is judged. It is judged command by command when the parser reads it; when it holds a construct
 * outside the parsed subset, the whole commands before that construct are judged first, then the line is refused, naming the construct,
 * since no write can be ruled out. That fallback is stricter than the raw-line rule it replaces, which also needed a write word: a line such
 * as `find … -delete` or `python3 -c` holds none. A line that hides the path, as `.gi?/working-agreement` or `$d/working-agreement` do,
 * is not judged at all.
 * @param command - The raw Bash command.
 * @returns The deny reason, or undefined when the command does not write there.
 */
export function judgeRecordsBash(command: string): string | undefined {
  if (!recordsPath.test(command)) return undefined
  if (herdrTyping.test(command)) return unanalysedRecordsDeny('types text through `herdr`, which then runs in another terminal the guard does not analyse')
  const line = parseShell(command)
  const deny = line.commands.map(judgeRecordsCommand).find(Boolean)
  if (deny !== undefined || line.kind === 'parsed') return deny
  return unanalysedRecordsDeny(`contains \`${line.construct}\`, which the guard does not analyse`)
}

/**
 * Refuses a file tool's write under the mailbox directory; the file tools' own judgement refuses the rest of the records directory.
 * @param path - The path the tool writes.
 * @returns The deny reason, or undefined when the path is elsewhere.
 */
export function judgeMailboxWrite(path: string): string | undefined {
  return mailboxPath.test(path) ? recordsDeny : undefined
}
