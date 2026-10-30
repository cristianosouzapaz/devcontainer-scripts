import type { RunRecord, Unit, VerifyRecord } from '../../types'
import { createEmptySession } from '../../hooks/domain/records'
import type { Session } from '../../hooks/domain/records'
import { githubSamples } from './github-samples'
import { configBlob, root } from './world'
import type { Checkout, Graph, Options } from './world'

/** A Write call's input. */
interface WriteCall { tool: 'Write'; file_path: string; content: string }

/** The session record of a session with no flow declared. */
export const noFlow = { flow: null, issues: [], info: {} }

/** Every tool the mod registers, in registration order. */
export const modToolNames = ['run', 'verify', 'declare_flow', 'suggest_coordinate', 'suggest_delegate', 'merge_child', 'commit', 'merge_parent', 'issue_create', 'issue_edit', 'issue_close', 'issue_comment', 'spawn', 'plan', 'unit_prompt', 'unit_read', 'retire_unit'] as const

/** A coordinator session with no flow. */
export const coordinator = { ...noFlow, role: 'coordinator' }

/** A Close out on #1 and #2, so a PR body must carry both Closes lines. */
export const twoIssueCloseOut: Options = {
  session: { flow: 'close-out', issues: [1, 2], info: { 1: { title: 'a', labels: [] }, 2: { title: 'b', labels: [] } } },
}

/** A repository verify file naming `./test/run.sh`. */
export const verifyFile = JSON.stringify({ always: [['./test/run.sh']] })

/** A Close out with committed work and Verify skipped, awaiting only its PR. */
export const pushedCloseOut: Options = {
  ...twoIssueCloseOut,
  unit: { skips: [{ step: 'verify', reason: 'covered separately' }] },
  prs: [buildPullRequest()],
}
/** A completed red/green pair, before the diagnosis comment. */
export const diagnoseRuns: RunRecord[] = [
  { argv: ['./check'], tree: 'red', outcome: { kind: 'fail', code: 1, signal: null }, runId: 'red', at: 1 },
  { argv: ['./check'], tree: 'green', outcome: { kind: 'pass' }, runId: 'green', at: 2 },
]
/** A diagnosis comment created after the fixture's green. */
export const diagnosisComment = { url: 'https://github.com/o/r/issues/1#issuecomment-1', createdAt: new Date(3).toISOString() }
/** A unit whose red run and diagnosis comment have the user's approval. */
export const diagnosed: Pick<Unit, 'runs' | 'approval'> = { runs: diagnoseRuns, approval: diagnosisComment.url }
/** The fix green: the red command passing on another tree after the approved comment. */
const fixGreen: RunRecord = { argv: ['./check'], tree: 'fixed', outcome: { kind: 'pass' }, runId: 'fixed', at: 4 }
/** A diagnosed unit whose approved fix passes the red command. */
export const fixed: Pick<Unit, 'runs' | 'approval'> = { runs: [fixGreen, ...diagnoseRuns], approval: diagnosisComment.url }

/**
 * Builds a Write call that writes an empty file.
 *
 * @param path - An absolute path, or one relative to the repository root.
 * @returns The call.
 */
export const buildWriteCall = (path: string): WriteCall =>
  ({ tool: 'Write', file_path: path.startsWith('/') ? path : `${root}/${path}`, content: '' })

/**
 * Builds the fields returned by the candidate-list command with realistic GitHub shapes.
 * @param changes - Fields that replace the open, pushed PR closing both declared issues.
 * @returns A candidate response sample.
 */
export function buildPullRequest(changes: Record<string, unknown> = {}): Record<string, unknown> {
  const sample = githubSamples['pull-requests'][0].body.data.repository.pullRequests.nodes[0]!
  const { closingIssuesReferences, ...pullRequest } = sample
  return { ...pullRequest, closingIssuesReferences: closingIssuesReferences.nodes, ...changes }
}

/**
 * Builds a PR of parent branch `par` into the default branch, as the candidate-list command returns it.
 * @param changes - Fields that replace the merged PR from `par` into `main`.
 * @returns A candidate response sample.
 */
export const buildParentPullRequest = (changes: Record<string, unknown> = {}): Record<string, unknown> =>
  buildPullRequest({ state: 'MERGED', headRefName: 'par', baseRefName: 'main', ...changes })

/**
 * Builds the reference workflow's history: `par` cut from the default branch, children `a` and `b` cut from `par` with
 * `git switch -c <child> par`, then, as commits for a test to move refs onto, `a` merged into `par` with `--no-ff` (`ma`),
 * `par` advanced (`p2`), `par` merged into `b` (`mb`) and committed on (`b2`), and `b` merged into `par` with `--no-ff` (`mpar`).
 * @returns A fresh graph with every ref at the cut: `par` at `p1`, `a` at `a2`, `b` at `b1`.
 */
export function buildParentGraph(): Graph {
  const par = { 'src/par.ts': 'p1' }
  const advanced = { 'src/par.ts': 'p2', 'src/a.ts': 'a2' }
  return {
    commits: {
      c0: { parents: [], files: {} },
      p1: { parents: ['c0'], files: par },
      a1: { parents: ['p1'], files: { ...par, 'src/a.ts': 'a1' } },
      a2: { parents: ['a1'], files: { ...par, 'src/a.ts': 'a2' } },
      b1: { parents: ['p1'], files: { ...par, 'src/b.ts': 'b1' } },
      ma: { parents: ['p1', 'a2'], files: { ...par, 'src/a.ts': 'a2' } },
      p2: { parents: ['ma'], files: advanced },
      mb: { parents: ['b1', 'p2'], files: { ...advanced, 'src/b.ts': 'b1' } },
      b2: { parents: ['mb'], files: { ...advanced, 'src/b.ts': 'b2' } },
      mpar: { parents: ['p2', 'b2'], files: { ...advanced, 'src/b.ts': 'b2' } },
    },
    refs: { main: 'c0', 'origin/main': 'c0', par: 'p1', a: 'a2', b: 'b1' },
    created: { a: 'par', b: 'par' },
  }
}

/**
 * Builds a passing Verify run of the shipped config on tree `one` over base `c0`.
 * @param changes - Fields that replace the run's.
 * @returns The run record.
 */
export const buildVerifyRun = (changes: Partial<VerifyRecord> = {}): VerifyRecord => ({
  tree: 'one', base: 'c0', configBlob: configBlob(verifyFile), commands: [['./test/run.sh']], outcome: { kind: 'pass' }, runId: 'r', at: 1, ...changes,
})

/**
 * Builds a dirty checkout of `feat` eight commits ahead on tree `one`, the change a Verify run is judged on; a fresh copy, since tests move it.
 * @returns The checkout.
 */
export const buildChangedCheckout = (): Checkout => ({ branch: 'feat', ahead: 8, isDirty: true, tree: 'one' })

/**
 * Names a Verify config by the id `/flow approve verify` previews and takes.
 * @param file - The config's text.
 * @returns The first twelve characters of its blob id.
 */
export const verifyId = (file = verifyFile): string => configBlob(file).slice(0, 12)

/**
 * Builds a fresh session as its mirror file saves it, without the flow and issues the engine's session state holds.
 * @param sessionId - The session's id.
 * @returns The saved session.
 */
export function buildSavedSession(sessionId = 'sid'): Omit<Session, 'flow' | 'issues'> {
  const { flow: _flow, issues: _issues, ...saved } = createEmptySession(sessionId)
  return saved
}

/**
 * Builds the options of a repository with a ruleset requiring signed commits, which keeps `no signed-commit ruleset` out of a delegation scope.
 * @returns The world options, fresh for each test.
 */
export function guarded(): Options {
  return { rules: [{ ruleset_id: 7, type: 'required_signatures' }], rulesets: [{ id: 7, current_user_can_bypass: 'never' }] }
}

/**
 * Builds the session record of a session in the Trivial change flow, which declares no issue.
 * @returns The session record, fresh for each test.
 */
export function trivialFlow(): Options['session'] {
  return { flow: 'trivial', issues: [], info: {} }
}
