import { formatIssueReferences } from '../domain/instruction'
import type { Identity, UnitEntry } from '../domain/records'
import { isIntegratedChild, isIntegrationBranch } from '../domain/requirements'
import { isUnitOnBase } from '../domain/step-states'
import type { UnitSlice } from '../domain/step-states'
import type { GitState } from '../lib/git'
import type { ClosingPullRequest } from '../lib/github'
import { fail, succeed, unwrapOr } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { composeCutCommand, readBranchChildren } from './integration'
import { readBranchUnitsStrictly, sameIdentity } from './record-store'
import { readCandidates, readDeclaredConclusion } from './unit-github'

/** Holds what a Follow-up's entry is judged on when it is declared. */
interface FollowUpEntry {
  identity: Identity
  /** The declaring branch's base branch, in the declaration's order: PR base, the base branch kept from the record, branch reflog, default branch. */
  parent: string
  git: GitState
  /** Each declared issue's open or merged closing PRs. */
  closing: Record<number, ClosingPullRequest[]>
  /** The declared identity's slice, null when it could not be read. */
  slice: UnitSlice | null
  /** Whether the declared identity names an unconcluded unit in the records. */
  isExisting: boolean
  /** Whether that unit is a Close out. */
  isCloseOut: boolean
}

/** Holds how a declared issue's closing PRs bear on its entry. */
interface ClosingRoute {
  issue: number
  /** The heads of its open closing PRs. */
  heads: string[]
  /** Whether a closing PR alone admits the issue on the declaring branch. */
  isAccepted: boolean
}

/** Holds the issues of the parent branch's unconcluded units that open the child route, and its children not yet merged into it. */
interface ParentUnits { delivered: number[]; pending: UnitEntry[] }

/**
 * Judges a Follow-up's entry on its branch: a closing PR whose head is the branch or its base branch, or the child route,
 * where an unconcluded unit delivered by the base branch declares the issue. A Follow-up that enters through its base
 * branch is a Follow-up child. Away from the default branch, a Follow-up is refused, with the command that cuts a child
 * branch, when the unit of its issues there is frozen or is the branch's Close out, the branch carries other unconcluded
 * units or is an integration branch, or an issue belongs to one of the branch's child units.
 * @param port - The engine calls.
 * @param entry - The declaration's facts.
 * @returns Whether the unit is a Follow-up child, or why the declaration is refused.
 */
export async function judgeFollowUp(port: EnginePort, entry: FollowUpEntry): Promise<Result<boolean>> {
  const { identity, parent, git, closing } = entry
  const isOnDefault = isUnitOnBase(identity, git)
  const routes: ClosingRoute[] = identity.issues.map(issue => {
    const prs = closing[issue] ?? []
    const heads = prs.filter(pr => pr.state === 'OPEN').map(pr => pr.headRefName)
    return { issue, heads, isAccepted: prs.length > 0 && (!heads.length || heads.includes(identity.branch) || heads.includes(parent)) }
  })
  // why: Only a records-backed parent branch opens the child route; the default branch delivers through each unit's own PR.
  const units = isOnDefault || parent === git.base ? succeed(null) : await readParentUnits(port, parent, git)
  if (!units.isOk) return fail(`Cannot read the units of ${parent}: ${units.error} — retry.`)
  const delivered = units.value?.delivered ?? []
  const isHead = routes.some(route => route.heads.includes(identity.branch))
  const isChild = !!units.value && !isHead && routes.some(route => delivered.includes(route.issue) || route.heads.includes(parent))
  if (!isOnDefault) {
    // why: A Follow-up child's branch is owned by its own unit too, so another Follow-up belongs on another child of the same parent.
    const refusal = await readBranchRefusal(port, entry, isChild ? parent : identity.branch)
    if (!refusal.isOk) return fail(`Cannot read the units of ${identity.branch}: ${refusal.error} — retry.`)
    if (refusal.value) return fail(refusal.value)
  }
  for (const { issue, heads, isAccepted } of routes) {
    if (isAccepted || delivered.includes(issue)) continue
    const pending = units.value?.pending.find(child => child.identity.branch !== identity.branch && child.identity.issues.includes(issue))
    if (pending) return fail(`Issue #${issue} belongs to unit ${pending.identity.branch}, not yet merged into ${parent} — continue that unit on its own branch.`)
    if (!closing[issue]?.length) return fail(`Issue #${issue} has no open or merged closing PR — declare its own flow.`)
    return fail(`Issue #${issue} has an open PR — check out its head branch (${heads.join(', ')}) or a branch cut from it.`)
  }
  return succeed(isChild)
}

/**
 * Reads the units a parent branch delivers that are not concluded, a unit on the branch itself or an integrated child,
 * stranded ones included, and the children not yet merged into it.
 * @param port - The engine calls.
 * @param parent - The parent branch.
 * @param git - The checkout's repository and default branch.
 * @returns The delivered units' issues and the pending children, or the first read that failed.
 */
async function readParentUnits(port: EnginePort, parent: string, git: GitState): Promise<Result<ParentUnits>> {
  const children = await readBranchChildren(port, parent, git, { isForced: true })
  if (!children.isOk) return children
  const own = await readUnconcludedUnits(port, parent, git)
  if (!own.isOk) return own
  return succeed({
    delivered: [...own.value, ...children.value.filter(isIntegratedChild).map(child => child.entry)].flatMap(unit => unit.identity.issues),
    pending: children.value.filter(child => child.state === 'pending').map(child => child.entry),
  })
}

/**
 * Reads a branch's unconcluded units, each judged on the branch's PRs as its own position judges it; a concluded unit
 * stays in the records only until the next sweep, and claims nothing.
 * @param port - The engine calls.
 * @param branch - The branch.
 * @param git - The checkout's repository and default branch.
 * @returns The unconcluded units, or the first read that failed, since a unit read as absent would be dropped.
 */
async function readUnconcludedUnits(port: EnginePort, branch: string, git: GitState): Promise<Result<UnitEntry[]>> {
  const units = await readBranchUnitsStrictly(port, branch)
  if (!units.isOk) return units
  const candidates = await readCandidates(port, branch, false, true)
  if (!candidates.isOk) return candidates
  const conclusions = await Promise.all(units.value.map(unit => readDeclaredConclusion(port, unit.identity, unit, candidates.value, git)))
  const failed = conclusions.find(conclusion => !conclusion.isOk)
  if (failed && !failed.isOk) return failed
  return succeed(units.value.filter((_unit, index) => !unwrapOr(conclusions[index]!, null)))
}

/**
 * Names why a Follow-up cannot be declared on its branch: it would be one more unit claiming the branch's delivery,
 * or would take over the unit that delivers it.
 * @param port - The engine calls.
 * @param entry - The declaration's facts.
 * @param cutFrom - The branch whose tip the refusal's command cuts a child branch from.
 * @returns The refusal with the command that cuts a child branch, null when no reason applies, or a failed read.
 */
async function readBranchRefusal(port: EnginePort, entry: FollowUpEntry, cutFrom: string): Promise<Result<string | null>> {
  const { identity, git, slice, isExisting, isCloseOut } = entry
  const { branch } = identity
  // why: An unreadable slice cannot tell a frozen unit from a live one, and a guess would accept a second unit on its range.
  if (isExisting && !slice) return fail('unit slice unreadable')
  const units = await readUnconcludedUnits(port, branch, git)
  if (!units.isOk) return units
  const children = await readBranchChildren(port, branch, git, { isForced: true })
  if (!children.isOk) return children
  const issues = formatIssueReferences(identity.issues, ', ')
  const owned = children.value.filter(child => child.state !== 'concluded').flatMap(child => identity.issues
    .filter(issue => child.identity.issues.includes(issue)).map(issue => `#${issue} belongs to child unit ${child.identity.branch}`))
  const reasons = [
    ...isExisting && slice?.isFrozen ? [`the unit of ${issues} on ${branch} is frozen`] : [],
    ...isExisting && isCloseOut ? [`the unit of ${issues} on ${branch} is its Close out`] : [],
    ...units.value.some(other => !sameIdentity(other.identity, identity)) ? [`other units on ${branch}`] : [],
    ...isIntegrationBranch(children.value) ? [`${branch} is an integration branch`] : [],
    ...owned,
  ]
  if (!reasons.length) return succeed(null)
  return succeed(`Follow-up is refused on ${branch}: ${reasons.join('; ')}. Cut a child branch from ${cutFrom}'s tip (${await composeCutCommand(port, cutFrom)}) and declare the Follow-up there.`)
}
