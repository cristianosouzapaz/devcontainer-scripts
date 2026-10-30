import { isUnitOnBase } from '../domain/step-states'
import { listNewCommits, readGitOutput, runGit } from '../lib/git'
import type { Worktree } from '../lib/git'
import type { EnginePort } from './engine-port'
import { isPlaced } from './placed-refs'
import { readSession, readUnit } from './record-store'
import { readGit } from './repository'
import { readUnitSlice } from './unit-slice'

/** Holds the refs, the worktree list and the session's checkout root at one end of a check window. */
export interface RefSnapshot { refs: Record<string, string>; worktrees: Worktree[]; root: string }

/** Names the commits a window judges, and whether some could be placed only by an unreadable slice. */
interface CommitVerdict { shas: string[]; isUnplaced: boolean }

/** Judges which of a window's facts are this session's. */
interface Territory {
  /**
   * Keeps the candidates reached by at least one in-territory ref.
   * @param candidates - The commits newly reachable during the window.
   * @param beforeTips - Every ref and worktree HEAD tip of the opening snapshot.
   * @returns The judged commits, flagging those whose placement could not be read.
   */
  judgeCommits: (candidates: string[], beforeTips: string[]) => Promise<CommitVerdict>
  /**
   * Places a push through its matching local branch, which need not exist.
   * @param ref - The moved remote-tracking ref.
   * @returns Whether the push is judged, or null when its placement cannot be read.
   */
  judgesPush: (ref: string) => Promise<boolean | null>
}

/** Holds a unit without a slice: none declared, on the default branch, or its branch gone. */
interface NoSlice { kind: 'none' }

/** Holds a slice that could not be read, which is never read as empty. */
interface UnreadableSlice { kind: 'unreadable' }

/** Holds a read slice: its base and the commits it holds. */
interface ReadSlice { kind: 'read'; base: string; commits: Set<string> }

/** Distinguishes a unit without a slice from an unreadable slice and a read one. */
type SliceRead = NoSlice | UnreadableSlice | ReadSlice

/** Holds a lazily started read. */
interface Cache<T> { value?: Promise<T> }

/** Holds the territory facts read from the session's records, only when a held branch makes them matter. */
interface Scope { unitBranch: string | null; defaultBranch: string; slice: SliceRead }

/** Names a local branch, or a detached worktree HEAD (null branch), that moved during the window. */
interface MovedTip { branch: string | null; before: string | undefined; after: string }

/**
 * Shares one lazy read between every question a window asks.
 * @param read - The read, started on first use.
 * @returns The memoized read.
 */
function once<T>(read: () => Promise<T>): () => Promise<T> {
  const cache: Cache<T> = {}
  return () => cache.value ??= read()
}

/**
 * Reads the unit's branch, the default branch and the unit's slice commits through the unit's own slice reader.
 * @param port - The engine calls.
 * @returns The scope, rejecting an unreadable default branch or session.
 */
async function readScope(port: EnginePort): Promise<Scope> {
  const git = await readGit(port)
  if (!git) throw new Error('default branch unreadable')
  const session = await readSession(port)
  const unit = session.unit
  if (!unit || isUnitOnBase(unit, git)) return { unitBranch: unit?.branch ?? null, defaultBranch: git.base, slice: { kind: 'none' } }
  // A unit branch deleted after its merge has no slice left to carry; only a failed read is unreadable.
  const exists = await runGit(port.processes, ['rev-parse', '--verify', '--quiet', `refs/heads/${unit.branch}`])
  if (exists.exitCode === 1) return { unitBranch: unit.branch, defaultBranch: git.base, slice: { kind: 'none' } }
  if (exists.exitCode !== 0) return { unitBranch: unit.branch, defaultBranch: git.base, slice: { kind: 'unreadable' } }
  const slice = await readUnitSlice(port, unit, await readUnit(port, unit), git, session.flow === 'close-out')
  // A rewritten slice no longer bounds the unit's commits, so it cannot say which ref carries them.
  const commits = slice?.base && !slice.isRewritten ? await readGitOutput(port.processes, ['rev-list', slice.end, '--not', slice.base]) : null
  return { unitBranch: unit.branch, defaultBranch: git.base,
    slice: slice?.base && commits !== null ? { kind: 'read', base: slice.base, commits: new Set(commits.split('\n').filter(Boolean)) } : { kind: 'unreadable' } }
}

/**
 * Lists the local tips that can newly reach a commit: moved branches and moved detached worktree HEADs.
 * @param before - The opening snapshot.
 * @param after - The closing snapshot.
 * @returns The moved tips.
 */
function listMovedTips(before: RefSnapshot, after: RefSnapshot): MovedTip[] {
  const branches = Object.entries(after.refs).filter(([ref, sha]) => ref.startsWith('refs/heads/') && before.refs[ref] !== sha)
    .map(([ref, sha]) => ({ branch: ref.slice('refs/heads/'.length), before: before.refs[ref], after: sha }))
  const heads = after.worktrees.filter(wt => !wt.branch && wt.head).flatMap(wt => {
    const previous = before.worktrees.find(held => held.root === wt.root)?.head
    return previous === wt.head ? [] : [{ branch: null, before: previous, after: wt.head }]
  })
  return [...branches, ...heads]
}

/**
 * Draws a window's territory from its two snapshots, reading the session's records only when another worktree holds a moved ref.
 * @param port - The engine calls.
 * @param before - The opening snapshot.
 * @param after - The closing snapshot.
 * @returns The commit and push judgements.
 */
export function drawTerritory(port: EnginePort, before: RefSnapshot, after: RefSnapshot): Territory {
  const roots = [before.root, after.root]
  // Held means the same other worktree has the branch checked out at both ends; one created, removed or switched mid-call holds nothing.
  const held = new Set(before.worktrees.filter(wt => wt.branch && !roots.includes(wt.root)
    && after.worktrees.some(next => next.root === wt.root && next.branch === wt.branch)).map(wt => wt.branch))
  const owned = new Set([...before.worktrees, ...after.worktrees].filter(wt => wt.branch && roots.includes(wt.root)).map(wt => wt.branch))
  const scope = once(() => readScope(port))
  const remotes = once(() => readGitOutput(port.processes, ['remote']))
  /**
   * Places a local branch under the session's own worktree, the unit's branch, the default branch or no other worktree's hold.
   * @param branch - The short branch name.
   * @returns Whether the branch is in the territory without its slice.
   */
  const ownsBranch = async (branch: string): Promise<boolean> => {
    const ref = `refs/heads/${branch}`
    if (!held.has(ref) || owned.has(ref)) return true
    const { unitBranch, defaultBranch } = await scope()
    return branch === unitBranch || branch === defaultBranch
  }
  /**
   * Tells whether a moved ref newly reaches a commit of the unit's slice that the mod did not bring into it.
   * @param tip - The moved ref.
   * @param brought - The commits the mod's own placed tips newly reach.
   * @returns Whether it does, or null when the slice cannot be read.
   */
  const carriesSlice = async (tip: MovedTip, brought: Set<string>): Promise<boolean | null> => {
    const { slice } = await scope()
    if (slice.kind !== 'read') return slice.kind === 'none' ? false : null
    if (!slice.commits.size) return false
    const entered = await listNewCommits(port.processes, [tip.after], [slice.base, ...(tip.before ? [tip.before] : [])])
    return entered.some(sha => slice.commits.has(sha) && !brought.has(sha))
  }
  return {
    judgeCommits: async (candidates, beforeTips) => {
      const tips = listMovedTips(before, after)
      // why: a tip spawn or merge_child set for another unit is the mod's own move, whichever session's window it falls in.
      const byMod = await Promise.all(tips.map(tip => tip.branch !== null && isPlaced(port, tip.branch, tip.after)))
      // An unreadable scope costs only the tips that needed it, never the verdicts of the others.
      const placed = await Promise.all(tips.map((tip, index) => byMod[index] ? false : tip.branch === null ? true : ownsBranch(tip.branch).catch(() => null)))
      if (placed.every(verdict => verdict === true)) return { shas: candidates, isUnplaced: false }
      // why: a placed unit branch takes the merged child's commits into the slice, which must not make the child's own branch carry it.
      const brought = new Set((await Promise.all(tips.filter((_tip, index) => byMod[index])
        .map(async tip => await listNewCommits(port.processes, [tip.after], beforeTips)))).flat())
      const judged = new Set<string>()
      const unplaced = new Set<string>()
      for (const [index, tip] of tips.entries()) {
        const reached = (await listNewCommits(port.processes, [tip.after], beforeTips)).filter(sha => candidates.includes(sha))
        const verdict = byMod[index] ? false : !reached.length || placed[index] ? true : placed[index] === null ? null : await carriesSlice(tip, brought).catch(() => null)
        for (const sha of verdict === false ? [] : reached) (verdict ? judged : unplaced).add(sha)
      }
      return { shas: candidates.filter(sha => judged.has(sha)), isUnplaced: [...unplaced].some(sha => !judged.has(sha)) }
    },
    judgesPush: async ref => {
      if (!held.size) return true
      const names = await remotes()
      if (names === null) return null
      const name = ref.slice('refs/remotes/'.length)
      const remote = names.split('\n').filter(entry => entry && name.startsWith(`${entry}/`)).sort((a, b) => b.length - a.length)[0]
      // A tracking ref no configured remote names has no local branch to map to, so it stays judged.
      return remote === undefined || ownsBranch(name.slice(remote.length + 1)).catch(() => null)
    },
  }
}
