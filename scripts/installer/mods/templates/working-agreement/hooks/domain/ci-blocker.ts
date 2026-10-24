/** Names where a unit's CI stands: what the PR's checks report, off when the repository has no CI to wait for, or unknown when that could not be read. */
export type CiState = 'passing' | 'failing' | 'pending' | 'off' | 'unknown'

/** Holds why a PR's CI holds the unit back, and what the agent does about it. */
interface CiBlocker {
  reason: string
  action: string
}

/**
 * Says why a PR's CI holds the unit back and what the agent does about it.
 *
 * @param checks - The CI state, which is not passing.
 * @param pullRequest - The PR as gh names it (`#5`, a URL or a branch), or empty for the current branch's.
 * @returns The reason and the action, for a deny or an instruction.
 */
export function describeCiBlocker(checks: CiState, pullRequest: string): CiBlocker {
  const subject = pullRequest ? `PR ${pullRequest}` : "this branch's PR"
  const command = pullRequest ? `gh pr checks ${pullRequest}` : 'gh pr checks'
  if (checks === 'failing') {
    return { reason: `CI is failing on ${subject}`, action: `run ${command} to see which check failed, tell the user, then fix it on the branch and ask the user to commit and push` }
  }
  if (checks === 'unknown') return { reason: `CI could not be read for ${subject}`, action: 'retry; if it keeps failing, stop and tell the user' }
  return {
    reason: checks === 'pending' ? `CI is still running on ${subject}` : `CI has reported no checks on ${subject} yet`,
    action: `wait with ${command} --watch, then retry`,
  }
}
