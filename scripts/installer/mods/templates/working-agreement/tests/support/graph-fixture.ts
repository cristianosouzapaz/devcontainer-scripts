import type { Graph } from './world'

/**
 * A git command the mod runs (after `git`), with what git answers in the fixture's repository; commit ids and file contents
 * are the fixture's names, which a real repository maps to its own ids. A non-zero exit is compared on its code alone.
 */
interface GitCheck { command: string; exitCode: number; stdout: string }

/** Two commits, and whether git gives them the same tree. */
interface TreeCheck { commits: [string, string]; isSame: boolean }

/**
 * The commit graph the test world's model is checked against real git with: main moved on after `feat` left it, `feat` has
 * two commits, `other` diverged with its own, `s1` squashes `f1` onto main and `g1` merges it. Each file's content hash is
 * the content itself; a real repository stores it as that text and a newline.
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
  },
  refs: { main: 'm2', 'origin/main': 'm2', feat: 'f2', other: 'o1' },
}

/** The git commands the mod runs, with git's answers in `conformanceGraph`'s repository. */
export const gitChecks: GitCheck[] = [
  { command: 'rev-list --count m1..f2', exitCode: 0, stdout: '2' },
  { command: 'rev-list --count origin/HEAD..f2', exitCode: 0, stdout: '2' },
  { command: 'rev-list --count m1..o1', exitCode: 0, stdout: '1' },
  { command: 'rev-list --count f1..m2', exitCode: 0, stdout: '1' },
  { command: 'rev-list --count f2..g1', exitCode: 0, stdout: '1' },
  { command: 'merge-base --is-ancestor f1 g1', exitCode: 0, stdout: '' },
  { command: 'merge-base --is-ancestor f1 s1', exitCode: 1, stdout: '' },
  { command: 'merge-base --is-ancestor o1 f2', exitCode: 1, stdout: '' },
  { command: 'merge-base m2 f2', exitCode: 0, stdout: 'm1' },
  { command: 'merge-base g1 f2', exitCode: 0, stdout: 'f1' },
  { command: 'rev-parse --verify --quiet refs/heads/feat^{commit}', exitCode: 0, stdout: 'f2' },
  { command: 'rev-parse --verify --quiet refs/heads/gone^{commit}', exitCode: 1, stdout: '' },
  { command: 'rev-parse --verify --quiet f1^{commit}', exitCode: 0, stdout: 'f1' },
  { command: 'rev-parse f2:src/a.ts', exitCode: 0, stdout: 'a2' },
  { command: 'rev-parse m1:src/b.ts', exitCode: 128, stdout: '' },
  { command: 'diff --name-only --no-renames m1 o1', exitCode: 0, stdout: 'src/b.ts' },
  { command: 'diff --name-only --no-renames m1 f2', exitCode: 0, stdout: 'src/a.ts' },
  { command: 'diff --name-only --no-renames f1 s1', exitCode: 0, stdout: '' },
  { command: 'diff --name-only --no-renames o1 m2', exitCode: 0, stdout: 'src/b.ts\nsrc/m.ts' },
]

/** Pairs of commits and whether git gives them the same tree, as `<commit>^{tree}` reads it. */
export const treeChecks: TreeCheck[] = [
  { commits: ['f1', 's1'], isSame: true },
  { commits: ['f1', 'g1'], isSame: true },
  { commits: ['m1', 'f1'], isSame: false },
  { commits: ['f2', 'g1'], isSame: false },
]
