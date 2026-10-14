import type { Session } from './records'
import { isOnBase } from './step-states'
import type { Position, RunInFlight, StepState } from './step-states'

/** Holds the instruction that sends the agent to a branch before its first write on the default branch. */
export const branchFirstInstruction = 'create a branch for the issue (git switch -c <name>)'

/**
 * Says what the agent must do to complete a step.
 *
 * @param state - The step and whether its stored evidence lapsed, so a PR needs updating again.
 * @param session - The session, which holds the declared issues and the followed-up issue.
 * @param position - Where the unit stands: its record, the checkout, the verify state, the red and the runs in flight.
 * @returns The step's next action, as an imperative phrase.
 */
export function describeRequirement(state: StepState, session: Session, position: Position): string {
  const { step, isStale } = state
  const { unit: { skills, testFiles = [], pr: pullRequest }, verify: { command: verifyCommand, running }, red, testRun, git } = position
  const isPushed = !!git?.isUpToDate
  if (step.isHuman && step.skill) return `the user's step: stop and ask them to run /${step.skill}`
  if (step.isTestExempt) {
    const first = step.skill && !skills.includes(step.skill) ? `run the ${step.skill} skill, then ` : ''
    if (!testFiles.length) return `${first}write the failing test that reproduces the bug before editing non-test files`
    if (testRun) return describeWait('reproduction test', testRun)
    if (red === 'stale') {
      return `${first}the reproduction test changed since it failed: re-run it on unfixed code and see it fail (if non-test changes are already in the tree, set them aside with git stash push -- <non-test paths>, re-run the test, then restore them with git stash pop); if the bug is in the test files themselves, so fixing it changes the reproduction, stop and ask the user to run /flow override diagnose <reason>`
    }
    const alternative = verifyCommand ? `, or run ${verifyCommand}` : ''
    return `${first}run the reproduction test directly by its path (the test file or its directory${alternative}) and see it fail on unfixed code, before changing any non-test file`
  }
  if (step.skill && !step.observe) return `run the ${step.skill} skill`
  if (step.isUnlocking) {
    const change = verifyCommand ? `make the change, then run ${verifyCommand} to pass Verify` : 'make the change'
    return isOnBase(git) ? `${branchFirstInstruction} first, then ${change}` : change
  }
  if (step.observe === 'verify.passed' && running) {
    return describeWait(verifyCommand ?? 'verify command', running)
  }
  if (step.observe === 'verify.passed') return `run ${verifyCommand} exactly (no pipe)`
  // The agent never commits or pushes: it hands the user the commands, and the step follows what git then reports.
  if (step.observe === 'commit') {
    if (!step.skill) return 'stop and give the user the git add, git commit and git push commands to run (never commit or push yourself)'
    return skills.includes(step.skill)
      ? `stop and ask the user to run the commit commands ${step.skill} produced, then push the branch (never commit or push yourself; no need to run it again)`
      : `run the ${step.skill} skill, then stop and ask the user to run the commands it produced and push the branch (never commit or push yourself)`
  }
  if (step.observe === 'pr.created') {
    const isOpen = pullRequest?.state === 'OPEN'
    // A PR shows only what is pushed, and the push is the user's: an unpushed branch waits for it first.
    const pushFirst = isPushed ? '' : 'stop and ask the user to push the branch, then '
    if (!step.skill) return isOpen ? `stop and ask the user to push the branch to PR #${pullRequest.number}` : `${pushFirst}open the PR with gh pr create`
    const lines = step.requires === 'refs' ? [`Refs #${session.followUp}`] : step.requires === 'closes' ? session.issues.map(number => `Closes #${number}`) : []
    const body = step.requires === 'linked' ? ` (body must keep a line linking #${session.followUp}: Closes, Refs, Fixes or Resolves)`
      : lines.length ? ` (body must carry ${lines.join(', ')})` : ''
    return `${pushFirst}run the ${step.skill} skill ${isStale ? 'again ' : ''}to ${isOpen ? `update PR #${pullRequest.number}` : 'open the PR'}${body}`
  }
  return step.label
}

// Tells the agent to wait for a run in flight, naming what reports its end: a herdr pane, or the task notification.
function describeWait(subject: string, run: RunInFlight): string {
  if (run.kind === 'herdr') return `wait for the running ${subject}: herdr pane wait-output ${run.pane} for its exit marker`
  if (run.kind === 'background') return `wait for the running ${subject} to finish: its task notification reports the outcome (do not run it again)`
  return `wait for the running ${subject} to finish`
}
