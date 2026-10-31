import type { Checkout, Graph } from './world'

/**
 * A git command the mod runs (after `git`), with what git answers in the fixture's repository; commit ids and file contents
 * are the fixture's names, which a real repository maps to its own ids. A non-zero exit is compared on its code alone.
 */
interface GitCheck {
  command: string; exitCode: number; stdout: string
  stdin?: string; dirty?: Record<string, string>; staged?: Record<string, string>; label?: string
}

/** Revisions (including WORKTREE), their dirty overlay, and whether git gives them the same tree. */
interface TreeCheck { commits: [string, string]; isSame: boolean; dirty?: Record<string, string> }

/**
 * Divergent, merged, squashed and disconnected history for comparing the model with git.
 * Blob ids are aliases; unless `blobs` supplies exact bytes, their content is the alias plus a newline.
 */
export const conformanceGraph: Graph = {
  commits: {
    m1: { parents: [], files: { 'src/a.ts': 'a0' } },
    f1: { parents: ['m1'], files: { 'src/a.ts': 'a1' } },
    f2: { parents: ['f1'], files: { 'src/a.ts': 'a2' } },
    o1: { parents: ['m1'], files: { 'src/a.ts': 'a0', 'src/b.ts': 'b1' } },
    s1: { parents: ['m1'], files: { 'src/a.ts': 'a1' } },
    g1: { parents: ['m1', 'f1'], files: { 'src/a.ts': 'a1' } },
    m2: { parents: ['m1'], files: { 'src/a.ts': 'a0', 'src/m.ts': 'm2' } },
    island: { parents: [], files: {} },
    cfg: { parents: ['m2'], files: { 'src/a.ts': 'a0', 'src/m.ts': 'm2', '.claude/working-agreement.json': 'config', '.gitignore': 'ignores' } },
  },
  refs: { main: 'm2', 'origin/main': 'm2', 'origin/HEAD': 'm2', feat: 'f2', other: 'o1', config: 'cfg' },
  blobs: { config: '{"always":[["./check"]]}', ignores: 'cache/\n' },
  upstreams: { main: 'origin/main', feat: 'origin/main' },
  created: { other: 'main' },
  trees: { 'config-tree': { 'src/a.ts': 'a0', 'src/m.ts': 'm2', '.claude/working-agreement.json': 'config', '.gitignore': 'ignores' } },
}

/** Real linked and detached worktrees built by the Bats harness. */
export const conformanceCheckout: Checkout = {
  branch: 'main', graph: conformanceGraph,
  worktrees: { '/repo': { branch: 'main' }, '/config': { branch: 'config' }, '/detached': { branch: 'HEAD', head: 'o1' }, '/linked': { branch: 'feat' } },
}

/** The git commands the mod runs, with git's answers in `conformanceGraph`'s repository. */
export const gitChecks: GitCheck[] = [
  { command: 'merge-base m1 island', exitCode: 1, stdout: '' },
  { command: 'merge-base m1 missing', exitCode: 128, stdout: '' },
  { command: 'merge-base origin/main refs/heads/feat', exitCode: 0, stdout: 'm1' },
  { command: 'merge-base g1 f2', exitCode: 0, stdout: 'f1' },
  { command: 'merge-base --is-ancestor m1 f2', exitCode: 0, stdout: '' },
  { command: 'merge-base --is-ancestor f1 o1', exitCode: 1, stdout: '' },
  { command: 'rev-parse --verify --quiet refs/heads/feat', exitCode: 0, stdout: 'f2' },
  { command: 'rev-parse --verify --quiet missing', exitCode: 1, stdout: '' },
  { command: 'merge-base --is-ancestor missing f2', exitCode: 128, stdout: '' },
  { command: 'rev-parse HEAD', exitCode: 0, stdout: 'm2' },
  { command: 'worktree list --porcelain', exitCode: 0, stdout: 'worktree /repo\nHEAD m2\nbranch refs/heads/main\n\n'
    + 'worktree /config\nHEAD cfg\nbranch refs/heads/config\n\nworktree /detached\nHEAD o1\ndetached\n\n'
    + 'worktree /linked\nHEAD f2\nbranch refs/heads/feat' },
  { command: '-C /repo rev-parse --path-format=absolute --git-path index --show-object-format', exitCode: 0, stdout: '/repo.git/index\nsha1' },
  { command: '-C /repo status --porcelain=v2 -z --untracked-files=all', exitCode: 0, stdout: '' },
  { command: 'rev-list --count m1..f2', exitCode: 0, stdout: '2' },
  { command: 'rev-list --count origin/HEAD..f2', exitCode: 0, stdout: '2' },
  { command: 'rev-list --count m1..o1', exitCode: 0, stdout: '1' },
  { command: 'rev-list --count f1..m2', exitCode: 0, stdout: '1' },
  { command: 'rev-list --count f2..g1', exitCode: 0, stdout: '1' },
  { command: 'symbolic-ref --short -q HEAD', exitCode: 0, stdout: 'main' },
  { command: '-C /detached symbolic-ref --short -q HEAD', exitCode: 1, stdout: '' },
  { command: '-C /linked symbolic-ref -q HEAD', exitCode: 0, stdout: 'refs/heads/feat' },
  { command: '-C /detached symbolic-ref -q HEAD', exitCode: 1, stdout: '' },
  { command: '-C /config check-ignore -- /config/cache/a.ts', exitCode: 0, stdout: '/config/cache/a.ts' },
  { command: '-C /config check-ignore -- /config/src/a.ts', exitCode: 1, stdout: '' },
  { command: 'for-each-ref --format=%(refname) %(objectname)', exitCode: 0,
    stdout: 'refs/heads/config cfg\nrefs/heads/feat f2\nrefs/heads/main m2\nrefs/heads/other o1\nrefs/remotes/origin/HEAD m2\nrefs/remotes/origin/main m2' },
  { command: 'rev-list f2 o1 --not m2', exitCode: 0, stdout: 'o1\nf2\nf1' },
  { command: 'rev-list --min-age=946684801 f2 o1 --not m2', exitCode: 0, stdout: 'f1' },
  { command: 'rev-list --min-age=946684803 f2 o1 --not m2', exitCode: 0, stdout: 'o1\nf2\nf1' },
  { command: 'rev-list --count f2 --not m2 o1', exitCode: 0, stdout: '2' },
  { command: 'rev-list --first-parent --parents f2 --not o1', exitCode: 0, stdout: 'f2 f1\nf1 m1' },
  { command: 'rev-list --first-parent --parents g1 --not o1', exitCode: 0, stdout: 'g1 m1 f1' },
  { command: 'rev-list --first-parent --parents m1 --not f2', exitCode: 0, stdout: '' },
  { command: 'rev-list --first-parent --parents island --not f2', exitCode: 0, stdout: 'island' },
  { command: 'rev-list --first-parent --parents missing --not f2', exitCode: 128, stdout: '' },
  { command: 'rev-parse --verify --quiet refs/remotes/origin/main', exitCode: 0, stdout: 'm2' },
  { command: 'log --walk-reflogs --format=%gs refs/heads/other --', exitCode: 0, stdout: 'branch: Created from main' },
  { command: 'log --walk-reflogs --format=%gs refs/heads/feat --', exitCode: 0, stdout: '' },
  { command: 'log --walk-reflogs --format=%gs refs/heads/missing --', exitCode: 128, stdout: '' },
  { command: 'show-ref --verify --quiet refs/heads/other', exitCode: 0, stdout: '' },
  { command: 'show-ref --verify --quiet refs/heads/origin/main', exitCode: 1, stdout: '' },
  { command: 'show-ref --verify --quiet refs/heads/f1', exitCode: 1, stdout: '' },
  { command: 'rev-parse --abbrev-ref HEAD', exitCode: 0, stdout: 'main' },
  { command: 'remote', exitCode: 0, stdout: 'origin' },
  { command: 'rev-parse --abbrev-ref origin/HEAD', exitCode: 0, stdout: 'origin/main' },
  { command: 'rev-list --count @{u}..HEAD', exitCode: 0, stdout: '0' },
  { command: '-C /linked rev-list --count @{u}..HEAD', exitCode: 0, stdout: '2' },
  { command: '-C /config rev-list --count @{u}..HEAD', exitCode: 128, stdout: '' },
  { command: 'rev-parse --show-toplevel', exitCode: 0, stdout: '/repo' },
  { command: 'branch -d missing', exitCode: 1, stdout: '' },
  { command: '-C /outside rev-parse --show-toplevel', exitCode: 128, stdout: '' },
  { command: '-C /linked rev-parse --path-format=absolute --git-common-dir --show-toplevel', exitCode: 0, stdout: '/repo.git\n/linked' },
  { command: '-C /outside rev-parse --path-format=absolute --git-common-dir --show-toplevel', exitCode: 128, stdout: '' },
  { command: 'rev-parse --path-format=absolute --git-common-dir', exitCode: 0, stdout: '/repo.git' },
  { command: 'hash-object --stdin', stdin: 'hello', exitCode: 0, stdout: 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0' },
  { command: 'hash-object --stdin', stdin: 'é\n', label: 'UTF-8 bytes', exitCode: 0, stdout: 'c6003325155f475bd7c87731607525dce73be9cf' },
  { command: 'cat-file blob cfg:.claude/working-agreement.json', exitCode: 0, stdout: '{"always":[["./check"]]}' },
  { command: 'cat-file blob m1:.claude/working-agreement.json', exitCode: 128, stdout: '' },
  { command: 'rev-parse cfg:.claude/working-agreement.json', exitCode: 0, stdout: 'config' },
  { command: 'rev-parse cfg^{tree}', exitCode: 0, stdout: 'config-tree' },
  { command: 'diff --name-only -z --no-renames --no-ext-diff m1 f2 -- :(top,glob)src/**', exitCode: 0, stdout: 'src/a.ts\0' },
  { command: 'diff --name-only -z --no-renames --no-ext-diff m1 f2 -- :(top,glob)docs/**', exitCode: 0, stdout: '' },
  { command: 'add -A', exitCode: 0, stdout: '' },
  { command: 'log --no-walk --format=%H:%G? f1', exitCode: 0, stdout: 'f1:N' },
  { command: 'log --no-walk --format=%H:%G? missing', exitCode: 128, stdout: '' },
  { command: 'diff-tree -r --no-commit-id -m f1', exitCode: 0, stdout: ':100644 100644 a0 a1 M\tsrc/a.ts' },
  { command: 'diff-tree -r --no-commit-id -m o1', exitCode: 0, stdout: ':000000 100644 0000000000000000000000000000000000000000 b1 A\tsrc/b.ts' },
  { command: 'diff-tree -r --no-commit-id -m g1', label: 'merge', exitCode: 0, stdout: ':100644 100644 a0 a1 M\tsrc/a.ts' },
  { command: 'diff-tree -r --no-commit-id -m m1', label: 'root', exitCode: 0, stdout: '' },
  { command: 'config --get-regexp ^alias\\.', exitCode: 1, stdout: '' },
  { command: '-C /repo ls-files --error-unmatch -- /repo/src/a.ts', exitCode: 0, stdout: 'src/a.ts' },
  { command: '-C /repo ls-files --error-unmatch -- /repo/src/new.ts', dirty: { 'src/new.ts': 'new' }, label: 'untracked', exitCode: 1, stdout: '' },
  { command: '-C /repo ls-files --error-unmatch -- /repo/src/new.ts', staged: { 'src/new.ts': 'new' }, label: 'only staged', exitCode: 0, stdout: 'src/new.ts' },
  { command: '-C /repo ls-files --error-unmatch -- /outside/x.sh', label: 'outside the repository', exitCode: 128, stdout: '' },
  { command: 'log -1 --format=%P g1', exitCode: 0, stdout: 'm1 f1' },
  { command: '-C /repo merge --no-gpg-sign --no-edit --ff-only m1', label: 'already merged', exitCode: 0, stdout: 'Already up to date.' },
  { command: '-C /repo merge --no-gpg-sign --no-edit --no-ff m1', label: 'already merged', exitCode: 0, stdout: 'Already up to date.' },
  { command: '-C /repo merge --no-gpg-sign --no-edit --ff-only feat', label: 'diverged', exitCode: 128, stdout: '' },
  { command: '-C /repo merge --abort', label: 'no merge in progress', exitCode: 128, stdout: '' },
  { command: 'merge-tree --write-tree --name-only --no-messages f1 s1', label: 'same change on both sides', exitCode: 0, stdout: 'tree:src/a.ts=a1' },
  { command: 'merge-tree --write-tree --name-only --no-messages f2 s1', label: 'conflict', exitCode: 1, stdout: '' },
  { command: 'commit --no-gpg-sign -F -', stdin: 'change', label: 'nothing staged', exitCode: 1, stdout: '' },
  { command: 'write-tree', exitCode: 0, stdout: 'tree:src/a.ts=a0,src/m.ts=m2' },
  { command: '-C /config write-tree', exitCode: 0, stdout: 'config-tree' },
  { command: '-C /linked rev-parse --path-format=absolute --git-path index --show-object-format', exitCode: 0, stdout: '/repo.git/worktrees/linked/index\nsha1' },
  { command: '-C /repo status --porcelain=v2 -z --untracked-files=all', dirty: { 'src/a.ts': 'a1' }, label: 'tracked edit', exitCode: 0,
    stdout: '1 .M N... 100644 100644 100644 a0 a0 src/a.ts\0' },
  { command: '-C /repo status --porcelain=v2 -z --untracked-files=all', dirty: { 'src/a.ts': '', 'src/new.ts': 'new' },
    label: 'delete and untracked', exitCode: 0,
    stdout: '1 .D N... 100644 100644 000000 a0 a0 src/a.ts\0? src/new.ts\0' },
  { command: '-C /repo status --porcelain=v2 -z --untracked-files=all', staged: { 'src/a.ts': 'staged' },
    dirty: { 'src/a.ts': 'a0' }, label: 'index changed and working tree restored', exitCode: 0,
    stdout: '1 MM N... 100644 100644 100644 a0 staged src/a.ts\0' },
  { command: '-C /repo diff --cached --binary HEAD', exitCode: 0, stdout: '' },
  { command: 'branch -D missing', exitCode: 1, stdout: '' },
  { command: 'worktree remove --force /missing', exitCode: 128, stdout: '' },
  { command: 'update-ref refs/heads/feat m1 ', label: 'existing branch', exitCode: 128, stdout: '' },
  // Last: the created branch outlives the row in the real repository.
  { command: 'update-ref refs/heads/spawned m1 ', exitCode: 0, stdout: '' },
  { command: 'update-ref refs/retired/1/20000101T000000Z m1 ', exitCode: 0, stdout: '' },

]

/** Pairs of commits and whether git gives them the same tree, as `<commit>^{tree}` reads it. */
export const treeChecks: TreeCheck[] = [
  { commits: ['WORKTREE', 'm2'], isSame: true },
  { commits: ['WORKTREE', 'm2'], isSame: false, dirty: { 'src/a.ts': 'a1', 'src/new.ts': 'new' } },
  { commits: ['WORKTREE', 'f1'], isSame: true, dirty: { 'src/a.ts': 'a1', 'src/m.ts': '' } },
  { commits: ['f1', 's1'], isSame: true },
  { commits: ['f1', 'g1'], isSame: true },
  { commits: ['m1', 'f1'], isSame: false },
  { commits: ['f2', 'g1'], isSame: false },
]

/**
 * Keeps the ref format, whose argument contains a space, intact for both runners.
 * @param command - A fixture command after git.
 * @returns The arguments without shell parsing.
 */
export function gitCheckArgs(command: string): string[] {
  return command.startsWith('for-each-ref ') ? ['for-each-ref', command.slice(13)] : command.split(' ')
}
