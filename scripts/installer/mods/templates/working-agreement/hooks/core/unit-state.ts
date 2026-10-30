import { hasMovedSinceCut, isAncestor, readDefaultRef, readLocalBranches, readParentBranch } from '../lib/git'
import { readGraphql } from '../lib/github'
import { triageLabels } from '../domain/issue-fields'
import { isUnitFinished } from '../domain/step-states'
import { isRecord } from '../lib/guards'
import { filterRecords, toStringOrEmpty } from '../lib/json'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { locatePosition } from './position'
import { readDeclaration, readSessionMirrors } from './record-store'
import type { SessionMirror } from './record-store'
import { readGit } from './repository'

/** Where an issue's unit is: no branch yet, a branch being worked, finished and awaiting its Integrate or PR, or merged into its parent. */
export type UnitState = 'none' | 'working' | 'finished' | 'integrated'

/** Where a new unit branch starts, with the branch it is cut from, or what it waits for. */
type Base = { isReady: true; ref: string; parent: string } | { isReady: false; reason: string }

/** The repository's default branch, by name and by the ref it resolves through. */
interface DefaultBase { name: string; ref: string }

/** An issue as spawn judges it: its title, its open blockers, and where its new unit branch would start, or what keeps it from starting. */
interface IssueStart { title: string; blockers: number[]; base: Base }

/**
 * Reads where an issue's unit is, by the same rule spawn uses to tell an integrated dependency.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @param base - The default branch's name and ref.
 * @param mirrors - Every session mirror.
 * @returns The unit's state.
 * @throws When the branches cannot be listed.
 */
export async function readUnitState(port: EnginePort, issue: number, base: DefaultBase, mirrors: SessionMirror[]): Promise<UnitState> {
  const branch = await findUnitBranch(port, issue)
  if (!branch) return 'none'
  if (!branch.isOk) throw new Error(branch.error)
  const record = mirrors.map(mirror => mirror.session).find(session => session.unit?.branch === branch.value)
  const declaration = record?.unit ? await readDeclaration(port, record.unit) : null
  const isCollected = async () => await readCollector(port, branch.value, base.name, base.ref) !== null
  if (!record?.unit || !declaration) return await isCollected() ? 'integrated' : 'working'
  const position = await locatePosition(port, { ...record, flow: declaration.flow, issues: record.unit.issues }, true)
  if (isUnitFinished(position) && !position?.current) return 'integrated'
  const observe = position?.current?.step.observe
  // why: a unit reopened on a branch its parent already holds is working toward new work until its session says otherwise.
  if ((observe !== 'integrated' && observe !== 'pr.created') || position?.slice?.isRewritten) return 'working'
  return await isCollected() ? 'integrated' : 'finished'
}

/**
 * Finds the branch an issue's unit already has, whatever type and slug it was given: `<n>-` starts its name or follows its last slash.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns The branch, as a success, or undefined when the issue has none.
 */
export async function findUnitBranch(port: EnginePort, issue: number): Promise<Result<string> | undefined> {
  const branches = await readLocalBranches(port.processes)
  if (branches === null) return fail('cannot list the branches')
  const branch = [...branches].find(name => name.slice(name.lastIndexOf('/') + 1).startsWith(`${issue}-`))
  return branch ? succeed(branch) : undefined
}

/**
 * Reads an issue from GitHub and judges, by spawn's rules, whether a new unit branch may start for it and from where.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns The issue's title, open blockers and base, or why it is unreadable.
 */
export async function readIssueStart(port: EnginePort, issue: number): Promise<Result<IssueStart>> {
  const read = await readGraphql(port.processes, `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issue(number:${issue}){`
    + 'state title labels(first:100){nodes{name}} blockedBy(first:50){nodes{number state}}}}}', [], { fallback: 'not found' })
  if (!read.isOk) return fail(`cannot read #${issue}: ${read.error}`)
  const fields = isRecord(read.value.issue) ? read.value.issue : null
  if (!fields) return fail(`cannot read #${issue}: unreadable gh output`)
  const title = toStringOrEmpty(fields.title)
  const blockers = filterRecords(isRecord(fields.blockedBy) ? fields.blockedBy.nodes : null).filter(node => node.state === 'OPEN').map(node => Number(node.number))
  const triage = filterRecords(isRecord(fields.labels) ? fields.labels.nodes : null).map(label => toStringOrEmpty(label.name)).find(label => triageLabels.includes(label))
  const refuse = (reason: string): Result<IssueStart> => succeed({ title, blockers, base: { isReady: false, reason } })
  if (fields.state !== 'OPEN') return refuse(`#${issue} is closed`)
  if (triage !== 'ready-for-agent') return refuse(`#${issue} is ${triage ?? 'not triaged'}, and only a ready-for-agent issue gets a unit: triage stays the user's unless /flow delegate triage hands it over`)
  const base = await resolveBase(port, blockers)
  return base.isReady ? succeed({ title, blockers, base }) : refuse(`#${issue} waits: ${base.reason}`)
}

/**
 * Picks where a new unit branch starts: the dependency's branch, or the branch that has integrated it, else the default branch.
 * @param port - The engine calls.
 * @param blockers - The issue's open blocked-by dependencies.
 * @returns The base ref, or what the unit waits for.
 */
async function resolveBase(port: EnginePort, blockers: number[]): Promise<Base> {
  const git = await readGit(port)
  if (!git) return { isReady: false, reason: 'the repository state is unreadable' }
  const defaultRef = await readDefaultRef(port.processes, git.base)
  const [blocker, ...others] = blockers
  if (blocker === undefined) return { isReady: true, ref: defaultRef, parent: git.base }
  if (others.length) return { isReady: false, reason: `it is blocked by #${blockers.join(', #')}, and a child unit has one parent` }
  const parent = await findUnitBranch(port, blocker)
  // why: when a dependent unit may start is the coordinator's call; a commit count does not say the dependency is ready.
  if (!parent?.isOk) return { isReady: false, reason: `its dependency #${blocker} has no unit branch yet` }
  // why: a dependent built on unfinished work duplicates or conflicts with it; only a committed, verified unit is a base.
  const state = await readUnitState(port, blocker, { name: git.base, ref: defaultRef }, await readSessionMirrors(port))
  if (state !== 'finished' && state !== 'integrated') return { isReady: false, reason: `#${blocker}'s unit is ${state}` }
  return await readCollector(port, parent.value, git.base, defaultRef) ?? { isReady: true, ref: parent.value, parent: parent.value }
}

/**
 * Finds the branch that already holds an integrated dependency's work, where its dependents start instead of from the dependency's own branch.
 * @param port - The engine calls.
 * @param branch - The dependency's unit branch.
 * @param defaultBranch - The default branch's name.
 * @param defaultRef - The default branch's ref.
 * @returns The branch the dependency was cut from, when it contains the dependency's tip, else null.
 */
async function readCollector(port: EnginePort, branch: string, defaultBranch: string, defaultRef: string): Promise<Base | null> {
  if (!await hasMovedSinceCut(port.processes, branch)) return null
  const parent = await readParentBranch(port.processes, branch, defaultBranch)
  const ref = parent ? `refs/heads/${parent}` : defaultRef
  return await isAncestor(port.processes, `refs/heads/${branch}`, ref) ? { isReady: true, ref, parent: parent ?? defaultBranch } : null
}
