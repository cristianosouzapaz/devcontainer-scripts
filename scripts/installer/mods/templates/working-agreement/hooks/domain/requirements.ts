import { diagnosisHeadings } from './diagnosis-comment'
import { flowDefinitions } from './flow-definitions'
import type { Step } from './flow-definitions'
import type { Session, Unit } from './records'
import { findDiagnoseStep, isApproved, isOnBase, isRedGreenSettled } from './step-states'
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
  const { unit: { skills, pr: pullRequest }, verify: { command: verifyCommand, running }, git } = position
  const isPushed = !!git?.isUpToDate
  if (step.isHuman && step.skill) return `the user's step: stop and ask them to run /${step.skill}`
  if (step.isInWorktree) return describeDiagnose(step.skill && !skills.includes(step.skill) ? `run the ${step.skill} skill, then ` : '', step, session, position)
  if (step.skill && !step.observe) return `run the ${step.skill} skill`
  if (step.isUnlocking) return describeCode(position)
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
    if (pullRequest?.state === 'CLOSED') return `PR #${pullRequest.number} is closed without merge: reopen it with gh pr reopen ${pullRequest.number}, or open a new one`
    const isOpen = pullRequest?.state === 'OPEN'
    // A PR shows only what is pushed, and the push is the user's: an unpushed branch waits for it first.
    const pushFirst = isPushed ? '' : 'stop and ask the user to push the branch, then '
    if (!step.skill) return isOpen ? `stop and ask the user to push the branch to PR #${pullRequest.number}` : `${pushFirst}open the PR with gh pr create`
    const lines = step.requires === 'refs' ? [`Refs #${session.followUp}`] : step.requires === 'closes' ? session.issues.map(number => `Closes #${number}`) : []
    const flow = session.flow ? flowDefinitions.flows[session.flow] : undefined
    const link = flow && findDiagnoseStep(flow) && isApproved(position.unit) ? [`the approved diagnosis comment link ${position.unit.approval}`] : []
    const body = step.requires === 'linked' ? ` (body must keep a line linking #${session.followUp}: Closes, Refs, Fixes or Resolves${link.map(text => `, and carry ${text}`).join('')})`
      : lines.length + link.length ? ` (body must carry ${[...lines, ...link].join(', ')})` : ''
    return `${pushFirst}run the ${step.skill} skill ${isStale ? 'again ' : ''}to ${isOpen ? `update PR #${pullRequest.number}` : 'open the PR'}${body}`
  }
  return step.label
}

// Says what Code needs: in a flow with Diagnose, the steps still open to bring the diagnosis into the main checkout and remove
// the worktree, in order, then the change itself. A verify run in the worktree tests the worktree, so Verify is judged only
// once the session is back in the main checkout.
function describeCode(position: Position): string {
  const { git, unit, worktree, redFiles, isCodeChanged, verify: { command: verifyCommand } } = position
  const pending = Object.keys(redFiles).filter(file => redFiles[file] === 'pending')
  const path = unit.worktree?.path
  const isTransferring = !!worktree?.isPresent && !!path && (pending.length > 0 || !isCodeChanged)
  const removals = worktree?.isPresent && path ? [`git worktree remove --force ${path}`, `git branch -D worktree-${worktree.name}`] : []
  const steps = [
    ...(isOnBase(git) && !position.judgedOn ? [`${branchFirstInstruction} first`] : []),
    ...(worktree?.isEntered ? ['call ExitWorktree with action keep'] : []),
    ...(isTransferring ? ['remove the [DEBUG-…] instrumentation in the worktree', `transfer everything at once with git -C ${path} add -N . && git -C ${path} diff --binary ${unit.start ?? 'HEAD'} | git apply`] : []),
    ...removals,
    ...(!worktree?.isPresent && pending.length ? [`add the red files not yet in the main checkout (${pending.join(', ')})`] : []),
  ]
  const make = isTransferring ? 'make the change (the fix may be refined after the transfer)' : 'make the change'
  return [...steps, verifyCommand ? `${make}, then run ${verifyCommand} to pass Verify` : make].join(', then ')
}

// Says what Diagnose needs next: the worktree, a start at the unit's start commit, the red, then the green, then the diagnosis
// comment and the user's approval of it. An override skips the red and the green alone. A red file changed in the main
// checkout comes first: its red and green are proved again.
function describeDiagnose(first: string, step: Step, session: Session, position: Position): string {
  const { unit, worktree, worktreeRun, redFiles } = position
  const { start, red } = unit
  const isOverridden = unit.overrides.some(override => override.step === step.id)
  const stale = Object.keys(redFiles).filter(file => redFiles[file] === 'stale')
  if (red && stale.length && !isOverridden) return `${first}${worktreeRun ? describeWait('re-proof', worktreeRun) : describeReproof(position, red.command, stale)}`
  // The worktree stays mandatory under an override: the diagnosis starts from one the session entered.
  if (isRedGreenSettled(step, unit) && (!isOverridden || unit.worktree)) return `${first}${describeDiagnosis(session, unit)}`
  if (!worktree?.isEntered) {
    return `${first}call EnterWorktree and diagnose there (the main checkout is read-only until the approval; a new worktree is brought to the unit's start commit), set the project up in it per its docs, ${isOverridden ? 'then post the diagnosis comment' : 'then run the command that reproduces the bug there and see it fail (red)'}`
  }
  if (start && worktree.head && worktree.head !== start) {
    return `${first}the worktree is at ${worktree.head}, not the unit's start ${start}, so a red there does not count: set its changes aside, run git reset --hard ${start} in it, then run the reproduction again`
  }
  if (worktreeRun) return describeWait(red ? 'green candidate' : 'reproduction command', worktreeRun)
  if (!red) {
    return `${first}run the command that reproduces the bug in the worktree and see it fail (red): a test runner, a curl call or a scratchpad script; the files changed in the worktree by then become the red files, and until the green a failing run of another command replaces the red, so end an exploratory command that may fail with || true`
  }
  return `${first}apply the candidate fix in the worktree and re-run exactly: ${red.command} — it must pass (green)`
}

// Says how to prove again a red that changed in the main checkout: the changed files go into the worktree, the fix's paths are
// stashed so the red fails, then restored so the green passes; a red file that also holds the fix has only the fix's hunks
// undone. A removed worktree is created anew, and Code needs it removed again.
function describeReproof(position: Position, command: string, stale: string[]): string {
  const { git, unit, worktree } = position
  const prove = `git stash push -- <files holding only the fix>, and in a red file that also holds the fix undo only the fix's hunks (a non-interactive reverse patch: git apply -R of a patch holding just those hunks, or by hand with Edit), run exactly ${command} and see it fail (red), restore the fix (git stash pop, or re-apply the patch), then run it again and see it pass (green)`
  const files = `${stale.join(', ')} changed in the main checkout, so Red and Green are stale`
  if (!worktree?.isPresent) {
    const bring = `git -C ${git?.root} add -N . && git -C ${git?.root} diff --binary ${unit.start ?? 'HEAD'} | git apply`
    return `${files} and the worktree is gone: call EnterWorktree to create a new one (it is brought to the unit's start commit), bring the main checkout's changes into it with ${bring}, ${prove}`
  }
  const enter = worktree.isEntered ? '' : `call EnterWorktree with path ${unit.worktree?.path}, `
  return `${files}: ${enter}copy each changed file from the main checkout into the worktree, ${prove}`
}

// Says what the diagnosis needs once the red and the green are settled: the comment on the issue, then the user's approval of it.
function describeDiagnosis(session: Session, unit: Unit): string {
  if (unit.diagnosis) {
    return `the diagnosis comment is posted: stop and ask the user to run /flow approve diagnose (the approval is theirs alone); if they reject it in chat, post a new diagnosis comment, since a newer comment voids any approval`
  }
  const files = Object.keys(unit.red?.fingerprints ?? {})
  const red = unit.red ? `quote the red command (${unit.red.command}) and name ${files.length ? `every red file (${files.join(', ')})` : 'no red file: the Regression test section explains why there is no test'}` : 'the Regression test section explains why there is no test'
  return `post the diagnosis as a comment on ${session.issues.map(number => `#${number}`).join(' ')} with gh issue comment, under the headings ${diagnosisHeadings.join(', ')}; ${red}`
}

// Tells the agent to wait for a run in flight, naming what reports its end: a herdr pane, or the task notification.
function describeWait(subject: string, run: RunInFlight): string {
  if (run.kind === 'herdr') return `wait for the running ${subject}: herdr pane wait-output ${run.pane} for its exit marker`
  if (run.kind === 'background') return `wait for the running ${subject} to finish: its task notification reports the outcome (do not run it again)`
  return `wait for the running ${subject} to finish`
}
