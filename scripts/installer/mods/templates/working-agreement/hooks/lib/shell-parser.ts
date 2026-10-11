import { normalizePath } from './paths'

/** A word of a command line; a redirect operator is a word of its own, and a quoted word names a program only where it opens its run. */
interface Word { text: string; isRedirect?: boolean; isQuoted?: boolean }

/**
 * Where a command line runs: the shell's working directory, null when unknown, and the home directory `~` stands for,
 * omitted when unknown.
 */
export interface ShellContext { cwd: string | null; home?: string }

/** A file a command writes: its absolute path, or null when the line hides it (a variable, a substitution, a directory it cannot name). */
export type WriteTarget = string | null

// Where the scan of a command stands: the segments built so far, the index of the next character to read, the word
// being built, the open quote, and the open parentheses, each a subshell's id or null for the ( of a substitution.
interface ScanState { next: number; segments: Segment[]; word: string; isWord: boolean; isQuoted: boolean; quote: string | null; parens: (number | null)[]; subshells: number }

// A segment of a line: its words and the ids of the subshells it runs in, outermost first.
interface Segment { words: Word[]; scope: number[] }

// A substitution in a line: where it starts and ends in the text, and the code it runs.
interface Substitution { start: number; end: number; body: string }

// Where the search for substitutions stands: those found, the next index to read, the open quote, and whether a substitution never closed.
interface SubstitutionScan { found: Substitution[]; next: number; quote: string; isUnclosed: boolean }

// A command a line runs: its words and the directory it runs in, null when the line moved to one it cannot name.
interface Run { words: Word[]; directory: string | null }

// The commands a line runs, in order, and the directory the line leaves its shell in.
interface Parse { runs: Run[]; directory: string | null }

// A parse in progress: the commands found so far and the directory of each scope opened.
interface ParseState { runs: Run[]; directories: Record<number, string | null> }

/**
 * A command found in a parsed line: the words that matched, the words after them, and the variables that
 * earlier segments of the line assigned (the last assignment wins).
 */
interface ParsedInvocation { isParsed: true; args: string[]; vars: Record<string, string> }

/** A command found by matching the whole line, because the line could not be parsed: only the words that matched are known. */
interface FallbackInvocation { isParsed: false }

/** A command a line runs, found in the parsed words or, for an unparseable line, in the whole text. */
export type Invocation = ParsedInvocation | FallbackInvocation

// Matches a heredoc and its body; the replacement `$3` keeps what follows the delimiter on its line.
const heredoc = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g

// Stands for a substitution in a line while the line is split into words.
const placeholder = /\u0000(\d+)\u0000/g

// The programs that write the files their arguments name.
const writers = /^(?:tee|cp|mv|sed)$/

// The scope of the line itself, outside any subshell.
const lineScope = -1

// Adds a word to the last segment, which runs in the subshells open at its first word.
const addWord = (state: ScanState, word: Word): ScanState => {
  const last = state.segments.at(-1)!
  const scope = last.words.length ? last.scope : state.parens.filter((id): id is number => id !== null)
  return { ...state, segments: [...state.segments.slice(0, -1), { words: [...last.words, word], scope }] }
}

// Ends the word being built, if any, and starts a new one.
const endWord = (state: ScanState): ScanState => {
  const cleared = { ...state, word: '', isWord: false, isQuoted: false }
  if (!state.isWord) return cleared
  return addWord(cleared, state.isQuoted ? { text: state.word, isQuoted: true } : { text: state.word })
}

// Appends a character to the word being built.
const appendCharacter = (state: ScanState, character: string): ScanState => ({ ...state, word: state.word + character, isWord: true })

// Reads the > at `index` with the operator that follows it, and the descriptor or file a > & names.
function readRedirect(text: string, state: ScanState, index: number): ScanState {
  const bare = !state.isQuoted && /^\d+$/.test(state.word) ? { ...state, word: '', isWord: false } : state
  const ended = endWord(bare)
  const operator = text[index + 1] === '>' || text[index + 1] === '|' ? index + 1 : index
  // >&2 and >&- duplicate or close a descriptor; >&file writes to a file, as > does.
  const duplicate = text[operator + 1] === '&' ? /^(?:\d+|-)(?=[\s;|&)]|$)/.exec(text.slice(operator + 2)) : null
  if (duplicate) return { ...ended, next: operator + 2 + duplicate[0].length }
  const last = text[operator + 1] === '&' ? operator + 1 : operator
  return { ...addWord(ended, { text: '>', isRedirect: true }), next: last + 1 }
}

// Reads the character at `index`, and any it consumes with it, into a new state.
function readCharacter(text: string, state: ScanState, index: number): ScanState {
  const character = text[index]!
  const advanced = { ...state, next: index + 1 }
  // A line continuation: the shell drops the backslash and the newline everywhere but inside single quotes.
  if (character === '\\' && text[index + 1] === '\n' && state.quote !== "'") return { ...advanced, next: index + 2 }
  if (state.quote) return character === state.quote ? { ...advanced, quote: null } : appendCharacter(advanced, character)
  if (character === "'" || character === '"') return { ...advanced, quote: character, isWord: true, isQuoted: true }
  // A lone & ends a segment too, unless it belongs to &> or <&.
  const isAmpersand = character === '&' && text[index + 1] !== '>' && text[index - 1] !== '<'
  if (character === '\n' || character === ';' || character === '|' || isAmpersand) {
    const ended = endWord(advanced)
    const split = { ...ended, segments: [...ended.segments, { words: [], scope: [] }] }
    return text.startsWith('&&', index) || text.startsWith('||', index) ? { ...split, next: index + 2 } : split
  }
  if (character === ')') return endWord({ ...advanced, parens: state.parens.slice(0, -1) })
  // The ( of $( <( >( stays in its word so a substitution reads as one; a subshell's ( breaks words.
  if (character === '(') {
    const isSubshell = !/[$<>]/.test(text[index - 1] ?? '')
    const opened = { ...advanced, parens: [...state.parens, isSubshell ? state.subshells : null], subshells: state.subshells + (isSubshell ? 1 : 0) }
    return isSubshell ? endWord(opened) : appendCharacter(opened, character)
  }
  if (/\s/.test(character)) return endWord(advanced)
  if (character === '>') return readRedirect(text, advanced, index)
  return appendCharacter(advanced, character)
}

// Splits a command into segments of words: quotes group, unquoted ; | & && || newline split,
// an unquoted >, >>, >| or >&file becomes a redirect marker (an fd prefix and >&n duplications are dropped).
function scanWords(text: string) {
  const start: ScanState = { next: 0, segments: [{ words: [], scope: [] }], word: '', isWord: false, isQuoted: false, quote: null, parens: [], subshells: 0 }
  // A character a longer token already consumed is skipped.
  const scanned = text.split('').reduce((state, _character, index) => (index < state.next ? state : readCharacter(text, state, index)), start)
  const final = endWord(scanned)
  return { segments: final.segments.filter(segment => segment.words.length), isOpen: final.quote !== null }
}

/**
 * Splits a command into segments of words, as the shell would separate them.
 *
 * @param text - The command line.
 * @returns Each segment's words; a redirect is a word of its own, flagged as one.
 */
export const splitShellWords = (text: string): Word[][] => scanWords(text).segments.map(segment => segment.words)

/**
 * Lists the files a shell command writes: redirect targets, tee files, the cp/mv destination and sed -i files, found
 * wherever the line runs code (sh -c, eval, substitutions, behind a prefix or a program path), and resolved as the
 * shell would: a relative path against the directory the last literal cd, pushd or popd before it left, `~` against
 * the home directory.
 *
 * @param command - The command line.
 * @param context - The shell's working directory and home directory.
 * @returns Each written path, absolute, or null where the line hides it; a line the parser cannot follow yields one null.
 *   Paths under /dev are left out.
 */
export function listWriteTargets(command: string, context: ShellContext): WriteTarget[] {
  const parsed = parseLine(command, context.cwd, context.home)
  // A line the parser cannot follow may write anywhere: one target it cannot resolve stands in for its writes.
  if (!parsed) return [null]
  return parsed.runs
    .flatMap(run => listWrittenWords(run.words).map(word => resolvePath(word, run.directory, context.home)))
    .filter(target => target === null || !target.startsWith('/dev/'))
}

/**
 * Tells whether a command line runs a command as one of its own segments, not piped or wrapped.
 *
 * @param command - The command line.
 * @param segment - The command, word for word.
 * @returns True when a segment is exactly that command.
 */
export const hasExactSegment = (command: string, segment: string): boolean =>
  command.split(/&&|;|\n/).some(part => part.trim() === segment)

// The program a word names, whether typed as gh, \gh or /usr/bin/gh.
const readProgramName = (word: string) => word.replace(/^\\/, '').split('/').pop()!

// The words a run hands its programs, leaving out redirects and their targets.
const listCommandWords = (words: Word[]): Word[] => words.filter((word, index) => !word.isRedirect && !words[index - 1]?.isRedirect)

// The index of the first word naming a program the leading patterns match, followed by words the rest match, or -1:
// a prefix such as sudo or timeout does not hide it. A quoted word names a program only where it opens the run, as
// in "cp" a b, so a quoted argument (grep "tee") never does.
const findLead = (run: Word[], lead: RegExp[]): number =>
  run.findIndex((word, index) => (index === 0 || !word.isQuoted) && lead.every((pattern, offset) => pattern.test(offset ? run[index + offset]?.text ?? '' : readProgramName(word.text))))

// The index of the closing ) or backtick of a substitution whose body starts at `from`, or -1 when it never closes.
function findClosing(text: string, from: number, isTick: boolean): number {
  if (isTick) {
    // A backslash escapes the character after it.
    const body = /(?:\\[\s\S]|[^\\`])*`/y
    body.lastIndex = from
    const match = body.exec(text)
    return match ? from + match[0].length - 1 : -1
  }
  const closed = [...text.slice(from).matchAll(/[()]/g)].reduce<{ depth: number; index: number }>(
    (state, match) => {
      if (state.index >= 0) return state
      const depth = state.depth + (match[0] === '(' ? 1 : -1)
      return { depth, index: depth === 0 ? from + match.index : -1 }
    },
    { depth: 1, index: -1 }
  )
  return closed.index
}

// Reads the character at `index` into a new scan state.
function readSubstitution(text: string, state: SubstitutionScan, index: number): SubstitutionScan {
  const character = text[index]!
  const advanced = { ...state, next: index + 1 }
  if (state.quote === "'") return character === "'" ? { ...advanced, quote: '' } : advanced
  if (character === '\\') return { ...advanced, next: index + 2 }
  if (character === '"') return { ...advanced, quote: state.quote ? '' : '"' }
  if (character === "'" && !state.quote) return { ...advanced, quote: "'" }
  if (character === '`' || (/[$<>]/.test(character) && text[index + 1] === '(')) {
    const from = index + (character === '`' ? 1 : 2)
    const end = findClosing(text, from, character === '`')
    if (end < 0) return { ...advanced, isUnclosed: true }
    return { ...advanced, found: [...state.found, { start: index, end: end + 1, body: text.slice(from, end) }], next: end + 1 }
  }
  return advanced
}

// The $(...), <(...), >(...) and backtick substitutions outside single quotes, or null when a quote or substitution is open.
function listSubstitutions(text: string): Substitution[] | null {
  const start: SubstitutionScan = { found: [], next: 0, quote: '', isUnclosed: false }
  const scanned = text.split('').reduce((state, _character, index) => (state.isUnclosed || index < state.next ? state : readSubstitution(text, state, index)), start)
  return scanned.isUnclosed || scanned.quote ? null : scanned.found
}

// The commands a line runs, in order: the code of its substitutions before the command that holds them, the script of
// sh -c and the arguments of eval after it. Each runs in the directory the last literal cd, pushd or popd before it left;
// a subshell, a substitution and sh -c keep their cd to themselves, eval does not.
// Null when a quote, heredoc or substitution cannot be resolved.
function parseLine(text: string, directory: string | null, home: string | undefined): Parse | null {
  const body = text.replace(heredoc, '$3')
  const substitutions = /<<(?!<)/.test(body) ? null : listSubstitutions(body)
  if (!substitutions) return null
  // A substitution stands in the line as a placeholder, so its code neither splits the line nor reads as the line's own words.
  const marked = substitutions.reduceRight((line, substitution, index) => `${line.slice(0, substitution.start)}\u0000${index}\u0000${line.slice(substitution.end)}`, body)
  const scan = scanWords(marked)
  if (scan.isOpen) return null
  const original = (index: string) => body.slice(substitutions[Number(index)]!.start, substitutions[Number(index)]!.end)
  // Adds the commands of a segment to the parse, or gives up with null.
  const parseSegment = (state: ParseState, segment: Segment): ParseState | null => {
    // The directory of each scope; a subshell starts in its parent's.
    const directories = segment.scope.reduce((known, id, index) => (id in known ? known : { ...known, [id]: known[segment.scope[index - 1] ?? lineScope] ?? null }), state.directories)
    const scope = segment.scope.at(-1) ?? lineScope
    const here = directories[scope] ?? null
    const nested = segment.words
      .flatMap(word => [...word.text.matchAll(placeholder)])
      .reduce<Run[] | null>((runs, [, index]) => {
        const inner = runs && parseLine(substitutions[Number(index)]!.body, here, home)
        return runs && inner && [...runs, ...inner.runs]
      }, [])
    if (!nested) return null
    const words = segment.words.map(word => ({ ...word, text: word.text.replace(placeholder, (_, index: string) => original(index)) }))
    const run = listCommandWords(words).map(word => word.text)
    const shell = run.findIndex(word => ['sh', 'bash', 'zsh', 'dash'].includes(readProgramName(word)))
    const flag = run.findIndex((word, index) => shell >= 0 && index > shell && /^-[a-z]*c[a-z]*$/.test(word))
    const script = run[flag + 1] === '--' ? run[flag + 2] : run[flag + 1]
    const hasScript = flag > 0 && script !== undefined
    // A shell reading a heredoc runs its body, which is not parsed here: left to the whole-command fallback.
    if (!hasScript && shell >= 0 && flag < 0 && body !== text) return null
    const scripted = hasScript ? parseLine(script, here, home) : { runs: [], directory: here }
    if (!scripted) return null
    const evalIndex = run.indexOf('eval')
    const evaluated = evalIndex >= 0 ? parseLine(run.slice(evalIndex + 1).join(' '), here, home) : { runs: [], directory: here }
    if (!evaluated) return null
    const isChange = ['cd', 'pushd', 'popd'].includes(run[0] ?? '')
    return {
      runs: [...state.runs, ...nested, { words, directory: here }, ...scripted.runs, ...evaluated.runs],
      directories: { ...directories, [scope]: isChange ? changeDirectory(run, here, home) : evaluated.directory }
    }
  }
  const parsed = scan.segments.reduce<ParseState | null>((state, segment) => state && parseSegment(state, segment), { runs: [], directories: { [lineScope]: directory } })
  return parsed && { runs: parsed.runs, directory: parsed.directories[lineScope] ?? null }
}

// The directory a cd, pushd or popd leaves the shell in, or null when it cannot be named (popd, cd -, a stack entry, a variable).
function changeDirectory(run: string[], directory: string | null, home: string | undefined): string | null {
  const operands = run.slice(1).filter(word => !/^-[LPe@]+$/.test(word))
  const target = operands[0]
  if (run[0] === 'popd' || /^[-+]/.test(target ?? '')) return null
  if (target === undefined) return run[0] === 'cd' ? home ?? null : null
  return resolvePath(target, directory, home)
}

// The words a run writes to: redirect targets, tee files, the cp/mv destination and sed -i files.
function listWrittenWords(words: Word[]): string[] {
  const redirected = words.flatMap((word, index) => (word.isRedirect && words[index + 1] ? [words[index + 1]!.text] : []))
  const run = listCommandWords(words)
  const leadIndex = findLead(run, [writers])
  if (leadIndex < 0) return redirected
  const name = readProgramName(run[leadIndex]!.text)
  const args = run.slice(leadIndex + 1).map(word => word.text)
  const last = args.slice(-1)
  if (name === 'tee') return [...redirected, ...args.filter(arg => !arg.startsWith('-'))]
  if ((name === 'cp' || name === 'mv') && args.length > 1) return [...redirected, ...last]
  if (name === 'sed' && args.some(arg => /^-\w*i/.test(arg) || arg.startsWith('--in-place'))) return [...redirected, ...last]
  return redirected
}

// Resolves a path the shell will write to or move into, as the shell would; null for a variable, a substitution or
// ~user, and for a relative path when the directory is unknown.
function resolvePath(word: string, directory: string | null, home: string | undefined): string | null {
  if (/[$`]/.test(word)) return null
  if (word === '~' || word.startsWith('~/')) return home === undefined ? null : normalizePath(word.slice(2), home)
  if (word.startsWith('~')) return null
  if (word.startsWith('/')) return normalizePath(word, '/')
  return directory === null ? null : normalizePath(word, directory)
}

/**
 * Finds the commands a line runs whose leading words match a pattern: the words appear one after another among the
 * words of any segment, the first of them unquoted, so a prefix such as sudo or timeout does not hide them, and quoted
 * text and heredoc bodies never match. Code a shell will execute (sh -c, eval, substitutions) is searched too.
 *
 * @param command - The command line.
 * @param pattern - The leading words as regular expression sources, with a space between words (e.g. `gh pr (?:create|edit)`).
 * @returns Each match with the words after its leading words and the variables assigned in earlier
 *   segments; a line that cannot be parsed yields a fallback invocation when the pattern matches the whole line.
 */
export function findRanCommands(command: string, pattern: string): Invocation[] {
  const parsed = parseLine(command, null, undefined)
  if (!parsed) {
    const match = new RegExp(`\\b(?:${pattern.replace(/ /g, '\\s+')})\\b`).exec(command)
    return match ? [{ isParsed: false }] : []
  }
  const lead = pattern.split(' ').map(source => new RegExp(`^(?:${source})$`))
  const runs = parsed.runs.map(run => listCommandWords(run.words))
  const assignment = /^([A-Za-z_]\w*)=(.*)$/s
  return runs.flatMap((run, index) => {
    // Assignments in the same run do not count: `f=x gh ... "$f"` expands $f before the assignment.
    // A command-prefix assignment does not outlive its command, so only all-assignment runs count.
    const assigned = runs
      .slice(0, index)
      .filter(earlier => earlier.every(word => assignment.test(word.text)))
      .flatMap(earlier => earlier.map(word => assignment.exec(word.text)!))
    const vars: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(assigned.map(match => [match[1]!, match[2]!])))
    const leadIndex = findLead(run, lead)
    const texts = run.map(word => word.text)
    return leadIndex < 0 ? [] : [{ isParsed: true, args: texts.slice(leadIndex + lead.length), vars }]
  })
}
