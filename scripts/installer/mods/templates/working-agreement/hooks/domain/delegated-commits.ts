import { hasOnlyKeys, isNonEmptyString, isRecord } from '../lib/guards'

/** Holds one commit a delegated unit made on its own branch, keyed by its change so the user's re-sign keeps it readable. */
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
 * Re-creates every commit of base..head signed, on its exact tree, byte-exact message, author and dates, then moves head and
 * the named merged children with their old value as a guard, only once the head keeps its tree and every commit carries a
 * signature, which must also verify when this machine can verify one.
 * Run as `bash -c "$script" resign <root> <base> <head> [<child>...]`; it holds no single quote so it can be quoted whole.
 */
const resignScript = 'set -euo pipefail; cd "$1"; base=$2; head=$3; shift 3; declare -A map; verify=; '
  // why: An SSH signature verifies only against an allowed-signers file, an OpenPGP one only against a keyring.
  + 'case $(git config gpg.format || echo openpgp) in ssh) git config gpg.ssh.allowedSignersFile >/dev/null && verify=1 || :;; '
  + 'openpgp) gpg --list-keys 2>/dev/null | grep -c . >/dev/null && verify=1 || :;; esac; '
  + 'for c in $(git rev-list --reverse --topo-order "$base..$head"); do parents=(); '
  + 'for p in $(git rev-list --parents -n1 "$c" | cut -d" " -f2-); do parents+=(-p "${map[$p]:-$p}"); done; '
  // why: The message goes through a pipe, since a shell variable, $(…) or <<< would strip or add trailing newlines.
  + 'map[$c]=$(git cat-file commit "$c" | sed "1,/^$/d" | GIT_AUTHOR_NAME=$(git log -1 --format=%an "$c") '
  + 'GIT_AUTHOR_EMAIL=$(git log -1 --format=%ae "$c") GIT_AUTHOR_DATE=$(git log -1 --format=%aD "$c") '
  + 'GIT_COMMITTER_DATE=$(git log -1 --format=%cD "$c") git commit-tree -S "$(git rev-parse "$c^{tree}")" "${parents[@]}" -F -); done; '
  + 'old=$(git rev-parse "refs/heads/$head"); new=${map[$old]}; '
  + '[[ $(git rev-parse "$old^{tree}") == $(git rev-parse "$new^{tree}") ]] || { echo "tree changed, no ref moved" >&2; exit 1; }; '
  + 'for c in $(git rev-list "$base..$new"); do git cat-file commit "$c" | grep -c ^gpgsig >/dev/null || { echo "unsigned $c, no ref moved" >&2; exit 1; }; '
  + '[[ -z $verify ]] || git verify-commit "$c" >/dev/null 2>&1 || { echo "signature of $c does not verify, no ref moved" >&2; exit 1; }; done; '
  + 'for b in "$head" "$@"; do o=$(git rev-parse "refs/heads/$b"); git update-ref -m "re-sign delegated commits" "refs/heads/$b" "${map[$o]}" "$o"; done; '
  + 'echo "signed $head: tree unchanged, every commit carries a signature${verify:+ that verifies here}"'

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
 * Gives, per parent chain, the commands that sign and push it: the chain's head and every child it merged are re-signed in
 * place without replaying a merge, then the head is pushed. A branch its parent has not merged heads a chain of its own.
 * @param branches - The branches with unsigned delegated commits.
 * @param defaultBranch - The default branch, whose origin copy the chains keep as their base.
 * @returns The commands, one per line, in the order to run them.
 */
export function composeSigningCommands(branches: SigningBranch[], defaultBranch: string): string[] {
  // why: A rebase re-runs every merge and stops on each conflict resolved by hand; re-creating each commit on its own tree
  // keeps the verified content, and a moved ref still matches its worktree since every tree stays the same.
  const merged = (head: string, seen: string[] = []): SigningBranch[] => branches
    .filter(entry => entry.isMerged && entry.parent === head && !seen.includes(entry.branch))
    .flatMap(entry => [entry, ...merged(entry.branch, [...seen, head])])
  return branches.filter(entry => !entry.isMerged).sort((a, b) => a.branch.localeCompare(b.branch)).flatMap(entry => {
    const children = merged(entry.branch).map(child => ` ${child.branch}`).join('')
    return [
      `bash -c '${resignScript}' resign ${entry.root ?? '.'} origin/${defaultBranch} ${entry.branch}${children}`,
      `${entry.root ? `git -C ${entry.root}` : 'git'} push -u origin ${entry.branch}`,
    ]
  })
}

/**
 * Introduces the signing commands for the user's reply.
 * @param commands - The commands, in order.
 * @returns The block to append, empty when nothing is left to sign.
 */
export function describeSigning(commands: string[]): string {
  return commands.length ? `\n\nDelegated commits are unsigned and local — sign and push them, in this order (each re-sign moves no ref unless the tree is unchanged and every commit carries a signature):\n${commands.map(command => `  ${command}`).join('\n')}` : ''
}
