import type { RunRecord, Unit } from '../../types'
import { githubSamples } from './github-samples'
import { root } from './world'
import type { Options } from './world'

/** A Write call's input. */
interface WriteCall { tool: 'Write'; file_path: string; content: string }

/** The session record of a session with no flow declared. */
export const noFlow = { flow: null, issues: [], info: {} }

/** A Close out on #1 and #2, so a PR body must carry both Closes lines. */
export const twoIssueCloseOut: Options = {
  session: { flow: 'close-out', issues: [1, 2], info: { 1: { title: 'a', labels: [] }, 2: { title: 'b', labels: [] } } },
}

/** A repository verify file naming `./test/run.sh`. */
export const verifyFile = JSON.stringify({ verify: ['./test/run.sh'] })

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
