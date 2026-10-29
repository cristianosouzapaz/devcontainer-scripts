import { createReadPort } from './read-port'
import { flowDefinitions, findFlow } from '../domain/flow-definitions'
import type { FlowDefinition } from '../domain/flow-definitions'
import { composeInstruction, composeStart, formatIssueReferences } from '../domain/instruction'
import type { DeclaredFlow } from '../domain/instruction'
import { createEmptyUnit, mergeUnique, sameIdentity } from '../domain/records'
import type { Identity, IssueInfo, Unit, UnitRecord } from '../domain/records'
import { describeRequirement } from '../domain/requirements'
import { formatStepLabel, isUnitOnBase, markStep, projectDisplayStates } from '../domain/step-states'
import { isAncestor, readForkPoint, readGitOutput, readParentBranch, runGit, readDefaultRef } from '../lib/git'
import type { GitState } from '../lib/git'
import { readClosingPullRequests } from '../lib/github'
import type { ClosingPullRequest, PullRequestCandidate } from '../lib/github'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { symbol } from '../ui/symbols'
import type { EnginePort } from './engine-port'
import { markIssuesDeclared, mergeIssue, readGithubStatus, readIssueAnswers } from './github-sync'
import { carryLog, logEvent } from './flow-log'
import { refreshView } from './pane-view'
import { locatePosition } from './position'
import { deleteDeclaration, nextGeneration, readBranchUnits, readDeclaration, readSession, readUnit, writeDeclaration, updateSession, replaceUnitEntry } from './record-store'
import { readIsTreeChanged, sessionMemory } from './session-memory'
import { readGit } from './repository'
import { readUnitSlice } from './unit-slice'
import { readCandidates, readDeclaredConclusion, selectBasePullRequest } from './unit-github'
import { judgeFollowUp } from './follow-up-entry'
import { pruneRecords } from './pruning'

/** The unit a new identity continues: an attach re-keys it, a hop copies its evidence without its base. */
interface Predecessor { declaration: UnitRecord; unit: Unit; isAttach: boolean }

/**
 * Declares the session's flow and the issues its unit resolves; runs inside `withRecordLock`.
 *
 * @param engine - The engine calls.
 * @param flow - The flow's id.
 * @param issues - The declared issue numbers.
 * @param declaredBy - Who declares it: a flow the user owns refuses the agent.
 * @returns The declaration with the flow's steps and next action and the prompt that starts its current step, or why it was refused.
 */
export async function declareFlow(engine: EnginePort, flow: string, issues: number[], declaredBy: FlowDefinition['declaredBy']): Promise<Result<DeclaredFlow>> {
  const port = createReadPort(engine)
  const definition = findFlow(flow)
  if (!definition) return fail(`Unknown flow "${flow}" — use one of ${Object.keys(flowDefinitions.flows).join(', ')}.`)
  if (definition.declaredBy === 'human' && declaredBy === 'agent') {
    return fail(`${definition.label} is declared only by the user — tell the user why and ask them to run /flow.`)
  }
  const checked = await runGit(port.processes, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (checked.exitCode !== 0 || !checked.stdout.trim()) return fail('check out a branch first')
  if (!issues.every(issue => Number.isSafeInteger(issue) && issue > 0)) return fail('Issue numbers must be positive integers.')
  const declared = [...new Set(issues)].sort((a, b) => a - b)

  const identity = { branch: checked.stdout.trim(), issues: declared }
  const git = await readGit(port)
  if (!git?.head) return fail('check out a branch with a commit first')
  const isOnDefault = isUnitOnBase(identity, git)
  const github = await readGithubStatus(port, true)
  const candidates = await readCandidates(port, identity.branch, false, true)
  if ((!isOnDefault || declared.length) && (github !== 'connected' || !candidates.isOk)) return fail('GitHub unreachable — retry')
  const chosen = candidates.isOk && !isOnDefault ? selectBasePullRequest(candidates.value) : succeed(null)
  if (!chosen.isOk) return fail(`The branch's ${chosen.error}, then declare again.`)
  const pullRequest = chosen.value
  const info: Record<string, IssueInfo> = {}
  const closing: Record<number, ClosingPullRequest[]> = {}
  const readAt = await port.now()
  const stored = (await readSession(port)).info
  const answers = await readIssueAnswers(port.processes, flow, declared)
  const errors: string[] = []
  for (const [index, issue] of declared.entries()) {
    const answer = answers[index]!
    if (!answer.issue.isOk) return fail(`Issue #${issue}: ${answer.issue.error} — check the number.`)
    if (flow === 'follow-up') {
      const found = await readClosingPullRequests(port.processes, issue)
      if (!found.isOk) return fail('GitHub unreachable — retry')
      closing[issue] = found.value
    } else if (answer.issue.value.state !== 'OPEN') return fail(`Issue #${issue} is ${answer.issue.value.state.toLowerCase()} — declare an open issue.`)
    // A re-declaration keeps the stored comments and sub-issues a failed read of them would otherwise erase.
    const merge = mergeIssue(stored[issue], answer)
    info[issue] = merge.info
    if (merge.error !== null) errors.push(merge.error)
  }
  const declaration = await readDeclaration(port, identity)
  const predecessor = declaration ? null : await readPredecessor(port, flow, identity, git, candidates.isOk ? candidates.value : [])
  if (predecessor && !predecessor.isOk) return fail('GitHub unreachable — retry')
  const carried = predecessor?.value ?? null
  const previous = carried?.unit ?? await readUnit(port, identity)
  const conclusion = candidates.isOk ? await readDeclaredConclusion(port, identity, previous, candidates.value, git, flow === 'close-out') : null
  if (conclusion && !conclusion.isOk) return fail('GitHub unreachable — retry')
  const isConcluded = !!(conclusion?.isOk && conclusion.value)
  const continued = declaration ?? (carried?.isAttach ? carried.declaration : null)
  // Allocate before pruning so even mixed mirrors from a dead chat cannot name the new lifetime.
  const generation = continued && !isConcluded ? continued.generation : await nextGeneration(port)
  await pruneRecords(port)
  const inherited = isConcluded ? createEmptyUnit() : previous
  const entries = isOnDefault ? [] : (await readBranchUnits(port, identity.branch))
    .filter(entry => !carried?.isAttach || !sameIdentity(entry.identity, carried.declaration.identity))
  const existing = !isConcluded && (!!carried?.isAttach || entries.some(entry => sameIdentity(entry.identity, identity)))
  // A base taken from another branch than the PR's is recomputed: re-declaring is how a mismatch is resolved.
  const isMismatched = !!inherited.baseBranch && !!pullRequest && pullRequest.baseRefName !== inherited.baseBranch
  const kept = isMismatched ? undefined : inherited.baseBranch
  const keepsBase = existing && !isMismatched && (!inherited.base || await isAncestor(port.processes, inherited.base, git.head))
  const isKeptBase = keepsBase && !!inherited.base
  // The reflog is read once, when the base is computed, and its answer cached: a clone or the reflog's expiry loses it.
  const parent = pullRequest || kept || isKeptBase || isOnDefault ? null : await readParentBranch(port.processes, identity.branch, git.base)
  const baseBranch = pullRequest?.baseRefName ?? kept ?? parent ?? git.base
  const slice = await readUnitSlice(port, identity, isKeptBase ? inherited : { ...inherited, baseBranch }, git, flow === 'close-out')
  const followUp = flow === 'follow-up'
    ? await judgeFollowUp(port, { identity, parent: baseBranch, git, closing, slice, isExisting: existing, isCloseOut: declaration?.flow === 'close-out' }) : null
  if (followUp && !followUp.isOk) return followUp
  // A Follow-up that enters through its base branch is a child unit: it spans from the fork point and is integrated, never tipped.
  const isFollowUpChild = !!followUp?.value
  if (existing && slice?.isFrozen && flow !== 'close-out') return fail('This unit is frozen — declare on a new branch.')
  if (!existing && entries.length && flow !== 'close-out') {
    const slices = await Promise.all(entries.map(entry => readUnitSlice(port, entry.identity, entry, git)))
    if (slices.some(previous => previous && !previous.isFrozen && previous.base === git.head)) return fail('The previous unit has an empty slice — commit work before declaring a new unit.')
  }
  const merged = candidates.isOk ? candidates.value.filter(pr => pr.state === 'MERGED') : []
  const delivered = await Promise.all(merged.map(async pr => await isAncestor(port.processes, pr.headRefOid, git.head)))
  const baseRef = await readDefaultRef(port.processes, baseBranch)
  const isTip = !keepsBase && !isMismatched && ((flow === 'follow-up' && !isFollowUpChild) || delivered.some(Boolean) || entries.some(entry => !sameIdentity(entry.identity, identity)))
  const base = isOnDefault ? undefined
    : keepsBase ? inherited.base ?? slice?.base ?? undefined
    : isTip ? git.head
    : await readBranchBase(port, baseBranch, baseRef, git.head)
  if (!isOnDefault && !base && !keepsBase && !isTip && !await readGitOutput(port.processes, ['rev-parse', '--verify', '--quiet', baseRef])) {
    return fail(`Cannot read unit base: ${baseBranch} is not fetched — run git fetch origin ${baseBranch}, then declare again.`)
  }
  if (!isOnDefault && !base) return fail('Cannot read unit base — retry.')
  // Close out spans the live merge-base with its branch; a declaration tip comes from no branch.
  const recordedBranch = isOnDefault ? undefined : flow === 'close-out' ? baseBranch
    : keepsBase && inherited.base ? inherited.baseBranch : isTip ? undefined : baseBranch
  const held = (await readSession(port)).unit
  await writeDeclaration(port, { v: 1, identity, flow, generation })
  const attached = carried?.isAttach ? carried.declaration.identity : null
  if (attached) {
    await deleteDeclaration(port, attached)
    carryLog(port, attached, identity)
  }
  const written = await updateSession(port, current => {
    const remaining = attached ? { ...current, units: current.units.filter(unit => !sameIdentity(unit.identity, attached)) } : current
    const entry = { ...inherited, base, baseBranch: recordedBranch, generation, identity, skills: mergeUnique(inherited.skills, current.skills ?? []) }
    return { ...replaceUnitEntry(remaining, identity, entry), unit: identity, flow, issues: declared, info, gh: github, skills: undefined }
  })
  if (!written) return fail('The declaration could not be recorded — retry.')
  const next = written.session
  const replaced = attached ?? (held && !sameIdentity(held, identity) ? held : undefined)
  logEvent(port, next, 'declare', { flow, declaredBy, ...(replaced ? { replaces: replaced } : {}) })
  markIssuesDeclared(readAt, errors[0] ?? null)
  sessionMemory.checks.clear()
  sessionMemory.rules.clear()
  const position = await locatePosition(port, next)
  await refreshView(port, { isQuiet: true, isSynced: true })
  void port.openPane()
  if (!position) return fail('The flow was declared but its position could not be located.')
  const localMerged = await Promise.all(merged.map(pr => readGitOutput(port.processes, ['rev-parse', '--verify', '--quiet', pr.headRefOid])))
  const excluded = base === git.head ? Number(await readGitOutput(port.processes, ['rev-list', '--count', git.head, '--not', baseRef,
    ...localMerged.filter((sha): sha is string => !!sha)]) ?? 0) : 0
  const notice = excluded > 0 ? ` ${excluded} commits already on this branch are not counted for this unit.` : ''
  const which = declared.length ? ` for ${formatIssueReferences(declared, ', ')}` : ''
  // Naming where the base came from makes a lost parent branch visible at once.
  const source = pullRequest && pullRequest.baseRefName === recordedBranch ? ` (PR #${pullRequest.number})` : parent && parent === recordedBranch ? ' (branch reflog)' : ''
  const origin = isOnDefault ? '' : recordedBranch ? `, base from ${recordedBranch}${source}` : isKeptBase ? ', base kept from the record' : ', base at the declaration tip'
  const shown = projectDisplayStates(position.states)
  const isTreeChanged = await readIsTreeChanged(port, next.unit, position.unit.generation)
  const steps = position.states.map((state, index) => `${symbol[markStep(shown[index]!, position, isTreeChanged).mark]} ${formatStepLabel(state.step, position.pullRequest)} (${describeRequirement(state, next, position)})`).join('; ')
  return succeed({ reply: `Flow declared: ${definition.label}${which}${origin}.${notice} Steps: ${steps}. ${composeInstruction(position, next)}`, start: composeStart(position, next, `Flow declared: ${definition.label}${which}.`) })
}

/**
 * Computes the base a unit records from its base branch: the fork point, unless it lies below the merge-base, where
 * the commits between them are another branch's work the base branch has already delivered, never the unit's own.
 * @param port - The engine calls.
 * @param baseBranch - The unit's base branch.
 * @param baseRef - The ref of the base branch a merge-base is read against.
 * @param head - The unit branch's tip.
 * @returns The base, or undefined when the branch shares no history with the tip.
 */
async function readBranchBase(port: EnginePort, baseBranch: string, baseRef: string, head: string): Promise<string | undefined> {
  const forkPoint = await readForkPoint(port.processes, baseBranch, head)
  const mergeBase = await readGitOutput(port.processes, ['merge-base', baseRef, head])
  return forkPoint && mergeBase && forkPoint !== mergeBase && await isAncestor(port.processes, forkPoint, mergeBase) ? mergeBase : forkPoint ?? undefined
}

/**
 * Finds the unit a new identity continues: the same branch's issue-less unit when a produced issue is attached,
 * or the default branch's unit for the same issues when the unit hops to its own branch.
 *
 * @param port - The engine calls.
 * @param flow - The declared flow's id; the predecessor must carry the same one.
 * @param identity - The new identity, which has no declaration yet.
 * @param git - The checkout's repository and default branch.
 * @param candidates - The branch's pull requests, for an attached unit's conclusion.
 * @returns The predecessor's declaration and the evidence the new unit starts from, null when there is none, or a comparison failure.
 */
async function readPredecessor(port: EnginePort, flow: string, identity: Identity, git: GitState, candidates: PullRequestCandidate[]): Promise<Result<Predecessor | null>> {
  if (!identity.issues.length) return succeed(null)
  if (findFlow(flow)?.issue === 'produced') {
    const issueless = { branch: identity.branch, issues: [] }
    const declaration = await readDeclaration(port, issueless)
    if (declaration?.flow === flow) {
      const unit = await readUnit(port, issueless)
      const conclusion = await readDeclaredConclusion(port, issueless, unit, candidates, git)
      if (!conclusion.isOk) return conclusion
      const slice = await readUnitSlice(port, issueless, unit, git)
      if (!conclusion.value && !slice?.isFrozen) return succeed({ declaration, unit, isAttach: true })
    }
  }
  if (isUnitOnBase(identity, git)) return succeed(null)
  const declaration = await readDeclaration(port, { branch: git.base, issues: identity.issues })
  if (declaration?.flow !== flow) return succeed(null)
  // The default branch has no slice, so the branch computes its own base.
  const { base: _base, baseBranch: _branch, ...unit } = await readUnit(port, declaration.identity)
  return succeed({ declaration, unit, isAttach: false })
}
