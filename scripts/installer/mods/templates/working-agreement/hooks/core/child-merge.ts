import { isStopped, stop, unknown } from '../domain/outcome'
import type { Identity, Session } from '../domain/records'
import { isUnitFinished } from '../domain/step-states'
import { readFirstParentFork, readGitOutput, readLocalBranchTips, readMergeConflicts, readParentBranch, readWorktrees, readWorktreeStatus } from '../lib/git'
import type { ProcessOutput } from '../lib/process'
import { fail, formatErrorLine, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { recordObservedEnd } from './child-end'
import { recordDelegated, runUnsignedGit } from './delegated-commits'
import { coversUnit, readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { composeMergeCommand, quoteArgument } from './integration'
import { leadCiLine, verifyMergeTarget } from './merge-gate'
import type { GateOutcome } from './merge-gate'
import { recordPlaced, removePlaced } from './placed-refs'
import type { PlacedLeft } from './placed-refs'
import { locatePosition } from './position'
import { readBranchUnits, readDeclaration, readSession, readSessionMirrors, readUnit } from './record-store'
import { readGit } from './repository'
import { closeUnitSession } from './unit-close'
import { findUnitBranch } from './unit-state'
import { isCoordinatorSession } from '../domain/coordinator'

/** A child the coordinator names, with the full SHA of the commit the reviewers' GO named, which is all a merge of it may integrate. */
export interface ChildTip { branch: string; tip: string }
/** A finished child of a known delegated pair, ready to be stacked onto its parent, bound to the commit its branch held when the call read it. */
interface ReadyChild { kind: 'ready'; branch: string; tip: string; parent: string; unit: Identity; session: Session; observe: () => Promise<void> }
/** A child its parent already holds, reported without a merge. */
interface DoneChild { kind: 'done'; text: string; observe: () => Promise<void> }
/** One child of a batch: ready, or already integrated. */
type CheckedChild = ReadyChild | DoneChild
/** How the verified top reaches moveParent: how its tree passed, the call's signal and whether a gate ran a command. */
interface ParentMove { verified: string; signal: AbortSignal; hasRun: boolean }
/** A final fast-forward that exited nonzero: the parent, its worktree, its tip before the call, the stack and how its top passed Verify. */
interface FailedMove { parent: string; root: string; old: string; stack: StackedChild[]; move: ParentMove }
/** What settling a parent that holds the verified commit left: the close sentences, and why it is not recorded as delegated, empty when it is. */
interface SettledMerge { closed: string; unrecorded: string }
/** One child stacked onto the commit below it: the commit the parent would move to with it, and whether it was a fast-forward. */
interface StackedChild { child: ReadyChild; target: string; isFastForward: boolean }

/** The most children one call stacks, so a red batch costs at most two more Verifies to name its culprit. */
export const maxBatchChildren = 3

/**
 * Runs the coordinator's merge of up to three finished child units into their shared parent branch, under delegation, for pairs the mod knows:
 * each parent is the branch the child's reflog was cut from, the child's unit is in this coordinator's scope, the parent is a unit branch
 * of an issue in that scope (declared or not), and the child's unit record names that parent. Every local branch tip is read once, first; a child
 * its parent does not hold yet is merged only when its branch is at the tip given, else the whole call is refused before any Verify, record or ref
 * write, and only the given commits are judged, built, verified and merged. The children are stacked in the order given:
 * each one onto the commit below it by a fast-forward when that commit is on the child's first-parent chain, else by a merge commit that applies
 * cleanly. One Verify runs on the top of the stack; the parent moves only to a commit whose exact tree Verify passed. When the top is red, the
 * stack is bisected by prefix: the parent moves to the longest green prefix, and the first child whose prefix is red is named as the culprit,
 * with its command, output tail and log. A conflict, named by its paths, is handed back with the parent where it was.
 * A merge is recorded as delegated only when the parent's new tip is the verified commit and no child moved; other branches may move.
 * Whenever the parent's tip is the verified commit, recorded or not, the integrated children's spawned sessions are closed once they are idle.
 * @param port - The engine calls.
 * @param children - The child branches with their tips, one to three, stacked in this order.
 * @param signal - The call's cancellation signal, which ends a gating Verify without moving the parent.
 * @returns What was merged, or the refusal; a merge into the default branch is always refused.
 */
export async function mergeChildren(port: EnginePort, children: ChildTip[], signal: AbortSignal): Promise<Result<string>> {
  if (!isCoordinatorSession(await readSession(port))) return fail('only a coordinator merges a child into its parent.')
  if (!children.length || children.length > maxBatchChildren || new Set(children.map(child => child.branch)).size !== children.length) {
    return fail(`merge_child takes 1 to ${maxBatchChildren} distinct children.`)
  }
  // why: one read answers both whether each branch exists and where it points, so the pair check and the tip check judge the same refs.
  const tips = await readLocalBranchTips(port.processes)
  if (!tips) {
    const names = children.map(child => child.branch)
    return fail(`the local branch tips could not be read, so whether ${names.join(', ')} ${names.length > 1 ? 'exist and where they point' : 'exists and where it points'} `
      + 'is unknown and nothing was merged; check with git for-each-ref refs/heads, then call merge_child again.')
  }
  const checked: CheckedChild[] = []
  for (const child of children) {
    const result = await checkChild(port, child, tips)
    if (!result.isOk) return result
    checked.push(result.value)
  }
  const result = await mergeChecked(port, checked, tips, signal)
  // why: the checks write nothing and a refusal changes nothing, so the slice ends they saw are cached only for an answer that is no refusal.
  if (result.isOk || isStopped(result) || 'isUnknown' in result) for (const child of checked) void child.observe()
  return result
}

/**
 * Merges the children that passed their checks: reports the ones their parent already holds, and stacks the ready ones onto their shared parent.
 * @param port - The engine calls.
 * @param checked - The checked children, in the order given.
 * @param tips - Every local branch tip, read once for the call.
 * @param signal - The call's cancellation signal.
 * @returns What was merged, or the refusal.
 */
async function mergeChecked(port: EnginePort, checked: CheckedChild[], tips: Map<string, string>, signal: AbortSignal): Promise<Result<string>> {
  const done = checked.flatMap(child => child.kind === 'done' ? [child.text] : [])
  const ready = checked.flatMap(child => child.kind === 'ready' ? [child] : [])
  const first = ready[0]
  if (!first) return succeed(done.join(' '))
  const parent = first.parent
  if (ready.some(child => child.parent !== parent)) return fail(`the children of one merge_child call share one parent branch: ${ready.map(child => `${child.branch} → ${child.parent}`).join(', ')}.`)
  const merged = await mergeStack(port, parent, ready, tips, signal)
  return merged.isOk ? succeed([...done, merged.value].join(' ')) : merged
}

/**
 * Checks one child of a batch: its delegated pair, then whether its parent already holds it, then that its branch is at the tip given,
 * then that its unit is finished, so a moved branch is refused before any finished check or hand-over.
 * @param port - The engine calls.
 * @param given - The child branch and the tip given for it.
 * @param tips - Every local branch tip, read once for the call.
 * @returns The ready child bound to its tip, a child its parent already holds, or the refusal naming it.
 */
async function checkChild(port: EnginePort, given: ChildTip, tips: Map<string, string>): Promise<Result<CheckedChild>> {
  const child = given.branch
  const git = await readGit(port)
  if (!git) return fail('the repository is unreadable.')
  const scope = await readOwnScope(port)
  if (!scope) return fail('this coordinator delegates nothing; merging is the user\'s.')
  const units = await Promise.all(scope.issues.map(issue => findUnitBranch(port, issue)))
  const live = tips.get(child)
  if (live === undefined) {
    const branches = units.flatMap(branch => branch?.isOk ? [branch.value] : [])
    return fail(`no branch named ${child}; the delegated units' branches are: ${branches.join(', ') || 'none'}.`)
  }
  const parent = await readParentBranch(port.processes, child, git.base)
  if (!parent) {
    const reflog = await readGitOutput(port.processes, ['log', '--walk-reflogs', '--format=%gs', `refs/heads/${child}`, '--'])
    const isFromBase = reflog?.split('\n').at(-1) === `branch: Created from ${git.base}`
    return fail(`${child} has no parent branch the mod knows${isFromBase ? ` (it was cut from ${git.base}, and a merge into ${git.base} is always the user's)` : ''}.`)
  }
  const candidates = (await readSessionMirrors(port)).map(mirror => mirror.session).filter(session => session.unit?.branch === child)
  const covered = await Promise.all(candidates.map(session => coversUnit(port, scope, session.unit?.issues ?? [], false)))
  const record = candidates.find((_, index) => covered[index])
  const declaration = record?.unit ? await readDeclaration(port, record.unit) : null
  // why: spawn cuts a child from the unit branch of an issue in scope without a unit on it, so a fresh integration branch counts too.
  const parentUnits = await readBranchUnits(port, parent)
  const isParentInScope = (await Promise.all(parentUnits.map(entry => coversUnit(port, scope, entry.identity.issues, false)))).some(Boolean)
    || units.some(branch => branch?.isOk && branch.value === parent)
  if (!record?.unit || !declaration || (await readUnit(port, record.unit)).baseBranch !== parent || !isParentInScope) return fail(`${child} → ${parent} is no delegated child/parent pair the mod knows.`)
  const session = { ...record, flow: declaration.flow, issues: record.unit.issues }
  // why: the position is judged at the tip this call read, so a branch reset between that read and this one cannot pass as already integrated.
  const position = await locatePosition(port, session, true, false, live)
  const slice = position?.slice
  const observe = () => slice && position.git ? recordObservedEnd(port, record.unit!, position.unit, position.git, slice, session.flow === 'close-out') : Promise.resolve()
  if (isUnitFinished(position) && !position?.current) return succeed({ kind: 'done', text: `${child} is already integrated into ${parent}.`, observe })
  // why: the tip is compared as a string with the SHA read for refs/heads/<child>, never passed to git, so no ref named like a SHA can stand in for it.
  if (live !== given.tip) {
    return fail(`${child}'s tip is ${live}, not the tip given, ${given.tip}, so nothing was merged and no ref moved. `
      + `Check what changed with git log --oneline ${given.tip}...${live} before calling merge_child with another tip.`)
  }
  if (position?.current?.step.observe !== 'integrated' || position.slice?.isRewritten) {
    return fail(`${child} is not finished: its unit is at ${position?.current?.step.label ?? 'an unreadable step'}, and only a finished child is merged.`)
  }
  return succeed({ kind: 'ready', branch: child, tip: live, parent, unit: record.unit, session, observe })
}

/**
 * Stacks the ready children onto their parent's tip, verifies the top, bisects a red top by prefix and moves the parent to the longest green prefix.
 * @param port - The engine calls.
 * @param parent - The shared parent branch.
 * @param ready - The children, in stacking order, each bound to its tip.
 * @param before - Every local branch tip, read once for the call before any check.
 * @param signal - The call's cancellation signal.
 * @returns What was merged, or the refusal naming the conflict, the red child or the moved tip.
 */
async function mergeStack(port: EnginePort, parent: string, ready: ReadyChild[], before: Map<string, string>, signal: AbortSignal): Promise<Result<string>> {
  const worktrees = await readWorktrees(port.processes)
  if (!worktrees) {
    return fail(`the worktree list could not be read, so which worktree holds ${parent} is unknown and nothing was merged; `
      + 'check with git worktree list --porcelain, then call merge_child again.')
  }
  const root = worktrees.find(worktree => worktree.branch === `refs/heads/${parent}`)?.root
  // why: every hand-over merges the bound commit, so the user never merges a commit the branch reached after this call read it.
  const handOver = async (children: ReadyChild[]) => `merging it is the user's: ${await composeMergeCommand(port, parent, children.map(child => ({ branch: child.branch, sha: child.tip })))}`
    + (children.length > 1 ? '. Run it as one line: a conflict stops it at that child, and the children after it are not merged.' : '')
  if (!root) return fail(`no worktree holds ${parent}; ${await handOver(ready)}`)
  const status = await readWorktreeStatus(port.processes, root)
  if (status === null) {
    return fail(`the status of ${root} could not be read, so whether it has uncommitted changes is unknown and nothing was merged; `
      + `check with git -C ${quoteArgument(root)} status, then call merge_child again.`)
  }
  if (status !== '') return fail(`${root} has uncommitted changes; ${await handOver(ready)}`)
  const parentTip = before.get(parent)
  if (!parentTip) return fail(`${parent} is not among the local branches read for this call, so nothing was merged; check with git for-each-ref refs/heads, then call merge_child again.`)
  const stack: StackedChild[] = []
  for (const child of ready) {
    const below = stack.at(-1)?.target ?? parentTip
    // why: fork points of earlier children are read on the parent's first-parent chain, which a fast-forward replaces with the child's; only a child whose own chain passes through the commit below keeps those earlier integrations on it.
    const isFastForward = await readFirstParentFork(port.processes, child.tip, below) === below
    const conflicts = isFastForward ? [] : await readMergeConflicts(port.processes, below, child.tip)
    const onto = below === parentTip ? `${parent}'s tip` : `${parent}'s tip with ${stack.map(entry => entry.child.branch).join(', ')}`
    if (conflicts?.length) return fail(`${child.branch} conflicts with ${onto} (conflicts in ${conflicts.join(', ')}), so nothing was merged: `
      + `the unit can bring the tip in with merge_parent, or ${await handOver([child])}`)
    // why: the merge commit is built with no ref on it, so the parent only ever fast-forwards to a commit whose tree Verify passed.
    const target = isFastForward ? child.tip : await buildMergeCommit(port, parent, child.branch, below, child.tip)
    if (!target) return fail(`the merge of ${child.branch} into ${parent} could not be built, so nothing was merged; ${await handOver([child])}`)
    stack.push({ child, target, isFastForward })
  }
  const gates: GateOutcome[] = []
  const verify = async (index: number): Promise<GateOutcome> => {
    const gate = await verifyMergeTarget(port, { target: stack[index]!.target, base: parentTip, root, origin: stack[index]!.child.unit }, signal)
    gates.push(gate)
    return gate
  }
  const unmoved = `this call did not move ${parent}.`
  // why: a throw while the parent moves still reaches settleGates, so every failed evidence write of the gates is named.
  const move = (entries: StackedChild[], verified: string, hasRun: boolean): Promise<Result<string>> =>
    moveParent(port, parent, root, before, entries, { verified, signal, hasRun })
      .catch((error: unknown) => unknown(`${formatErrorLine(error)}, while moving ${parent}; ${verified}`, `git -C ${quoteArgument(root)} log -1 --format=%H`))
  const top = await verify(stack.length - 1)
  if (top.kind === 'pass') return settleGates(prefixResult(leadCiLine(top), await move(stack, top.text, top.isCommandStarted)), gates)
  // why: only a red names a child; a gate that ended any other way says nothing about the children's trees.
  if (top.kind === 'not verified') return settleGates(fail(`${leadCiLine(top)}${top.text}\nNothing was merged: ${unmoved}`), gates)
  // why: prefixes are tried bottom up, so the first red one names the child that broke the stack; a prefix whose tree a gate already passed is answered from that record without a run, but a unit's own pass never answers a gate.
  const passed: GateOutcome[] = []
  const found: { red: GateOutcome } = { red: top }
  for (const index of stack.keys()) {
    if (index === stack.length - 1) break
    const gate = await verify(index)
    if (gate.kind === 'pass') {
      passed.push(gate)
      continue
    }
    if (gate.kind === 'not verified') {
      return settleGates(stop(`${leadCiLine(top)}${top.text}\n${leadCiLine(gate)}${gate.text}\nBisected: no culprit could be named; ${unmoved}`), gates)
    }
    found.red = gate
    break
  }
  const red = passed.length
  const culprit = stack[red]!.child.branch
  const failure = found.red === top ? top.text : `${leadCiLine(found.red)}${found.red.text}`
  const blame = `${leadCiLine(top)}${failure}\n${stack.length > 1 ? `Bisected: Verify ${red ? 'passed with the children before' : 'failed with only'} ${culprit}${red ? ' and failed once it was added' : ''}. ` : ''}`
  const resend = `Send this to ${culprit}'s unit: bring the tip in with merge_parent, fix, and Verify again.`
  const rest = stack.slice(red + 1).map(entry => entry.child.branch)
  const retry = rest.length ? ` ${rest.join(', ')} ${rest.length > 1 ? 'were' : 'was'} not merged: run merge_child for ${rest.length > 1 ? 'them' : 'it'} again.` : ''
  if (red === 0) return settleGates(fail(`${blame}Nothing was merged: ${unmoved} ${resend}${retry}`), gates)
  const moved = await move(stack.slice(0, red), passed.at(-1)!.text, true)
  const text = `${blame}${moved.isOk ? moved.value : moved.error} ${culprit} was not merged. ${resend}${retry}`
  return settleGates(moved.isOk || isStopped(moved) ? stop(text) : 'isUnknown' in moved ? { ...moved, error: text } : fail(text), gates)
}

/**
 * Leads an answer with a line, keeping whether it is done, refused, stopped or unknown.
 * @param lead - The line, or empty.
 * @param result - The answer.
 * @returns The led answer.
 */
function prefixResult(lead: string, result: Result<string>): Result<string> {
  if (!lead) return result
  return result.isOk ? succeed(`${lead}${result.value}`) : { ...result, error: `${lead}${result.error}` }
}

/**
 * Classifies an answer by what its gates left: unknown when one cannot establish its change, otherwise a stop once one left a change,
 * so an answer is a refusal only when no gate started a command or left anything. Every gate whose evidence write failed, the top's
 * and each prefix's alike, is named in the answer.
 * @param result - The answer as the stack worded it.
 * @param gates - Every gate the call ran.
 * @returns The answer, never a refusal or a plain success after a change.
 */
function settleGates(result: Result<string>, gates: GateOutcome[]): Result<string> {
  const unwritten = gates.flatMap(gate => gate.kind !== 'not verified' && gate.evidence && !gate.evidence.isOk
    ? [`\nThe gate evidence of tree ${gate.tree} was not written (${gate.evidence.error}), so a later merge_child verifies that tree again.`] : [])
  const text = `${result.isOk ? result.value : result.error}${unwritten.join('')}`
  // why: an answer that did not finish lists every check its parts need, the move's as well as each gate cleanup's.
  const own = !result.isOk && 'check' in result && typeof result.check === 'string' ? [result.check] : []
  const uncertain = [...own, ...gates.flatMap(gate => gate.effect.kind === 'unknown' ? [gate.effect.check] : [])]
  if (uncertain.length) return unknown(text, [...new Set(uncertain)].join(' and '))
  if (!result.isOk && (isStopped(result) || 'isUnknown' in result)) return { ...result, error: text }
  if (gates.some(gate => gate.effect.kind === 'changed')) return stop(text)
  return result.isOk ? succeed(text) : fail(text)
}

/**
 * Moves the parent to the top of a verified stack, closes the integrated children's sessions and records the merge commits as delegated.
 * @param port - The engine calls.
 * @param parent - The parent branch.
 * @param root - The parent's worktree.
 * @param before - Every local branch tip before the call.
 * @param stack - The children to integrate, in order; the last one's target is the verified commit.
 * @param move - How the top's tree passed Verify, the call's signal, read before any ref write, and whether a gate ran a command.
 * @returns What was merged, or why nothing was: a cancel before the move is a stop once a gate ran a command.
 */
async function moveParent(port: EnginePort, parent: string, root: string, before: Map<string, string>, stack: StackedChild[], move: ParentMove): Promise<Result<string>> {
  const { verified, signal, hasRun } = move
  const target = stack.at(-1)!.target
  const text = `the call was cancelled before the parent move; this call did not move ${parent}. ${verified}.`
  const cancelled = hasRun ? stop(text) : fail(text)
  if (signal.aborted) return cancelled
  // why: the tip is known before it moves, so a window closing mid-merge already finds the record.
  await recordPlaced(port, parent, target)
  // why: the record write is awaited, so a cancel that arrived during it is read before any merge starts.
  if (signal.aborted) return cancelled
  const merge = await runUnsignedGit(port, ['-C', root, 'merge'], ['--no-edit', '--ff-only', target])
  if (merge.exitCode !== 0) return answerFailedMove(port, { parent, root, old: before.get(parent)!, stack, move }, merge)
  const after = await readLocalBranchTips(port.processes)
  const names = stack.map(entry => entry.child.branch).join(', ')
  const was = stack.length > 1 ? 'were' : 'was'
  if (after?.get(parent) !== target) {
    return stop(`${names} ${was} merged into ${parent} at ${target}, but ${after ? 'its tip is no longer the verified commit' : 'its tip could not be read back'}, so it is not recorded as delegated — tell the user.`)
  }
  const { closed, unrecorded } = await settleMerged(port, parent, stack, after)
  if (unrecorded) return stop(`${names} ${was} merged into ${parent} at ${target}, but ${unrecorded}, so it is not recorded as delegated — tell the user.${closed}`)
  const how = (entry: StackedChild) => entry.isFastForward ? 'fast-forward' : `merge ${entry.target}`
  const what = stack.length === 1 ? `${names} into ${parent} (${how(stack[0]!)})` : `${stack.map(entry => `${entry.child.branch} (${how(entry)})`).join(', ')} into ${parent}`
  return succeed(`Merged ${what}, recorded as delegated. ${verified}.${closed}`)
}

/**
 * Judges a final fast-forward that exited nonzero by the parent's tip read back: still at its old tip, the placed record written for the move
 * is removed, and nothing was merged once the parent's worktree reads clean again; at the verified commit, the merge stands and is recorded like
 * a clean move; anywhere else, the placed record is removed and whether the children were merged is unknown; unreadable, the record is kept,
 * since the move may have happened, and the outcome is unknown.
 * @param port - The engine calls.
 * @param failed - The parent, its worktree, its tip before the call, the stack and how its top passed Verify.
 * @param merge - The failed fast-forward's output.
 * @returns The refusal, the stop naming what stands, or the unknown outcome with how to check.
 */
async function answerFailedMove(port: EnginePort, failed: FailedMove, merge: ProcessOutput): Promise<Result<string>> {
  const { parent, root, old, stack, move } = failed
  const target = stack.at(-1)!.target
  const reason = (merge.stderr.trim() || merge.stdout.trim()).split('\n')[0] || 'no output'
  const failure = `git merge --ff-only ${target} failed in ${root} (exit ${merge.exitCode}: ${reason})`
  const shellRoot = quoteArgument(root)
  const after = await readLocalBranchTips(port.processes)
  const names = stack.map(entry => entry.child.branch).join(', ')
  const was = stack.length > 1 ? 'were' : 'was'
  const check = `git log -1 ${parent} and plan`
  if (!after) return unknown(`${failure}, and ${parent}'s tip could not be read back, so whether ${names} ${was} merged is unknown`, check)
  const now = after.get(parent)
  const run = move.hasRun ? ` ${move.verified}.` : ''
  // why: the placed record names a move the mod was about to make; once the parent is read elsewhere, no record may claim it.
  const unplace = () => removePlaced(port, parent, target)
    .catch((error: unknown) => ({ path: `the placed record of ${parent} at ${target}`, error: formatErrorLine(error) }))
  const describeLeft = (left: PlacedLeft | null) => left ? `; its placed-ref record ${left.path} could not be removed (${left.error}), so remove that file` : ''
  if (now === old) {
    const removal = await unplace()
    const left = describeLeft(removal)
    // why: git updates the worktree before the ref, so a ref update that fails can leave the target's files checked out on the unmoved parent.
    const status = await readWorktreeStatus(port.processes, root)
    if (status !== '') {
      return stop(`${failure}, so ${parent} stays at ${old} and nothing was merged into it, but ${root} `
        + (status === null ? 'has a status that could not be read, so whether the failed merge changed its files is unknown'
          : `is no longer clean: the failed merge may have left ${target}'s files there`)
        + `; check with git -C ${shellRoot} status, and once nothing there is anyone's own work, restore it with git -C ${shellRoot} reset --hard ${old}${left}; `
        + `then call merge_child again.${run}`)
    }
    const unmoved = `${failure}, so nothing was merged and ${parent} stays at ${old}`
    if (removal) {
      return stop(`${unmoved}, but its placed-ref record ${removal.path} could not be removed (${removal.error}); remove that file, check with git -C ${shellRoot} status, `
        + `then call merge_child again.${run}`)
    }
    const refused = `${unmoved}; check with git -C ${shellRoot} status, then call merge_child again.`
    // why: a gate that ran its commands left their log, so a parent that did not move is a stop naming that run, never a refusal.
    return move.hasRun ? stop(`${refused}${run}`) : fail(refused)
  }
  if (now === target) {
    // why: the parent holds the verified commit itself, so the merge is the one Verify passed, unlike a child that moved during the gate.
    const { closed, unrecorded } = await settleMerged(port, parent, stack, after)
    const exited = `git merge exited ${merge.exitCode} (${reason})`
    return stop(unrecorded
      ? `${names} ${was} merged into ${parent} at ${target} (the verified commit), but ${exited} and the merge is not recorded as delegated (${unrecorded}) — tell the user.${closed}`
      : `${names} ${was} merged into ${parent} at ${target} (the verified commit) and recorded as delegated, but ${exited}; check with git -C ${shellRoot} status.${run}${closed}`)
  }
  const where = now ? `is at ${now}, neither ${old} nor the verified ${target}` : 'is no longer among the local branches'
  return unknown(`${parent} ${where}, so whether ${names} ${was} merged is unknown${describeLeft(await unplace())}`, check)
}

/**
 * Settles a parent that holds the verified commit: closes the integrated children's sessions and records the merge commits as delegated,
 * unless a child's branch is no longer at the tip the call bound.
 * @param port - The engine calls.
 * @param parent - The parent branch.
 * @param stack - The integrated children, in order.
 * @param after - Every local branch tip, read after the move.
 * @returns The close sentences, and why the merge is not recorded as delegated, empty when it is.
 */
async function settleMerged(port: EnginePort, parent: string, stack: StackedChild[], after: Map<string, string>): Promise<SettledMerge> {
  // why: an integrated unit's idle session holds memory and polls GitHub; closing it keeps everything a later spawn resumes from.
  const closed = (await Promise.all(stack.flatMap(entry => entry.child.unit.issues.map(issue => closeUnitSession(port, issue))))).join('')
  // why: the gating Verify runs for minutes while other units commit and merge their parents' tips; only the pair's own refs decide.
  const isUnmoved = stack.every(entry => entry.child.tip === after.get(entry.child.branch))
  const merges = stack.filter(entry => !entry.isFastForward).map(entry => entry.target)
  // why: the parent has moved, so a record write that throws must still be answered as a stop naming the merged tip.
  const unrecorded = !isUnmoved ? 'a child moved' : !merges.length ? ''
    : await recordDelegated(port, merges, parent).then(added => added ? '' : 'the merge is not the expected one', (error: unknown) => `its record was not written (${formatErrorLine(error)})`)
  if (!unrecorded) for (const entry of stack) logEvent(port, entry.child.session, 'delegated-merge', { parent, sha: entry.target, kind: entry.isFastForward ? 'fast-forward' : 'merge' })
  return { closed, unrecorded }
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
