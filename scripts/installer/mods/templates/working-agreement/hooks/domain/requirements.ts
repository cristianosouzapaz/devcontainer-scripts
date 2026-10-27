import type { Session } from './records'
import { describeUnknownEnd, isCodeJudgedByFix, isOnBase, isUnitOnBase } from './step-states'
import type { ChildState, ChildUnit, DeliveryFact, Position, StepState } from './step-states'

/** Holds the instruction that sends the agent to a branch before its first write on the default branch. */
export const branchFirstInstruction = 'create a branch for the issue (git switch -c <name>)'

/** Holds the child states whose issues a Close out's PR delivers. */
const deliveredChildStates: ChildState[] = ['integrated', 'stranded']

/**
 * Tells whether a child unit is integrated into its parent branch, a stranded one included, whose commits the parent holds.
 * @param child - The child unit.
 * @returns True when integrated or stranded.
 */
export const isIntegratedChild = (child: ChildUnit): boolean => child.state === 'integrated' || child.state === 'stranded'

/**
 * Tells whether a branch is an integration branch: at least one of its child units is integrated into it.
 * @param children - The branch's child units.
 * @returns True with an integrated or stranded child.
 */
export const isIntegrationBranch = (children: ChildUnit[]): boolean => children.some(isIntegratedChild)

/**
 * Lists the issues a unit's PR delivers: its declared issues and, for a Close out, those of every integrated,
 * unconcluded child unit, each once.
 * @param flow - The declared flow.
 * @param issues - The declared issues.
 * @param children - The child units of the unit's branch.
 * @returns The delivered issues, in ascending order.
 */
function listDeliveredIssues(flow: string | null, issues: number[], children: ChildUnit[]): number[] {
  const delivered = flow === 'close-out' ? children.filter(child => deliveredChildStates.includes(child.state)).flatMap(child => child.identity.issues) : []
  return [...new Set([...issues, ...delivered])].sort((a, b) => a - b)
}

/**
 * Lists the issues a unit's PR must close: the issues it delivers, then, for a Close out, the open issues of every
 * child whose slice end is unknown or whose branch was deleted unmerged, which only the user can settle.
 * @param flow - The declared flow.
 * @param issues - The declared issues.
 * @param children - The child units of the unit's branch.
 * @returns The delivered issues in ascending order, then the other required ones in ascending order.
 */
export function listRequiredIssues(flow: string | null, issues: number[], children: ChildUnit[]): number[] {
  const delivered = listDeliveredIssues(flow, issues, children)
  const unsettled = flow === 'close-out' ? children.flatMap(child => 'openIssues' in child ? child.openIssues : []) : []
  return [...delivered, ...[...new Set(unsettled)].filter(issue => !delivered.includes(issue)).sort((a, b) => a - b)]
}

/**
 * Names a required issue the PR does not close; for a child whose slice end is unknown or whose branch was deleted
 * unmerged, and whose issue the unit does not deliver itself, the fact is the user's to resolve.
 * @param flow - The declared flow.
 * @param issues - The declared issues.
 * @param issue - The issue.
 * @param children - The child units of the unit's branch.
 * @returns The PR fact.
 */
export function describeMissingIssue(flow: string | null, issues: number[], issue: number, children: ChildUnit[]): DeliveryFact {
  const unsettled = flow === 'close-out' && !listDeliveredIssues(flow, issues, children).includes(issue)
    ? children.find(child => 'openIssues' in child && child.openIssues.includes(issue)) : undefined
  if (unsettled?.state === 'deleted-unmerged') {
    return {
      prFact: `child #${issue}: branch ${unsettled.identity.branch} deleted unmerged — restore it with ${unsettled.command} and merge it, or add Closes #${issue} to the PR or close #${issue}`,
      prFactCode: 'child-unmerged',
    }
  }
  if (unsettled?.state !== 'unknown-end') return { prFact: `PR does not close #${issue}` }
  const end = unsettled.end === 'ambiguous' ? 'end ambiguous' : 'end never observed (branch deleted)'
  return { prFact: `child #${issue}: ${end} — verify it is merged, then add Closes #${issue} to the PR or close #${issue}`, prFactCode: 'child-end-unknown' }
}

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
  // The merge is a commit, so the agent hands it to the user and the step follows the ancestry git then reports.
  if (step.observe === 'integrated') {
    const { integration } = position
    if (!integration) return 'retry; if it keeps failing, stop and tell the user'
    if (integration.state === 'unknown-end') {
      return integration.end === 'ambiguous'
        ? `stop and tell the user: ${describeUnknownEnd(integration.end)}, so this unit cannot be judged until ${integration.parent} reaches one of the observed ends`
        : `stop and tell the user: ${describeUnknownEnd(integration.end)}, so this unit can no longer be judged`
    }
    if (integration.state === 'deleted-unmerged') {
      return `the user's step: stop and ask them to run ${integration.command} to restore the branch, then merge this unit into ${integration.parent} (never do either yourself)`
    }
    if (integration.state === 'integrated' || integration.state === 'delivered') return `the user's step: merge this unit into ${integration.parent}`
    // why: The gap is the parent's delivery, so the child's worktree holds nothing left to do.
    if (integration.state === 'stranded') return `the user's step: stop and ask them to run a Close out on ${integration.parent} that opens a new PR containing this unit (nothing to do in this worktree)`
    const pullRequest = integration.childPullRequest ? `merge PR #${integration.childPullRequest} and fetch, or ` : ''
    return `the user's step: stop and ask them to ${pullRequest}run ${integration.command} to merge this unit into ${integration.parent} (never merge yourself)`
  }
  if (step.observe === 'pr.created') {
    if (state.factCode === 'github-unreachable' || state.factCode === 'ci-unreadable') return 'retry; if it keeps failing, stop and tell the user'
    if (state.factCode === 'pr-ambiguous') return 'stop and ask the user which PR delivers this unit and to close the others'
    if (state.factCode === 'child-end-unknown') return "the user's step: stop and ask them to check that the child's work is merged, then add its Closes line to the PR or close its issue (never do either yourself)"
    if (state.factCode === 'child-unmerged') return "the user's step: stop and ask them to restore the child's branch and merge it into this branch, or add its Closes line to the PR or close its issue (never do any of it yourself)"
    if (state.factCode === 'base-mismatch') {
      const target = `so the unit's base is taken from ${pullRequest?.baseRefName ?? "the PR's base"}`
      return position.flow.declaredBy === 'human'
        ? `stop and ask the user to run /flow ${[session.flow, ...session.issues.map(number => `#${number}`)].join(' ')} again, ${target}`
        : `call declare_flow again with the same flow and issues, ${target}`
    }
    // why: Only a Close out's PR closes the children's issues, so a unit that would deliver the round otherwise leaves them open.
    const round = session.flow !== 'close-out' && isIntegrationBranch(position.children ?? [])
      ? "; this branch is an integration branch: its round is delivered by a Close out, whose PR also closes the integrated child units' issues" : ''
    const closeOut = round + '; before the unit counts as finished, record on the issue or PR any session context no issue captured (a dead end explored, an approach ruled out)'
    if (state.factCode === 'push-required') return `stop and ask the user to push the branch${pullRequest ? ` to PR #${pullRequest.number}` : ''}${closeOut}`
    const isOpen = pullRequest?.state === 'OPEN'
    const pushFirst = isPushed ? '' : 'stop and ask the user to push the branch, then '
    const closing = step.requires === 'closes' ? listDeliveredIssues(session.flow, session.issues, position.children ?? []).map(number => `Closes #${number}`) : []
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
