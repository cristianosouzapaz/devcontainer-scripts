import { asRecords, asString, parseJson } from './json'

/** Where a PR's CI stands: every check passed, one failed, some still run, none reported yet, or the repository has no CI to wait for. */
export type Checks = 'passing' | 'failing' | 'pending' | 'none' | 'off'

/** Why a PR's CI holds the unit back, and what the agent does about it. */
export interface ChecksTodo { reason: string; todo: string }

/**
 * Reads what `gh pr checks --json bucket` printed; output that is not a list of checks reads as none, so the gate fails closed.
 *
 * @param stdout - The command's output.
 * @returns Failing when any check failed or was cancelled, else pending when any still runs, else passing; none when no check is listed.
 */
export function readChecks(stdout: string): Checks {
  const buckets = asRecords(parseJson(stdout)).map(c => asString(c.bucket))
  if (!buckets.length) return 'none'
  if (buckets.some(b => b === 'fail' || b === 'cancel')) return 'failing'
  return buckets.some(b => b === 'pending') ? 'pending' : 'passing'
}

/**
 * Says why a PR's CI holds the unit back and what the agent does about it.
 *
 * @param checks - The CI state, which is not passing.
 * @param pr - The PR as gh names it (`#5`, a URL or a branch), or empty for the current branch's.
 * @returns The reason and the action, for a deny or an instruction.
 */
export function checksTodo(checks: Checks, pr: string): ChecksTodo {
  const which = pr ? `PR ${pr}` : "this branch's PR"
  const cmd = pr ? `gh pr checks ${pr}` : 'gh pr checks'
  if (checks === 'failing') {
    return { reason: `CI is failing on ${which}`, todo: `run ${cmd} to see which check failed, tell the user, then fix it on the branch and push` }
  }
  return {
    reason: checks === 'pending' ? `CI is still running on ${which}` : `CI has reported no checks on ${which} yet`,
    todo: `wait with ${cmd} --watch, then retry`,
  }
}
