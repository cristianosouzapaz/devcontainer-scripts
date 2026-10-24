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
 * Stages tracked and untracked content in a temporary index, copying the existing index when present and excluding ignored files.
 * @param processes - The process runner.
 * @param root - The worktree holding the branch.
 * @param temporary - The unique temporary index path under the common metadata directory.
 * @returns The content tree, or null if any command fails.
 */
export async function readContentTree(processes: ProcessPort, root: string, temporary: string): Promise<string | null> {
  const index = await readGitOutput(processes, ['-C', root, 'rev-parse', '--path-format=absolute', '--git-path', 'index'])
  if (!index) return null
  try {
    const directory = temporary.slice(0, temporary.lastIndexOf('/'))
    if (!hasExitedZero(await runProcess(processes, ['mkdir', '-p', '--', directory])).isOk) return null
    const copied = hasExitedZero(await runProcess(processes, ['sh', '-c', 'if [ -e "$1" ]; then cp -- "$1" "$2"; fi', 'copy-index', index, temporary]))
    if (!copied.isOk) return null
    const command = ['env', `GIT_INDEX_FILE=${temporary}`, ...gitArgv(['-c', 'core.splitIndex=false', '-C', root])]
    const added = hasExitedZero(await runProcess(processes, [...command, 'add', '-A']))
    if (!added.isOk) return null
    const tree = hasExitedZero(await runProcess(processes, [...command, 'write-tree']))
    return tree.isOk ? tree.value.stdout.trim() : null
  } finally {
    await removeFile(processes, temporary, `${temporary}.lock`)
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
 * Selects the remote default ref when it resolves, otherwise its local ref.
 * @param processes - The engine's process runner.
 * @param base - The default branch name.
 * @returns The default ref used for a merge base.
 */
export async function readDefaultRef(processes: ProcessPort, base: string): Promise<string> {
  return await readGitOutput(processes, ['rev-parse', '--verify', '--quiet', `origin/${base}`]) ? `origin/${base}` : `refs/heads/${base}`
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
