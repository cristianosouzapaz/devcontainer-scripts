import { removeFile } from '../lib/files'
import { readLocalBranches } from '../lib/git'
import type { GitState } from '../lib/git'
import { readIssue } from '../lib/github'
import type { PullRequestCandidate } from '../lib/github'
import { hasExitedZero } from '../lib/process'
import { fail } from '../lib/result'
import type { Result } from '../lib/result'
import type { Identity, UnitEntry, UnitRecord } from '../domain/records'
import { isChildUnit, isUnitOnBase } from '../domain/step-states'
import { bestEffort, logFailure } from './best-effort'
import type { EnginePort } from './engine-port'
import { createReadPort } from './read-port'
import { deleteDeclaration, deleteObservedEnds, readCommonDir, readDeclarations, readSession, readSessionMirrors, sameIdentity, updateSession, recordsPath } from './record-store'
import { sessionMemory } from './session-memory'
import { readGit } from './repository'
import { readGithubStatus } from './github-sync'
import { examineCandidates, readCandidates, readConclusion } from './unit-github'
import { knownEnd, readChildEnd } from './child-end'
import { readUnitSlice } from './unit-slice'
import { temporaryExpiryMs } from './timing'

/** The records one sweep judges: every chat's unit entries and every declaration on disk. */
interface Sweep { git: GitState; entries: UnitEntry[]; declarations: UnitRecord[] }

/** What a rule removes: the entries it matches, and the identities whose declaration goes once none of their entries remains. */
interface Removal { isEntryRemoved: (entry: UnitEntry) => boolean; isDeclarationRemoved: (identity: Identity) => boolean }

/** Judges the sweep from fresh reads, answering null when any of them fails so the whole pass removes nothing. */
type PruningRule = (port: EnginePort, sweep: Sweep) => Promise<Removal | null>

/** The rules of a sweep; a record goes when any of them removes it. */
const pruningRules: PruningRule[] = [judgeConcluded, judgeRetired]

/**
 * Prunes the records the pruning rules remove, then orphan files, only after every read of the sweep succeeds.
 * Other chats' records are only ever deleted whole; a mixed record remains untouched.
 * @param engine - The engine calls.
 * @returns Once the removed records and orphan files are pruned.
 */
export async function pruneRecords(engine: EnginePort): Promise<void> {
  const port = createReadPort(engine)
  const git = await readGit(port)
  if (!git || await readGithubStatus(port, true) !== 'connected') return
  const mirrors = await readSessionMirrors(port)
  // A failed listing must not read as no declarations.
  const declarations = await readDeclarations(port).catch(() => null)
  if (!declarations) return
  const entries = mirrors.flatMap(mirror => mirror.session.units)
  const removals = await Promise.all(pruningRules.map(rule => rule(port, { git, entries, declarations })))
  if (removals.some(removal => removal === null)) return
  const isRemoved = (entry: UnitEntry): boolean => removals.some(removal => removal?.isEntryRemoved(entry))
  const session = await readSession(port)
  const own = mirrors.find(mirror => mirror.session.sessionId === session.sessionId)?.session.units ?? []
  if (own.some(isRemoved)) await updateSession(port, current => current.units.some(isRemoved) ? { ...current, units: current.units.filter(unit => !isRemoved(unit)) } : null)
  for (const mirror of mirrors.filter(mirror => mirror.session.sessionId !== session.sessionId)) {
    if (mirror.session.units.every(isRemoved)) logFailure(port, 'session mirror delete', hasExitedZero(await removeFile(port.processes, mirror.path)))
  }
  for (const identity of listIdentities([...entries, ...declarations])) {
    const isDeclarationRemoved = removals.some(removal => removal?.isDeclarationRemoved(identity))
    if (isDeclarationRemoved && !entries.some(entry => sameIdentity(entry.identity, identity) && !isRemoved(entry))) {
      await bestEffort(port, 'declaration delete', () => deleteDeclaration(port, identity), undefined)
    }
  }
  await bestEffort(port, 'file prune', () => pruneFiles(port), undefined)
}

/**
 * Removes concluded entries: a merged PR delivered their lifetime. A child is concluded only by a PR into the default
 * branch whose head contains its slice end, so a stranded child, whose parent was delivered without it, is never removed here.
 * @param port - The engine calls.
 * @param sweep - The records the sweep judges.
 * @returns The concluded entries and their declarations, or null when a PR read, a comparison or a child's slice read fails.
 */
async function judgeConcluded(port: EnginePort, { git, entries, declarations }: Sweep): Promise<Removal | null> {
  const isChild = (unit: UnitEntry): boolean => isChildUnit(unit, git.base,
    declarations.find(declaration => sameIdentity(declaration.identity, unit.identity))?.flow === 'close-out')
  // why: Every read here is forced, so listing a parent once per child would cost one GitHub call per sibling.
  const branches = [...new Set(entries.flatMap(unit => [unit.identity.branch, ...(isChild(unit) && unit.baseBranch ? [unit.baseBranch] : [])]))]
  const candidates = new Map(await Promise.all(branches.map(async branch => [branch, await readCandidates(port, branch, false, true)] as const)))
  if ([...candidates.values()].some(read => !read.isOk)) return null
  const local = entries.some(isChild) ? await readLocalBranches(port.processes) : null
  const judgements = await Promise.all(entries.map(async unit => {
    const read = (branch: string): Result<PullRequestCandidate[]> => candidates.get(branch) ?? fail(`${branch} not read`)
    const examined = examineCandidates(read(unit.identity.branch), isChild(unit) && unit.baseBranch ? read(unit.baseBranch) : null)
    if (!examined.isOk) return null
    // why: A deleted child branch is judged on its observed end, and one never observed keeps the child; a slice or end that fails to read is a failed read.
    const end = isChild(unit) ? await readChildEnd(port, unit.identity, unit, await readUnitSlice(port, unit.identity, unit, git), local) : undefined
    if (isChild(unit) && !end) return null
    const conclusion = await readConclusion(port, unit.identity, unit, examined.value, git.base, isChild(unit), knownEnd(end))
    return conclusion.isOk ? { unit, isConcluded: !!conclusion.value } : null
  }))
  if (judgements.some(judgement => judgement === null)) return null
  // The session's own entries are re-read fresh, so an entry is matched by its identity and lifetime.
  const isConcluded = (unit: UnitEntry): boolean => judgements.some(judgement => judgement?.isConcluded
    && sameIdentity(judgement.unit.identity, unit.identity) && judgement.unit.generation === unit.generation)
  return { isEntryRemoved: isConcluded, isDeclarationRemoved: identity => entries.some(entry => isConcluded(entry) && sameIdentity(entry.identity, identity)) }
}

/**
 * Retires units whose declared issues are all closed and whose work can no longer continue: no local branch carries
 * them, or they sit on the default branch outside Follow-up. Every lifetime of a retired identity goes with its declaration.
 * @param port - The engine calls.
 * @param sweep - The records the sweep judges.
 * @returns The retired identities, or null when the branch listing or an issue read fails.
 */
async function judgeRetired(port: EnginePort, { git, entries, declarations }: Sweep): Promise<Removal | null> {
  const branches = await readLocalBranches(port.processes)
  if (!branches) return null
  // why: A hop still copies a default-branch Follow-up's evidence, and its issue is closed from the start; a hop
  // needs the declaration, so entries left without one have nothing to keep them.
  const isFollowUp = (identity: Identity): boolean => declarations.some(record => sameIdentity(record.identity, identity) && record.flow === 'follow-up')
  const ended = listIdentities([...entries, ...declarations]).filter(identity => identity.issues.length > 0
    && (!branches.has(identity.branch) || (isUnitOnBase(identity, git) && !isFollowUp(identity))))
  const issues = [...new Set(ended.flatMap(identity => identity.issues))]
  const reads = await Promise.all(issues.map(async issue => ({ issue, read: await readIssue(port.processes, issue) })))
  if (reads.some(({ read }) => !read.isOk)) return null
  const closed = new Set(reads.flatMap(({ issue, read }) => read.isOk && read.value.state === 'CLOSED' ? [issue] : []))
  const retired = ended.filter(identity => identity.issues.every(issue => closed.has(issue)))
  const isRetired = (identity: Identity): boolean => retired.some(other => sameIdentity(other, identity))
  return { isEntryRemoved: entry => isRetired(entry.identity), isDeclarationRemoved: isRetired }
}

/**
 * Lists each distinct identity the records name.
 * @param records - Entries or declarations.
 * @returns Every identity once, in first-seen order.
 */
function listIdentities(records: Pick<UnitEntry, 'identity'>[]): Identity[] {
  return records.map(record => record.identity).filter((identity, index, all) => all.findIndex(other => sameIdentity(other, identity)) === index)
}

/**
 * Removes expired temporary files, orphaned run artifacts, transition logs and observed slice ends while preserving live
 * owners and displayed runs; a unit's log and observed ends live as long as its declaration.
 * @param port - The engine calls.
 */
async function pruneFiles(port: EnginePort): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  const sid = await port.readSessionId()
  // Existence keeps an owner live even if its mirror cannot be parsed.
  const sessions = await port.files.list(recordsPath(common, 's'))
  const live = new Set([`${sid}.json`, ...sessions.map(entry => entry.name)])
  const mirrors = await readSessionMirrors(port, true)
  const named = new Set(mirrors.flatMap(mirror => mirror.session.units.flatMap(unit => [...unit.verifyRuns, ...unit.runs].map(run => run.runId))))
  const memory = sessionMemory.runViews.get(sid)
  const held = new Set([memory?.live?.runId, memory?.published.runId, memory?.last?.runId])
  // why: A session writes its mirror only on its first record change, so owner liveness cannot keep a temporary file.
  const expiry = await port.now() - temporaryExpiryMs
  for (const bucket of ['s', 'u', 'd', 'ok', 'runs']) {
    // The bucket directory may not exist yet.
    const entries = await port.files.list(recordsPath(common, bucket)).catch(() => [])
    for (const { name, mtimeMs } of entries) {
      const temporary = name.match(/^\.tmp-([^/\\]+)-\d+(?:\.lock)?$/)
      const sidecar = bucket === 'runs' ? name.match(/^(\d+-\d+-([^/\\]+))\.json$/) : null
      const log = bucket === 'runs' ? name.match(/^([^/\\]+)-(\d+-\d+-\1)\.log(?:\.output|\.tmp|\.fifo-(?:in|tail|count))?$/) : null
      const owner = temporary?.[1] ?? sidecar?.[2] ?? log?.[1]
      const runId = sidecar?.[1] ?? log?.[2]
      if (!owner) continue
      const dead = !live.has(`${owner}.json`)
      if (temporary ? mtimeMs < expiry : runId && !named.has(runId) && (dead || owner === sid && !held.has(runId))) {
        logFailure(port, 'orphan file delete', hasExitedZero(await removeFile(port.processes, recordsPath(common, bucket, name))))
      }
    }
  }
  // A failed listing must not read as no declarations, which would delete every log.
  const declared = new Set((await port.files.list(recordsPath(common, 'u'))).map(entry => entry.name))
  // The log bucket may not exist yet.
  for (const { name } of await port.files.list(recordsPath(common, 'log')).catch(() => [])) {
    const hash = name.match(/^([0-9a-f]+)\.jsonl$/)?.[1]
    if (hash && !declared.has(`${hash}.json`)) logFailure(port, 'orphan log delete', hasExitedZero(await removeFile(port.processes, recordsPath(common, 'log', name))))
  }
  // The observed end bucket may not exist yet.
  for (const { name } of await port.files.list(recordsPath(common, 'end')).catch(() => [])) {
    if (/^[0-9a-f]+$/.test(name) && !declared.has(`${name}.json`)) {
      await bestEffort(port, 'orphan observed end delete', () => deleteObservedEnds(port, recordsPath(common, 'end', name)), undefined)
    }
  }
}
