import { asString, isRecord } from './json'

/** What a tool call returns: its result, flagged when the call failed. */
export interface ToolRun { isError?: true; result?: unknown }

/** A pull request event a Bash call reports: the PR's number and what happened to it. */
export interface PrEvent { number: number; action: string }

/** What a Bash call did, as its result reports it. */
export interface BashOutcome { isOk: boolean; isFailed: boolean; stdout: string; commit: boolean; push: boolean; pr: PrEvent | null }

/**
 * Reads what a Bash call did from its tool result.
 *
 * @param ran - The tool result.
 * @returns Whether it ran to completion in the foreground, whether it exited non-zero in the foreground, its output, and the git and PR operations it reports.
 */
export function bashOutcome(ran: ToolRun): BashOutcome {
  const out = isRecord(ran.result) ? ran.result : {}
  const op = isRecord(out.gitOperation) ? out.gitOperation : {}
  const pr = isRecord(op.pr) && typeof op.pr.number === 'number' ? { number: op.pr.number, action: asString(op.pr.action) } : null
  return {
    isOk: ran.isError !== true && !out.backgroundTaskId,
    // The result carries no exit code: a non-zero exit comes back as an error.
    isFailed: ran.isError === true && !out.backgroundTaskId && !out.interrupted,
    stdout: asString(out.stdout), commit: !!op.commit, push: !!op.push, pr,
  }
}
