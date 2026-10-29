import { hasOnlyKeys, isNonEmptyString, isRecord } from '../lib/guards'

/** Holds one commit a delegated unit made on its own branch, keyed by its change so the user's signing rebase keeps it readable. */
export interface DelegatedCommit { v: 1; key: string; sha: string; branch: string }

/** Holds a branch with unsigned delegated commits, as the signing commands rewrite it. */
export interface SigningBranch {
  branch: string
  /** The worktree that has the branch checked out, or null when none does. */
  root: string | null
  /** The branch it was cut from, when that branch is rewritten too. */
  parent: string | null
  /** Whether the parent already carries every commit of the branch, so the parent's rewrite signs them. */
  isMerged: boolean
}

/**
 * Validates a delegated-commit record read from disk with exactly its keys.
 * @param value - The decoded JSON.
 * @returns The record, or null.
 */
export function parseDelegatedCommit(value: unknown): DelegatedCommit | null {
  return isRecord(value) && hasOnlyKeys(value, ['v', 'key', 'sha', 'branch']) && value.v === 1
    && isNonEmptyString(value.key) && isNonEmptyString(value.sha) && isNonEmptyString(value.branch)
    ? { v: 1, key: value.key, sha: value.sha, branch: value.branch } : null
}

/**
 * Gives, per parent chain, the commands that sign and push it: each merged child's worktree is detached, then the chain's
 * head is rebased in place with every merged child's ref updated, its signatures listed and the head pushed.
 * A branch its parent has not merged heads a chain of its own.
 * @param branches - The branches with unsigned delegated commits.
 * @param defaultBranch - The default branch, whose origin copy the chains keep as their base.
 * @returns The commands, one per line, in the order to run them.
 */
export function composeSigningCommands(branches: SigningBranch[], defaultBranch: string): string[] {
  // why: --force-rebase signs commits --keep-base would otherwise keep as they are, --rebase-merges keeps the child merges,
  // and --update-refs moves the merged children's refs, which it skips while a worktree holds them.
  const merged = (head: string, seen: string[] = []): SigningBranch[] => branches
    .filter(entry => entry.isMerged && entry.parent === head && !seen.includes(entry.branch))
    .flatMap(entry => [entry, ...merged(entry.branch, [...seen, head])])
  return branches.filter(entry => !entry.isMerged).sort((a, b) => a.branch.localeCompare(b.branch)).flatMap(entry => {
    const git = entry.root ? `git -C ${entry.root}` : 'git'
    const base = `origin/${defaultBranch}`
    return [
      ...merged(entry.branch).flatMap(child => child.root ? [`git -C ${child.root} switch --detach`] : []),
      `${git} rebase --keep-base --rebase-merges --update-refs --force-rebase --gpg-sign ${base} ${entry.branch}`,
      `${git} log --format='%G? %h %s' ${base}..${entry.branch}`,
      `${git} push -u origin ${entry.branch}`,
    ]
  })
}

/**
 * Introduces the signing commands for the user's reply.
 * @param commands - The commands, in order.
 * @returns The block to append, empty when nothing is left to sign.
 */
export function describeSigning(commands: string[]): string {
  return commands.length ? `\n\nDelegated commits are unsigned and local — sign and push them, in this order (every log line must start with G):\n${commands.map(command => `  ${command}`).join('\n')}` : ''
}
