import { hasOnlyKeys, isNonEmptyString, isRecord } from '../lib/guards'
import { quoteIfNeeded, quoteWord } from '../lib/shell'

/** Holds one commit a delegated unit made on its own branch, keyed by its change so the user's re-sign keeps it readable. */
export interface DelegatedCommit { v: 1; key: string; sha: string; branch: string }

/** Holds a merged child ref with commits outside its head, and those commits' short ids. */
interface StrayChild { branch: string; commits: string[] }

/** Holds a chain's head and the merged child refs that move with it. */
interface ChainGroup { head: SigningBranch; children: SigningBranch[] }

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

/** Holds one parent chain the sign script re-signs: its head, the child refs that move with it and the facts the summary shows. */
export interface SigningChain {
  branch: string
  /** The worktree that has the head checked out, or null when none does. */
  root: string | null
  /** The commits above the default branch. */
  commits: number
  /** How many of those commits carry no signature. */
  unsigned: number
  /** The merged child refs that move with the head. */
  children: string[]
  /** The children with commits outside the head, each with those commits' short ids; the script refuses these. */
  strays: StrayChild[]
}

/** Holds everything the user needs to review, dry-run, run and push one signing round. */
export interface SigningPlan {
  /** The default branch, whose origin copy the chains keep as their base. */
  base: string
  /** Whether the signatures can be verified on this machine, worded for the Checks row. */
  verify: string
  /** The sign script's absolute path. */
  path: string
  chains: SigningChain[]
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
 * Groups the branches into parent chains: a head, and every branch merged into it, directly or through another merged branch.
 * A branch its parent has not merged heads a chain of its own.
 * @param branches - The branches with unsigned delegated commits.
 * @returns The chains sorted by head, each with its merged children.
 */
export function groupChains(branches: SigningBranch[]): ChainGroup[] {
  // why: A rebase re-runs every merge and stops on each conflict resolved by hand; re-creating each commit on its own tree keeps the verified content, and a moved ref still matches its worktree since every tree stays the same.
  const merged = (head: string, seen: string[] = []): SigningBranch[] => branches
    .filter(entry => entry.isMerged && entry.parent === head && !seen.includes(entry.branch))
    .flatMap(entry => [entry, ...merged(entry.branch, [...seen, head])])
  return branches.filter(entry => !entry.isMerged).sort((a, b) => a.branch.localeCompare(b.branch))
    .map(head => ({ head, children: merged(head.branch) }))
}

/**
 * Names a branch for the summary by its issue number, as `#<n>`, or by its own name when it carries none.
 * @param branch - The branch.
 * @returns The label.
 */
function issueLabel(branch: string): string {
  const issue = /^[^/]+\/(\d+)-/.exec(branch)?.[1]
  return issue ? `#${issue}` : branch
}

/**
 * Names the sign script's file: the head's issue number for one chain, `all` for several, and the head's name with `/` replaced by `-`
 * when the head carries no issue number.
 * @param heads - The chains' head branches.
 * @returns The file name.
 */
export function nameSignScript(heads: string[]): string {
  const [only] = heads
  if (only === undefined || heads.length > 1) return 'all.sh'
  return `${/^[^/]+\/(\d+)-/.exec(only)?.[1] ?? only.replace(/\//g, '-')}.sh`
}

/**
 * Writes the sign script: a reviewable multi-line bash file that re-creates every commit of each chain signed, on its exact tree,
 * author, dates and byte-exact message, then moves the head and its child refs only once every check has passed.
 * It takes `--dry-run`, which lists the commits and refs and moves nothing. It holds no rebase, so a merge resolved by hand keeps its tree.
 * @param chains - The chains, in the order to sign them.
 * @param base - The default branch.
 * @returns The script text.
 */
export function composeSignScript(chains: Pick<SigningChain, 'branch' | 'root' | 'children'>[], base: string): string {
  const lines = chains.map(chain => `  "$@" ${[chain.root ?? '.', `origin/${base}`, chain.branch, ...chain.children].map(quoteWord).join(' ')}`)
  return [
    '#!/bin/bash',
    '# Re-signs the unsigned delegated commits of the chains below, in place. Generated by the working-agreement mod: read it, then run it.',
    '#   bash <this file> --dry-run   lists the commits it would re-create and the refs it would move, and moves nothing',
    '#   bash <this file>             signs',
    '# Every commit is re-created with commit-tree -S on its exact tree, so no rebase replays a merge that was resolved by hand.',
    'set -euo pipefail',
    '',
    'dry_run=',
    '[[ ${1:-} == --dry-run ]] && dry_run=1',
    '',
    '# map: a commit to its signed twin. before: a ref to the value it had when this script started, which guards its move.',
    'declare -A map before',
    'verify=',
    `repo=${quoteIfNeeded(chains[0]?.root ?? '.')}`,
    '',
    '# The chains to sign, one per line: worktree, base, head, then the child refs that move with the head.',
    'chains() {',
    ...lines,
    '}',
    '',
    '# Phase 1, pre-check: a child ref may move only if every commit of it is inside its head; otherwise the head would move and the child would not.',
    'precheck() {',
    '  local root=$1 base=$2 head=$3 branch extra',
    '  shift 3',
    '  before[$head]=$(git -C "$root" rev-parse "refs/heads/$head")',
    '  for branch in "$@"; do',
    '    before[$branch]=$(git -C "$root" rev-parse "refs/heads/$branch")',
    '    extra=$(git -C "$root" rev-list --abbrev-commit "refs/heads/$branch" --not "refs/heads/$head" | paste -sd" " -)',
    '    [[ -z $extra ]] || { echo "stop: $branch has commits outside $head ($extra), no ref moved" >&2; exit 1; }',
    '  done',
    '}',
    '',
    '# Phase 2, verify capability: an SSH signature verifies only against an allowed-signers file, an OpenPGP one only against a keyring.',
    'check_capability() {',
    '  case $(git -C "$repo" config gpg.format || echo openpgp) in',
    '    ssh) git -C "$repo" config gpg.ssh.allowedSignersFile >/dev/null && verify=1 || : ;;',
    '    openpgp) gpg --list-keys 2>/dev/null | grep -c . >/dev/null && verify=1 || : ;;',
    '  esac',
    '}',
    '',
    '# Dry run: what phases 3 to 5 would do.',
    'list() {',
    '  local root=$1 base=$2 head=$3 branch',
    '  shift 2',
    '  echo "chain $head: would re-create these commits"',
    '  git -C "$root" log --reverse --format="  %h %s" "$base..refs/heads/$head"',
    '  echo "  and then move these refs, each guarded by its current value"',
    '  for branch in "$@"; do',
    '    ! git -C "$root" merge-base --is-ancestor "${before[$branch]}" "$base" || continue',
    '    echo "    $branch (now ${before[$branch]:0:12})"',
    '  done',
    '}',
    '',
    '# Phase 3, re-create: every commit gets a signed twin on the same tree, with its parents mapped to their twins.',
    'recreate() {',
    '  local root=$1 base=$2 head=$3 c p parents',
    '  for c in $(git -C "$root" rev-list --reverse --topo-order "$base..refs/heads/$head"); do',
    '    [[ -z ${map[$c]:-} ]] || continue',
    '    parents=()',
    '    for p in $(git -C "$root" rev-list --parents -n1 "$c" | cut -d" " -f2-); do parents+=(-p "${map[$p]:-$p}"); done',
    '    # The message goes through a pipe, since a shell variable, $(...) or <<< would strip or add trailing newlines.',
    '    map[$c]=$(git -C "$root" cat-file commit "$c" | sed "1,/^$/d" \\',
    '      | GIT_AUTHOR_NAME=$(git -C "$root" log -1 --format=%an "$c") GIT_AUTHOR_EMAIL=$(git -C "$root" log -1 --format=%ae "$c") \\',
    '        GIT_AUTHOR_DATE=$(git -C "$root" log -1 --format=%aD "$c") GIT_COMMITTER_DATE=$(git -C "$root" log -1 --format=%cD "$c") \\',
    '        git -C "$root" commit-tree -S "$(git -C "$root" rev-parse "$c^{tree}")" "${parents[@]}" -F -)',
    '  done',
    '}',
    '',
    '# Phase 4, checks: the head keeps its tree and every new commit carries a signature, which must also verify when this machine can verify one.',
    'check() {',
    '  local root=$1 base=$2 head=$3 old new c',
    '  old=${before[$head]}',
    '  new=${map[$old]}',
    '  [[ $(git -C "$root" rev-parse "$old^{tree}") == $(git -C "$root" rev-parse "$new^{tree}") ]] || { echo "tree changed, no ref moved" >&2; exit 1; }',
    '  for c in $(git -C "$root" rev-list "$base..$new"); do',
    '    git -C "$root" cat-file commit "$c" | grep -c ^gpgsig >/dev/null || { echo "unsigned $c, no ref moved" >&2; exit 1; }',
    '    [[ -z $verify ]] || git -C "$root" verify-commit "$c" >/dev/null 2>&1 || { echo "signature of $c does not verify, no ref moved" >&2; exit 1; }',
    '  done',
    '}',
    '',
    '# Phase 5, move refs: only now, each guarded by its old value, so a ref that changed meanwhile stops the run before the next one moves.',
    'move() {',
    '  local root=$1 base=$2 head=$3 branch',
    '  shift 2',
    '  for branch in "$@"; do',
    '    [[ -n ${map[${before[$branch]}]:-} ]] || continue',
    '    git -C "$root" update-ref -m "re-sign delegated commits" "refs/heads/$branch" "${map[${before[$branch]}]}" "${before[$branch]}"',
    '  done',
    '  echo "signed $head: tree unchanged, every commit carries a signature${verify:+ that verifies here}"',
    '}',
    '',
    'chains precheck',
    'check_capability',
    'if [[ -n $dry_run ]]; then',
    '  chains list',
    '  echo "dry run: no ref moved"',
    '  exit 0',
    'fi',
    'chains recreate',
    'chains check',
    'chains move',
    '',
  ].join('\n')
}

/**
 * Words the signing round for the user's reply: one block for a chain, or a table with a row per chain, then the steps to run.
 * @param plan - The round, or null when nothing is left to sign.
 * @returns The block to append, empty when nothing is left to sign.
 */
export function describeSigning(plan: SigningPlan | null): string {
  if (!plan?.chains.length) return ''
  const row = (key: string, value: string): string => `  ${key.padEnd(13)}${value}`
  const precheck = (chain: SigningChain): string => chain.strays.length
    ? `✘ ${chain.strays.map(stray => `${issueLabel(stray.branch)} has ${stray.commits.join(' ')} outside the head`).join(' · ')} — the script stops before any ref moves`
    : chain.children.length ? '✔ every child is inside the head' : '✔ no child refs'
  const checks = `tree unchanged · every commit signed · verify: ${plan.verify}`
  const [only] = plan.chains
  const lines = ['', '']
  if (plan.chains.length === 1 && only) {
    lines.push(`To sign  ${only.branch}`,
      row('Commits', `${only.commits} above origin/${plan.base} (${only.unsigned} unsigned, ${only.commits - only.unsigned} signed)`),
      row('Child refs', only.children.length ? `${only.children.length} move with it (${only.children.map(issueLabel).join(' ')})` : 'none'),
      row('Checks', checks), row('Pre-check', precheck(only)))
  } else {
    const table = [['Chain', 'Commits', 'Unsigned', 'Children', 'Pre-check'], ...plan.chains.map(chain => [chain.branch, `${chain.commits}`, `${chain.unsigned}`, `${chain.children.length}`, precheck(chain)])]
    const widths = (table[0] ?? []).map((_, column) => Math.max(...table.map(cells => (cells[column] ?? '').length)))
    lines.push(`To sign  ${plan.chains.length} chains above origin/${plan.base}`,
      ...table.map(cells => `  ${cells.map((cell, column) => column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)).join('  ')}`), row('Checks', checks))
  }
  const script = `bash ${quoteIfNeeded(plan.path)}`
  lines.push('', 'Run', `  1. ${script} --dry-run    # lists, moves nothing`, `  2. ${script}`,
    ...plan.chains.map((chain, index) => `  ${index + 3}. ${chain.root ? `git -C ${quoteIfNeeded(chain.root)}` : 'git'} push -u origin ${chain.branch}`))
  return lines.join('\n')
}
