/** A word of a command line; a redirect operator is a word of its own. */
export interface Word { text: string; isRedirect?: boolean }

// Where the scan of a command stands: the character it reads, the word it builds, and the open quote.
interface Scan { i: number; word: string; isWord: boolean; isQuoted: boolean; quote: string | null }

/**
 * A command found in a parsed line: the words that matched, the words after them, and the variables that
 * earlier segments of the line assigned (the last assignment wins).
 */
export interface ParsedInvocation { isParsed: true; lead: string; args: string[]; vars: Record<string, string> }

/** A command found by matching the whole line, because the line could not be parsed: only the words that matched are known. */
export interface FallbackInvocation { isParsed: false; lead: string }

/** A command a line runs, found in the parsed words or, for an unparseable line, in the whole text. */
export type Invocation = ParsedInvocation | FallbackInvocation

// Matches a heredoc and its body; the replacement `$3` keeps what follows the delimiter on its line.
const heredoc = /<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g

// Splits a command into segments of words: quotes group, unquoted ; | & && || newline split,
// an unquoted > or >> becomes a redirect marker (an fd prefix and >&n duplications are dropped).
function scanWords(text: string) {
  const segments: Word[][] = [[]]
  const at: Scan = { i: 0, word: '', isWord: false, isQuoted: false, quote: null }
  const current = () => segments[segments.length - 1]!
  const end = () => {
    if (at.isWord) current().push({ text: at.word })
    at.word = ''
    at.isWord = false
    at.isQuoted = false
  }
  // Reads the character under the scan; the caller then moves past it.
  const read = () => {
    const ch = text[at.i]!
    if (at.quote) {
      if (ch === at.quote) at.quote = null
      else at.word += ch
      return
    }
    if (ch === "'" || ch === '"') {
      at.quote = ch
      at.isWord = true
      at.isQuoted = true
      return
    }
    // A lone & ends a segment too, unless it belongs to &> or <&.
    const isAmp = ch === '&' && text[at.i + 1] !== '>' && text[at.i - 1] !== '<'
    if (ch === '\n' || ch === ';' || ch === '|' || isAmp) {
      end()
      segments.push([])
      if (text.startsWith('&&', at.i) || text.startsWith('||', at.i)) at.i++
      return
    }
    // A subshell's ( and ) break words; the ( of $( <( >( stays in its word so a substitution reads as one.
    if (/\s/.test(ch) || ch === ')' || (ch === '(' && !/[$<>]/.test(text[at.i - 1] ?? ''))) {
      end()
      return
    }
    if (ch === '>') {
      if (!at.isQuoted && /^\d+$/.test(at.word)) {
        at.word = ''
        at.isWord = false
      }
      end()
      if (text[at.i + 1] === '>') at.i++
      if (text[at.i + 1] === '&') {
        at.i++
        while (at.i + 1 < text.length && /[\w-]/.test(text[at.i + 1]!)) at.i++
        return
      }
      current().push({ text: '>', isRedirect: true })
      return
    }
    at.word += ch
    at.isWord = true
  }
  while (at.i < text.length) {
    read()
    at.i++
  }
  end()
  return { segments: segments.filter(seg => seg.length), isOpen: at.quote !== null }
}

/**
 * Splits a command into segments of words, as the shell would separate them.
 *
 * @param text - The command line.
 * @returns Each segment's words; a redirect is a word of its own, flagged as one.
 */
export const shellWords = (text: string): Word[][] => scanWords(text).segments

/**
 * Lists the files a shell command writes: redirect targets, tee files, the cp/mv destination and sed -i files.
 *
 * @param command - The command line.
 * @param patterns - Regular expressions of which one must match before the command is parsed at all.
 * @returns The written paths as typed, leaving out /dev and any path behind a variable or ~.
 */
export function shellTargets(command: string, patterns: string[]): string[] {
  if (!patterns.some(p => new RegExp(p).test(command))) return []
  const body = command.replace(heredoc, '$3')
  const targets: string[] = []
  for (const seg of shellWords(body)) {
    const tok: string[] = []
    seg.forEach((w, i) => {
      if (w.isRedirect) targets.push(seg[i + 1]?.text ?? '')
      else if (!seg[i - 1]?.isRedirect) tok.push(w.text)
    })
    const cmd = tok[0] === 'sudo' ? tok.slice(1) : tok
    if (cmd[0] === 'tee') targets.push(...cmd.slice(1).filter(t => !t.startsWith('-')))
    if ((cmd[0] === 'cp' || cmd[0] === 'mv') && cmd.length > 2) targets.push(cmd[cmd.length - 1]!)
    if (cmd[0] === 'sed' && cmd.some(t => /^-\w*i/.test(t) || t.startsWith('--in-place'))) targets.push(cmd[cmd.length - 1]!)
  }
  // A target behind a variable or ~ cannot be resolved here: left to the human, never misread as a repo path.
  return targets.filter(t => t && !/^[&$~]/.test(t) && !t.startsWith('/dev/'))
}

/**
 * Tells whether a command line runs the verify command as one of its own segments, not piped or wrapped.
 *
 * @param command - The command line.
 * @param verifyCmd - The repository's verify command.
 * @returns True when a segment is exactly the verify command.
 */
export const runsVerify = (command: string, verifyCmd: string): boolean =>
  command.split(/&&|;|\n/).some(seg => seg.trim() === verifyCmd)

// The program a word names, whether typed as gh, \gh or /usr/bin/gh.
const program = (word: string) => word.replace(/^\\/, '').split('/').pop()!

// The index of the closing ) or backtick of a substitution whose body starts at `from`, or -1 when it never closes.
function closing(text: string, from: number, isTick: boolean): number {
  const at = { j: from, depth: 1 }
  while (at.j < text.length) {
    const ch = text[at.j]!
    if (isTick && ch === '\\') at.j++
    else if (isTick && ch === '`') return at.j
    else if (!isTick && ch === '(') at.depth++
    else if (!isTick && ch === ')') {
      at.depth--
      if (at.depth === 0) return at.j
    }
    at.j++
  }
  return -1
}

// The bodies of the $(...), <(...), >(...) and backtick substitutions outside single quotes, or null when a quote or substitution is open.
function substitutions(text: string): string[] | null {
  const found: string[] = []
  const at = { i: 0, quote: '' }
  while (at.i < text.length) {
    const ch = text[at.i]!
    if (at.quote === "'") {
      if (ch === "'") at.quote = ''
    } else if (ch === '\\') at.i++
    else if (ch === '"') at.quote = at.quote ? '' : '"'
    else if (ch === "'" && !at.quote) at.quote = "'"
    else if (ch === '`' || (/[$<>]/.test(ch) && text[at.i + 1] === '(')) {
      const from = at.i + (ch === '`' ? 1 : 2)
      const end = closing(text, from, ch === '`')
      if (end < 0) return null
      found.push(text.slice(from, end))
      at.i = end
    }
    at.i++
  }
  return at.quote ? null : found
}

// Every segment a line runs, as its words: the script of sh -c, the arguments of eval and substitutions are segments too.
// Null when a quote, heredoc or substitution cannot be resolved.
function runsOf(text: string): string[][] | null {
  const body = text.replace(heredoc, '$3')
  const subs = /<<(?!<)/.test(body) ? null : substitutions(body)
  const scan = scanWords(body)
  if (!subs || scan.isOpen) return null
  const runs: string[][] = []
  const nested: string[] = [...subs]
  for (const seg of scan.segments) {
    const run = seg.filter((w, i) => !w.isRedirect && !seg[i - 1]?.isRedirect).map(w => w.text)
    if (!run.length) continue
    runs.push(run)
    const shell = run.findIndex(w => ['sh', 'bash', 'zsh', 'dash'].includes(program(w)))
    const flag = run.findIndex((w, i) => shell >= 0 && i > shell && /^-[a-z]*c[a-z]*$/.test(w))
    const script = run[flag + 1] === '--' ? run[flag + 2] : run[flag + 1]
    if (flag > 0 && script !== undefined) nested.push(script)
    // A shell reading a heredoc runs its body, which is not parsed here: left to the whole-command fallback.
    else if (shell >= 0 && flag < 0 && body !== text) return null
    const evalAt = run.indexOf('eval')
    if (evalAt >= 0) nested.push(run.slice(evalAt + 1).join(' '))
  }
  for (const code of nested) {
    const inner = runsOf(code)
    if (!inner) return null
    runs.push(...inner)
  }
  return runs
}

/**
 * Finds the commands a line runs whose leading words match a pattern: the words appear one after another among the
 * unquoted words of any segment, so a prefix such as sudo or timeout does not hide them, and quoted text and heredoc
 * bodies never match. Code a shell will execute (sh -c, eval, substitutions) is searched too.
 *
 * @param command - The command line.
 * @param pattern - The leading words as regular expression sources, with a space between words (e.g. `gh pr (?:create|edit)`).
 * @returns Each match with its leading words, the words after them and the variables assigned in earlier
 *   segments; a line that cannot be parsed yields a fallback invocation when the pattern matches the whole line.
 */
export function ranCommands(command: string, pattern: string): Invocation[] {
  const runs = runsOf(command)
  if (!runs) {
    const m = new RegExp(`\\b(?:${pattern.replace(/ /g, '\\s+')})\\b`).exec(command)
    return m ? [{ lead: m[0].split(/\s+/).join(' '), isParsed: false }] : []
  }
  const lead = pattern.split(' ').map(w => new RegExp(`^(?:${w})$`))
  return runs.flatMap((run, n) => {
    // Assignments in the same run do not count: `f=x gh ... "$f"` expands $f before the assignment.
    const vars: Record<string, string> = Object.create(null)
    const assignment = /^([A-Za-z_]\w*)=(.*)$/s
    for (const earlier of runs.slice(0, n)) {
      // A command-prefix assignment does not outlive its command, so only all-assignment runs count.
      if (!earlier.every(w => assignment.test(w))) continue
      for (const word of earlier) {
        const m = assignment.exec(word)!
        vars[m[1]!] = m[2]!
      }
    }
    const at = run.findIndex((_, i) => lead.every((re, k) => re.test(k ? run[i + k] ?? '' : program(run[i]!))))
    return at < 0 ? [] : [{ isParsed: true, lead: [program(run[at]!), ...run.slice(at + 1, at + lead.length)].join(' '), args: run.slice(at + lead.length), vars }]
  })
}
