import { hasExitedZero, runCommand } from './process'
import type { ProcessPort } from './process'
import { fail, succeed, unwrapOr } from './result'
import type { Result } from './result'
import { hasPullRequestTrigger } from './workflow-triggers'

/** The checkout as git reports it: where it is, which branch and commit, and how it stands against the default branch. */
export interface GitState { root: string; branch: string; head: string; base: string; ahead: number; isDirty: boolean; isUpToDate: boolean }

/** The refs tried, in order, for the default branch. */
const baseCandidates = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']

/**
 * Reads the repository root.
 *
 * @param processes - The engine's process runner.
 * @returns The root, null outside a repository, or a failure when git cannot run.
 */
export async function readRoot(processes: ProcessPort): Promise<Result<string | null>> {
  const run = await runCommand(processes, ['git', 'rev-parse', '--show-toplevel'])
  if (!run.isOk) return run
  return succeed(run.value.exitCode === 0 ? run.value.stdout.trim() : null)
}

// The trimmed output of a git command, whatever its exit code; '' when git cannot run.
async function readOutput(processes: ProcessPort, args: string[]): Promise<string> {
  const run = await runCommand(processes, ['git', ...args])
  return run.isOk ? run.value.stdout.trim() : ''
}

// The first candidate ref that exists, or null.
async function findFirstRef(processes: ProcessPort, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const run = await runCommand(processes, ['git', 'rev-parse', '--verify', '--quiet', candidate])
    if (run.isOk && run.value.exitCode === 0) return candidate
  }
  return null
}

/**
 * Counts the commits a commit has beyond a ref.
 *
 * @param processes - The engine's process runner.
 * @param fromRef - The ref counted from.
 * @param to - The commit counted to; HEAD when omitted.
 * @returns The count, or a failure when git cannot count them.
 */
export async function countCommitsSince(processes: ProcessPort, fromRef: string, to = 'HEAD'): Promise<Result<number>> {
  const run = hasExitedZero(await runCommand(processes, ['git', 'rev-list', '--count', `${fromRef}..${to}`]))
  const count = run.isOk ? Number(run.value.stdout.trim()) : NaN
  return run.isOk && Number.isInteger(count) ? succeed(count) : fail(run.isOk ? 'unreadable commit count' : run.error)
}

/**
 * Tells whether a commit is an ancestor of another, or the same commit.
 *
 * @param processes - The engine's process runner.
 * @param ancestor - The commit expected behind.
 * @param descendant - The commit expected ahead.
 * @returns Whether it is, or a failure when git cannot tell, as for a commit it does not know.
 */
export async function isAncestor(processes: ProcessPort, ancestor: string, descendant: string): Promise<Result<boolean>> {
  const run = await runCommand(processes, ['git', 'merge-base', '--is-ancestor', ancestor, descendant])
  if (!run.isOk) return run
  return run.value.exitCode === 0 || run.value.exitCode === 1 ? succeed(run.value.exitCode === 0) : fail(`git merge-base exited ${run.value.exitCode}`)
}

/**
 * Reads the tree a commit holds.
 *
 * @param processes - The engine's process runner.
 * @param commit - The commit.
 * @returns The tree id, or a failure when the commit is unknown or git cannot run.
 */
export async function readCommitTree(processes: ProcessPort, commit: string): Promise<Result<string>> {
  const run = hasExitedZero(await runCommand(processes, ['git', 'rev-parse', `${commit}^{tree}`]))
  return run.isOk ? succeed(run.value.stdout.trim()) : run
}

/**
 * Reads the commit HEAD points at.
 *
 * @param processes - The engine's process runner.
 * @returns The commit id, or a failure when there is none or git cannot run.
 */
export async function readHead(processes: ProcessPort): Promise<Result<string>> {
  const run = hasExitedZero(await runCommand(processes, ['git', 'rev-parse', 'HEAD']))
  if (!run.isOk) return run
  const head = run.value.stdout.trim()
  return head ? succeed(head) : fail('no HEAD commit')
}

/**
 * Reads the checkout: its root, branch, HEAD, default branch, commits ahead of it, and whether it is dirty or level with its upstream.
 *
 * @param processes - The engine's process runner.
 * @returns The checkout, null outside a repository, or a failure when git cannot run.
 */
export async function readGitState(processes: ProcessPort): Promise<Result<GitState | null>> {
  const root = await readRoot(processes)
  if (!root.isOk || !root.value) return root.isOk ? succeed(null) : root
  const branch = await readOutput(processes, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const baseRef = await findFirstRef(processes, baseCandidates)
  const named = baseRef === 'origin/HEAD' ? await readOutput(processes, ['rev-parse', '--abbrev-ref', baseRef]) : baseRef
  const base = named?.replace(/^origin\//, '') || 'main'
  const ahead = baseRef ? unwrapOr(await countCommitsSince(processes, baseRef), 0) : 0
  const isDirty = (await readOutput(processes, ['status', '--porcelain'])) !== ''
  const upstream = await runCommand(processes, ['git', 'rev-list', '--count', '@{u}..HEAD'])
  const isUpToDate = upstream.isOk && upstream.value.exitCode === 0 && upstream.value.stdout.trim() === '0'
  return succeed({ root: root.value, branch, head: unwrapOr(await readHead(processes), ''), base, ahead, isDirty, isUpToDate })
}

/**
 * Tells whether a GitHub Actions workflow runs on pull requests, through the `on:` key rather than any mention of the word.
 * The pathspec is anchored at the root: git resolves a plain one against the working directory, which may be a subfolder.
 *
 * @param processes - The engine's process runner.
 * @returns Whether one does, or a failure when git cannot run or cannot search.
 */
export async function hasPullRequestWorkflow(processes: ProcessPort): Promise<Result<boolean>> {
  const run = await runCommand(processes, ['git', 'grep', '-I', '--full-name', '--null', '-e', '', '--', ':/.github/workflows'])
  if (!run.isOk) return run
  // Exit 1 is git grep's "no match": the repository has no workflow file.
  if (run.value.exitCode === 1) return succeed(false)
  const read = hasExitedZero(run, `git grep exited ${run.value.exitCode}`)
  if (!read.isOk) return read
  // Each output line is `<path>\0<line>`; the lines are grouped back into their files.
  const files = run.value.stdout.split('\n').reduce<Record<string, string[]>>((byPath, line) => {
    const split = line.indexOf('\0')
    if (split < 0) return byPath
    const path = line.slice(0, split)
    return { ...byPath, [path]: [...(byPath[path] ?? []), line.slice(split + 1)] }
  }, {})
  return succeed(Object.values(files).some(hasPullRequestTrigger))
}

/**
 * Hashes the whole working tree, untracked files included, without touching the real index.
 *
 * @param processes - The engine's process runner.
 * @returns The tree id, or a failure when it cannot be written.
 */
export async function readTreeKey(processes: ProcessPort): Promise<Result<string>> {
  const run = hasExitedZero(await runCommand(processes, ['sh', '-c',
    'T=$(mktemp) && cp "$(git rev-parse --git-dir)/index" "$T" 2>/dev/null; ' +
    'GIT_INDEX_FILE="$T" git add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$T" git write-tree; rm -f "$T"']))
  return run.isOk ? succeed(run.value.stdout.trim()) : run
}

/**
 * Hashes a file's content as git would store it.
 *
 * @param processes - The engine's process runner.
 * @param path - The file's absolute path, so it resolves from any working directory.
 * @returns The content hash, or a failure when the file is absent or git cannot run.
 */
export async function hashFile(processes: ProcessPort, path: string): Promise<Result<string>> {
  const run = hasExitedZero(await runCommand(processes, ['git', 'hash-object', '--', path]))
  return run.isOk ? succeed(run.value.stdout.trim()) : run
}

/**
 * Lists every file changed since a commit: staged or not, and untracked files.
 *
 * @param processes - The engine's process runner.
 * @param root - The repository root.
 * @param since - The commit compared against.
 * @returns The repo-relative paths, or a failure when either listing fails.
 */
export async function listChangedFiles(processes: ProcessPort, root: string, since: string): Promise<Result<string[]>> {
  const changed = hasExitedZero(await runCommand(processes, ['git', '-C', root, 'diff', '--name-only', '--no-renames', since]))
  if (!changed.isOk) return changed
  const untracked = hasExitedZero(await runCommand(processes, ['git', '-C', root, 'ls-files', '--others', '--exclude-standard']))
  if (!untracked.isOk) return untracked
  return succeed([...changed.value.stdout.split('\n'), ...untracked.value.stdout.split('\n')].filter(Boolean))
}

/**
 * Lists every file that differs between two commits.
 *
 * @param processes - The engine's process runner.
 * @param root - The repository root.
 * @param from - The commit compared against.
 * @param to - The commit compared.
 * @returns The repo-relative paths, or a failure when the diff fails.
 */
export async function listCommittedFiles(processes: ProcessPort, root: string, from: string, to: string): Promise<Result<string[]>> {
  const run = hasExitedZero(await runCommand(processes, ['git', '-C', root, 'diff', '--name-only', '--no-renames', from, to]))
  return run.isOk ? succeed(run.value.stdout.split('\n').filter(Boolean)) : run
}
