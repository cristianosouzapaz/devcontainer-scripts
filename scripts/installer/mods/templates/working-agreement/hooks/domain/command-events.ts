import { normalizePath, toRepoRelative } from '../lib/paths'
import { findRanCommands, hasExactSegment, splitShellWords } from '../lib/shell-parser'
import type { Invocation } from '../lib/shell-parser'

/** Records a run of the repository's verify command. */
interface VerifyEvent {
  kind: 'verify'
}
/** Records a run of some of the unit's test files: those its arguments name, or all of them for the verify command. */
interface TestEvent {
  kind: 'test'
  testFiles: string[]
}
/** Records a `git commit`. */
interface CommitEvent {
  kind: 'commit'
}
/** Records a `git push`. */
interface PushEvent {
  kind: 'push'
}
/** Records another git command that brings in or rewrites commits: merge, pull, cherry-pick, revert, am or rebase. */
interface HistoryEvent {
  kind: 'history'
  subcommand: string
}
/** Holds text a PR command's body carries. */
interface TextBodyPart {
  kind: 'text'
  text: string
}
/** Names a file a PR command reads its body from. */
interface FileBodyPart {
  kind: 'file'
  path: string
}
/** Names the text a PR command's body carries, or the file it reads the body from. */
export type BodyPart = TextBodyPart | FileBodyPart
/**
 * Records a `gh pr create`, with the PR number when the engine reported it, and, when recognised from its text, where its
 * body comes from.
 */
interface PullRequestCreateEvent {
  kind: 'pr-create'
  number?: number
  body?: BodyPart[]
}
/** Records a `gh pr edit`, with where its body comes from when the edit can change the body. */
interface PullRequestEditEvent {
  kind: 'pr-edit'
  body?: BodyPart[]
}
/** Records a `gh pr merge`, with the PR number its arguments name, if any. */
interface PullRequestMergeEvent {
  kind: 'pr-merge'
  number?: number
}
/** Records a `gh pr close` or `gh pr review`. */
interface PullRequestReviewEvent {
  kind: 'pr-close' | 'pr-review'
}
/** Records a `gh issue create`, with the title its arguments give, when they give one literally. */
interface IssueCreateEvent {
  kind: 'issue-create'
  title?: string
}
/** Records a `gh issue edit` or `gh issue comment`, with the declared issues it names. */
interface IssueEditEvent {
  kind: 'issue-edit'
  issues: number[]
}

/** Names what an observed command does for the unit; the same command maps to the same events whether it runs directly or in a herdr pane. */
export type CommandEvent =
  | VerifyEvent | TestEvent | CommitEvent | PushEvent | HistoryEvent
  | PullRequestCreateEvent | PullRequestEditEvent | PullRequestMergeEvent | PullRequestReviewEvent
  | IssueCreateEvent | IssueEditEvent

/** Names how an observed command ended: with exit 0, non-zero, or not at all yet (in the background, interrupted, or no marker read back). */
export type CommandOutcome = 'passed' | 'failed' | 'unfinished'

/**
 * Holds a command as observed at its launch: the events it maps to, when it started on the engine clock, the tree it started on,
 * and whether that tree held only test changes then.
 */
export interface LaunchedCommand {
  events: CommandEvent[]
  startedAt: number
  tree: string | null
  isTestOnly: boolean
}

/** Holds a launched command that ended, and what it printed: empty for a herdr run, whose output stays in its pane. */
export interface Observation extends LaunchedCommand {
  outcome: CommandOutcome
  output: string
}

/** Holds what recognising a command needs beyond its text. */
export interface CommandContext {
  /** The repository's verify command, if it names one. */
  verifyCommand: string | undefined
  /** The unit's repo-relative test files. */
  testFiles: string[]
  /** The directory the command runs in. */
  cwd: string
  /** The repository root, or null outside a repository. */
  root: string | null
  /** The declared issues. */
  issues: number[]
}

// The global git options that consume the next word, which must not be mistaken for the subcommand.
const gitValueOptions = ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']

// The gh pr flags that set the body, as text or as a file to read.
const bodyFlag = /^(--body|-b|--body-file|-F)(=|$)/

// The git subcommands only the user runs: each makes a commit or changes a remote.
const userGitSubcommands = ['commit', 'merge', 'pull', 'cherry-pick', 'revert', 'am', 'rebase', 'push']

// The first word past git's own options (`git -C dir commit` commits).
function findGitSubcommand(args: string[]): string | undefined {
  const [first, ...rest] = args
  if (!first?.startsWith('-')) return first
  return findGitSubcommand(gitValueOptions.includes(first) ? rest.slice(1) : rest)
}

// The git subcommands a line runs; for a line that cannot be parsed, the user's subcommands it names.
function listGitSubcommands(command: string): string[] {
  return findRanCommands(command, 'git').flatMap(run => {
    if (!run.isParsed) return new RegExp(`\\bgit\\s+(${userGitSubcommands.join('|')})\\b`).exec(command)?.[1] ?? []
    return findGitSubcommand(run.args) ?? []
  })
}

// The value a flag gives as its next word or after `=`; none when it is absent or still holds a variable or substitution the shell expands.
function readFlagValue(args: string[], names: string[]): string | undefined {
  const at = args.findIndex(word => names.includes(word) || names.some(name => word.startsWith(`${name}=`)))
  const word = args[at]
  const value = word === undefined ? undefined : names.includes(word) ? args[at + 1] : word.slice(word.indexOf('=') + 1)
  return value && !/[$`]/.test(value) ? value : undefined
}

// Where a gh pr command's body comes from: its --body/-b values and its --body-file/-F files. Without parsed words (a
// fallback invocation) the whole line stands in, as it does for a body file fed from stdin (`-`), a body file whose path
// keeps a variable, and a value whose substitution or heredoc tokenizing stripped.
function readBodyParts(line: string, run: Invocation): BodyPart[] {
  if (!run.isParsed) return [{ kind: 'text', text: line }]
  const { args, vars } = run
  const wholeLine: BodyPart = { kind: 'text', text: line }
  const describeValue = (flag: string, value: string): BodyPart[] => {
    const substituted = /\$\(|`|<</.test(value) ? [wholeLine] : []
    if (flag === '--body' || flag === '-b') return [...substituted, { kind: 'text', text: value }]
    if (value === '-') return [...substituted, wholeLine]
    // Only plain $NAME and ${NAME} of variables assigned earlier in the line; any other reference stays as written.
    const path = value.replace(/\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/g, (reference, plain, braced) => vars[plain ?? braced] ?? reference)
    return [...substituted, /[$`]/.test(path) ? wholeLine : { kind: 'file', path }]
  }
  const collect = (rest: string[]): BodyPart[] => {
    const [arg, ...following] = rest
    if (arg === undefined) return []
    const flag = bodyFlag.exec(arg)
    if (!flag) return collect(following)
    const isInline = !!flag[2]
    const value = isInline ? arg.slice(flag[0].length) : following[0] ?? ''
    return [...describeValue(flag[1]!, value), ...collect(isInline ? following : following.slice(1))]
  }
  return collect(args)
}

/**
 * Lists the recorded test files a command runs: those its arguments name or sit under, or all of them when it runs the verify command.
 *
 * @param command - The command line.
 * @param context - The verify command, the unit's test files, the working directory and the repository root.
 * @returns The test files the command runs.
 */
function listTestRuns(command: string, context: CommandContext): string[] {
  const { verifyCommand, testFiles, cwd, root } = context
  if (verifyCommand && hasExactSegment(command, verifyCommand)) return testFiles
  if (!root) return []
  const relativePaths = splitShellWords(command)
    .flatMap(segment => segment.filter((word, index) => !word.isRedirect && !segment[index - 1]?.isRedirect))
    .map(word => toRepoRelative(normalizePath(word.text, cwd), root))
  // The repository root is '' and would contain every file: only a named file or a subdirectory counts.
  return testFiles.filter(file => relativePaths.some(path => path !== null && (path === file || (path !== '' && file.startsWith(`${path}/`)))))
}

/**
 * Maps a command line to the events it does for the unit. This is the only reader of a command's text for the steps and
 * the gates: the observation layer applies it to a direct Bash call and to the command a herdr pane runs alike, before the
 * command runs and once it ended.
 *
 * @param command - The command line.
 * @param context - What recognising needs beyond the text.
 * @returns The events, empty when the command does nothing the steps observe.
 */
export function recogniseCommand(command: string, context: CommandContext): CommandEvent[] {
  const events: CommandEvent[] = []
  if (context.verifyCommand && hasExactSegment(command, context.verifyCommand)) events.push({ kind: 'verify' })
  const testFiles = listTestRuns(command, context)
  if (testFiles.length) events.push({ kind: 'test', testFiles })
  const subcommands = listGitSubcommands(command)
  if (subcommands.includes('commit')) events.push({ kind: 'commit' })
  if (subcommands.includes('push')) events.push({ kind: 'push' })
  for (const subcommand of new Set(subcommands)) {
    if (subcommand !== 'commit' && subcommand !== 'push' && userGitSubcommands.includes(subcommand)) events.push({ kind: 'history', subcommand })
  }
  for (const run of findRanCommands(command, 'gh pr create')) events.push({ kind: 'pr-create', body: readBodyParts(command, run) })
  for (const run of findRanCommands(command, 'gh pr edit')) {
    // An edit that leaves the body alone (labels, title) cannot drop a required line.
    const hasBodyFlag = !run.isParsed || run.args.some(word => bodyFlag.test(word))
    events.push(hasBodyFlag ? { kind: 'pr-edit', body: readBodyParts(command, run) } : { kind: 'pr-edit' })
  }
  for (const run of findRanCommands(command, 'gh pr merge')) {
    const number = run.isParsed ? Number(run.args.map(word => /^(?:#|.*\/pull\/)?(\d+)$/.exec(word)?.[1]).find(Boolean)) : NaN
    events.push(Number.isInteger(number) && number > 0 ? { kind: 'pr-merge', number } : { kind: 'pr-merge' })
  }
  if (findRanCommands(command, 'gh pr close').length) events.push({ kind: 'pr-close' })
  if (findRanCommands(command, 'gh pr review').length) events.push({ kind: 'pr-review' })
  for (const run of findRanCommands(command, 'gh issue create')) {
    const title = run.isParsed ? readFlagValue(run.args, ['--title', '-t']) : undefined
    events.push(title ? { kind: 'issue-create', title } : { kind: 'issue-create' })
  }
  const issueRuns = findRanCommands(command, 'gh issue (?:edit|comment)')
  if (issueRuns.length) {
    // The outcome can also land on the declared issue itself.
    const issues = context.issues.filter(issue => issueRuns.some(run => run.isParsed
      ? run.args.some(word => new RegExp(`(^|[#/])${issue}$`).test(word))
      : new RegExp(`(^|[\\s#/])${issue}(\\s|$)`).test(command)))
    events.push({ kind: 'issue-edit', issues })
  }
  return events
}
