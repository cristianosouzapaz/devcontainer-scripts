import type { PrSnapshot, UncheckedReason, Violation, ViolationFact } from '../../types'
import { listNewCommits, readContentTree, readGitOutput, readGitState, readWorktrees } from '../lib/git'
import { readPrFields } from '../lib/github'
import { runProcess } from '../lib/process'
import { fail, formatError } from '../lib/result'
import { bestEffort, logFailure } from './best-effort'
import { claimDelegatedCommits } from './delegated-commits'
import type { EnginePort } from './engine-port'
import { isJudgedTool } from './judged-tools'
import { createReadPort } from './read-port'
import { readCommonDir, readSession, temporaryPath, updateSession, recordsPath } from './record-store'
import { modToolPrefix } from '../domain/messages'
import { sameIdentity, uncheckedReasons } from '../domain/records'
import { readRepositoryRoot } from './repository'
import { sessionMemory, withRecordLock } from './session-memory'
import { drawTerritory } from './territory'
import type { RefSnapshot } from './territory'
import { readCandidates, selectBasePullRequest } from './unit-github'
import { pluralize } from '../domain/messages'
import { readGithubStatus } from './github-sync'

/** Which part of a PR snapshot failed: GitHub, or the git, repository, session or record reads around it. */
interface PrFailure { read: 'PR' | 'repository'; error: string }

/** Keeps independent snapshots so a GitHub failure cannot suppress git verdicts. */
export interface GuaranteeSnapshot {
  windowStartSeconds: number
  refs: RefSnapshot | null
  trees: Record<string, string> | null
  pr: PrSnapshot | null
  /** Why the PR check could not run, inherited by the closing snapshot from the opening one; null when it ran. */
  prFailure: PrFailure | null
}

/** Who reads a violation: the agent in its call result, or the user in the pane and `/flow status`. */
type ViolationReader = 'agent' | 'user'

// why: One short wait lets a blip longer than a round trip pass before the single retry, well inside the hook budget.
const retryDelaySeconds = 1

const readOnly = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'LSP', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'TodoWrite', 'ToolSearch', 'TaskOutput',
  'ExitPlanMode', 'EnterPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'ListAgents', 'CronList', 'GetTask', 'FetchInboxMessage',
  'ListConnectors', 'ListPlugins', 'ListSkills', 'SearchMcpRegistry', 'SearchPlugins', 'SearchSkills',
  'memory_list', 'memory_read', 'ReadNotifications', 'WaitForMcpServers', `${modToolPrefix}declare_flow`,
])

/** Marks a failure GitHub answered, so the snapshot tells it apart from a local read's failure. */
class GithubReadError extends Error {}

/**
 * Selects every call except the explicit read-only allowlist.
 * @param tool - The engine tool name.
 * @returns Whether to open a guarantee window.
 */
export const checksGuarantees = (tool: string): boolean => !readOnly.has(tool)

/**
 * Waits before a retry in a host `sleep`: a process call in flight stops the hook's budget clock, which a `$.clock` wait runs down.
 * @param port - The port the retry goes through.
 */
async function waitBeforeRetry(port: EnginePort): Promise<void> {
  await runProcess(port.processes, ['sleep', String(retryDelaySeconds)])
}

/**
 * Refreshes the last PR read in authoritative state, including tick and turn-end reads.
 * @param port - The engine calls.
 * @param number - The open PR selected by the unit reader, if any.
 * @param retry - The port a failed read is made once more through, as a guarantee snapshot needs so one transient failure leaves its call checked; none, no retry.
 * @returns The last fresh read, or null when no open PR is known.
 */
export async function refreshPrSnapshot(port: EnginePort, number?: number, retry?: EnginePort): Promise<PrSnapshot | null> {
  const session = await readSession(port)
  if (!session.unit) return null
  const held = session.prSnapshot && sameIdentity(session.prSnapshot.unit, session.unit) ? session.prSnapshot : null
  const selected = number ?? (held?.fields.state === 'OPEN' ? held.number : undefined)
  if (!selected || (held?.number === selected && held.fields.state !== 'OPEN')) return null
  const first = await readPrFields(port.processes, selected)
  const read = first.isOk || !retry ? first : await waitBeforeRetry(retry).then(() => readPrFields(retry.processes, selected))
  if (!read.isOk) throw new GithubReadError(read.error)
  const snapshot = { unit: session.unit, number: selected, fields: read.value }
  await withRecordLock(() => updateSession(port, current => current.unit && sameIdentity(current.unit, snapshot.unit) ? { ...current, prSnapshot: snapshot } : null))
  return snapshot
}

/**
 * Reads the candidates once more after a short wait, through a probe of its own: the candidates cache and a forced
 * probe both reuse a failed first attempt, so only a fresh probe followed by a forced read reads again.
 * @param retry - The port the retry goes through.
 * @param branch - The unit branch.
 * @returns The candidates, or why the retry failed.
 */
async function retryCandidates(retry: EnginePort, branch: string): ReturnType<typeof readCandidates> {
  await waitBeforeRetry(retry)
  const github = await readGithubStatus(retry, true, true)
  return github === 'connected' ? readCandidates(retry, branch, false, true) : fail(`GitHub ${github}: ${sessionMemory.githubError?.trim().split('\n')[0] || 'no detail'}`)
}

/**
 * Captures the unit's open PR before a guarded operation, retrying each failed PR read once and rejecting unreadable repository facts.
 * @param port - The engine calls.
 * @param retry - The port each retry goes through, outside the observation's shared reads, which hold a failure too.
 * @returns The existing or refreshed open-PR snapshot, or null without an open PR.
 */
async function readPrBefore(port: EnginePort, retry: EnginePort): Promise<PrSnapshot | null> {
  const session = await readSession(port)
  if (!session.unit) return null
  if (session.prSnapshot && sameIdentity(session.prSnapshot.unit, session.unit)) return session.prSnapshot.fields.state === 'OPEN' ? session.prSnapshot : null
  const git = await readGitState(port.processes)
  if (!git.isOk || !git.value) throw new Error(git.isOk ? 'not a repository' : `repository unreadable: ${git.error}`)
  const first = await readCandidates(port, session.unit.branch)
  const candidates = first.isOk ? first : await retryCandidates(retry, session.unit.branch)
  if (!candidates.isOk) throw new GithubReadError(`PR candidates unreadable: ${candidates.error}`)
  const chosen = selectBasePullRequest(candidates.value)
  if (!chosen.isOk) throw new GithubReadError(chosen.error)
  return chosen.value?.state === 'OPEN' ? refreshPrSnapshot(port, chosen.value.number, retry) : null
}

/**
 * Captures refs, worktrees and the session's checkout root together for post-operation guarantee checks.
 * @param port - The engine calls.
 * @returns The ref snapshot, or null when the refs, the worktrees or the root are unreadable.
 */
async function readRefs(port: EnginePort): Promise<RefSnapshot | null> {
  const refs = await readGitOutput(port.processes, ['for-each-ref', '--format=%(refname) %(objectname)'])
  const worktrees = await readWorktrees(port.processes)
  // Without its root the session's own worktree would read as another's, silently dropping its commits.
  const root = await readRepositoryRoot(port)
  if (refs === null || worktrees === null || root === null) return null
  return { refs: Object.fromEntries(refs.split('\n').filter(Boolean).map(line => line.split(' ') as [string, string])), worktrees, root }
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
  const pr = await (async (): Promise<{ value: PrSnapshot | null; failure: PrFailure | null }> => {
    if (isJudgedTool(tool)) return { value: null, failure: null }
    try {
      const value = before ? (before.pr ? await refreshPrSnapshot(port, before.pr.number, engine) : null) : await readPrBefore(port, engine)
      return { value, failure: before?.prFailure ?? null }
    } catch (error) {
      logFailure(port, 'PR snapshot read', fail(formatError(error)))
      return { value: null, failure: { read: error instanceof GithubReadError ? 'PR' : 'repository', error: formatError(error) } }
    }
  })()
  return { windowStartSeconds, refs, trees, pr: pr.value, prFailure: pr.failure }
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
 * Judges complete check pairs, excluding fetched history dated before the window and every commit or push outside the session's territory;
 * unreadable checks produce one unchecked fact for the call.
 * @param engine - The engine calls.
 * @param before - The opening snapshots.
 * @param after - The closing snapshots.
 * @param toolUseId - The call's identity for an unchecked fact.
 * @returns Facts this window judges, without consulting other sessions.
 */
export async function judgeGuarantees(engine: EnginePort, before: GuaranteeSnapshot, after: GuaranteeSnapshot, toolUseId: string): Promise<ViolationFact[]> {
  const port = createReadPort(engine)
  const facts: ViolationFact[] = []
  const reasons = new Set<UncheckedReason>()
  if (!before.refs) reasons.add('refs read failed before')
  if (!after.refs) reasons.add('refs read failed after')
  if (!before.trees) reasons.add('trees read failed before')
  if (!after.trees) reasons.add('trees read failed after')
  if (before.prFailure) reasons.add(`${before.prFailure.read} read failed before`)
  // The closing snapshot inherits the opening one's failure, so only a failure the opening one lacked is a fresh one.
  else if (after.prFailure) reasons.add(`${after.prFailure.read} read failed after`)
  const beforeRefs = before.refs
  const afterRefs = after.refs
  if (beforeRefs && afterRefs) {
    const checked = await bestEffort(port, 'commit reachability read', async () => {
      const territory = drawTerritory(port, beforeRefs, afterRefs)
      const beforeTips = [...Object.values(beforeRefs.refs), ...beforeRefs.worktrees.map(wt => wt.head)].filter(Boolean)
      const candidates = await listNewCommits(port.processes, localTips(afterRefs), beforeTips)
      // Git's min-age is inclusive; commits from the window's first second still count.
      const fetched = candidates.length ? await listNewCommits(port.processes, remoteTips(afterRefs), beforeTips, before.windowStartSeconds - 1) : []
      const unfetched = candidates.filter(sha => !fetched.includes(sha))
      const verdict = unfetched.length ? await territory.judgeCommits(unfetched, beforeTips) : { shas: [], isUnplaced: false }
      // A delegated unit's own unsigned commit is recorded as delegated, never as a violation.
      const delegated = await claimDelegatedCommits(port, beforeRefs, afterRefs, verdict.shas)
      const shas = verdict.shas.filter(sha => !delegated.includes(sha))
      if (shas.length) facts.push({ kind: 'commit', fact: { shas }, checkouts: afterRefs.worktrees
        .filter(wt => shas.includes(wt.head)).map(wt => ({ root: wt.root, branch: wt.branch ? wt.branch.replace('refs/heads/', '') : null })) })
      const local = await listNewCommits(port.processes, localTips(beforeRefs), remoteTips(beforeRefs))
      const pushes = { isUnplaced: false }
      for (const [ref, sha] of Object.entries(afterRefs.refs).filter(([ref]) => ref.startsWith('refs/remotes/'))) {
        const added = await listNewCommits(port.processes, [sha], remoteTips(beforeRefs))
        if (!added.some(sha => local.includes(sha))) continue
        const judged = await territory.judgesPush(ref)
        if (judged === null) pushes.isUnplaced = true
        if (judged) facts.push({ kind: 'push', fact: { ref, before: beforeRefs.refs[ref] ?? null, after: sha } })
      }
      return verdict.isUnplaced || pushes.isUnplaced ? 'unplaced' : 'placed'
    }, 'failed')
    if (checked === 'failed') reasons.add('commit reachability read failed')
    if (checked === 'unplaced') reasons.add('commits or push could not be placed')
  }
  if (before.trees && after.trees) for (const [root, tree] of Object.entries(after.trees)) {
    const previous = before.trees[root]
    if (previous && previous !== tree) facts.push({ kind: 'default-tree', fact: { root, before: previous, after: tree } })
  }
  if (before.pr && after.pr && before.pr.fields.state === 'OPEN' && JSON.stringify(before.pr.fields) !== JSON.stringify(after.pr.fields)) {
    facts.push({ kind: 'pr', fact: { number: before.pr.number, before: before.pr.fields, after: after.pr.fields } })
  }
  if (reasons.size) facts.push({ kind: 'unchecked', fact: { toolUseId, reasons: uncheckedReasons.filter(reason => reasons.has(reason)) } })
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
    const reasons = fact.fact.reasons?.join(', ') ?? 'reason not recorded'
    // why: the user's row is keyed `Unchecked`, which already says it; the agent's text has no key.
    return `${reader === 'agent' ? 'unchecked: ' : ''}${reasons}, for ${pluralize(fact.count ?? 1, 'call')}, latest ${fact.fact.toolUseId}`
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

/**
 * Names an observed violation's kind in words, for a surface with room for no more than the kind, such as the herdr sidebar.
 * @param kind - The violation's kind.
 * @returns The kind in the words the pane's note starts with.
 */
export function nameViolationKind(kind: Exclude<Violation['kind'], 'unchecked'>): string {
  return kind === 'commit' ? 'a commit' : kind === 'push' ? 'a push' : kind === 'pr' ? 'a PR change' : 'a default-branch tree change'
}
