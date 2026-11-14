/** A word after quote removal, with where it starts in the line and what the shell would still expand in it. */
export interface Word {
  text: string
  at: number
  /** The first parameter or tilde expansion the word holds, as written. */
  expansion?: string
  isGlob: boolean
}

/** A redirection: its operator as written, with any file descriptor, where it starts, and its target word, which for a heredoc is the delimiter. */
interface Redirect {
  operator: string
  at: number
  target: Word
}

/** An interpreter's inline code: the option or program that carries it, as written, and the code. */
interface InlineCode {
  flag: string
  code: Word
}

/** One simple command, after its assignments and the wrappers that run it. */
export interface SimpleCommand {
  /** The command and its words, head first; empty when the command holds only assignments or redirections. */
  argv: Word[]
  /** Git's subcommand after git's global options, or gh's first operand after its repository option. */
  subcommand?: Word
  /** The words after the subcommand, or after the head when there is none. */
  args: Word[]
  redirects: Redirect[]
  inlineCode?: InlineCode
  /** The first assignment the command runs with, before it or given to env, which may set a variable that runs a program, such as LESSOPEN. */
  assignment?: Word
  /** Whether the command reads the output of the command before it through a pipe. */
  isPiped: boolean
}

/** A line inside the subset: its simple commands in order. */
interface ParsedLine {
  kind: 'parsed'
  commands: SimpleCommand[]
}

/** A line with a construct outside the subset: the earliest one in line order, as written, and the whole commands before it. */
interface UnmodelledLine {
  kind: 'unmodelled'
  construct: string
  commands: SimpleCommand[]
}

/** A heredoc whose body starts on the next line. */
interface PendingHeredoc {
  delimiter: string
  isTabStripped: boolean
  isQuoted: boolean
}

/** A quoted string's text and the first expansion it holds. */
interface QuotedText {
  text: string
  expansion?: string
}

/** A reader's cursor over a word: its position, its parts so far and what it would expand. */
interface WordState {
  at: number
  parts: string[]
  expansion?: string
  isGlob: boolean
}

/** The words and redirections of one simple command, before it is built. */
interface Segment {
  words: Word[]
  redirects: Redirect[]
  isPiped: boolean
}

/** The tokenizer's cursor, the heredocs whose bodies start on the next line, and the tokens so far. */
interface TokenizerState {
  at: number
  pending: PendingHeredoc[]
  tokens: Token[]
}

/** The tokens of a line, up to the construct that stopped the tokenizer, if any. */
interface Tokens {
  tokens: Token[]
  failure?: OutsideSubset
}

/** A value read from the line, with the position after it. */
interface Read<T> {
  value: T
  at: number
}

/** A word of a command line. */
interface WordToken {
  kind: 'word'
  word: Word
}

/** A list or pipe operator; a newline reads as `;`. */
interface OperatorToken {
  kind: 'operator'
  operator: string
}

/** A redirection and its target. */
interface RedirectToken {
  kind: 'redirect'
  redirect: Redirect
}

/** The options a wrapper takes before the command it runs. */
interface WrapperOptions {
  bare: string[]
  valued: string[]
  /** Options that change what or where the command runs in a way the guards do not follow. */
  unmodelled: string[]
  /** How many operands come before the command, such as timeout's duration. */
  operands: number
}

/** A parsed line, or the first construct that keeps it outside the subset. */
export type ShellLine = ParsedLine | UnmodelledLine
type Token = WordToken | OperatorToken | RedirectToken

/** The names of the shells a command may run, as a pattern source. */
export const shellNames = '(ba|z|da|k)?sh'
// why: A script file hides its words from the guards; an interpreter's first operand that is a file is the script it runs.
export const interpreter = new RegExp(`^(${shellNames}|python[\\d.]*|node|perl|ruby|deno|bun|tsx|ts-node|source)$`)
const shell = new RegExp(`^${shellNames}$`)
const awk = /^[gmn]?awk$/
// why: An interpreter given one of these as its script reads it from stdin, which the line feeds it.
const stdinScripts = new Set(['-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'])
const metachars = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')'])
const operatorPattern = /^(&&|\|\||\|&|\|)/
const redirectPattern = /^(\d*)(&>>|&>|<<<|<<-|<<|<>|<&|<\(|>\(|>>|>\||>&|<|>)/
const leadingAssignment = /^[A-Za-z_]\w*\+?=/
// why: an assignment before a command, or one env gives it, whose name may hold a dot.
const assignmentWord = /^[^-=][^=]*=/
// why: Each of these opens a compound command, whose body the parser does not read as simple commands.
const reservedWords = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function', '!', '[[', ']]', '{', '}', 'coproc'])
// why: Each of these changes the directory later commands run in, runs a shell, or runs a command the line spells only as data.
const unmodelledHeads = new Set(['cd', 'pushd', 'popd', 'eval', 'xargs', 'su', 'runuser'])
// why: find runs these commands or writes these files itself.
const findActions = new Set(['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'])
const wrappers = new Map<string, WrapperOptions>([
  ['env', { bare: ['-', '-i', '-0', '-v', '--ignore-environment', '--null', '--debug'], valued: ['-u', '--unset'], unmodelled: ['-C', '--chdir', '-S', '--split-string'], operands: 0 }],
  ['command', { bare: ['-p'], valued: [], unmodelled: [], operands: 0 }],
  ['builtin', { bare: [], valued: [], unmodelled: [], operands: 0 }],
  ['exec', { bare: ['-c', '-l'], valued: ['-a'], unmodelled: [], operands: 0 }],
  ['nice', { bare: [], valued: ['-n', '--adjustment'], unmodelled: [], operands: 0 }],
  ['nohup', { bare: [], valued: [], unmodelled: [], operands: 0 }],
  ['timeout', { bare: ['--preserve-status', '--foreground', '-v', '--verbose'], valued: ['-s', '--signal', '-k', '--kill-after'], unmodelled: [], operands: 1 }],
  ['time', { bare: ['-p'], valued: [], unmodelled: [], operands: 0 }],
  ['sudo', {
    bare: ['-E', '-H', '-n', '-S', '-b', '-k', '-P', '-A', '-B', '--preserve-env', '--non-interactive', '--set-home', '--stdin', '--background'],
    valued: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-T', '--command-timeout', '-r', '--role', '-t', '--type', '-U', '--other-user'],
    unmodelled: ['-i', '-s', '--login', '--shell', '-D', '--chdir', '-e', '--edit'], operands: 0,
  }],
  ['doas', { bare: ['-n', '-L'], valued: ['-u'], unmodelled: ['-s', '-C'], operands: 0 }],
])
const gitValued = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']
const gitBare = ['--no-pager', '-p', '-P', '--paginate', '--bare', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks', '--no-advice', '--no-lazy-fetch', '--exec-path', '--html-path', '--man-path', '--info-path', '--version', '-v', '--help', '-h']

/** Stops the parse at a construct outside the subset, where it starts in the line. */
class OutsideSubset extends Error {
  /**
   * Names the construct.
   * @param construct - The construct as written.
   * @param at - Where it starts in the line.
   */
  constructor(readonly construct: string, readonly at: number) {
    super(construct)
  }
}

/**
 * Names the command a word runs, without its directory.
 * @param word - The command word, a bare name or a path.
 * @returns The part after its last slash.
 */
export function commandName(word: string): string {
  return word.split('/').pop() ?? ''
}

/**
 * Stops the parse at a construct outside the subset.
 * @param construct - The construct as written.
 * @param at - Where it starts in the line.
 * @returns Never: it throws.
 */
function outside(construct: string, at: number): never {
  throw new OutsideSubset(construct, at)
}

/**
 * Reads a `$` expansion; command substitution and the quoting forms after `$` are outside the subset.
 * @param source - The line.
 * @param start - The position of the `$`.
 * @param isQuoted - Whether the `$` stands inside double quotes.
 * @returns The expansion as written, empty for a lone `$`, with the position after it.
 */
function readDollar(source: string, start: number, isQuoted: boolean): Read<string> {
  const next = source[start + 1] ?? ''
  if (next === '(') outside('$(', start)
  if (!isQuoted && (next === '\'' || next === '"')) outside(`$${next}`, start)
  if (next === '{') {
    const end = source.indexOf('}', start)
    if (end < 0 || /[$`]/.test(source.slice(start + 2, end))) outside('${', start)
    return { value: source.slice(start, end + 1), at: end + 1 }
  }
  const name = /^([A-Za-z_]\w*|[0-9@*#?$!-])/.exec(source.slice(start + 1))?.[0]
  return name === undefined ? { value: '', at: start + 1 } : { value: `$${name}`, at: start + 1 + name.length }
}

/**
 * Reads a double-quoted string, where `$` still expands.
 * @param source - The line.
 * @param start - The position of the opening quote.
 * @returns The text without its quotes and its first expansion, with the position after the closing quote.
 */
function readDoubleQuoted(source: string, start: number): Read<QuotedText> {
  const state: WordState = { at: start + 1, parts: [], isGlob: false }
  while (source[state.at] !== '"') {
    const char = source[state.at]
    if (char === undefined) outside('"', start)
    if (char === '`') outside('`', state.at)
    if (char === '\\' && source[state.at + 1] === '\n') outside('\\', state.at)
    if (char === '\\' && '$`"\\'.includes(source[state.at + 1] ?? '')) {
      state.parts.push(source[state.at + 1]!)
      state.at += 2
    } else if (char === '$') {
      const dollar = readDollar(source, state.at, true)
      state.expansion ??= dollar.value || undefined
      state.parts.push(dollar.value || '$')
      state.at = dollar.at
    } else {
      state.parts.push(char)
      state.at += 1
    }
  }
  return { value: { text: state.parts.join(''), expansion: state.expansion }, at: state.at + 1 }
}

/**
 * Reads one word up to the next unquoted metacharacter, removing its quotes.
 * @param source - The line.
 * @param start - The word's first position.
 * @returns The word, with the position after it.
 */
function readWord(source: string, start: number): Read<Word> {
  const state: WordState = { at: start, parts: [], isGlob: false }
  while (state.at < source.length && !metachars.has(source[state.at]!)) {
    const char = source[state.at]!
    if (char === '`') outside('`', state.at)
    if (char === '\\') {
      const next = source[state.at + 1]
      if (next === undefined || next === '\n') outside('\\', state.at)
      state.parts.push(next)
      state.at += 2
    } else if (char === '\'') {
      const end = source.indexOf('\'', state.at + 1)
      if (end < 0) outside('\'', state.at)
      state.parts.push(source.slice(state.at + 1, end))
      state.at = end + 1
    } else if (char === '"') {
      const quoted = readDoubleQuoted(source, state.at)
      state.expansion ??= quoted.value.expansion
      state.parts.push(quoted.value.text)
      state.at = quoted.at
    } else if (char === '$') {
      const dollar = readDollar(source, state.at, false)
      state.expansion ??= dollar.value || undefined
      state.parts.push(dollar.value || '$')
      state.at = dollar.at
    } else {
      // why: a glob or a brace expansion names paths the guard cannot list, and a leading tilde names the home directory.
      if ('*?[{'.includes(char)) state.isGlob = true
      if (char === '~' && state.at === start) state.expansion ??= '~'
      state.parts.push(char)
      state.at += 1
    }
  }
  return { value: { text: state.parts.join(''), at: start, expansion: state.expansion, isGlob: state.isGlob }, at: state.at }
}

/**
 * Reads the bodies of the heredocs a line opened, in order, from the line after it; a body ends at the line that is its delimiter alone.
 * @param source - The command.
 * @param start - The first position after the line's newline.
 * @param pending - The heredocs the line opened.
 * @returns The position after the last body.
 */
function readBodies(source: string, start: number, pending: readonly PendingHeredoc[]): number {
  const state = { at: start }
  for (const heredoc of pending) {
    const lines: string[] = []
    const bodyAt = state.at
    while (state.at < source.length) {
      const end = source.indexOf('\n', state.at)
      const line = source.slice(state.at, end < 0 ? source.length : end)
      state.at = end < 0 ? source.length : end + 1
      if ((heredoc.isTabStripped ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) break
      lines.push(line)
    }
    // why: an unquoted delimiter leaves the body open to expansion, so a substitution in it runs.
    const body = heredoc.isQuoted ? '' : lines.join('\n')
    if (body.includes('$(')) outside('$(', bodyAt + body.indexOf('$('))
    if (body.includes('`')) outside('`', bodyAt + body.indexOf('`'))
  }
  return state.at
}

/**
 * Splits a command line into words, operators and redirections, skipping comments and heredoc bodies, up to the first construct outside the subset.
 * @param source - The command.
 * @returns The tokens in order, and the construct that stopped the tokenizer, if any.
 */
function tokenize(source: string): Tokens {
  const state: TokenizerState = { at: 0, pending: [], tokens: [] }
  try {
    while (state.at < source.length) {
      const char = source[state.at]!
      const rest = source.slice(state.at)
      const operator = operatorPattern.exec(rest)?.[0]
      const redirect = redirectPattern.exec(rest)
      const last = state.tokens[state.tokens.length - 1]
      if (char === ' ' || char === '\t') {
        state.at += 1
      } else if (char === '\n') {
        // why: a newline after |, && or || continues the same list, as in Bash.
        if (last?.kind !== 'operator' || last.operator === ';') state.tokens.push({ kind: 'operator', operator: ';' })
        state.at = readBodies(source, state.at + 1, state.pending)
        state.pending = []
      } else if (char === '#') {
        const end = source.indexOf('\n', state.at)
        state.at = end < 0 ? source.length : end
      } else if (char === '(' || char === ')') {
        outside(char, state.at)
      } else if (operator !== undefined) {
        state.tokens.push({ kind: 'operator', operator: operator === '|&' ? '|' : operator })
        state.at += operator.length
      } else if (rest.startsWith(';;') || rest.startsWith(';&')) {
        outside(rest.slice(0, 2), state.at)
      } else if (char === ';') {
        state.tokens.push({ kind: 'operator', operator: ';' })
        state.at += 1
      } else if (redirect !== null) {
        const op = redirect[0]
        if (redirect[2] === '<(' || redirect[2] === '>(') outside(redirect[2], state.at + redirect[1]!.length)
        const targetAt = state.at + op.length + (/^[ \t]*/.exec(source.slice(state.at + op.length))?.[0].length ?? 0)
        const substitution = /^[<>]\(/.exec(source.slice(targetAt))?.[0]
        if (substitution) outside(substitution, targetAt)
        if (targetAt >= source.length || metachars.has(source[targetAt]!)) outside(op, state.at)
        const target = readWord(source, targetAt)
        if (redirect[2] === '<<' || redirect[2] === '<<-') {
          state.pending.push({ delimiter: target.value.text, isTabStripped: redirect[2] === '<<-', isQuoted: /['"\\]/.test(source.slice(targetAt, target.at)) })
        }
        state.tokens.push({ kind: 'redirect', redirect: { operator: op, at: state.at, target: target.value } })
        state.at = target.at
      } else if (char === '&') {
        outside('&', state.at)
      } else {
        const word = readWord(source, state.at)
        state.tokens.push({ kind: 'word', word: word.value })
        state.at = word.at
      }
    }
    return { tokens: state.tokens }
  } catch (error) {
    if (error instanceof OutsideSubset) return { tokens: state.tokens, failure: error }
    throw error
  }
}

/**
 * Drops a wrapper's options, and its operands before the command it runs.
 * @param name - The wrapper.
 * @param options - The options it takes.
 * @param words - The words after it.
 * @returns The words from the command it runs.
 */
function dropWrapperOptions(name: string, options: WrapperOptions, words: Word[]): Word[] {
  const [first, ...rest] = words
  if (first === undefined) return []
  const text = first.text
  const flag = text.split('=')[0]!
  if (text === '--') return rest.slice(options.operands)
  // why: env takes any word with `=` that is not an option as an assignment, a dotted name such as A.B=c included.
  const isAssignment = name === 'env' && /^[^-=][^=]*=/.test(text)
  if (isAssignment || (name === 'nice' && /^-\d+$/.test(text)) || options.bare.includes(text)) return dropWrapperOptions(name, options, rest)
  if (!text.startsWith('-')) return words.slice(options.operands)
  if (options.unmodelled.includes(flag) || options.unmodelled.includes(text.slice(0, 2))) outside(`${name} ${flag}`, first.at)
  if (options.valued.includes(flag)) return dropWrapperOptions(name, options, text.includes('=') ? rest : rest.slice(1))
  if (options.valued.includes(text.slice(0, 2))) return dropWrapperOptions(name, options, rest)
  return outside(`${name} ${text}`, first.at)
}

/**
 * Skips the wrappers that run the next word as the command, however deep.
 * @param words - The words from the first one that is not an assignment.
 * @returns The words from the command that runs.
 */
function unwrap(words: Word[]): Word[] {
  const name = commandName(words[0]?.text ?? '')
  const options = wrappers.get(name)
  // why: command -v and -V only look a name up; they run nothing.
  if (options === undefined || (name === 'command' && /^-[a-zA-Z]*[vV]/.test(words[1]?.text ?? ''))) return words
  return unwrap(dropWrapperOptions(name, options, words.slice(1)))
}

/**
 * Drops git's global options before its subcommand.
 * @param words - The words after git.
 * @returns The words from the subcommand.
 */
function dropGitOptions(words: Word[]): Word[] {
  const [first, ...rest] = words
  if (first === undefined || !first.text.startsWith('-')) return words
  const flag = first.text.split('=')[0]!
  if (gitBare.includes(first.text)) return dropGitOptions(rest)
  if (gitValued.includes(flag)) return dropGitOptions(first.text.includes('=') ? rest : rest.slice(1))
  return outside(`git ${first.text}`, first.at)
}

/**
 * Drops gh's repository option, which gh takes before and after a subcommand.
 * @param words - The words after gh or one of its subcommands.
 * @returns The words without the repository option and its value.
 */
export function dropGhRepository(words: Word[]): Word[] {
  const index = words.findIndex(word => /^(-R|--repo)(=|$)|^-R./.test(word.text))
  if (index < 0) return words
  const isSeparate = /^(-R|--repo)$/.test(words[index]!.text)
  return dropGhRepository([...words.slice(0, index), ...words.slice(index + (isSeparate ? 2 : 1))])
}

/**
 * Finds the program awk runs from its first operand, unless a file gives it.
 * @param argv - The command, head first.
 * @returns The program as inline code, or undefined when awk reads it from a file.
 */
function findAwkProgram(argv: Word[]): InlineCode | undefined {
  const words = argv.slice(1)
  const index = words.findIndex((word, at) => !word.text.startsWith('-') && !/^-[Fv]$/.test(words[at - 1]?.text ?? ''))
  if (words.some(word => /^-f|^--file/.test(word.text)) || index < 0) return undefined
  return { flag: commandName(argv[0]!.text), code: words[index]! }
}

/**
 * Finds the inline code an interpreter runs from an option, before its first operand.
 * @param name - The interpreter.
 * @param argv - The command, head first.
 * @returns The option and its code, or undefined when the interpreter runs no inline code.
 */
function findInlineCode(name: string, argv: Word[]): InlineCode | undefined {
  const letters = shell.test(name) || name.startsWith('python') ? 'c' : name === 'perl' ? 'eE' : name === 'ruby' ? 'e' : name === 'source' ? '' : 'ep'
  const empty: Word = { text: '', at: argv[0]!.at, isGlob: false }
  if (name === 'deno' && argv[1]?.text === 'eval') return { flag: 'eval', code: argv[2] ?? empty }
  const options = argv.slice(1)
  const end = options.findIndex(word => !word.text.startsWith('-') || word.text === '-' || word.text === '--')
  for (const [index, word] of (end < 0 ? options : options.slice(0, end)).entries()) {
    const long = /^--(eval|print)(=|$)/.exec(word.text)
    const short = letters === '' ? null : new RegExp(`^-[a-zA-Z0-9]*?[${letters}]`).exec(word.text)
    const match = name === 'perl' || name === 'ruby' || letters === 'c' ? short : long ?? short
    if (match === null) continue
    const attached = word.text.slice(match[0].length)
    const code = attached === '' ? options[index + 1] : { ...word, text: attached }
    return { flag: match[0].replace(/=$/, ''), code: code ?? empty }
  }
  return undefined
}

/**
 * Builds a simple command from its words and redirections, stopping at a construct outside the subset.
 * @param segment - Its words, assignments first, its redirections and whether it reads a pipe.
 * @param isPartial - Whether the tokenizer stopped inside it, so the checks that need the whole command are left out.
 * @returns The command.
 */
function buildCommand(segment: Segment, isPartial: boolean): SimpleCommand {
  const { words, redirects, isPiped } = segment
  const start = words.findIndex(word => !leadingAssignment.test(word.text))
  if (start >= 0 && reservedWords.has(words[start]!.text)) outside(words[start]!.text, words[start]!.at)
  const argv = start < 0 ? [] : unwrap(words.slice(start))
  const head = argv[0]
  // why: the words before the command are its assignments and its wrappers' words, among which env's assignments.
  const assignment = words.slice(0, words.length - argv.length).find(word => assignmentWord.test(word.text))
  if (head === undefined) return { argv, args: [], redirects, assignment, isPiped }
  if (reservedWords.has(head.text)) outside(head.text, head.at)
  if (head.expansion !== undefined || head.isGlob) outside(head.text, head.at)
  const name = commandName(head.text)
  if (unmodelledHeads.has(name)) outside(name, head.at)
  const action = name === 'find' ? argv.find(word => findActions.has(word.text)) : undefined
  if (action) outside(action.text, action.at)
  const inlineCode = awk.test(name) ? findAwkProgram(argv) : interpreter.test(name) ? findInlineCode(name, argv) : undefined
  if (interpreter.test(name) && !isPartial) {
    const stdin = redirects.find(redirect => /^\d*(<<-?|<<<)$/.test(redirect.operator))
    if (stdin) outside(stdin.operator.replace(/^\d+/, ''), stdin.at)
    const fromStdin = argv.slice(1).find(word => stdinScripts.has(word.text) || (shell.test(name) && /^-[a-zA-Z]*s[a-zA-Z]*$/.test(word.text)))
    if (fromStdin) outside(`${name} ${fromStdin.text}`, fromStdin.at)
    const hasScript = argv.slice(1).some(word => !word.text.startsWith('-')) || redirects.some(redirect => /^0?<$/.test(redirect.operator))
    if (isPiped && inlineCode === undefined && !hasScript) outside(name, head.at)
  }
  const rest = name === 'git' ? dropGitOptions(argv.slice(1)) : name === 'gh' ? dropGhRepository(argv.slice(1)) : undefined
  return rest === undefined ? { argv, args: argv.slice(1), redirects, inlineCode, assignment, isPiped }
    : { argv, subcommand: rest[0], args: rest.slice(1), redirects, inlineCode, assignment, isPiped }
}

/**
 * Groups tokens into the segments of simple commands, split at each operator.
 * @param tokens - The tokens in order.
 * @returns The segments that hold a word or a redirection.
 */
function splitSegments(tokens: readonly Token[]): Segment[] {
  const segments: Segment[] = [{ words: [], redirects: [], isPiped: false }]
  for (const token of tokens) {
    const segment = segments[segments.length - 1]!
    if (token.kind === 'word') segment.words.push(token.word)
    else if (token.kind === 'redirect') segment.redirects.push(token.redirect)
    else segments.push({ words: [], redirects: [], isPiped: token.operator === '|' })
  }
  return segments.filter(segment => segment.words.length > 0 || segment.redirects.length > 0)
}

/**
 * Parses a Bash command line within a closed subset: simple commands joined by `;`, `&&`, `||`, `|` and newlines, quotes, redirections
 * and heredocs, behind the wrappers that run the next word. Anything else stops the parse at the earliest such construct in line order,
 * naming it, so a guard judges the line by its own fallback rule instead; which programs a guard judges by structure is the table in
 * shell-table.ts. A heredoc's body ends at its first line that is the delimiter alone, as in Bash.
 * @param command - The command line as the model wrote it.
 * @returns Its simple commands, or the earliest construct outside the subset with the whole commands before it.
 */
export function parseShell(command: string): ShellLine {
  const { tokens, failure } = tokenize(command)
  const segments = splitSegments(tokens)
  const commands: SimpleCommand[] = []
  for (const [index, segment] of segments.entries()) {
    const isPartial = failure !== undefined && index === segments.length - 1
    try {
      const built = buildCommand(segment, isPartial)
      if (!isPartial) commands.push(built)
    } catch (error) {
      if (!(error instanceof OutsideSubset)) throw error
      const first = failure !== undefined && failure.at < error.at ? failure : error
      return { kind: 'unmodelled', construct: first.construct, commands }
    }
  }
  return failure === undefined ? { kind: 'parsed', commands } : { kind: 'unmodelled', construct: failure.construct, commands }
}
