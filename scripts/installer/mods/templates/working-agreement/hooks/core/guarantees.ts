import type { PrSnapshot, Violation, ViolationFact } from '../../types'
import { readContentTree, readGitOutput, readGitState, readWorktrees } from '../lib/git'
import { readPrFields } from '../lib/github'
import type { Worktree } from '../lib/git'
import { bestEffort } from './best-effort'
import type { EnginePort } from './engine-port'
import { isJudgedTool } from './judged-tools'
import { createReadPort } from './read-port'
import { readCommonDir, readSession, sameIdentity, temporaryPath, updateSession, recordsPath } from './record-store'
import { withRecordLock } from './session-memory'
import { readCandidates, selectBasePullRequest } from './unit-github'

interface RefSnapshot { refs: Record<string, string>; worktrees: Worktree[] }
/** Keeps independent snapshots so a GitHub failure cannot suppress git verdicts. */
export interface GuaranteeSnapshot {
  windowStartSeconds: number
  refs: RefSnapshot | null
  trees: Record<string, string> | null
  pr: PrSnapshot | null
  isPrUnchecked: boolean
}

/** Who reads a violation: the agent in its call result, or the user in the pane and `/flow status`. */
type ViolationReader = 'agent' | 'user'

const readOnly = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'LSP', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'TodoWrite', 'ToolSearch', 'TaskOutput',
  'ExitPlanMode', 'EnterPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'ListAgents', 'CronList', 'GetTask', 'FetchInboxMessage',
  'ListConnectors', 'ListPlugins', 'ListSkills', 'SearchMcpRegistry', 'SearchPlugins', 'SearchSkills',
  'memory_list', 'memory_read', 'ReadNotifications', 'WaitForMcpServers', 'mcp__working-agreement__declare_flow',
])

/**
 * Selects every call except the explicit read-only allowlist.
 * @param tool - The engine tool name.
 * @returns Whether to open a guarantee window.
 */
export const checksGuarantees = (tool: string): boolean => !readOnly.has(tool)

/**
 * Refreshes the last PR read in authoritative state, including tick and turn-end reads.
 * @param port - The engine calls.
 * @param number - The open PR selected by the unit reader, if any.
 * @returns The last fresh read, or null when no open PR is known.
 */
export async function refreshPrSnapshot(port: EnginePort, number?: number): Promise<PrSnapshot | null> {
  const session = await readSession(port)
  if (!session.unit) return null
  const held = session.prSnapshot && sameIdentity(session.prSnapshot.unit, session.unit) ? session.prSnapshot : null
  const selected = number ?? (held?.fields.state === 'OPEN' ? held.number : undefined)
  if (!selected || (held?.number === selected && held.fields.state !== 'OPEN')) return null
  const read = await readPrFields(port.processes, selected)
  if (!read.isOk) throw new Error(read.error)
  const snapshot = { unit: session.unit, number: selected, fields: read.value }
  await withRecordLock(() => updateSession(port, current => current.unit && sameIdentity(current.unit, snapshot.unit) ? { ...current, prSnapshot: snapshot } : null))
  return snapshot
}

/**
 * Captures the unit's open PR before a guarded operation, rejecting unreadable repository facts.
 * @param port - The engine calls.
 * @returns The existing or refreshed open-PR snapshot, or null without an open PR.
 */
async function readPrBefore(port: EnginePort): Promise<PrSnapshot | null> {
  const session = await readSession(port)
  if (!session.unit) return null
  if (session.prSnapshot && sameIdentity(session.prSnapshot.unit, session.unit)) return session.prSnapshot.fields.state === 'OPEN' ? session.prSnapshot : null
  const git = await readGitState(port.processes)
  if (!git.isOk || !git.value) throw new Error('repository unreadable')
  const candidates = await readCandidates(port, session.unit.branch)
  if (!candidates.isOk) throw new Error('PR candidates unreadable')
  const chosen = selectBasePullRequest(candidates.value)
  if (!chosen.isOk) throw new Error(chosen.error)
  return chosen.value?.state === 'OPEN' ? refreshPrSnapshot(port, chosen.value.number) : null
}

/**
 * Captures refs and worktrees together for post-operation guarantee checks.
 * @param port - The engine calls.
 * @returns The ref snapshot, or null when either source is unreadable.
 */
async function readRefs(port: EnginePort): Promise<RefSnapshot | null> {
  const refs = await readGitOutput(port.processes, ['for-each-ref', '--format=%(refname) %(objectname)'])
  const worktrees = await readWorktrees(port.processes)
  if (refs === null || worktrees === null) return null
  return {
    refs: Object.fromEntries(refs.split('\n').filter(Boolean).map(line => line.split(' '))),
    worktrees,
  }
}

/**
 * Captures default-branch worktree content for detecting protected edits.
 * @param port - The engine calls.
 * @param refs - The pre-operation refs and worktrees.
 * @returns Content trees keyed by worktree root, or null when capture fails.
 */
async function readTrees(port: EnginePort, refs: RefSnapshot | null): Promise<Record<string, string> | null> {
  if (!refs) return null
  const git = await readGitState(port.processes)
  const common = await readCommonDir(port)
  if (!git.isOk || !git.value || !common) return null
  const trees = await Promise.all(refs.worktrees.filter(wt => wt.branch === `refs/heads/${git.value?.base}`).map(async wt => {
    const tree = await readContentTree(port.processes, wt.root, await temporaryPath(port, recordsPath(common, 's')))
    return { root: wt.root, tree }
  }))
  return trees.some(entry => !entry.tree) ? null : Object.fromEntries(trees.map(entry => [entry.root, entry.tree!]))
}

/**
 * Takes independent git and PR snapshots without allowing failures to escape into the tool chain.
 * @param engine - The engine calls.
 * @param tool - The tool, determining whether GitHub can change.
 * @param before - The opening snapshot; omitted at the start of the window.
 * @returns All readable snapshots, the window's opening epoch second, and an explicit PR failure flag.
 */
export async function snapshotGuarantees(engine: EnginePort, tool: string, before?: GuaranteeSnapshot): Promise<GuaranteeSnapshot> {
  const windowStartSeconds = before?.windowStartSeconds ?? Math.floor(await engine.now() / 1000)
  const port = createReadPort(engine)
  const refs = await bestEffort(port, 'guarantee refs read', () => readRefs(port), null)
  const trees = await bestEffort(port, 'guarantee trees read', () => readTrees(port, refs), null)
  const pr = await (async () => {
    if (isJudgedTool(tool)) return { value: null, isUnchecked: false }
    return bestEffort(port, 'PR snapshot read', async () => {
      const value = before ? (before.pr ? await refreshPrSnapshot(port, before.pr.number) : null) : await readPrBefore(port)
      return { value, isUnchecked: before?.isPrUnchecked ?? false }
    }, { value: null, isUnchecked: true })
  })()
  return { windowStartSeconds, refs, trees, pr: pr.value, isPrUnchecked: pr.isUnchecked }
}

/**
 * Includes detached worktree heads in local commit-reachability checks.
 * @param snapshot - The captured refs and worktrees.
 * @returns The non-empty local branch and worktree tips.
 */
function localTips(snapshot: RefSnapshot): string[] {
  return [...Object.entries(snapshot.refs).filter(([ref]) => ref.startsWith('refs/heads/')).map(([, sha]) => sha), ...snapshot.worktrees.map(wt => wt.head)].filter(Boolean)
}

/**
 * Defines the remote reachability boundary for commit guarantees.
 * @param snapshot - The captured refs and worktrees.
 * @returns The remote-tracking ref tips.
 */
function remoteTips(snapshot: RefSnapshot): string[] {
  return Object.entries(snapshot.refs).filter(([ref]) => ref.startsWith('refs/remotes/')).map(([, sha]) => sha)
}

/**
 * Finds commits newly reachable beyond a previous reachability boundary.
 * @param port - The engine calls.
 * @param tips - The tips whose reachable commits are inspected.
 * @param excluded - The tips whose reachable commits are excluded.
 * @param minAge - The latest included committer date, in epoch seconds; omitted for all dates.
 * @returns The sorted new commit SHAs, rejecting unreadable reachability.
 */
async function newCommits(port: EnginePort, tips: string[], excluded: string[], minAge?: number): Promise<string[]> {
  if (!tips.length) return []
  const output = await readGitOutput(port.processes, ['rev-list', ...(minAge === undefined ? [] : [`--min-age=${minAge}`]), ...new Set(tips), '--not', ...new Set(excluded)])
  if (output === null) throw new Error('commit reachability unreadable')
  return output.split('\n').filter(Boolean).sort()
}

/**
 * Judges complete check pairs, excluding fetched history dated before the window; unreadable checks produce one unchecked fact for the call.
 * @param engine - The engine calls.
 * @param before - The opening snapshots.
 * @param after - The closing snapshots.
 * @param toolUseId - The call's identity for an unchecked fact.
 * @returns Facts seen by this window, without consulting other sessions.
 */
export async function judgeGuarantees(engine: EnginePort, before: GuaranteeSnapshot, after: GuaranteeSnapshot, toolUseId: string): Promise<ViolationFact[]> {
  const port = createReadPort(engine)
  const facts: ViolationFact[] = []
  const unchecked = { value: !before.refs || !after.refs || !before.trees || !after.trees || before.isPrUnchecked || after.isPrUnchecked }
  const beforeRefs = before.refs
  const afterRefs = after.refs
  if (beforeRefs && afterRefs) {
    const checked = await bestEffort(port, 'commit reachability read', async () => {
      const beforeTips = [...Object.values(beforeRefs.refs), ...beforeRefs.worktrees.map(wt => wt.head)].filter(Boolean)
      const candidates = await newCommits(port, localTips(afterRefs), beforeTips)
      // Git's min-age is inclusive; commits from the window's first second still count.
      const fetched = candidates.length ? await newCommits(port, remoteTips(afterRefs), beforeTips, before.windowStartSeconds - 1) : []
      const shas = candidates.filter(sha => !fetched.includes(sha))
      if (shas.length) facts.push({ kind: 'commit', fact: { shas }, checkouts: afterRefs.worktrees
        .filter(wt => shas.includes(wt.head)).map(wt => ({ root: wt.root, branch: wt.branch ? wt.branch.replace('refs/heads/', '') : null })) })
      const local = await newCommits(port, localTips(beforeRefs), remoteTips(beforeRefs))
      for (const [ref, sha] of Object.entries(afterRefs.refs).filter(([ref]) => ref.startsWith('refs/remotes/'))) {
        const added = await newCommits(port, [sha], remoteTips(beforeRefs))
        if (added.some(sha => local.includes(sha))) facts.push({ kind: 'push', fact: { ref, before: beforeRefs.refs[ref] ?? null, after: sha } })
      }
      return true
    }, false)
    if (!checked) unchecked.value = true
  }
  if (before.trees && after.trees) for (const [root, tree] of Object.entries(after.trees)) {
    const previous = before.trees[root]
    if (previous && previous !== tree) facts.push({ kind: 'default-tree', fact: { root, before: previous, after: tree } })
  }
  if (before.pr && after.pr && before.pr.fields.state === 'OPEN' && JSON.stringify(before.pr.fields) !== JSON.stringify(after.pr.fields)) {
    facts.push({ kind: 'pr', fact: { number: before.pr.number, before: before.pr.fields, after: after.pr.fields } })
  }
  if (unchecked.value) facts.push({ kind: 'unchecked', fact: { toolUseId } })
  return facts
}

/**
 * Describes the fact with worktree attribution appropriate to this session, addressed to its reader.
 * @param fact - The observed fact.
 * @param reader - The agent, warned in its call result, or the user, shown the pane note and status row.
 * @param root - The root of this session's checkout.
 * @returns The agent warning or the user's note.
 */
export function describeViolation(fact: Violation, reader: ViolationReader, root?: string): string {
  if (fact.kind === 'unchecked') {
    const count = fact.count ?? 1
    return `unchecked: guarantee snapshots unavailable for ${count} call${count === 1 ? '' : 's'}, latest ${fact.fact.toolUseId}`
  }
  const outside = fact.kind === 'commit' ? fact.checkouts?.find(wt => wt.root !== root) : undefined
  const subject = fact.kind === 'commit' ? `a commit appeared${outside ? ` on ${outside.branch ?? 'a detached HEAD'}, checked out in another worktree,` : ''}`
    : fact.kind === 'push' ? `a push appeared on ${fact.fact.ref}`
    : fact.kind === 'pr' ? `PR #${fact.fact.number} changed its protected fields`
    : `the default-branch tree changed at ${fact.fact.root}${fact.fact.root !== root ? ', in another worktree,' : ''}`
  const other = outside || (fact.kind === 'default-tree' && fact.fact.root !== root) ? " or another session's" : ''
  return reader === 'agent'
    ? `${subject} during your call (it may be the user's${other}): stop and tell the user`
    : `${subject.charAt(0).toUpperCase()}${subject.slice(1)} during an agent call (it may be yours${other})`
}
