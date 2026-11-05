import type { Identity, Session } from '../domain/records'
import { coversIssues } from '../domain/delegation'
import { isUnitFinished } from '../domain/step-states'
import { findWorktreeRoot, readFirstParentFork, readGitOutput, readLocalBranchTips, readMergeConflicts, readParentBranch, readWorktreeStatus } from '../lib/git'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { recordDelegated, runUnsignedGit } from './delegated-commits'
import { readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { composeMergeCommand } from './integration'
import { verifyMergeTarget } from './merge-gate'
import { recordPlaced } from './placed-refs'
import { locatePosition } from './position'
import { readBranchUnits, readDeclaration, readSession, readSessionMirrors, readUnit } from './record-store'
import { readGit } from './repository'
import { closeUnitSession } from './unit-close'
import { findUnitBranch } from './unit-state'
import { isCoordinatorSession } from '../domain/coordinator'

/** A finished child of a known delegated pair, ready to be stacked onto its parent. */
interface ReadyChild { kind: 'ready'; branch: string; parent: string; unit: Identity; session: Session }
/** A child its parent already holds, reported without a merge. */
interface DoneChild { kind: 'done'; text: string }
/** One child of a batch: ready, or already integrated. */
type CheckedChild = ReadyChild | DoneChild
/** One child stacked onto the commit below it: the commit the parent would move to with it, and whether it was a fast-forward. */
interface StackedChild { child: ReadyChild; target: string; isFastForward: boolean }

/** The most children one call stacks, so a red batch costs at most two more Verifies to name its culprit. */
export const maxBatchChildren = 3

/**
 * Runs the coordinator's merge of up to three finished child units into their shared parent branch, under delegation, for pairs the mod knows:
 * each parent is the branch the child's reflog was cut from, the child's unit is in this coordinator's scope, the parent is a unit branch
 * of an issue in that scope (declared or not), and the child's unit record names that parent. The children are stacked in the order given:
 * each one onto the commit below it by a fast-forward when that commit is on the child's first-parent chain, else by a merge commit that applies
 * cleanly. One Verify runs on the top of the stack; the parent moves only to a commit whose exact tree Verify passed. When the top is red, the
 * stack is bisected by prefix: the parent moves to the longest green prefix, and the first child whose prefix is red is named as the culprit,
 * with its command, output tail and log. A conflict, named by its paths, is handed back with the parent where it was.
 * A merge is recorded as delegated only when the parent's new tip is the verified commit and no child moved; other branches may move.
 * Whenever the parent's tip is the verified commit, recorded or not, the integrated children's spawned sessions are closed once they are idle.
 * @param port - The engine calls.
 * @param children - The child branches, one to three, stacked in this order.
 * @param signal - The call's cancellation signal, which ends a gating Verify without moving the parent.
 * @returns What was merged, or the refusal; a merge into the default branch is always refused.
 */
export async function mergeChildren(port: EnginePort, children: string[], signal: AbortSignal): Promise<Result<string>> {
  if (!isCoordinatorSession(await readSession(port))) return fail('only a coordinator merges a child into its parent.')
  if (!children.length || children.length > maxBatchChildren || new Set(children).size !== children.length) {
    return fail(`merge_child takes 1 to ${maxBatchChildren} distinct children.`)
  }
  const checked: CheckedChild[] = []
  for (const child of children) {
    const result = await checkChild(port, child)
    if (!result.isOk) return result
    checked.push(result.value)
  }
  const done = checked.flatMap(child => child.kind === 'done' ? [child.text] : [])
  const ready = checked.flatMap(child => child.kind === 'ready' ? [child] : [])
  const first = ready[0]
  if (!first) return succeed(done.join(' '))
  const parent = first.parent
  if (ready.some(child => child.parent !== parent)) return fail(`the children of one merge_child call share one parent branch: ${ready.map(child => `${child.branch} → ${child.parent}`).join(', ')}.`)
  const merged = await mergeStack(port, parent, ready, signal)
  return merged.isOk ? succeed([...done, merged.value].join(' ')) : merged
}

/**
 * Checks one child of a batch: its delegated pair, and that its unit is finished.
 * @param port - The engine calls.
 * @param child - The child branch.
 * @returns The ready child, a child its parent already holds, or the refusal naming it.
 */
async function checkChild(port: EnginePort, child: string): Promise<Result<CheckedChild>> {
  const git = await readGit(port)
  if (!git) return fail('the repository is unreadable.')
  const scope = await readOwnScope(port)
  if (!scope) return fail('this coordinator delegates nothing; merging is the user\'s.')
  const parent = await readParentBranch(port.processes, child, git.base)
  const unknown = `${child} has no parent branch the mod knows (a merge into ${git.base} is always the user's).`
  if (!parent) return fail(unknown)
  const record = (await readSessionMirrors(port)).map(mirror => mirror.session).find(session => session.unit?.branch === child && coversIssues(scope, session.unit.issues))
  const declaration = record?.unit ? await readDeclaration(port, record.unit) : null
  // why: spawn cuts a child from the unit branch of an issue in scope without a unit on it, so a fresh integration branch counts too.
  const isParentInScope = (await readBranchUnits(port, parent)).some(entry => coversIssues(scope, entry.identity.issues))
    || (await Promise.all(scope.issues.map(issue => findUnitBranch(port, issue)))).some(branch => branch?.isOk && branch.value === parent)
  if (!record?.unit || !declaration || (await readUnit(port, record.unit)).baseBranch !== parent || !isParentInScope) return fail(`${child} → ${parent} is no delegated child/parent pair the mod knows.`)
  const session = { ...record, flow: declaration.flow, issues: record.unit.issues }
  const position = await locatePosition(port, session, true)
  if (isUnitFinished(position) && !position?.current) return succeed({ kind: 'done', text: `${child} is already integrated into ${parent}.` })
  if (position?.current?.step.observe !== 'integrated' || position.slice?.isRewritten) {
    return fail(`${child} is not finished: its unit is at ${position?.current?.step.label ?? 'an unreadable step'}, and only a finished child is merged.`)
  }
  return succeed({ kind: 'ready', branch: child, parent, unit: record.unit, session })
}

/**
 * Stacks the ready children onto their parent's tip, verifies the top, bisects a red top by prefix and moves the parent to the longest green prefix.
 * @param port - The engine calls.
 * @param parent - The shared parent branch.
 * @param ready - The children, in stacking order.
 * @param signal - The call's cancellation signal.
 * @returns What was merged, or the refusal naming the conflict, the red child or the moved tip.
 */
async function mergeStack(port: EnginePort, parent: string, ready: ReadyChild[], signal: AbortSignal): Promise<Result<string>> {
  const names = ready.map(child => child.branch).join(', ')
  const root = await findWorktreeRoot(port.processes, parent)
  const handOver = async (child: string) => `merging it is the user's: ${await composeMergeCommand(port, parent, child)}`
  if (!root) return fail(`no worktree holds ${parent}; ${await handOver(names)}`)
  if (await readWorktreeStatus(port.processes, root) !== '') return fail(`${root} has uncommitted changes; ${await handOver(names)}`)
  const before = await readLocalBranchTips(port.processes)
  const parentTip = before?.get(parent)
  if (!before || !parentTip || ready.some(child => !before.get(child.branch))) return fail('the branch tips are unreadable.')
  const stack: StackedChild[] = []
  for (const child of ready) {
    const below = stack.at(-1)?.target ?? parentTip
    const childTip = before.get(child.branch)!
    // why: Fork points of earlier children are read on the parent's first-parent chain, which a fast-forward replaces with the
    // child's; only a child whose own chain passes through the commit below keeps those earlier integrations on it.
    const isFastForward = await readFirstParentFork(port.processes, `refs/heads/${child.branch}`, below) === below
    const conflicts = isFastForward ? [] : await readMergeConflicts(port.processes, below, childTip)
    const onto = below === parentTip ? `${parent}'s tip` : `${parent}'s tip with ${stack.map(entry => entry.child.branch).join(', ')}`
    if (conflicts?.length) return fail(`${child.branch} conflicts with ${onto} (conflicts in ${conflicts.join(', ')}), so nothing was merged: `
      + `the unit can bring the tip in with merge_parent, or ${await handOver(child.branch)}`)
    // why: the merge commit is built with no ref on it, so the parent only ever fast-forwards to a commit whose tree Verify passed.
    const target = isFastForward ? childTip : await buildMergeCommit(port, parent, child.branch, below, childTip)
    if (!target) return fail(`the merge of ${child.branch} into ${parent} could not be built, so nothing was merged; ${await handOver(child.branch)}`)
    stack.push({ child, target, isFastForward })
  }
  const verify = (index: number) => verifyMergeTarget(port, { target: stack[index]!.target, base: parentTip, root, origin: stack[index]!.child.unit }, signal)
  const top = await verify(stack.length - 1)
  if (top.isOk) return moveParent(port, parent, root, before, stack, top.value)
  // why: prefixes are tried bottom up, so the first red one names the child that broke the stack; a prefix of one fast-forward
  // child is its own verified tip, which a recorded pass answers without a run.
  const passed: string[] = []
  const failure = { text: top.error }
  for (const index of stack.keys()) {
    if (index === stack.length - 1) break
    const gate = await verify(index)
    if (!gate.isOk) {
      failure.text = gate.error
      break
    }
    passed.push(gate.value)
  }
  const red = passed.length
  const culprit = stack[red]!.child.branch
  const blame = `${failure.text}\n${stack.length > 1 ? `Bisected: Verify ${red ? 'passed with the children before' : 'failed with only'} ${culprit}${red ? ' and failed once it was added' : ''}. ` : ''}`
  const resend = `Send this to ${culprit}'s unit: bring the tip in with merge_parent, fix, and Verify again.`
  const rest = stack.slice(red + 1).map(entry => entry.child.branch)
  const retry = rest.length ? ` ${rest.join(', ')} ${rest.length > 1 ? 'were' : 'was'} not merged: run merge_child for ${rest.length > 1 ? 'them' : 'it'} again.` : ''
  if (red === 0) return fail(`${blame}Nothing was merged: ${parent} stays at ${parentTip}. ${resend}${retry}`)
  const moved = await moveParent(port, parent, root, before, stack.slice(0, red), passed.at(-1)!)
  return fail(`${blame}${moved.isOk ? moved.value : moved.error} ${culprit} was not merged. ${resend}${retry}`)
}

/**
 * Moves the parent to the top of a verified stack, closes the integrated children's sessions and records the merge commits as delegated.
 * @param port - The engine calls.
 * @param parent - The parent branch.
 * @param root - The parent's worktree.
 * @param before - Every local branch tip before the call.
 * @param stack - The children to integrate, in order; the last one's target is the verified commit.
 * @param verified - How the top's tree passed Verify.
 * @returns What was merged, or why nothing was.
 */
async function moveParent(port: EnginePort, parent: string, root: string, before: Map<string, string>, stack: StackedChild[], verified: string): Promise<Result<string>> {
  const target = stack.at(-1)!.target
  // why: the tip is known before it moves, so a window closing mid-merge already finds the record.
  await recordPlaced(port, parent, target)
  const merge = await runUnsignedGit(port, ['-C', root, 'merge'], ['--no-edit', '--ff-only', target])
  if (merge.exitCode !== 0) return fail(`${parent}'s tip moved while the merged tree was verified, so nothing was merged; run merge_child again.`)
  const after = await readLocalBranchTips(port.processes)
  const names = stack.map(entry => entry.child.branch).join(', ')
  const was = stack.length > 1 ? 'were' : 'was'
  if (after?.get(parent) !== target) return fail(`${names} ${was} merged into ${parent}, but its tip is no longer the verified commit, so it is not recorded as delegated — tell the user.`)
  // why: an integrated unit's idle session holds memory and polls GitHub; closing it keeps everything a later spawn resumes from.
  const closed = (await Promise.all(stack.flatMap(entry => entry.child.unit.issues.map(issue => closeUnitSession(port, issue))))).join('')
  // why: the gating Verify runs for minutes while other units commit and merge their parents' tips; only the pair's own refs decide.
  const isUnmoved = stack.every(entry => before.get(entry.child.branch) === after.get(entry.child.branch))
  const merges = stack.filter(entry => !entry.isFastForward).map(entry => entry.target)
  const isRecorded = isUnmoved && (!merges.length || await recordDelegated(port, merges, parent))
  if (!isRecorded) return fail(`${names} ${was} merged into ${parent}, but a child moved or the merge is not the expected one, so it is not recorded as delegated — tell the user.${closed}`)
  for (const entry of stack) logEvent(port, entry.child.session, 'delegated-merge', { parent, sha: entry.target, kind: entry.isFastForward ? 'fast-forward' : 'merge' })
  const how = (entry: StackedChild) => entry.isFastForward ? 'fast-forward' : `merge ${entry.target}`
  const what = stack.length === 1 ? `${names} into ${parent} (${how(stack[0]!)})` : `${stack.map(entry => `${entry.child.branch} (${how(entry)})`).join(', ')} into ${parent}`
  return succeed(`Merged ${what}, recorded as delegated. ${verified}.${closed}`)
}

/**
 * Writes the merge commit of a child onto a commit below it, parents in that order, without moving any ref or touching a worktree.
 * @param port - The engine calls.
 * @param parent - The parent branch, named in the message.
 * @param child - The child branch, named in the message.
 * @param below - The parent's tip or the stack's top so far, the first parent.
 * @param childTip - The child's tip, the second parent.
 * @returns The unsigned merge commit, or null when the merge conflicts or git fails.
 */
async function buildMergeCommit(port: EnginePort, parent: string, child: string, below: string, childTip: string): Promise<string | null> {
  const written = await readGitOutput(port.processes, ['merge-tree', '--write-tree', '--name-only', '--no-messages', below, childTip])
  const tree = written?.split('\n')[0]
  if (!tree) return null
  const commit = await runUnsignedGit(port, ['commit-tree'], [tree, '-p', below, '-p', childTip, '-F', '-'], `Merge branch '${child}' into ${parent}\n`)
  return commit.exitCode === 0 ? commit.stdout.trim() || null : null
}
