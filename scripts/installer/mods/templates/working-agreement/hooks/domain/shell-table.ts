import { commandName } from './shell-parse'
import type { SimpleCommand, Word } from './shell-parse'

/** A command's option grammar: bare and valued short letters, and bare, valued and `=`-only long names, each list split on spaces. */
interface Grammar {
  bare: string
  valued: string
  bareLong: string
  valuedLong: string
  /** Long options that take a value only after `=`. */
  attachedLong: string
}

/** A modelled writer: its grammar and which operands it writes. */
interface Writer extends Grammar {
  writes: 'all' | 'destination'
}

/** A command's words read against its grammar: its operands and every option value, or the first word outside the grammar. */
interface ReadArgs {
  operands: Word[]
  values: Map<string, Word[]>
  outside?: string
}

/** The state of a grammar read, which only its own reader advances. */
interface ArgsState {
  index: number
  operands: Word[]
  values: Map<string, Word[]>
  isOptionsEnd: boolean
  outside?: string
}

/** Where a command leaves the table: the construct as written, and whether it is the program itself rather than one of its forms. */
export interface OutsideTable {
  construct: string
  isProgram: boolean
}

// why: The records, the mailbox among them, live in the working-agreement directory of the git common directory, which is named .git or ends in .git.
export const recordsPath = /\.git\/working-agreement(\/|\b)/
// why: the full option grammar of each modelled writer, so an option value is never read as an operand; an option outside it, such as rsync's --remove-source-files, -e or --backup-dir, which write or run elsewhere, leaves the table.
const writers = new Map<string, Writer>([
  ['cp', { bare: 'abdfHilLnPpRrsTuvxZ', valued: 'St', bareLong: 'archive attributes-only copy-contents dereference force interactive link no-clobber no-dereference no-target-directory one-file-system parents recursive remove-destination strip-trailing-slashes symbolic-link update verbose backup', valuedLong: 'suffix target-directory', attachedLong: 'preserve no-preserve reflink sparse backup update context', writes: 'destination' }],
  ['mv', { bare: 'bfinTuvZ', valued: 'St', bareLong: 'force interactive no-clobber no-target-directory strip-trailing-slashes update verbose backup', valuedLong: 'suffix target-directory', attachedLong: 'backup update context', writes: 'all' }],
  ['ln', { bare: 'bdFfiLnPrsTv', valued: 'St', bareLong: 'directory force interactive logical no-dereference no-target-directory physical relative symbolic verbose backup', valuedLong: 'suffix target-directory', attachedLong: 'backup', writes: 'destination' }],
  ['install', { bare: 'bCcDdpsTvZ', valued: 'gmoSt', bareLong: 'compare directory preserve-timestamps strip verbose no-target-directory preserve-context backup', valuedLong: 'group mode owner suffix target-directory', attachedLong: 'backup context', writes: 'destination' }],
  ['rsync', {
    bare: 'avrlptgoDzhPnucqxHAXSWRmikKLEOJ', valued: 'fB', bareLong: 'archive verbose recursive links perms times group owner devices specials compress human-readable progress partial dry-run update checksum quiet one-file-system hard-links acls xattrs sparse whole-file relative prune-empty-dirs itemize-changes copy-links keep-dirlinks copy-unsafe-links safe-links executability omit-dir-times delete delete-before delete-during delete-after delete-excluded ignore-existing existing inplace append stats numeric-ids no-motd force size-only ignore-times mkpath', valuedLong: 'exclude include exclude-from include-from files-from filter chmod chown suffix compare-dest copy-dest link-dest block-size bwlimit timeout contimeout port max-size min-size max-delete modify-window out-format info debug iconv protocol usermap groupmap', attachedLong: '',
    writes: 'destination',
  }],
  ['rm', { bare: 'dfiIrRv', valued: '', bareLong: 'force recursive dir verbose one-file-system no-preserve-root preserve-root', valuedLong: '', attachedLong: 'interactive', writes: 'all' }],
  ['tee', { bare: 'aip', valued: '', bareLong: 'append ignore-interrupts', valuedLong: '', attachedLong: 'output-error', writes: 'all' }],
  ['touch', { bare: 'acfhm', valued: 'drt', bareLong: 'no-create no-dereference', valuedLong: 'date reference', attachedLong: 'time', writes: 'all' }],
  ['mkdir', { bare: 'pv', valued: 'm', bareLong: 'parents verbose', valuedLong: 'mode', attachedLong: 'context', writes: 'all' }],
  ['rmdir', { bare: 'pv', valued: '', bareLong: 'parents verbose ignore-fail-on-non-empty', valuedLong: '', attachedLong: '', writes: 'all' }],
  ['truncate', { bare: 'co', valued: 'rs', bareLong: 'no-create io-blocks', valuedLong: 'reference size', attachedLong: '', writes: 'all' }],
  ['unlink', { bare: '', valued: '', bareLong: '', valuedLong: '', attachedLong: '', writes: 'all' }],
  ['chmod', { bare: 'cfvR', valued: '', bareLong: 'changes silent quiet verbose recursive preserve-root no-preserve-root', valuedLong: 'reference', attachedLong: '', writes: 'all' }],
  ['chown', { bare: 'cfvRHLPh', valued: '', bareLong: 'changes silent quiet verbose recursive dereference no-dereference preserve-root no-preserve-root', valuedLong: 'reference', attachedLong: 'from', writes: 'all' }],
])
// why: each of these writes no file and runs no program, except through the forms matched against it, which write a file in any spelling of the option or set the clock, and which leave the table.
const readers = new Map<string, RegExp | undefined>([
  ...['grep', 'egrep', 'fgrep', 'cat', 'head', 'tail', 'jq', 'wc', 'diff', 'cmp', 'comm', 'ls', 'echo', 'printf', 'cut', 'tr', 'nl', 'column', 'stat', 'du', 'df',
    'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'true', 'false', ':', 'test', '[', 'which', 'type', 'sha256sum', 'sha1sum', 'md5sum', 'base64', 'od', 'tac', 'rev',
    'seq', 'sleep', 'id', 'whoami', 'uname', 'printenv', 'shellcheck', 'fold', 'expand', 'fmt', 'paste', 'find', 'uniq'].map((name): [string, RegExp | undefined] => [name, undefined]),
  ['sort', /^-[a-zA-Z]*[oT]|^--(o|t|com)/],
  ['rg', /^--pre(=|$)/],
  ['date', /^-[a-zA-Z]*s|^--se/],
])
// why: git subcommands that run no hook, pager program or external tool of the line's choosing and write no file outside the repository; those that do, such as commit, push, checkout or format-patch, leave the table.
const gitSubcommands = new Set(['add', 'blame', 'branch', 'cat-file', 'check-ignore', 'cherry', 'config', 'count-objects', 'describe', 'diff', 'fetch', 'for-each-ref', 'fsck',
  'grep', 'help', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'merge-base', 'name-rev', 'range-diff', 'reflog', 'remote', 'reset', 'restore', 'rev-list', 'rev-parse',
  'shortlog', 'show', 'show-ref', 'stash', 'status', 'tag', 'var', 'verify-commit', 'version', 'whatchanged'])
// why: git options that run a program, a pager or another config, or write a file the line names.
const gitRunsOrWrites = ['ext-diff', 'open-files-in-pager', 'upload-pack', 'receive-pack', 'exec', 'output', 'textconv']
// why: git's short options that do so, -O and -o, alone or bundled after other letters.
const gitShortRunsOrWrites = /^-[a-zA-Z0-9]*[Oo]/
// why: git config's new-syntax actions that write config or open an editor.
const gitConfigWrites = new Set(['set', 'unset', 'edit', 'rename-section', 'remove-section', 'replace-all', 'add'])
// why: gh forms that write files, such as a download, a clone or a checkout, which gh has no destination model for.
const ghWrites = /^(-D|-O|--dir|--output|--clone)(=|$)|^-[DO].|^(download|clone|checkout)$/
// why: git global options that load config, a program path or another repository the guards do not follow.
const gitUnsafeGlobals = /^(-c|--config-env|--exec-path|--git-dir|--work-tree|--namespace|--super-prefix)(=|$)/
// why: git config reads only with these options and at most one name, or two with the pattern reads.
const gitConfigReads = /^(--get|--get-all|--get-regexp|--get-urlmatch|--list|-l|--show-origin|--show-scope|--global|--local|--system|--worktree|--name-only|--null|-z|--bool|--int|--path|--includes|--no-includes|--type=\w+|--default=.*)$/
// why: gh subcommands that run no command of the line's choosing; extension and alias do.
const ghSubcommands = new Set(['api', 'auth', 'browse', 'cache', 'codespace', 'config', 'gist', 'help', 'issue', 'label', 'org', 'pr', 'project', 'release', 'repo', 'ruleset', 'run',
  'search', 'secret', 'status', 'variable', 'workflow'])
const sedGrammar: Grammar = { bare: 'nrsuzE', valued: 'efl', bareLong: 'quiet silent posix debug separate unbuffered null-data regexp-extended', valuedLong: 'expression file line-length', attachedLong: '' }

/**
 * Reads a command's words against its grammar: options consume their values, and an option after the first operand leaves the grammar.
 * @param name - The command, as the refusal names it.
 * @param rules - Its grammar.
 * @param args - The words after the command.
 * @returns The operands and every option value, or the first word outside the grammar.
 */
function readArgs(name: string, rules: Grammar, args: readonly Word[]): ReadArgs {
  const state: ArgsState = { index: 0, operands: [], values: new Map(), isOptionsEnd: false }
  const take = (key: string, value: Word | undefined): void => {
    if (value !== undefined) state.values.set(key, [...state.values.get(key) ?? [], value])
  }
  while (state.index < args.length && state.outside === undefined) {
    const word = args[state.index]!
    const text = word.text
    state.index += 1
    if (state.isOptionsEnd || text === '-' || !text.startsWith('-')) {
      state.operands.push(word)
    } else if (text === '--') {
      state.isOptionsEnd = true
    } else if (state.operands.length > 0) {
      state.outside = `${name} ${text}`
    } else if (text.startsWith('--')) {
      const [long, value] = [text.slice(2).split('=')[0]!, text.includes('=') ? text.slice(text.indexOf('=') + 1) : undefined]
      if (rules.valuedLong.split(' ').includes(long)) {
        take(`--${long}`, value === undefined ? args[state.index] : { ...word, text: value })
        if (value === undefined) state.index += 1
      } else if (!(value === undefined ? rules.bareLong : rules.attachedLong).split(' ').includes(long)) {
        state.outside = `${name} --${long}`
      }
    } else {
      const letters = text.slice(1)
      const valuedAt = [...letters].findIndex(letter => rules.valued.includes(letter))
      const bare = valuedAt < 0 ? letters : letters.slice(0, valuedAt)
      const unknown = [...bare].find(letter => !rules.bare.includes(letter))
      if (unknown !== undefined) {
        state.outside = `${name} -${unknown}`
      } else if (valuedAt >= 0) {
        const attached = letters.slice(valuedAt + 1)
        take(`-${letters[valuedAt]}`, attached === '' ? args[state.index] : { ...word, text: attached })
        if (attached === '') state.index += 1
      }
    }
  }
  return { operands: state.operands, values: state.values, outside: state.outside }
}

/**
 * Names the program a simple command runs, without its directory.
 * @param entry - The command.
 * @returns The program's name, empty when the command runs none.
 */
const nameHead = (entry: SimpleCommand): string => commandName(entry.argv[0]?.text ?? '')

/**
 * Finds the end of a delimited part of a sed script, such as an address regex or one part of an s command.
 * @param script - The script.
 * @param at - The first position after the opening delimiter.
 * @param delimiter - The delimiter.
 * @returns The position after the closing delimiter, or -1 when the part does not close.
 */
function skipDelimited(script: string, at: number, delimiter: string): number {
  const state = { at }
  while (state.at < script.length && script[state.at] !== delimiter) state.at += script[state.at] === '\\' ? 2 : 1
  return state.at < script.length ? state.at + 1 : -1
}

/**
 * Skips one sed address: a line number with an optional step, a relative or step count, `$`, or a regex with its flags.
 * @param script - The script.
 * @param at - Where the address may start.
 * @returns The position after the address, the same position when there is none, or -1 when a regex does not close.
 */
function skipSedAddress(script: string, at: number): number {
  const plain = /^(\d+(~\d+)?|[+~]\d+|\$)/.exec(script.slice(at))?.[0]
  if (plain !== undefined) return at + plain.length
  const open = script[at] === '/' ? 1 : script[at] === '\\' ? 2 : 0
  if (open === 0) return at
  const end = skipDelimited(script, at + open, script[at + open - 1]!)
  return end < 0 ? -1 : end + (/^[IM]*/.exec(script.slice(end))?.[0].length ?? 0)
}

/**
 * Tells whether a sed script uses only read-safe commands: addresses, `!`, blocks, p, d, n, q and =, and s/// with flags only in
 * gpiImM and digits, so it never writes a file with w or W, runs one with e, or reads one with r or R.
 * @param script - The script.
 * @returns Whether every command in it is read-safe.
 */
function isReadSafeSed(script: string): boolean {
  const state = { at: 0 }
  while (state.at < script.length) {
    if (/[\s;{}]/.test(script[state.at]!)) {
      state.at += 1
      continue
    }
    const first = skipSedAddress(script, state.at)
    const second = first >= 0 && script[first] === ',' ? skipSedAddress(script, first + 1) : first
    if (second < 0) return false
    state.at = second + (/^[\s!]*/.exec(script.slice(second))?.[0].length ?? 0)
    const command = script[state.at]
    if (command === undefined || command === '{' || command === '}') continue
    if ('pdnq='.includes(command)) {
      state.at += 1 + (command === 'q' ? /^\s*\d*/.exec(script.slice(state.at + 1))![0].length : 0)
      continue
    }
    const delimiter = script[state.at + 1]
    if (command !== 's' || delimiter === undefined || /[\s\\\n]/.test(delimiter)) return false
    const pattern = skipDelimited(script, state.at + 2, delimiter)
    const replacement = pattern < 0 ? -1 : skipDelimited(script, pattern, delimiter)
    if (replacement < 0) return false
    state.at = replacement + /^[gpiImM0-9]*/.exec(script.slice(replacement))![0].length
    if (state.at < script.length && !/[\s;}]/.test(script[state.at]!)) return false
  }
  return true
}

/**
 * Reads sed's words: its scripts, from every -e or its first operand, and the files it reads. A script file, -i, or any script with a
 * command outside the read-safe set leaves the table.
 * @param args - The words after sed.
 * @returns The files it reads, or the construct outside the table.
 */
function readSedArgs(args: readonly Word[]): ReadArgs {
  const read = readArgs('sed', sedGrammar, args)
  if (read.outside !== undefined) return read
  if (read.values.has('-f') || read.values.has('--file')) return { ...read, outside: 'sed -f' }
  const scripts = [...read.values.get('-e') ?? [], ...read.values.get('--expression') ?? []]
  const all = scripts.length === 0 && read.operands[0] !== undefined ? [read.operands[0]] : scripts
  const unsafe = all.find(word => !isReadSafeSed(word.text))
  if (unsafe !== undefined) return { ...read, outside: `sed ${unsafe.text}` }
  return { ...read, operands: scripts.length === 0 ? read.operands.slice(1) : read.operands }
}

/**
 * Names where a git command leaves the table: an unsafe global option, -C into the records, a subcommand outside the list, an option that
 * runs a program or writes a file, or config with a value or a file.
 * @param entry - The git command.
 * @returns The construct as written, or undefined when the command is in the table.
 */
function describeGitOutside(entry: SimpleCommand): string | undefined {
  const subcommand = entry.subcommand?.text ?? ''
  const subcommandAt = entry.subcommand === undefined ? entry.argv.length : entry.argv.indexOf(entry.subcommand)
  const globals = entry.argv.slice(1, subcommandAt)
  const unsafeGlobal = globals.find(word => gitUnsafeGlobals.test(word.text))
  if (unsafeGlobal !== undefined) return `git ${unsafeGlobal.text.split('=')[0]}`
  if (globals.some((word, index) => word.text === '-C' && recordsPath.test(globals[index + 1]?.text ?? ''))) return 'git -C'
  if (subcommand !== '' && !gitSubcommands.has(subcommand)) return `git ${subcommand}`
  const texts = entry.args.map(word => word.text)
  // why: git accepts any unambiguous prefix of a long option, so a prefix of a name that runs or writes counts as that name.
  const isRunOrWrite = (text: string): boolean => {
    const long = /^--([^=]+)/.exec(text)?.[1]
    return long === undefined ? gitShortRunsOrWrites.test(text) : gitRunsOrWrites.some(name => name.startsWith(long))
  }
  const unsafe = texts.find(isRunOrWrite)
  if (unsafe !== undefined) return `git ${subcommand} ${unsafe.split('=')[0]}`
  const operands = texts.filter(text => !text.startsWith('-'))
  const names = /^(get|list)$/.test(operands[0] ?? '') ? operands.slice(1) : operands
  const isPatternRead = texts.some(text => /^--get-(regexp|all|urlmatch)$/.test(text))
  const isConfigRead = texts.filter(text => text.startsWith('-')).every(text => gitConfigReads.test(text))
    && !gitConfigWrites.has(operands[0] ?? '') && names.length <= (isPatternRead ? 2 : 1)
  return subcommand === 'config' && !isConfigRead ? 'git config' : undefined
}

/**
 * Names the first construct by which a parsed command leaves the closed table of commands the Bash guards judge by structure. The
 * admission rule: a form is in the table only if every form it accepts is a known read or has every path it writes modelled; when in
 * doubt it leaves, and the guard's raw-line rule applies. So an assignment before the command, a program not listed, a writer used
 * outside its option grammar, a reader's form that writes or runs, sed with a script outside its read-safe commands, or git and gh
 * outside their lists leave it. A command with no program gives none.
 * @param entry - The command.
 * @returns The construct and whether it is the program itself, or undefined when the command is in the table.
 */
export function describeOutsideTable(entry: SimpleCommand): OutsideTable | undefined {
  const name = nameHead(entry)
  const args = entry.argv.slice(1)
  if (entry.argv.length === 0) return undefined
  const form = (construct: string | undefined): OutsideTable | undefined => construct === undefined ? undefined : { construct, isProgram: false }
  if (entry.assignment !== undefined) return form(`${entry.assignment.text.split('=')[0]}=`)
  if (writers.has(name)) return form(readArgs(name, writers.get(name)!, args).outside)
  if (name === 'dd') return form(args.map(word => word.text).find(text => !/^[a-z]+=/.test(text)))
  if (name === 'sed') return form(readSedArgs(args).outside)
  if (name === 'git') return form(describeGitOutside(entry))
  if (name === 'gh' && entry.subcommand !== undefined && !ghSubcommands.has(entry.subcommand.text)) return form(`gh ${entry.subcommand.text}`)
  if (name === 'gh') return form(entry.args.map(word => word.text).find(text => ghWrites.test(text))?.replace(/^/, `gh ${entry.subcommand?.text ?? ''} `))
  if (!readers.has(name)) return { construct: name, isProgram: true }
  const forbidden = readers.get(name)
  const option = forbidden === undefined ? undefined : args.find(word => forbidden.test(word.text))
  if (option !== undefined) return form(`${name} ${option.text}`)
  return form(name === 'uniq' && args.filter(word => !word.text.startsWith('-')).length > 1 ? 'uniq' : undefined)
}

/**
 * Names the write a command in the table makes: a modelled writer or dd.
 * @param entry - The command.
 * @returns The command as the refusal names it, or undefined when it writes no operand.
 */
export function findWriteCommand(entry: SimpleCommand): string | undefined {
  const name = nameHead(entry)
  return writers.has(name) || name === 'dd' ? name : undefined
}

/**
 * Lists the operands a write command in the table writes: dd's `of=`, the destination or -t target of cp, ln, install and rsync, and
 * every operand of the rest, mv's source among them since moving a file removes it.
 * @param entry - The command, which runs a modelled writer.
 * @returns The operands it writes.
 */
export function listWrittenOperands(entry: SimpleCommand): Word[] {
  const name = nameHead(entry)
  const args = entry.argv.slice(1)
  if (name === 'dd') return args.filter(word => word.text.startsWith('of='))
  const writer = writers.get(name)!
  const read = readArgs(name, writer, args)
  const targets = [...read.values.get('-t') ?? [], ...read.values.get('--target-directory') ?? []]
  const isDirectories = name === 'install' && args.some(word => /^-[a-zA-Z]*d|^--directory$/.test(word.text))
  if (targets.length > 0) return [...targets, ...writer.writes === 'all' ? read.operands : []]
  return writer.writes === 'all' || isDirectories ? read.operands : read.operands.slice(-1)
}
