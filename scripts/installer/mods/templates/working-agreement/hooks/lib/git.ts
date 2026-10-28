import { executeProcess, hasExitedZero, runProcess } from './process'
import { removeFile } from './files'
import type { ProcessOutput, ProcessPort } from './process'
import { succeed } from './result'
import type { Result } from './result'

/** The checkout branch, HEAD, default branch and upstream state. */
export interface GitState { root: string; branch: string; head: string; base: string; isUpToDate: boolean }

/**
 * Describes a checkout listed by git, retaining full branch refs and detached HEADs.
 */
export interface Worktree { root: string; head: string; branch: string }

/** The refs tried, in order, for the default branch. */
const baseCandidates = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']

/** The tree git writes from an empty index, by repository object format. */
const emptyTrees = new Map([
  ['sha1', '4b825dc642cb6eb9a060e54bf8d69288fbee4904'],
  ['sha256', '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'],
])

/**
 * Prevents read-only git probes from taking optional repository locks.
 * @param args - The git subcommand and arguments.
 * @returns The git invocation with optional locks disabled.
 */
function gitArgv(args: string[]): string[] {
  return ['git', '--no-optional-locks', ...args]
}

/**
 * Reads the repository root.
 *
 * @param processes - The engine's process runner.
 * @returns The root, null outside a repository, or a failure when git cannot run.
 */
export async function readRoot(processes: ProcessPort): Promise<Result<string | null>> {
  const run = await runProcess(processes, gitArgv(['rev-parse', '--show-toplevel']))
  if (!run.isOk) return run
  return succeed(run.value.exitCode === 0 ? run.value.stdout.trim() : null)
}

/**
 * Selects the first resolvable default-branch candidate.
 * @param processes - The engine's process runner.
 * @param candidates - The refs in preference order.
 * @returns The first readable ref, or null when none resolves.
 */
async function findFirstRef(processes: ProcessPort, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const run = await runProcess(processes, gitArgv(['rev-parse', '--verify', '--quiet', candidate]))
    if (run.isOk && run.value.exitCode === 0) return candidate
  }
  return null
}

/**
 * Reads the checkout: its root, branch, HEAD, default branch, and whether it is level with its upstream.
 *
 * @param processes - The engine's process runner.
 * @returns The checkout, null outside a repository, or a failure when git cannot run.
 */
export async function readGitState(processes: ProcessPort): Promise<Result<GitState | null>> {
  const root = await readRoot(processes)
  if (!root.isOk || !root.value) return root.isOk ? succeed(null) : root
  const branch = await readGitOutput(processes, ['rev-parse', '--abbrev-ref', 'HEAD']) ?? ''
  const baseRef = await findFirstRef(processes, baseCandidates)
  const named = baseRef === 'origin/HEAD' ? await readGitOutput(processes, ['rev-parse', '--abbrev-ref', baseRef]) : baseRef
  const base = named?.replace(/^origin\//, '') || 'main'
  const upstream = await runProcess(processes, gitArgv(['rev-list', '--count', '@{u}..HEAD']))
  const isUpToDate = upstream.isOk && upstream.value.exitCode === 0 && upstream.value.stdout.trim() === '0'
  return succeed({ root: root.value, branch, head: await readGitOutput(processes, ['rev-parse', 'HEAD']) ?? '', base, isUpToDate })
}

/**
 * Reads a git fact only when the command succeeds.
 * @param processes - The process runner.
 * @param args - The git arguments.
 * @returns The trimmed output, or null on failure.
 */
export async function readGitOutput(processes: ProcessPort, args: string[]): Promise<string | null> {
  const run = hasExitedZero(await runProcess(processes, gitArgv(args)))
  return run.isOk ? run.value.stdout.trim() : null
}

/**
 * Tests ancestry without treating an unreadable revision as an ancestor.
 * @param processes - The process runner.
 * @param base - The possible ancestor.
 * @param tip - The descendant.
 * @returns Whether base is reachable from tip.
 */
export async function isAncestor(processes: ProcessPort, base: string, tip: string): Promise<boolean> {
  return (await readGitOutput(processes, ['merge-base', '--is-ancestor', base, tip])) !== null
}

/**
 * Finds commits newly reachable beyond a previous reachability boundary.
 * @param processes - The process runner.
 * @param tips - The tips whose reachable commits are inspected.
 * @param excluded - The tips whose reachable commits are excluded.
 * @param minAge - The latest included committer date, in epoch seconds; omitted for all dates.
 * @returns The sorted new commit SHAs, rejecting unreadable reachability.
 */
export async function listNewCommits(processes: ProcessPort, tips: string[], excluded: string[], minAge?: number): Promise<string[]> {
  if (!tips.length) return []
  const output = await readGitOutput(processes, ['rev-list', ...(minAge === undefined ? [] : [`--min-age=${minAge}`]), ...new Set(tips), '--not', ...new Set(excluded)])
  if (output === null) throw new Error('commit reachability unreadable')
  return output.split('\n').filter(Boolean).sort()
}

/**
 * Stages tracked and untracked content in a temporary index, copying the existing index when present and excluding ignored files.
 * @param processes - The process runner.
 * @param root - The worktree holding the branch.
 * @param temporary - The unique temporary index path under the common metadata directory.
 * @returns The content tree, or null if any command fails or the temporary index vanished during the capture.
 */
export async function readContentTree(processes: ProcessPort, root: string, temporary: string): Promise<string | null> {
  const paths = await readGitOutput(processes, ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', 'index', '--show-object-format'])
  const [index, format] = paths?.split('\n') ?? []
  if (!index) return null
  const stamp = `${temporary}.stamp`
  const live = `${temporary}.live`
  try {
    const directory = temporary.slice(0, temporary.lastIndexOf('/'))
    if (!hasExitedZero(await runProcess(processes, ['mkdir', '-p', '--', directory])).isOk) return null
    // why: git rechecks by content an entry written in the index's own mtime second, so a copy with a later mtime would trust stale stat data; stamping before copying means an index swapped in between can only leave the copy older, rechecking more.
    // The copy and stamp may thus be days old, so the fresh live marker, touched first, keeps another chat's sweep off the running capture.
    const copied = hasExitedZero(await runProcess(processes, ['sh', '-c', 'touch -- "$4" && if [ -e "$1" ]; then touch -r "$1" "$3" && cp -- "$1" "$2" && touch -r "$3" "$2"; fi', 'copy-index', index, temporary, stamp, live]))
    if (!copied.isOk) return null
    const command = ['env', `GIT_INDEX_FILE=${temporary}`, ...gitArgv(['-c', 'core.splitIndex=false', '-C', root])]
    const added = hasExitedZero(await runProcess(processes, [...command, 'add', '-A']))
    if (!added.isOk) return null
    const tree = hasExitedZero(await runProcess(processes, [...command, 'write-tree']))
    const content = tree.isOk ? tree.value.stdout.trim() : null
    if (content !== emptyTrees.get(format ?? '')) return content
    // why: git reads an index deleted under it as empty and recreates it, so the empty tree of a worktree holding files is the only trace of that deletion.
    const listed = await readGitOutput(processes, ['-C', root, 'ls-files', '-z', '-t', '--cached', '--deleted', '--others', '--exclude-standard'])
    if (listed === null) return null
    // --deleted lists each tracked file missing from the worktree a second time, so files are present only when entries outnumber twice the deletions.
    const entries = listed.split('\0').filter(Boolean)
    return entries.length > 2 * entries.filter(entry => entry.startsWith('R ')).length ? null : content
  } finally {
    await removeFile(processes, temporary, `${temporary}.lock`, stamp, live)
  }
}

/**
 * Executes git without optional locks, preserving rejected runs and non-zero exits.
 * @param processes - The engine's process runner.
 * @param args - The git arguments.
 * @param stdin - Optional standard input.
 * @returns The unmodified process output.
 */
export function runGit(processes: ProcessPort, args: string[], stdin?: string): Promise<ProcessOutput> {
  return executeProcess(processes, gitArgv(args), stdin === undefined ? {} : { stdin })
}

/**
 * Reads every listed worktree without inferring a branch for detached HEADs.
 * @param processes - The engine's process runner.
 * @returns The worktrees, or null when git cannot list them.
 */
export async function readWorktrees(processes: ProcessPort): Promise<Worktree[] | null> {
  const text = await readGitOutput(processes, ['worktree', 'list', '--porcelain'])
  return text === null ? null : text.split('\n\n').filter(Boolean).map(block => {
    const lines = block.split('\n')
    return { root: lines.find(line => line.startsWith('worktree '))?.slice(9) ?? '',
      head: lines.find(line => line.startsWith('HEAD '))?.slice(5) ?? '',
      branch: lines.find(line => line.startsWith('branch '))?.slice(7) ?? '' }
  })
}

/**
 * Reads the names of every local branch, so a missing branch is told apart from a failed read.
 * @param processes - The engine's process runner.
 * @returns The local branch names, or null when git cannot list the refs.
 */
export async function readLocalBranches(processes: ProcessPort): Promise<Set<string> | null> {
  const tips = await readLocalBranchTips(processes)
  return tips && new Set(tips.keys())
}

/**
 * Reads every local branch with its tip, as the refs stand now.
 * @param processes - The engine's process runner.
 * @returns The tip of each local branch by name, or null when git cannot list the refs.
 */
export async function readLocalBranchTips(processes: ProcessPort): Promise<Map<string, string> | null> {
  const text = await readGitOutput(processes, ['for-each-ref', '--format=%(refname) %(objectname)'])
  return text === null ? null : new Map(text.split('\n').flatMap(line => line.startsWith('refs/heads/')
    ? [[line.slice('refs/heads/'.length, line.lastIndexOf(' ')), line.slice(line.lastIndexOf(' ') + 1)] as const] : []))
}

/**
 * Selects the remote default ref when it resolves, otherwise its local ref.
 * @param processes - The engine's process runner.
 * @param base - The default branch name.
 * @returns The default ref used for a merge base.
 */
export async function readDefaultRef(processes: ProcessPort, base: string): Promise<string> {
  return await readGitOutput(processes, ['rev-parse', '--verify', '--quiet', `origin/${base}`]) ? `origin/${base}` : `refs/heads/${base}`
}

/**
 * Reads the branch a branch was cut from, as the oldest entry of its reflog names it.
 * @param processes - The engine's process runner.
 * @param branch - The branch whose reflog is read.
 * @param defaultBranch - The default branch, which is never a parent branch.
 * @returns The parent branch, or null when the reflog is absent or expired, or names HEAD, a revision, the branch itself,
 *   the default branch or no existing local branch.
 */
export async function readParentBranch(processes: ProcessPort, branch: string, defaultBranch: string): Promise<string | null> {
  const reflog = await readGitOutput(processes, ['log', '--walk-reflogs', '--format=%gs', `refs/heads/${branch}`, '--'])
  const name = reflog?.split('\n').at(-1)?.match(/^branch: Created from (.+)$/)?.[1]
  if (!name || name === branch || name === defaultBranch) return null
  // why: show-ref names only an exact ref, so a revision start point such as par~1 never passes for a branch.
  return await readGitOutput(processes, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]) === null ? null : name
}

/**
 * Reads a tip's fork point on a branch: the newest commit of the branch's first-parent chain that the tip reaches.
 * The local branch and its origin copy are both read and the newer fork point wins, so a stale copy of either never
 * pulls the base back; when the two have diverged, the local one wins.
 * @param processes - The engine's process runner.
 * @param branch - The base branch's name.
 * @param tip - The commit whose history is searched.
 * @returns The fork point, or null when neither copy of the branch exists or shares history with the tip.
 */
export async function readForkPoint(processes: ProcessPort, branch: string, tip: string): Promise<string | null> {
  const [local, remote] = await Promise.all([`refs/heads/${branch}`, `refs/remotes/origin/${branch}`].map(ref => readFirstParentFork(processes, ref, tip)))
  if (!local || !remote) return local ?? remote ?? null
  return local !== remote && await isAncestor(processes, local, remote) ? remote : local
}

/**
 * Walks a ref's first-parent chain down to the first commit the tip reaches.
 * @param processes - The engine's process runner.
 * @param ref - The full ref name.
 * @param tip - The commit whose history ends the walk.
 * @returns The first reached commit, or null when the ref does not exist or its chain never meets the tip's history.
 */
async function readFirstParentFork(processes: ProcessPort, ref: string, tip: string): Promise<string | null> {
  const head = await readGitOutput(processes, ['rev-parse', '--verify', '--quiet', ref])
  if (!head) return null
  // why: The walk lists the chain commits the tip does not reach, newest first; the last one's first parent is the fork point.
  const walk = await readGitOutput(processes, ['rev-list', '--first-parent', '--parents', head, '--not', tip])
  if (walk === null) return null
  return walk ? walk.split('\n').at(-1)?.split(' ')[1] ?? null : head
}

/**
 * Hashes exact text with the repository's object format without writing an object.
 * @param processes - The engine's process runner.
 * @param text - The exact standard input.
 * @returns The unmodified process output.
 */
export function hashObject(processes: ProcessPort, text: string): Promise<ProcessOutput> {
  return runGit(processes, ['hash-object', '--stdin'], text)
}

/**
 * Reads NUL-delimited changed paths with literal pathspec environment overrides disabled.
 * @param processes - The engine's process runner.
 * @param base - The base tree.
 * @param tree - The unit tree.
 * @param paths - The glob filters.
 * @returns The unmodified process output.
 */
export function diffPaths(processes: ProcessPort, base: string, tree: string, paths: string[]): Promise<ProcessOutput> {
  return executeProcess(processes, ['env', 'GIT_LITERAL_PATHSPECS=0', 'GIT_GLOB_PATHSPECS=0', 'GIT_ICASE_PATHSPECS=0',
    ...gitArgv(['-c', 'core.quotePath=false', '-c', 'diff.relative=false', 'diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', base, tree,
    '--', ...paths.map(path => `:(glob)${path}`)])])
}
