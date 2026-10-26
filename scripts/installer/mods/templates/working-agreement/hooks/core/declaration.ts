import { createReadPort } from './read-port'
import { flowDefinitions, findFlow } from '../domain/flow-definitions'
import type { FlowDefinition } from '../domain/flow-definitions'
import { composeInstruction, composeStart, formatIssueReferences } from '../domain/instruction'
import type { DeclaredFlow } from '../domain/instruction'
import { createEmptyUnit, mergeSkills } from '../domain/records'
import type { Identity, IssueInfo, Unit, UnitRecord } from '../domain/records'
import { describeRequirement } from '../domain/requirements'
import { formatStepLabel, isUnitOnBase, projectDisplayStates } from '../domain/step-states'
import { isAncestor, readGitOutput, runGit, readDefaultRef } from '../lib/git'
import type { GitState } from '../lib/git'
import { readClosingPullRequests, readIssue } from '../lib/github'
import type { PullRequestCandidate } from '../lib/github'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { stepSymbol } from '../ui/theme'
import type { EnginePort } from './engine-port'
import { describeIssue, readGithubStatus } from './github-sync'
import { carryLog, logEvent } from './flow-log'
import { refreshView } from './pane-view'
import { locatePosition } from './position'
import { deleteDeclaration, nextGeneration, readBranchUnits, readDeclaration, readSession, readUnit, sameIdentity, writeDeclaration, updateSession, replaceUnitEntry } from './record-store'
import { sessionMemory } from './session-memory'
import { readGit } from './repository'
import { readUnitSlice } from './unit-slice'
import { readCandidates, readConclusion, selectBasePullRequest } from './unit-github'
import { pruneConcluded } from './pruning'

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
  // One base per unit: the PR's base once a PR exists, the default branch before.
  const baseBranch = chosen.value?.baseRefName ?? git.base
  const info: Record<string, IssueInfo> = {}
  for (const issue of declared) {
    const read = await readIssue(port.processes, issue)
    if (!read.isOk) return fail(`Issue #${issue}: ${read.error} — check the number.`)
    if (flow === 'follow-up') {
      const closing = await readClosingPullRequests(port.processes, issue)
      if (!closing.isOk) return fail('GitHub unreachable — retry')
      if (!closing.value.length) return fail(`Issue #${issue} has no open or merged closing PR — declare its own flow.`)
      const open = closing.value.filter(pr => pr.state === 'OPEN')
      if (open.length && !open.some(pr => pr.headRefName === identity.branch)) return fail(`Issue #${issue} has an open PR — check out its head branch (${open.map(pr => pr.headRefName).join(', ')}).`)
    } else if (read.value.state !== 'OPEN') return fail(`Issue #${issue} is ${read.value.state.toLowerCase()} — declare an open issue.`)
    info[issue] = await describeIssue(port, flow, issue, read.value)
  }
  const declaration = await readDeclaration(port, identity)
  const predecessor = declaration ? null : await readPredecessor(port, flow, identity, git, candidates.isOk ? candidates.value : [])
  if (predecessor && !predecessor.isOk) return fail('GitHub unreachable — retry')
  const carried = predecessor?.value ?? null
  const previous = carried?.unit ?? await readUnit(port, identity)
  const conclusion = candidates.isOk ? await readConclusion(port, identity, previous, candidates.value) : null
  if (conclusion && !conclusion.isOk) return fail('GitHub unreachable — retry')
  const isConcluded = !!(conclusion?.isOk && conclusion.value)
  const continued = declaration ?? (carried?.isAttach ? carried.declaration : null)
  // Allocate before pruning so even mixed mirrors from a dead chat cannot name the new lifetime.
  const generation = continued && !isConcluded ? continued.generation : await nextGeneration(port)
  await pruneConcluded(port)
  const inherited = isConcluded ? createEmptyUnit() : previous
  const entries = isOnDefault ? [] : (await readBranchUnits(port, identity.branch))
    .filter(entry => !carried?.isAttach || !sameIdentity(entry.identity, carried.declaration.identity))
  const existing = !isConcluded && (!!carried?.isAttach || entries.some(entry => sameIdentity(entry.identity, identity)))
  const slice = await readUnitSlice(port, identity, { ...inherited, baseBranch }, git, flow === 'close-out')
  if (existing && slice?.isFrozen && flow !== 'close-out') return fail('This unit is frozen — declare on a new branch.')
  if (!existing && entries.length && flow !== 'close-out') {
    const slices = await Promise.all(entries.map(entry => readUnitSlice(port, entry.identity, entry, git)))
    if (slices.some(previous => previous && !previous.isFrozen && previous.base === git.head)) return fail('The previous unit has an empty slice — commit work before declaring a new unit.')
  }
  const merged = candidates.isOk ? candidates.value.filter(pr => pr.state === 'MERGED') : []
  const delivered = await Promise.all(merged.map(async pr => await isAncestor(port.processes, pr.headRefOid, git.head)))
  // A base taken from another branch than the PR's is recomputed: re-declaring is how a mismatch is resolved.
  const isMismatched = !!inherited.baseBranch && inherited.baseBranch !== baseBranch
  const keepsBase = existing && !isMismatched && (!inherited.base || await isAncestor(port.processes, inherited.base, git.head))
  const baseRef = await readDefaultRef(port.processes, baseBranch)
  const isTip = !keepsBase && !isMismatched && (flow === 'follow-up' || delivered.some(Boolean) || entries.some(entry => !sameIdentity(entry.identity, identity)))
  const base = isOnDefault ? undefined
    : keepsBase ? inherited.base ?? slice?.base ?? undefined
    : isTip ? git.head
    : await readGitOutput(port.processes, ['merge-base', baseRef, git.head]) ?? undefined
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
    const entry = { ...inherited, base, baseBranch: recordedBranch, generation, identity, skills: mergeSkills(inherited.skills, current.skills ?? []) }
    return { ...replaceUnitEntry(remaining, identity, entry), unit: identity, flow, issues: declared, info, gh: github, skills: undefined }
  })
  if (!written) return fail('The declaration could not be recorded — retry.')
  const next = written.session
  const replaced = attached ?? (held && !sameIdentity(held, identity) ? held : undefined)
  logEvent(port, next, 'declare', { flow, declaredBy, ...(replaced ? { replaces: replaced } : {}) })
  sessionMemory.issuesCheckedAt = await port.now()
  sessionMemory.checks.clear()
  sessionMemory.rules.clear()
  const position = await locatePosition(port, next)
  await refreshView(port, true, true)
  void port.openPane()
  if (!position) return fail('The flow was declared but its position could not be located.')
  const localMerged = await Promise.all(merged.map(pr => readGitOutput(port.processes, ['rev-parse', '--verify', '--quiet', pr.headRefOid])))
  const excluded = base === git.head ? Number(await readGitOutput(port.processes, ['rev-list', '--count', git.head, '--not', baseRef,
    ...localMerged.filter((sha): sha is string => !!sha)]) ?? 0) : 0
  const notice = excluded > 0 ? ` ${excluded} commits already on this branch are not counted for this unit.` : ''
  const which = declared.length ? ` for ${formatIssueReferences(declared, ', ')}` : ''
  const shown = projectDisplayStates(position.states)
  const steps = position.states.map((state, index) => `${stepSymbol[shown[index]!.state]} ${formatStepLabel(state.step, position.pullRequest, state.state === 'current')} (${describeRequirement(state, next, position)})`).join('; ')
  return succeed({ reply: `Flow declared: ${definition.label}${which}.${notice} Steps: ${steps}. ${composeInstruction(position, next)}`, start: composeStart(position, next, `Flow declared: ${definition.label}${which}.`) })
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
      const conclusion = await readConclusion(port, issueless, unit, candidates)
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
