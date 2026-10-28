import type { Args, CommandSpec, On, PaneOpenArgs, ProcessRunResult, SessionContextUsage, ToolSpec, UiLogSink } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { FlowView, ReadFailure, RunView } from '../../types'
import type { ProcessPort } from '../../hooks/lib/process'
import type { EnginePort, PaneView } from '../../hooks/core/engine-port'
import { createEmptySession } from '../../hooks/domain/records'
import type { SessionRecord } from '../../hooks/domain/records'
import type { MockClock } from 'claude-code/testing'
import { githubSamples } from './github-samples'

type CheckRun = (typeof githubSamples)['check-runs'][number]['body'][number]
type Status = (typeof githubSamples)['statuses'][number]['body'][number]
type WorkflowRun = (typeof githubSamples)['workflow-runs'][number]['body'][number]
type IssueComment = (typeof githubSamples)['issue-comments'][number]['body'][number]
type SubIssue = (typeof githubSamples)['sub-issues'][number]['body'][number]

/** The live checkout, with working-file and index overlays and an optional tree alias for seeded records. */
export interface Checkout extends Worktree {
  ahead?: number; changed?: string[]; graph?: Graph
  worktrees?: Record<string, Worktree>
}

/** A commit's parents, file hashes by repo-relative path, and optional committer date in epoch seconds. */
interface Commit { parents: string[]; files: Record<string, string>; committerDate?: number }

/**
 * Seeded commit ids are immutable and ordered by creation time; the real-git harness assigns dates in that order.
 * Later commits default to the world's clock unless their committer date is specified.
 * Two commits with the same files have the same tree. Optional trees and blobs give object ids readable fixture aliases.
 * `created` names the start point each listed branch's reflog records as `branch: Created from <start>`; every other
 * branch's reflog holds one entry with no message, as `git update-ref` writes it.
 */
export interface Graph {
  commits: Record<string, Commit>; refs: Record<string, string>
  trees?: Record<string, Record<string, string>>; blobs?: Record<string, string>; upstreams?: Record<string, string>
  created?: Record<string, string>
}

interface Worktree {
  branch: string; head?: string; dirty?: Record<string, string>; staged?: Record<string, string>; tree?: string; isDirty?: boolean
}
interface HerdrResult { exitCode: number; stderr: string }
interface ProtectionError { status?: number; message: string }
interface Repository { common: string; branch: string }
interface GhResponse { body: unknown; exitCode?: number }
interface HerdrActivity { calls: number; active: number; maximum: number }

/** The records and external responses that replace a world's defaults. */
export interface Options {
  herdrEnv?: Record<string, string>
  beforeHerdr?: () => void
  herdrGate?: Promise<void>
  ghResponse?: GhResponse
  herdrResult?: HerdrResult
  /** The standard output herdr prints for these arguments; empty when unset. */
  herdrReply?: (args: string[]) => string
  approvedConfig?: string
  verifyFile?: string
  platform?: string
  spawnCode?: number | null
  spawnSignal?: string | null
  spawnGate?: Promise<void>
  spawnOutput?: string
  afterSpawn?: () => void
  beforeSessionId?: () => void
  beforePromptSubmit?: (text: string) => void
  /** Whether the engine shows a proposed prompt suggestion; true when unset. */
  isSuggestionShown?: boolean
  contextUsage?: (args: Args<'session.usage'>) => SessionContextUsage
  session?: Record<string, unknown>
  unit?: Record<string, unknown>
  issues?: Record<number, string>
  missing?: number[]
  prs?: Record<string, unknown>[]
  prsHasNextPage?: boolean
  prFields?: Record<string, unknown>
  prReadError?: boolean
  afterTool?: () => void
  statusGate?: Promise<void>
  failing?: string
  removeExitCode?: number
  appendExitCode?: number
  listFailurePrefix?: string
  /** Makes reading a present file under this prefix reject, as an I/O error does. */
  readFailurePrefix?: string
  /** Whether listing a directory no file lives under fails, as the engine's listing of a missing directory does. */
  isMissingListFailed?: boolean
  isLoggedOut?: boolean
  isOutsideRepo?: boolean
  renameFailures?: number
  casMisses?: number
  watchPaths?: string[]
  isStateAbsent?: boolean
  /** Holds the first GitHub issue read until it opens. */
  issueGate?: Promise<void>
  legacy?: Record<string, unknown>
  issueLabels?: Record<number, string[]>
  checkRuns?: Record<string, CheckRun[]>
  statuses?: Record<string, Status[]>
  workflowRuns?: Record<string, WorkflowRun[]>
  rules?: Record<string, unknown>[]
  rulesError?: number
  rulesMessage?: string
  rulesGate?: Promise<void>
  rulesets?: Record<string, unknown>[]
  isProtected?: boolean
  protectionError?: ProtectionError
  closingPrs?: Record<number, Record<string, unknown>[]>
  closingHasNextPage?: boolean
  /** PRs whose body mentions the issue, as the issue's cross-reference timeline lists them. */
  crossReferences?: Record<number, Record<string, unknown>[]>
  timelineHasNextPage?: boolean
  unpublished?: string[]
  comments?: Record<number, IssueComment[] | ReadFailure>
  subIssues?: Record<number, SubIssue[]>
  cwd?: string
  symlinks?: Record<string, string | null>
  repositories?: Record<string, Repository>
  ignored?: string[]
}

/** The mutable chat id lets a test move to another chat; only the first one has the engine's session store. */
interface Chat { id: string }

/** A session store value the world holds, at the version the engine would give it. */
interface HeldSession { value: SessionRecord | undefined; version: number }

interface WorldBoundaries extends Pick<EnginePort, 'files' | 'readCwd' | 'readSessionId' | 'readHerdrEnv'> { processes: ProcessPort }
interface LogEntry { text: string; to: UiLogSink }
interface HerdrCall { argv: string[]; timeoutMs?: number }

/** A promise gate controlled by its test. */
export interface Gate { open?: () => void }

/** The world's command log, prompt log and clock. */
export interface World {
  ready: Promise<void>
  answeredEntries: Set<string>
  herdrActivity: HerdrActivity
  boundaries: WorldBoundaries
  /** The session store of a direct-dispatch port, which runs mod code beside the engine and so reaches no engine store. */
  directSessionState: Pick<EnginePort, 'readSessionState' | 'writeSessionState'>
  herdrCalls: HerdrCall[]
  registeredCommands: CommandSpec[]
  registeredTools: Pick<ToolSpec, 'name' | 'isDeferred'>[]
  logs: LogEntry[]
  commands: string[]
  prompts: string[]
  suggestions: string[]
  clock: MockClock
  files: Map<string, string>
  /** A file's modification time in epoch ms, where it differs from now. */
  modified: Map<string, number>
  runs: string[]
  chat: Chat
  /** Each chat's session record as its last landed write, or its seed, left it; only the mod writes it. */
  sessions: ReadonlyMap<string, SessionRecord>
  /**
   * Gives a chat other than the first the record its session start would have loaded.
   * @param id - The chat id.
   * @param record - The record.
   */
  seedChat: (id: string, record: SessionRecord) => void
  legacy: Set<string>
  views: (FlowView | null)[]
  /** Every live-run display written, in order. */
  liveRuns: (RunView | null)[]
  paneViews: PaneView[]
  opened: PaneOpenArgs[]
  approveConfig: (text: string) => void
}

interface GraphCache { highest: number; linear?: Graph; indexed?: Graph }
interface GitAnswer { exitCode: number; stdout: string }
interface GitContext {
  graph: Graph; checkout: Checkout; worktrees: Record<string, Worktree>; stdin: string
  commitDates: Map<string, number>
  owner: [string, Repository]; localRoot: string; working: Record<string, string>
  /** The process directory below the repository root, which git prepends to a pathspec without `top` magic. */
  prefix: string
  resolve: (revision: string) => string | undefined
  filesAt: (revision: string) => Record<string, string> | undefined
  treeName: (files: Record<string, string>, alias?: string) => string
  blobText: (blob: string) => string
}
interface GitEntry { name: string; pattern: RegExp; answer: (context: GitContext, match: readonly string[]) => GitAnswer | Promise<GitAnswer> }

const ancestorCache = new WeakMap<Commit, string[]>()
const fatal: GitAnswer = { exitCode: 128, stdout: '' }
const gitAnswers: GitEntry[] = [
  { name: 'hash', pattern: /^hash-object --stdin$/, answer: async c => ok(await hashBlob(c.stdin)) },
  { name: 'common', pattern: /^rev-parse --path-format=absolute --git-common-dir$/, answer: c => ok(c.owner[1].common) },
  { name: 'repository', pattern: /^rev-parse --path-format=absolute --git-common-dir --show-toplevel$/,
    answer: c => ok(`${c.owner[1].common}\n${c.owner[0]}`) },
  { name: 'root', pattern: /^rev-parse --show-toplevel$/, answer: c => ok(c.owner[0]) },
  { name: 'symbolic', pattern: /^symbolic-ref (--short -q|-q) HEAD$/, answer: (c, m) => c.checkout.branch === 'HEAD'
    ? { exitCode: 1, stdout: '' } : ok(m[1] === '--short -q' ? c.checkout.branch : `refs/heads/${c.checkout.branch}`) },
  { name: 'abbrev', pattern: /^rev-parse --abbrev-ref (HEAD|origin\/HEAD)$/, answer: (c, m) => ok(m[1] === 'HEAD' ? c.checkout.branch : 'origin/main') },
  { name: 'verify', pattern: /^rev-parse --verify --quiet (\S+)$/, answer: (c, m) => {
    const id = c.resolve(m[1] ?? '')
    return id ? ok(id) : { exitCode: 1, stdout: '' }
  } },
  { name: 'head', pattern: /^rev-parse HEAD$/, answer: c => c.resolve('HEAD') ? ok(c.resolve('HEAD') ?? '') : fatal },
  { name: 'refs', pattern: /^for-each-ref --format=%\(refname\) %\(objectname\)$/, answer: c => ok(Object.entries(c.graph.refs)
    .filter(([ref]) => ref !== 'HEAD').map(([ref, sha]) => {
      const name = ref.startsWith('refs/') ? ref : ref.startsWith('origin/') ? `refs/remotes/${ref}` : `refs/heads/${ref}`
      return `${name} ${sha}`
    }).sort().join('\n')) },
  { name: 'first-parent', pattern: /^rev-list --first-parent --parents (\S+) --not (\S+)$/, answer: (c, m) => {
    const [from, stop] = [c.resolve(m[1] ?? ''), c.resolve(m[2] ?? '')]
    return from && stop ? ok(walkFirstParents(c.graph, from, new Set(listAncestors(c.graph, stop))).join('\n')) : fatal
  } },
  { name: 'reflog', pattern: /^log --walk-reflogs --format=%gs refs\/heads\/(\S+) --$/, answer: (c, m) =>
    isLocalBranch(c.graph, m[1] ?? '') ? ok(c.graph.created?.[m[1] ?? ''] ? `branch: Created from ${c.graph.created[m[1] ?? '']}` : '') : fatal },
  { name: 'show-ref', pattern: /^show-ref --verify --quiet refs\/heads\/(\S+)$/, answer: (c, m) =>
    isLocalBranch(c.graph, m[1] ?? '') ? ok('') : { exitCode: 1, stdout: '' } },
  { name: 'list', pattern: /^rev-list (--count )?(?:--min-age=(-?\d+) )?(.+) --not (.+)$/, answer: (c, m) =>
    revisionDifference(c, m[3] ?? '', m[4] ?? '', m[1] !== undefined, m[2] === undefined ? undefined : Number(m[2])) },
  { name: 'count', pattern: /^rev-list --count (\S+)\.\.(\S+)$/, answer: (c, m) => revisionDifference(c, m[2] ?? '', m[1] ?? '', true) },
  { name: 'merge', pattern: /^merge-base (?!-)(\S+) (\S+)$/, answer: (c, m) => {
    const [from, to] = [c.resolve(m[1] ?? ''), c.resolve(m[2] ?? '')]
    const ancestors = new Set(to ? listAncestors(c.graph, to) : [])
    const common = from ? listAncestors(c.graph, from).filter(id => ancestors.has(id)) : []
    // A best common ancestor is no ancestor of another common ancestor.
    const base = common.find(id => !common.some(other => other !== id && listAncestors(c.graph, other).includes(id)))
    return base ? ok(base) : { exitCode: from && to ? 1 : 128, stdout: '' }
  } },
  { name: 'ancestor', pattern: /^merge-base --is-ancestor (\S+) (\S+)$/, answer: (c, m) => {
    const [from, to] = [c.resolve(m[1] ?? ''), c.resolve(m[2] ?? '')]
    return from && to ? { exitCode: listAncestors(c.graph, to).includes(from) ? 0 : 1, stdout: '' } : fatal
  } },
  { name: 'tree', pattern: /^rev-parse (\S+)\^\{tree\}$/, answer: (c, m) => {
    const files = c.filesAt(m[1] ?? '')
    return files ? ok(c.treeName(files)) : fatal
  } },
  { name: 'blob', pattern: /^(rev-parse|cat-file blob) (\S+):(.+)$/, answer: (c, m) => {
    const blob = c.filesAt(m[2] ?? '')?.[m[3] ?? '']
    return blob ? ok(m[1] === 'rev-parse' ? blob : c.blobText(blob)) : fatal
  } },
  { name: 'diff', pattern: /^diff --name-only -z --no-renames --no-ext-diff (\S+) (\S+) --(?: (.*))?$/, answer: (c, m) => {
    const [from, to] = [c.filesAt(m[1] ?? ''), c.filesAt(m[2] ?? '')]
    const patterns = m[3]?.split(' ').map(pattern => pattern.startsWith(':(top,glob)') ? pattern.slice(11) : `${c.prefix}${pattern.replace(/^:\(glob\)/, '')}`) ?? []
    return from && to ? ok(diffFiles(from, to).filter(path => !patterns.length || patterns.some(pattern => matchesGlob(path, pattern)))
      .map(path => `${path}\0`).join('')) : fatal
  } },
  { name: 'index', pattern: /^rev-parse --path-format=absolute --git-path index --show-object-format$/, answer: c => ok(`${c.localRoot === root
    ? `${c.owner[1].common}/index` : `${c.owner[1].common}/worktrees/${c.localRoot.split('/').at(-1)}/index`}\nsha1`) },
  { name: 'status', pattern: /^status --porcelain=v2 -z --untracked-files=all$/, answer: c => {
    const before = c.filesAt('HEAD') ?? {}
    const staged = c.checkout.staged ?? (c.checkout.isDirty && !diffFiles(before, c.working).length ? { 'src/a.ts': 'staged' } : {})
    const index = { ...before, ...staged }
    const changed = [...new Set([...diffFiles(before, index), ...diffFiles(index, c.working)])].sort()
    return ok(changed.filter(path => !isIgnored(c, path)).map(path => before[path]
      ? `1 ${before[path] === index[path] ? '.' : 'M'}${index[path] === c.working[path] ? '.' : c.working[path] ? 'M' : 'D'}`
        + ` N... 100644 100644 ${c.working[path] ? '100644' : '000000'} ${before[path]} ${index[path]} ${path}\0`
      : `? ${path}\0`).join(''))
  } },
  { name: 'ignore', pattern: /^check-ignore -- (.+)$/, answer: (c, m) => isIgnored(c, (m[1] ?? '').replace(`${c.owner[0]}/`, ''))
    ? ok(m[1] ?? '') : { exitCode: 1, stdout: '' } },
  { name: 'add', pattern: /^add -A$/, answer: () => ok('') },
  // A safe delete leaves the graph alone: tests read the deletion from the recorded runs.
  { name: 'branch-delete', pattern: /^branch -d (\S+)$/, answer: (c, m) => {
    const tip = isLocalBranch(c.graph, m[1] ?? '') ? c.resolve(m[1] ?? '') : undefined
    const head = c.resolve('HEAD')
    return tip && head && listAncestors(c.graph, head).includes(tip) ? ok(`Deleted branch ${m[1]} (was ${tip}).`) : { exitCode: 1, stdout: '' }
  } },
  { name: 'write', pattern: /^write-tree$/, answer: c =>
    ok(c.treeName(Object.fromEntries(Object.entries(c.working).filter(([path]) => !isIgnored(c, path))), c.checkout.tree)) },
  { name: 'remotes', pattern: /^remote$/, answer: c => ok([...new Set(Object.keys(c.graph.refs)
    .flatMap(ref => ref.startsWith('origin/') ? ['origin'] : ref.startsWith('refs/remotes/') ? [ref.split('/')[2] ?? ''] : []))].sort().join('\n')) },
  { name: 'worktrees', pattern: /^worktree list --porcelain$/, answer: c => ok(Object.entries(c.worktrees)
    .sort(([a], [b]) => a === root ? -1 : b === root ? 1 : a.localeCompare(b))
    .map(([path, wt]) => `worktree ${path}\nHEAD ${wt.head ?? c.graph.refs[wt.branch]}\n`
      + `${wt.branch === 'HEAD' ? 'detached' : `branch refs/heads/${wt.branch}`}\n`).join('\n')) },
]

/** Names every answer that fixture rows must exercise. */
export const gitAnswerNames = gitAnswers.map(entry => entry.name)

/** The repository root every world runs in. */
export const root = '/repo'

/** The git common directory shared by test chats. */
export const common = '/repo.git'

/**
 * Builds a successful process answer.
 * @param stdout - Git's output.
 * @returns A zero exit and output.
 */
function ok(stdout: string): GitAnswer { return { exitCode: 0, stdout } }

/**
 * Answers revision walks with the graph's cached reachability sets.
 * @param context - Repository graph.
 * @param included - Space-separated positive revisions.
 * @param excluded - Space-separated negative revisions.
 * @param count - Whether only the count is requested.
 * @param minAge - The latest included committer date in epoch seconds, when limited.
 * @returns The walk or a failed revision lookup.
 */
function revisionDifference(context: GitContext, included: string, excluded: string, count: boolean, minAge = Infinity): GitAnswer {
  const revisions = [...included.split(' '), ...excluded.split(' ')]
  if (revisions.some(ref => !context.resolve(ref))) return fatal
  const ancestors = (refs: string) => refs.split(' ').flatMap(ref => listAncestors(context.graph, context.resolve(ref) ?? ''))
  const omitted = new Set(ancestors(excluded))
  const ids = [...new Set(ancestors(included))].filter(id => !omitted.has(id) && (context.commitDates.get(id) ?? 0) <= minAge)
  const order = Object.keys(context.graph.commits)
  return ok(count ? String(ids.length) : ids.sort((a, b) => order.indexOf(b) - order.indexOf(a)).join('\n'))
}

/**
 * Evaluates repository ignore patterns against an untracked path.
 * @param context - Checkout contents.
 * @param path - Repository-relative file.
 * @returns Whether git excludes the path.
 */
function isIgnored(context: GitContext, path: string): boolean {
  if (context.filesAt('HEAD')?.[path]) return false
  const blob = context.working['.gitignore']
  const patterns = blob ? context.blobText(blob).split('\n').filter(Boolean) : []
  return patterns.some(pattern => pattern.endsWith('/') ? path.startsWith(pattern) : matchesGlob(path, pattern))
}

/**
 * Gives test blobs stable ids that change with their content.
 * @param text - Config content.
 * @returns A deterministic hex id.
 */
export function configBlob(text: string): string {
  return ([...text].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0).toString(16).padStart(8, '0').repeat(5)
}

/**
 * Matches the glob pathspecs used by verification rules.
 * @param path - Repository-relative path.
 * @param pattern - Git glob pathspec without its magic prefix.
 * @returns Whether the path matches.
 */
function matchesGlob(path: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0001').replace(/\*/g, '[^/]*').replace(/\u0001/g, '.*')
  return new RegExp(`^${escaped}$`).test(path)
}

/**
 * Hashes the exact UTF-8 bytes using git's blob header.
 * @param text - Standard input, without an implicit newline.
 * @returns Git's SHA-1 blob id.
 */
async function hashBlob(text: string): Promise<string> {
  const encoder = new TextEncoder()
  const bytes = encoder.encode(text)
  const digest = await crypto.subtle.digest('SHA-1', encoder.encode(`blob ${bytes.length}\0${text}`))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Names a unit's record files the way the mod does, so a test can seed or find its declaration and transition log.
 * @param branch - The unit's branch.
 * @param issues - The unit's sorted issues.
 * @returns The hash shared by the unit's declaration and log.
 */
export const hashIdentity = (branch: string, issues: number[]): Promise<string> => hashBlob(JSON.stringify({ branch, issues }))

/**
 * Resolves a revision of a graph to a commit id: a branch, `refs/heads/<branch>`, `origin/HEAD` (the default branch), `HEAD` or a commit id.
 *
 * @param graph - The graph.
 * @param head - HEAD's commit.
 * @param revision - The revision.
 * @returns The commit id, or undefined when the graph does not know it.
 */
function resolveRevision(graph: Graph, head: string | undefined, revision: string): string | undefined {
  const name = revision.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '')
  if (name === 'HEAD') return head
  if (name === 'origin/HEAD') return graph.refs['origin/main'] ?? graph.refs.main
  return graph.refs[name] ?? (graph.commits[name] ? name : undefined)
}

/**
 * Lists the commits reachable from a commit of a graph, itself included.
 *
 * @param graph - The graph.
 * @param id - The commit id.
 * @returns The ids, in breadth-first order from the commit.
 */
function listAncestors(graph: Graph, id: string): string[] {
  const commit = graph.commits[id]
  if (!commit) return []
  const cached = ancestorCache.get(commit)
  if (cached) return cached
  const seen = new Set<string>()
  const queue = [id]
  while (queue.length) {
    const next = queue.shift() ?? ''
    if (seen.has(next) || !graph.commits[next]) continue
    seen.add(next)
    queue.push(...(graph.commits[next]?.parents ?? []))
  }
  const result = [...seen]
  ancestorCache.set(commit, result)
  return result
}

/**
 * Tells whether a graph holds a local branch by that exact name; `origin/` refs are remote-tracking ones.
 * @param graph - The graph.
 * @param name - The branch name.
 * @returns Whether `refs/heads/<name>` exists.
 */
const isLocalBranch = (graph: Graph, name: string): boolean => !name.startsWith('origin/') && name !== 'HEAD' && graph.refs[name] !== undefined

/**
 * Lists a first-parent chain until it meets a reached commit, each commit with all its parents, as `git rev-list --first-parent --parents` prints it.
 * @param graph - The graph.
 * @param id - The chain's newest commit.
 * @param reached - The commits the walk stops at.
 * @returns The lines, newest first.
 */
function walkFirstParents(graph: Graph, id: string | undefined, reached: Set<string>): string[] {
  const commit = id === undefined ? undefined : graph.commits[id]
  return !id || !commit || reached.has(id) ? [] : [[id, ...commit.parents].join(' '), ...walkFirstParents(graph, commit.parents[0], reached)]
}

/**
 * Names the tree a set of files makes: the same files give the same tree.
 *
 * @param files - The content hash of every file, by path.
 * @returns The tree id.
 */
const nameTree = (files: Record<string, string>): string =>
  `tree:${Object.entries(files).filter(([, hash]) => hash).sort(([a], [b]) => a.localeCompare(b)).map(([path, hash]) => `${path}=${hash}`).join(',')}`

/**
 * Lists the paths whose content differs between two sets of files.
 *
 * @param from - The files compared against.
 * @param to - The files compared.
 * @returns The paths, sorted.
 */
const diffFiles = (from: Record<string, string>, to: Record<string, string>): string[] =>
  [...new Set([...Object.keys(from), ...Object.keys(to)])].filter(path => (from[path] ?? '') !== (to[path] ?? '')).sort()

/**
 * Builds a linear history with stable commit and tree aliases.
 * @param tips - Current tip number of each observed branch.
 * @param config - Config contents, when present.
 * @param highest - Highest previously observed tip, retaining commits after a reset.
 * @returns The graph consumed by the shared git answers.
 */
export function linearGraph(tips: Record<string, number>, config?: string, highest = 0): Graph {
  const maximum = Math.max(highest, 0, ...Object.values(tips))
  const base: Record<string, string> = config === undefined ? {} : { '.claude/working-agreement.json': configBlob(config) }
  const trees = { 'base-tree': base, tree: { ...base, 'src/a.ts': 'tree' } }
  return {
    commits: Object.fromEntries(Array.from({ length: maximum + 1 }, (_, index) => [`c${index}`, {
      parents: index ? [`c${index - 1}`] : [], files: index ? trees.tree : trees['base-tree'],
    }])),
    refs: { ...Object.fromEntries(Object.entries(tips).flatMap(([branch, tip]) => [
      [branch, `c${tip}`], [`origin/${branch}`, `c${tip}`],
    ])), main: 'c0', 'origin/main': 'c0' },
    trees, blobs: config === undefined ? {} : { [configBlob(config)]: config },
    upstreams: Object.fromEntries(Object.keys(tips).filter(branch => branch !== 'HEAD').map(branch => [branch, `origin/${branch}`])),
  }
}

/**
 * Mocks the engine beneath the mod: a Small feature session at Code on #1 (ready-for-agent) by default,
 * checked out on `git.branch`, with GitHub connected and every gh issue open unless `issues` says otherwise.
 *
 * @param on - The test's hook registrar.
 * @param checkout - The checkout, read on every git call so a test can change it mid-way.
 * @param options - Session records and external responses that replace the defaults.
 * @returns The world's command log and clock.
 */
export function createWorld(on: On, checkout: Checkout, options: Options = {}): World {
  mock.env(on, options.herdrEnv ?? {})
  // A test moves the session by setting options.cwd.
  const session = { get cwd() { return options.cwd ?? root } }
  const chat = { id: 'sid' }
  const commands: string[] = []
  const runs: string[] = []
  const herdrCalls: World['herdrCalls'] = []
  const registeredCommands: World['registeredCommands'] = []
  const registeredTools: World['registeredTools'] = []
  const statusGates = new Set<Promise<void>>()
  const issueGates = new Set<Promise<void>>()
  const prompts: string[] = []
  const suggestions: string[] = []
  const files = new Map<string, string>()
  const modified = new Map<string, number>()
  /**
   * Seeds approval without exposing the approval record to scenarios.
   * @param text - The approved config content.
   */
  const approveConfig = (text: string): void => { files.set(`${common}/working-agreement/ok/${configBlob(text)}.json`, '{"v":1}') }
  if (options.approvedConfig !== undefined) approveConfig(options.approvedConfig)
  files.set('/plugin/.claude-plugin/plugin.json', JSON.stringify({ version: '1.2.3' }))
  const engineChat = chat.id
  const sessions = new Map<string, SessionRecord>()
  const held = new Map<string, HeldSession>()
  const engineStore = { isWritten: false }
  const failures = { renames: options.renameFailures ?? 0, compares: options.casMisses ?? 0 }
  const identity = { branch: checkout.branch, issues: (options.session?.flow === null && options.unit ? [1] : options.session?.issues ?? [1]) as number[] }
  // Custom issue state does not inherit the default at-Code skill evidence.
  const seeded = { ...createEmptySession(chat.id), unit: identity, units: options.session?.flow === null && !options.unit ? [] : [{ identity, skills: options.session?.info === undefined ? ['to-spec'] : [], verifyRuns: [], runs: [], ...options.unit }],
    info: { 1: { title: 'feat', labels: ['ready-for-agent'] } }, gh: 'connected', ...options.session }
  const { flow: _flow, issues: _issues, ...record } = seeded
  const initial: SessionRecord = { ...record, unit: options.session?.flow === null ? null : identity } as SessionRecord
  const seed = options.isStateAbsent ? undefined : initial
  if (seed) sessions.set(chat.id, seed)
  const flow = options.session?.flow ?? (options.session?.flow === null ? null : 'small-feature')
  const ready = flow ? hashBlob(JSON.stringify(identity)).then(hash => {
    files.set(`${common}/working-agreement/u/${hash}.json`, JSON.stringify({ v: 1, identity, flow }))
  }) : Promise.resolve()
  const legacy = new Set(Object.keys(options.legacy ?? {}))
  const views: (FlowView | null)[] = []
  const liveRuns: (RunView | null)[] = []
  const paneViews: PaneView[] = []
  const opened: PaneOpenArgs[] = []
  const logs: LogEntry[] = []
  const tips = new Map<string, number>()
  const answeredEntries = new Set<string>()
  const herdrActivity = { calls: 0, active: 0, maximum: 0 }
  const initialConfig = options.verifyFile
  const graphCache: GraphCache = { highest: 0 }
  const commitDates = new Map<string, number>()
  const treeFiles = new Map<string, Record<string, string>>()
  const treeNames = new Map<string, string>()
  // The first alias wins; the canonical key indexes subsequent lookups.
  const treeName = (contents: Record<string, string>, alias?: string): string => {
    const key = nameTree(contents)
    const name = treeNames.get(key) ?? (alias && !treeFiles.has(alias) ? alias : key)
    treeNames.set(key, name)
    treeFiles.set(name, contents)
    return name
  }
  on('store.keys', () => ({ value: [...legacy] }))
  on('store.delete', (_$, e) => { legacy.delete(e.key); return { value: undefined } })
  on('state.set', { plugin: 'working-agreement', key: 'view' }, (_$, e, next) => { views.push(e.value); return next(e) })
  on('state.set', { plugin: 'working-agreement', key: 'liveRun' }, (_$, e, next) => { liveRuns.push(e.value); return next(e) })
  // why: The kit hosts one engine session, so only the first chat has the engine's store; another chat is another
  // session, and a direct-dispatch port runs beside the engine. The world holds those stores, so they answer live
  // reads rather than one moment per dispatch; a held store and the engine's never share a record.
  const readHeld = (id: string): HeldSession => held.get(id) ?? { value: sessions.get(id), version: 0 }
  const writeHeld = (id: string, value: SessionRecord, expected: number): boolean => {
    const { version } = readHeld(id)
    if (failures.compares > 0) { failures.compares -= 1; return false }
    if (expected !== version) return false
    held.set(id, { value, version: version + 1 })
    sessions.set(id, value)
    return true
  }
  const refuseMixed = (): void => {
    if (chat.id === engineChat && held.has(engineChat)) throw new Error('a direct-dispatch port wrote this chat\'s record, which the engine store does not hold')
  }
  const directSessionState: World['directSessionState'] = {
    readSessionState: async () => readHeld(chat.id),
    writeSessionState: async (value, expected) => {
      if (chat.id === engineChat && engineStore.isWritten) throw new Error('the engine store holds this chat\'s record, which a direct-dispatch port cannot write')
      return writeHeld(chat.id, value, expected)
    },
  }
  const seedChat: World['seedChat'] = (id, record) => {
    if (id === engineChat) throw new Error('the first chat starts from the world options')
    held.set(id, { value: record, version: 1 })
    sessions.set(id, record)
  }
  on('state.get', { plugin: 'working-agreement', key: 'session' }, async (_$, e, next) => {
    if (chat.id !== engineChat) return { value: readHeld(chat.id) }
    refuseMixed()
    const read = await next(e)
    // why: The chat starts as one whose session already started: until the mod writes, the store holds what its start loaded.
    return seed && read.value && read.value.value === undefined && read.value.version === 0 ? { value: { value: seed, version: 0 } } : read
  })
  on('state.set', { plugin: 'working-agreement', key: 'session' }, async (_$, e, next) => {
    if (chat.id !== engineChat) return { value: { isSet: writeHeld(chat.id, e.value, e.ifVersion ?? readHeld(chat.id).version), version: readHeld(chat.id).version } }
    refuseMixed()
    if (failures.compares > 0) { failures.compares -= 1; return { value: { isSet: false, version: e.ifVersion ?? 0 } } }
    const written = await next(e)
    if (written.value?.isSet) { engineStore.isWritten = true; sessions.set(engineChat, e.value) }
    return written
  })
  const clock = mock.clock(on)
  on('session.id', async () => ({ value: await boundaries.readSessionId() }))
  on('session.cwd', () => ({ value: session.cwd }))
  on('session.usage', (_$, e) => ({ value: { startedAt: 0, context: options.contextUsage?.(e) ?? { tokens: 0, window: 200000 }, rateLimits: [] } }))
  on('command.register', (_$, e) => {
    registeredCommands.push(e)
    return { value: { command: e.name } }
  })
  on('tool.register', (_$, e) => {
    registeredTools.push({ name: e.name, isDeferred: e.isDeferred })
    return { value: { tool: `mcp__working-agreement__${e.name}` } }
  })
  const run = async (e: Args<'process.run'>): Promise<{ value: ProcessRunResult }> => {
    await ready
    if (e.argv[0] === 'herdr') herdrCalls.push({ argv: [...e.argv], timeoutMs: e.init?.timeoutMs })
    const raw = e.argv.filter(arg => arg !== '--no-optional-locks')
    const withoutEnv = raw[0] === 'env' ? raw.slice(raw.indexOf('git')) : raw
    const normalized = withoutEnv.filter((arg, index, args) => arg !== '-c' && args[index - 1] !== '-c')
    const command = normalized.join(' ')
    runs.push(command)
    if (options.failing !== undefined && command.startsWith(options.failing)) throw new Error(`${command} failed`)
    const buildResult = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'herdr') {
      herdrActivity.calls += 1
      herdrActivity.active += 1
      herdrActivity.maximum = Math.max(herdrActivity.maximum, herdrActivity.active)
      try { options.beforeHerdr?.(); if (herdrActivity.calls === 1) await options.herdrGate
        return buildResult(options.herdrReply?.(e.argv.slice(1)) ?? '', options.herdrResult?.exitCode ?? 0, options.herdrResult?.stderr ?? '')
      } finally { herdrActivity.active -= 1 }
    }
    if (command === 'uname -s') return buildResult(options.platform ?? 'Linux')
    if (e.argv[0] === 'tail') return buildResult((options.spawnOutput ?? '').replace(/\n$/, '').split('\n').slice(-4).join('\n'))
    if (e.argv[0] === 'sh') return buildResult(options.spawnOutput ?? '')
    if (e.argv[0] === 'cp' || e.argv[0] === 'mkdir') return buildResult('')
    if (e.argv[0] === 'tee') {
      if (options.appendExitCode) return buildResult('', options.appendExitCode, 'append failed')
      const target = e.argv[3] ?? ''
      files.set(target, (files.get(target) ?? '') + (e.init?.stdin ?? ''))
      return buildResult(e.init?.stdin ?? '')
    }
    if (e.argv[0] === 'rm') {
      if (options.removeExitCode) return buildResult('', options.removeExitCode, 'delete failed')
      for (const path of e.argv.slice(3)) files.delete(path)
      return buildResult('')
    }
    if (e.argv[0] === 'rmdir') {
      const directory = e.argv[2] ?? ''
      return [...files.keys()].some(path => path.startsWith(`${directory}/`)) ? buildResult('', 1, 'Directory not empty') : buildResult('')
    }
    if (e.argv[0] === 'mv') {
      if (failures.renames > 0) { failures.renames -= 1; return buildResult('', 1, 'rename failed') }
      const source = e.argv[3] ?? ''
      const target = e.argv[4] ?? ''
      const text = files.get(source)
      if (text === undefined) return buildResult('', 1, 'missing temporary record')
      files.set(target, text)
      files.delete(source)
      return buildResult('')
    }
    const worktrees: Record<string, Worktree> = checkout.worktrees ?? { [root]: checkout }
    if (!checkout.graph && (tips.get(checkout.branch) !== (checkout.ahead ?? 0)
      || Object.values(worktrees).some(wt => !tips.has(wt.branch)))) {
      tips.set(checkout.branch, checkout.ahead ?? 0)
      for (const wt of Object.values(worktrees)) if (!tips.has(wt.branch)) tips.set(wt.branch, 0)
      graphCache.highest = Math.max(graphCache.highest, ...tips.values())
      graphCache.linear = linearGraph(Object.fromEntries(tips), initialConfig, graphCache.highest)
    }
    const graph = checkout.graph ?? graphCache.linear ?? linearGraph(Object.fromEntries(tips), initialConfig)
    const isInitialGraph = commitDates.size === 0
    for (const [ordinal, [id, commit]] of Object.entries(graph.commits).entries()) {
      // Seeded history matches the real conformance repo; later commits default to the live clock.
      commitDates.set(id, commit.committerDate ?? commitDates.get(id)
        ?? (isInitialGraph ? Date.UTC(2000, 0, 1, 0, 0, ordinal) / 1000 : Math.floor(clock.now() / 1000)))
    }
    if (graphCache.indexed !== graph) {
      for (const [alias, contents] of Object.entries(graph.trees ?? {})) treeName(contents, alias)
      graphCache.indexed = graph
    }
    if (normalized[0] === 'git') {
      const localRoot = normalized[1] === '-C' ? normalized[2] ?? root : root
      const local = normalized.slice(normalized[1] === '-C' ? 3 : 1).join(' ')
      const repositories = { ...(options.isOutsideRepo ? {} : { [root]: { common, branch: checkout.branch } }),
        ...Object.fromEntries(Object.entries(checkout.worktrees ?? {}).map(([path, wt]) => [path, { common, branch: wt.branch }])),
        ...options.repositories }
      const owner = Object.entries(repositories).sort(([a], [b]) => b.length - a.length)
        .find(([path, repo]) => (localRoot === path || localRoot.startsWith(`${path}/`))
          && localRoot !== repo.common && !localRoot.startsWith(`${repo.common}/`) && !localRoot.includes('/.git'))
      const selected = worktrees[localRoot] ?? checkout
      const git: Checkout = owner && owner[1].branch !== selected.branch ? { ...selected, branch: owner[1].branch } : selected
      const head = worktrees[localRoot]?.head ?? graph.refs[git.branch]
      const config = options.verifyFile
      const blob = config === undefined ? '' : configBlob(config)
      const paths = git.changed ?? (git.isDirty ? ['src/a.ts'] : [])
      const working = Object.fromEntries(Object.entries({ ...graph.commits[head ?? '']?.files,
        ...Object.fromEntries(paths.map(path => [path, git.tree ?? 'tree'])), ...git.dirty,
        ...(config === undefined ? {} : { '.claude/working-agreement.json': blob }),
        ...(options.ignored?.length ? { '.gitignore': options.ignored.map(path => path.replace(`${owner?.[0] ?? root}/`, '')).join('\n') } : {}),
      }).filter(([, hash]) => hash))
      const resolve = (revision: string) => resolveRevision(graph, head,
        revision === '@{u}' ? graph.upstreams?.[git.branch] ?? '' : revision)
      const filesAt = (revision: string): Record<string, string> | undefined =>
        graph.commits[resolve(revision) ?? '']?.files ?? treeFiles.get(revision)
      const entry = gitAnswers.find(candidate => candidate.pattern.test(local))
      if (!entry) throw new Error(`Unmodelled git command: ${local}`)
      // why: Without -C git runs in the session's directory, as the engine runs a process with no cwd.
      const directory = normalized[1] === '-C' ? localRoot : e.init?.cwd ?? session.cwd
      const prefix = owner && directory.startsWith(`${owner[0]}/`) ? `${directory.slice(owner[0].length + 1)}/` : ''
      const answer = owner ? await entry.answer({ graph, commitDates, checkout: git, working, worktrees, localRoot, owner, prefix, resolve, filesAt,
        treeName,
        blobText: id => id === blob ? config ?? '' : graph.blobs?.[id] ?? `${id}\n`, stdin: e.init?.stdin ?? '',
      }, local.match(entry.pattern) ?? []) : fatal
      answeredEntries.add(entry.name)
      const gate = local.startsWith('status ') ? options.statusGate : undefined
      if (gate && !statusGates.has(gate)) { statusGates.add(gate); await gate }
      return buildResult(answer.stdout, answer.exitCode)
    }
    if (options.isLoggedOut && command.startsWith('gh ')) return buildResult('', 4, 'To get started with GitHub CLI, please run:  gh auth login')
    if (command.startsWith('gh ') && options.ghResponse) return buildResult(JSON.stringify(options.ghResponse.body), options.ghResponse.exitCode ?? 0)
    if (command.startsWith('gh api user')) return buildResult('me')
    const comments = command.match(/^gh api repos\/\{owner\}\/\{repo\}\/issues\/(\d+)\/comments --paginate --jq /)
    if (comments) {
      const response = options.comments?.[Number(comments[1])] ?? []
      return Array.isArray(response) ? buildResult(response.map(comment => JSON.stringify(comment)).join('\n')) : buildResult('', 1, response.error)
    }
    const subIssues = command.match(/^gh api repos\/\{owner\}\/\{repo\}\/issues\/(\d+)\/sub_issues --paginate --jq /)
    if (subIssues) return buildResult((options.subIssues?.[Number(subIssues[1])] ?? [])
      .map(subIssue => JSON.stringify({ state: subIssue.state, labels: subIssue.labels })).join('\n'))
    // gh api --include prints the response head before the body, and on an error the body is GitHub's JSON message.
    const rest = (status: number, body: unknown) => buildResult(`HTTP/2.0 ${status}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
      status < 300 ? 0 : 1, status < 300 ? '' : `gh: HTTP ${status}`)
    const compare = command.match(/^gh api --include repos\/\{owner\}\/\{repo\}\/compare\/(\S+)\.\.\.(\S+)$/)
    if (compare) {
      if (options.failing !== undefined && command.replace('gh api --include ', 'gh api ').startsWith(options.failing)) throw new Error(`${command} failed`)
      const from = compare[1] ?? ''
      const to = compare[2] ?? ''
      const known = (sha: string) => !!graph.commits[sha]
      if (!known(from) || !known(to) || options.unpublished?.includes(from) || options.unpublished?.includes(to)) {
        return rest(githubSamples.compare[1].status, githubSamples.compare[1].body)
      }
      const ancestors = (sha: string) => listAncestors(graph, sha)
      const fromAncestors = ancestors(from)
      const toAncestors = ancestors(to)
      const ahead = toAncestors.filter(sha => !fromAncestors.includes(sha)).length
      const behind = fromAncestors.filter(sha => !toAncestors.includes(sha)).length
      return rest(githubSamples.compare[0].status, { ...githubSamples.compare[0].body,
        status: from === to ? 'identical' : !behind ? 'ahead' : !ahead ? 'behind' : 'diverged', ahead_by: ahead, behind_by: behind, total_commits: ahead })
    }
    const checkRuns = command.match(/^gh api --paginate repos\/\{owner\}\/\{repo\}\/commits\/(\S+)\/check-runs --jq /)
    if (checkRuns) return buildResult((options.checkRuns?.[checkRuns[1] ?? ''] ?? [])
      .map(row => JSON.stringify(row)).join('\n'))
    const statuses = command.match(/^gh api --paginate repos\/\{owner\}\/\{repo\}\/commits\/(\S+)\/status --jq /)
    if (statuses) return buildResult((options.statuses?.[statuses[1] ?? ''] ?? [])
      .map(row => JSON.stringify(row)).join('\n'))
    const workflowRuns = command.match(/^gh api --paginate repos\/\{owner\}\/\{repo\}\/actions\/runs\?head_sha=(\S+) --jq /)
    if (workflowRuns) return buildResult((options.workflowRuns?.[workflowRuns[1] ?? ''] ?? [])
      .map(row => JSON.stringify(row)).join('\n'))
    if (command.startsWith('gh api --include repos/{owner}/{repo}/rules/branches/')) {
      const answer = () => options.rulesError
        ? rest(options.rulesError, { message: options.rulesMessage ?? githubSamples['branch-rules'][1].body.message })
        : rest(githubSamples['branch-rules'][0].status, options.rules ?? [])
      return options.rulesGate ? options.rulesGate.then(answer) : answer()
    }
    const ruleset = command.match(/^gh api --include repos\/\{owner\}\/\{repo\}\/rulesets\/(\d+)$/)
    if (ruleset) {
      const found = options.rulesets?.find(row => row['id'] === Number(ruleset[1]))
      return found ? rest(githubSamples.ruleset[0].status, { ...githubSamples.ruleset[0].body, ...found }) : rest(404, { message: 'Not Found' })
    }
    // GitHub marks a branch protected for a ruleset too; only protection.enabled is classic protection.
    if (command.startsWith('gh api --include repos/{owner}/{repo}/branches/')) {
      const error = options.protectionError
      const isClassic = options.isProtected ?? githubSamples.branch[0].body.protection.enabled
      if (!error) return rest(githubSamples.branch[0].status, { ...githubSamples.branch[0].body,
        protected: isClassic || (options.rules ?? []).length > 0, protection: { ...githubSamples.branch[0].body.protection, enabled: isClassic } })
      return error.status ? rest(error.status, { message: error.message }) : buildResult('', 1, error.message)
    }
    if (command.startsWith('gh api graphql -F owner={owner} -F name={repo} -f query=') && command.includes('pullRequest(number:')) {
      return options.prReadError ? buildResult('', 1, 'unreachable') : buildResult(JSON.stringify({ data: { repository: {
        pullRequest: options.prFields ?? githubSamples['pr-fields'][0].body.data.repository.pullRequest,
      } } }))
    }
    if (command.startsWith('gh api graphql -F owner={owner} -F name={repo} ') && command.includes('pullRequests(headRefName:')) {
      const head = normalized.find(arg => arg.startsWith('head='))?.slice(5)
      const base = normalized.find(arg => arg.startsWith('base='))?.slice(5)
      const { pullRequests: sample, ...repository } = githubSamples['pull-requests'][0].body.data.repository
      const closingPageInfo = sample.nodes[0]!.closingIssuesReferences.pageInfo
      const nodes = (options.prs ?? []).filter(pr => (!pr.headRefName || pr.headRefName === head) && (!base || !pr.baseRefName || pr.baseRefName === base))
        .map(pr => ({ ...pr, url: pr.url ?? `https://github.test/pull/${pr.number}`, baseRefName: pr.baseRefName ?? 'main', body: pr.body ?? '', closingIssuesReferences: Array.isArray(pr.closingIssuesReferences)
          ? { nodes: pr.closingIssuesReferences, pageInfo: closingPageInfo } : pr.closingIssuesReferences }))
      return buildResult(JSON.stringify({ data: { repository: { ...repository, pullRequests: { ...sample, nodes,
        pageInfo: { ...sample.pageInfo, hasNextPage: options.prsHasNextPage ?? sample.pageInfo.hasNextPage } } } } }))
    }
    const issue = command.startsWith('gh api graphql -F owner={owner} -F name={repo} -f query=') ? command.match(/issue\(number:(\d+)\)/) : null
    if (issue && command.includes('closedByPullRequestsReferences')) {
      const number = Number(issue[1])
      const sample = githubSamples['closing-pull-requests'][0].body.data.repository
      const references = sample.issue.closedByPullRequestsReferences
      const timeline = sample.issue.timelineItems
      return buildResult(JSON.stringify({ data: { repository: { ...sample, issue: { closedByPullRequestsReferences: { ...references,
        nodes: options.closingPrs?.[number] ?? [],
        pageInfo: { ...references.pageInfo, hasNextPage: options.closingHasNextPage ?? references.pageInfo.hasNextPage },
      }, timelineItems: { nodes: (options.crossReferences?.[number] ?? []).map(source => ({ source: { __typename: 'PullRequest', ...source } })),
        pageInfo: { ...timeline.pageInfo, hasNextPage: options.timelineHasNextPage ?? timeline.pageInfo.hasNextPage } } } } } }))
    }
    if (issue && options.missing?.includes(Number(issue[1]))) return buildResult('', 1)
    if (issue) {
      const number = Number(issue[1])
      const gate = options.issueGate
      if (gate && !issueGates.has(gate)) { issueGates.add(gate); await gate }
      const held = initial.info[String(number)]
      const info = held && !('error' in held) ? held : undefined
      const sample = (githubSamples.issue.find(each => each.body.data.repository.issue.state === options.issues?.[number]) ?? githubSamples.issue[0]).body.data.repository.issue
      const labels = (options.issueLabels?.[number] ?? info?.labels ?? []).map(name => ({ name }))
      return buildResult(JSON.stringify({ data: { repository: { issue: { ...sample,
        state: options.issues?.[number] ?? sample.state, title: info?.title ?? sample.title, labels: { ...sample.labels, nodes: labels },
      } } } }))
    }
    return buildResult('')
  }
  on('process.run', (_$, e) => run(e))
  on('process.spawn', async function* (_$, e, next) {
    runs.push(JSON.stringify(e.argv.slice(6)))
    if (options.spawnGate) {
      const stopped: { resolve?: () => void } = {}
      const abort = () => stopped.resolve?.()
      const cancelled = new Promise<void>(resolve => { stopped.resolve = resolve })
      next.signal.addEventListener('abort', abort, { once: true })
      if (next.signal.aborted) abort()
      try { await Promise.race([options.spawnGate, cancelled]) }
      finally { next.signal.removeEventListener('abort', abort) }
    }
    options.afterSpawn?.()
    return { value: { code: options.spawnCode === undefined ? 0 : options.spawnCode, signal: options.spawnSignal ?? null } }
  })
  const boundaries = {
    processes: { run: async (argv, init) => (await run({ argv, init })).value },
    files: {
      stat: async path => {
        const link = Object.entries(options.symlinks ?? {}).find(([name]) => path === name || path.startsWith(`${name}/`))
        if (link && link[1] === null) return { kind: 'other' as const, size: 0, mtimeMs: 0, isLink: true }
        const realPath = link ? `${link[1]}${path.slice(link[0].length)}` : path
        const directories = ['/', '/tmp', root, common, session.cwd, ...Object.keys(checkout.worktrees ?? {}),
          ...Object.keys(options.repositories ?? {}), ...Object.values(options.repositories ?? {}).map(repo => repo.common)]
        const isDirectory = directories.includes(realPath) || [...files.keys()].some(file => file.startsWith(`${realPath}/`))
        if (!isDirectory && !files.has(realPath)) throw new Error(`no such file: ${path}`)
        return { kind: isDirectory ? 'dir' as const : 'file' as const, realPath, size: 0, mtimeMs: 0, isLink: !!link }
      },
      exists: async path => files.has(path),
      read: async path => {
        const text = files.get(path)
        if (text === undefined) throw new Error(`no such file: ${path}`)
        if (options.readFailurePrefix && path.startsWith(options.readFailurePrefix)) throw new Error(`EIO: i/o error, read '${path}'`)
        return text
      },
      write: async (path, text) => { files.set(path, text) },
      list: async directory => {
        if (options.listFailurePrefix && directory.startsWith(options.listFailurePrefix)) throw new Error('listing failed')
        if (options.isMissingListFailed && ![...files.keys()].some(path => path.startsWith(`${directory}/`))) throw new Error(`no such directory: ${directory}`)
        const names = [...new Set([...files.keys()].filter(path => path.startsWith(`${directory}/`)).map(path => path.slice(directory.length + 1).split('/')[0]!))]
        return names.map(name => files.has(`${directory}/${name}`)
          ? { name, kind: 'file' as const, isLink: false, size: files.get(`${directory}/${name}`)?.length ?? 0,
            mtimeMs: modified.get(`${directory}/${name}`) ?? clock.now() }
          : { name, kind: 'dir' as const, isLink: false, size: 0, mtimeMs: clock.now() })
      },
    },
    readHerdrEnv: async () => ({ environment: options.herdrEnv?.HERDR_ENV, paneId: options.herdrEnv?.HERDR_PANE_ID }),
    readCwd: async () => session.cwd,
    readSessionId: async () => { options.beforeSessionId?.(); return chat.id },
  } satisfies World['boundaries']
  on('fs.stat', async (_$, e) => ({ value: await boundaries.files.stat(e.path) }))
  on('fs.read', async (_$, e) => ({ value: await boundaries.files.read(e.path.endsWith('/.claude-plugin/plugin.json') ? '/plugin/.claude-plugin/plugin.json' : e.path) }))
  on('fs.exists', async (_$, e) => ({ value: await boundaries.files.exists(e.path) }))
  on('fs.write', async (_$, e) => ({ value: await boundaries.files.write(e.path, e.text) }))
  on('fs.list', async (_$, e) => ({ value: await boundaries.files.list(e.path) }))
  on('classic.SessionStart', () => ({ watchPaths: options.watchPaths }))
  on('classic.FileChanged', () => ({}))
  on('classic.WorktreeCreate', () => ({}))
  on('classic.WorktreeRemove', () => ({}))
  on('classic.Stop', () => ({}))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.run', (_$, e) => {
    commands.push(e.command)
    return {}
  })
  on('ui.log', (_$, e, next) => { logs.push({ text: e.text, to: e.to }); return next(e) })
  on('ui.open', (_$, e) => { opened.push({ id: e.id, title: e.title, closeOnEscape: e.closeOnEscape }); return { value: { isPlaced: true } } })
  on('tool.call', () => { options.afterTool?.(); return { result: 'written' } })
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => {
    options.beforePromptSubmit?.(e.text)
    prompts.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('prompt.suggest', (_$, e) => {
    suggestions.push(e.text)
    return { isShown: options.isSuggestionShown ?? true }
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}))
  return { ready, answeredEntries, herdrActivity, approveConfig, boundaries, directSessionState, herdrCalls, registeredCommands, registeredTools,
    commands, prompts, suggestions, clock, files, modified, runs, chat, sessions, seedChat, legacy, views, liveRuns, paneViews, opened, logs }
}

/**
 * Adapts a world for direct dispatch when engine dispatch cannot preserve the scenario.
 * @param world - The test boundaries and observed state.
 * @returns A port that refuses unexpected command spawns.
 */
export function createTestPort(world: World): EnginePort {
  return {
    ...world.boundaries, ...world.directSessionState, cause: 'test',
    logDebug: text => { world.logs.push({ text, to: 'debug' }) },
    processes: { ...world.boundaries.processes, spawn: () => { throw new Error('unexpected spawn') } },
    clock: { sleep: delayMs => world.clock.sleep(delayMs) },
    clearLegacyStore: async () => {}, now: async () => world.clock.now(), repeat: () => {}, defer: work => { work() },
    readPluginRoot: async () => '/plugin', readContext: async () => ({ window: 200000 }), readView: async () => world.views.at(-1) ?? null,
    writeView: async view => { world.views.push(view) }, readLiveRun: async () => world.liveRuns.at(-1) ?? null,
    writeLiveRun: async run => { world.liveRuns.push(run) }, readPaneView: async () => world.paneViews.at(-1) ?? 'flow',
    writePaneView: async view => { world.paneViews.push(view) }, openPane: async closeOnEscape => { world.opened.push({ id: 'working-agreement', title: 'Flow', closeOnEscape }) },
    runSlashCommand: async () => {}, submitPrompt: async () => {}, suggestPrompt: async () => false, registerSurface: async () => {},
  }
}
