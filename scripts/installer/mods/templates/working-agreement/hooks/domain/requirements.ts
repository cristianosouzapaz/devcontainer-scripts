import type { Session } from './records'
import { isCodeJudgedByFix, isOnBase, isUnitOnBase } from './step-states'
import type { Position, StepState } from './step-states'

/** Holds the instruction that sends the agent to a branch before its first write on the default branch. */
export const branchFirstInstruction = 'create a branch for the issue (git switch -c <name>)'

/**
 * Says what the agent must do to complete a step.
 *
 * @param state - The step and its first failing fact.
 * @param session - The session, which holds the declared issues.
 * @param position - Where the unit stands: its record, the checkout, the verify state.
 * @returns The step's next action, as an imperative phrase.
 */
export function describeRequirement(state: StepState, session: Session, position: Position): string {
  const { step } = state
  const { unit: { skills }, pullRequest, git } = position
  const isPushed = !!git?.isUpToDate
  if ((step.isUnlocking || step.observe === 'commit') && isUnitOnBase(session.unit, git)) return "check out the unit's branch and re-declare"
  if (step.isHuman && step.skill) return `the user's step: stop and ask them to run /${step.skill}`
  if (step.isInWorktree) return `run the ${step.skill} skill through its Phases 1–4; reproduce the bug with a failing red command through the run tool (Bash runs never count), preferably a failing test or a small harness; do not apply the fix in Diagnose; post a diagnosis comment on the issue stating the cause, the red command, and the regression test (or why there is no correct seam), with no required headings; then stop and ask the user to run /flow approve <comment URL>; if no command reproduces the bug, stop and tell the user they may run /flow skip diagnose <reason>`
  if (step.skill && !step.observe) return `run the ${step.skill} skill`
  if (step.isUnlocking) return describeCode(position)
  if (step.observe === 'verify.passed') return position.verify.factCode === 'verify-config-missing'
    ? "propose the minimum .claude/working-agreement.json: verify alone, as an argv taken from the project's docs, scripts or CI; rules only when the full command is slow and the repository has clear boundaries (workspaces, manifests, CI paths: filters); argv only, strict keys (verify, always, full, rules, timeoutMinutes, $schema), sub-packages as [\"sh\",\"-c\",\"cd pkg && …\"]; write it on the unit's branch as a normal change, ship it in its PR, then stop and ask the user to approve it with /flow approve verify" : 'call the verify tool'
  // The agent never commits or pushes: it hands the user the commands, and the step follows what git then reports.
  if (step.observe === 'commit') {
    const target = pullRequest?.baseRefName && pullRequest.baseRefName !== git?.base ? pullRequest.baseRefName : 'the default branch'
    const sharedBranch = position.slice?.isShared
      ? `; this branch carries another unit's commits: bring ${target} in with a merge, never a rebase (a rebase leaves the earlier units' PR step not done)` : ''
    if (!step.skill) return `stop and give the user the git add, git commit and git push commands to run (never commit or push yourself)${sharedBranch}`
    return skills.includes(step.skill)
      ? `stop and ask the user to run the commit commands ${step.skill} produced, then push the branch (never commit or push yourself; no need to run it again)${sharedBranch}`
      : `run the ${step.skill} skill, then stop and ask the user to run the commands it produced and push the branch (never commit or push yourself)${sharedBranch}`
  }
  if (step.observe === 'pr.created') {
    if (state.factCode === 'github-unreachable' || state.factCode === 'ci-unreadable') return 'retry; if it keeps failing, stop and tell the user'
    if (state.factCode === 'pr-ambiguous') return 'stop and ask the user which PR delivers this unit and to close the others'
    if (state.factCode === 'base-mismatch') {
      const target = `so the unit's base is taken from ${pullRequest?.baseRefName ?? "the PR's base"}`
      return position.flow.declaredBy === 'human'
        ? `stop and ask the user to run /flow ${[session.flow, ...session.issues.map(number => `#${number}`)].join(' ')} again, ${target}`
        : `call declare_flow again with the same flow and issues, ${target}`
    }
    const closeOut = '; before the unit counts as finished, record on the issue or PR any session context no issue captured (a dead end explored, an approach ruled out)'
    if (state.factCode === 'push-required') return `stop and ask the user to push the branch${pullRequest ? ` to PR #${pullRequest.number}` : ''}${closeOut}`
    const isOpen = pullRequest?.state === 'OPEN'
    const pushFirst = isPushed ? '' : 'stop and ask the user to push the branch, then '
    const closing = step.requires === 'closes' ? session.issues.map(number => `Closes #${number}`) : []
    const body = closing.length ? ` (body must carry ${closing.join(', ')})` : ''
    if (!step.skill) return (isOpen ? `stop and ask the user to push the branch to PR #${pullRequest.number}` : `${pushFirst}open the PR with gh pr create`) + closeOut
    return `${pushFirst}run the ${step.skill} skill to ${isOpen ? `update PR #${pullRequest.number}` : 'open the PR'}${body}${closeOut}`
  }
  return step.label
}

/**
 * Directs code work through the branch prerequisite and Verify tool.
 * @param position - The unit's current position.
 * @returns The next actions required for the Code step.
 */
function describeCode(position: Position): string {
  const { git } = position
  const steps = [
    ...(isOnBase(git) ? [`${branchFirstInstruction} first`] : []),
  ]
  const diagnosis = position.flow.steps.find(step => step.isInWorktree)?.skill
  const change = isCodeJudgedByFix(position.flow, position.unit)
    ? `resume the ${diagnosis} skill at Phase 5: write the regression test if the red is not already one, apply the approved fix, rerun the red command's argv through the run tool until it passes (the green; Bash runs never count), do the Phase 6 cleanup, then call the verify tool`
    : 'make the change, then call the verify tool'
  return [...steps, change].join(', then ')
}
