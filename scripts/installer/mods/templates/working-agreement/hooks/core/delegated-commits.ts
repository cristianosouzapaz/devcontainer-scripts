import { findDeniedWord, isGitCommit, listScriptCandidates } from '../domain/bash-guards'
import { composeSigningCommands, parseDelegatedCommit } from '../domain/delegated-commits'
import type { DelegatedCommit, SigningBranch } from '../domain/delegated-commits'
import { markForAgent } from '../domain/messages'
import type { Identity } from '../domain/records'
import { hashObject, isAncestor, readDefaultRef, readGitOutput, readParentBranch, readWorktrees, runGit } from '../lib/git'
import { readBranchRulesets } from '../lib/github'
import { readJson } from '../lib/json'
import type { ProcessOutput } from '../lib/process'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { findDelegation, findLiveDelegation } from './delegation'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { atomicReplace, listRecordNames, readCommonDir, readSession, recordsPath } from './record-store'
import { readGit } from './repository'
import type { RefSnapshot } from './territory'

// why: Any unit session writes here and the coordinator reads every unit's records, so they live under the common directory;
// one file per change key means two writers never share a file.
const bucket = 'delegated'

/**
 * Reads the unit of this session when a coordinator delegates it.
 * @param port - The engine calls.
 * @param isLiveOnly - Whether a scope whose coordinator is gone or cannot be judged delegates nothing, as for what delegation grants;
 * a guard passes false, so it holds until the scope is stopped.
 * @returns The unit, or null for a coordinator, a session without a unit or one no scope delegates.
 */
export async function readDelegatedUnit(port: EnginePort, isLiveOnly = true): Promise<Identity | null> {
  const session = await readSession(port)
  if (!session.unit || session.role) return null
  return await (isLiveOnly ? findLiveDelegation : findDelegation)(port, session.unit.issues, true) ? session.unit : null
}

/**
 * Keys a commit by its change, which a rebase that keeps the parent's content keeps too.
 * @param port - The engine calls.
 * @param sha - The commit.
 * @returns The key, or null when the change cannot be read.
 */
async function readChangeKey(port: EnginePort, sha: string): Promise<string | null> {
  // why: -m diffs a merge against each parent, which the user's re-signed merge keeps; a plain commit's diff is unchanged.
  const diff = await readGitOutput(port.processes, ['diff-tree', '-r', '--no-commit-id', '-m', sha])
  if (diff === null) return null
  const run = await hashObject(port.processes, diff)
  return run.exitCode === 0 && run.stdout.trim() ? run.stdout.trim() : null
}

/**
 * Reads which commits carry no signature.
 * @param port - The engine calls.
 * @param shas - The commits.
 * @returns The unsigned ones, or null when git cannot tell.
 */
async function readUnsigned(port: EnginePort, shas: string[]): Promise<string[] | null> {
  const marks = await readGitOutput(port.processes, ['log', '--no-walk', '--format=%H:%G?', ...shas])
  if (marks === null) return null
  const unsigned = new Set(marks.split('\n').filter(line => line.endsWith(':N')).map(line => line.slice(0, line.indexOf(':'))))
  return shas.filter(sha => unsigned.has(sha))
}

/**
 * Reads every delegated-commit record of the repository; an unreadable one is skipped.
 * @param port - The engine calls.
 * @returns The records, or null when the records directory exists but cannot be listed.
 */
export async function readDelegatedCommits(port: EnginePort): Promise<DelegatedCommit[] | null> {
  const common = await readCommonDir(port)
  if (!common) return []
  const directory = recordsPath(common, bucket)
  const names = await listRecordNames(port, directory).catch(() => null)
  if (!names) return null
  const records = await Promise.all(names.filter(name => name.endsWith('.json'))
    .map(async name => parseDelegatedCommit(await readJson(port.files, recordsPath(common, bucket, name)).catch(() => undefined))))
  return records.filter((record): record is DelegatedCommit => record !== null)
}

/**
 * Names the first script file a command runs through an interpreter that the repository does not track.
 * Known gaps of this accident guard: a script piped to an interpreter's stdin, an untracked file executed directly, a tracked script
 * edited to carry denied words, and a script only staged with git add, which ls-files already counts as tracked.
 * @param port - The engine calls.
 * @param command - The raw Bash command.
 * @returns The script's path, or undefined when every script it runs is tracked.
 */
async function findUntrackedScript(port: EnginePort, command: string): Promise<string | undefined> {
  const cwd = await port.readCwd()
  for (const candidates of listScriptCandidates(command)) {
    for (const candidate of candidates) {
      const path = candidate.startsWith('/') ? candidate : `${cwd}/${candidate}`
      if ((await port.files.stat(path).catch(() => null))?.kind !== 'file') continue
      if ((await runGit(port.processes, ['-C', cwd, 'ls-files', '--error-unmatch', '--', path])).exitCode !== 0) return candidate
      break
    }
  }
  return undefined
}

/**
 * Refuses, in a delegated unit session, a command that names a word able to move another ref or runs an untracked script; other sessions are not checked.
 * @param port - The engine calls.
 * @param command - The raw Bash command.
 * @returns The deny reason, or undefined when the command may run.
 */
export async function denyDelegatedCommand(port: EnginePort, command: string): Promise<string | undefined> {
  // why: an unreadable session or scope could hide a delegated unit, so the word guard then applies as if it were one.
  if (!await readDelegatedUnit(port, false).catch(() => true)) return undefined
  if (isGitCommit(command)) return markForAgent('Under delegation a Bash git commit is refused before it runs: stage the work with git add, then commit it with the commit tool, '
    + 'which commits unsigned on this unit\'s branch and records it as delegated.')
  const aliases = await runGit(port.processes, ['config', '--get-regexp', '^alias\\.'])
  // git config exits 1 when no alias is set.
  const names = aliases.exitCode === 0 ? aliases.stdout.split('\n').filter(Boolean).map(line => line.split(' ')[0]?.slice('alias.'.length) ?? '')
    : aliases.exitCode === 1 ? [] : null
  const word = findDeniedWord(command, names)
  const script = word === undefined ? await findUntrackedScript(port, command) : undefined
  if (script) return markForAgent(`Under delegation running an untracked script is refused before it runs (${script}): the word guard cannot read a file's contents. `
    + 'Run its commands directly, or a script tracked in the repository; a commit goes through the commit tool.')
  return word === undefined ? undefined : markForAgent(`Under delegation this command is refused before it runs (it names ${word}): `
    + 'a delegated unit only commits on its own branch; pushes, merges, rebases, ref rewrites and PR writes are the user\'s on their return. '
    + 'A commit message that names one of these words goes through the commit tool.')
}

/**
 * Runs a git command that writes a commit, unsigned.
 * @param port - The engine calls.
 * @param command - The git arguments up to the subcommand.
 * @param rest - The arguments after it.
 * @param stdin - Optional standard input.
 * @returns The unmodified process output.
 */
export function runUnsignedGit(port: EnginePort, command: string[], rest: string[], stdin?: string): Promise<ProcessOutput> {
  // why: A delegated commit stays unsigned whatever commit.gpgsign says; the user's re-sign signs it on their return.
  return runGit(port.processes, [...command, '--no-gpg-sign', ...rest], stdin)
}

/**
 * Commits the staged work of a delegated unit, unsigned, on its own branch checked out in this session's worktree, and records it as delegated.
 * It runs in the hook process, so no Bash permission rule decides whether it runs.
 * @param port - The engine calls.
 * @param message - The commit message.
 * @returns What was committed, or the refusal.
 */
export async function commitDelegated(port: EnginePort, message: string): Promise<Result<string>> {
  const unit = await readDelegatedUnit(port).catch(() => null)
  if (!unit) return fail('only a delegated unit commits through this tool; elsewhere commits are the user\'s.')
  const elsewhere = await refuseOtherCheckout(port, unit.branch)
  if (elsewhere) return fail(elsewhere)
  const run = await runUnsignedGit(port, ['commit'], ['-F', '-'], message)
  if (run.exitCode !== 0) return fail(`git commit failed — stage the work with git add first: ${`${run.stdout}\n${run.stderr}`.trim()}`)
  const sha = await recordHead(port, unit.branch, 'a commit')
  if (!sha.isOk) return sha
  logEvent(port, await readSession(port), 'delegated-commit', { shas: sha.value })
  return succeed(`Committed ${sha.value} on ${unit.branch}, unsigned and recorded as delegated; the user signs and pushes it on their return.`)
}

/**
 * Refuses a delegated unit's write unless its own branch is checked out in this session's worktree.
 * @param port - The engine calls.
 * @param branch - The unit's branch.
 * @returns The refusal, or null when the branch is checked out here.
 */
export async function refuseOtherCheckout(port: EnginePort, branch: string): Promise<string | null> {
  return await readGitOutput(port.processes, ['symbolic-ref', '-q', 'HEAD']) === `refs/heads/${branch}` ? null : `this worktree does not have the unit's branch ${branch} checked out.`
}

/**
 * Records the commit a delegated unit's write just made at HEAD as delegated.
 * @param port - The engine calls.
 * @param branch - The unit's branch.
 * @param made - The commit as the refusal names it, such as `a commit`.
 * @returns The commit's id, or the refusal when it cannot be read or recorded.
 */
export async function recordHead(port: EnginePort, branch: string, made: string): Promise<Result<string>> {
  const sha = await readGitOutput(port.processes, ['rev-parse', 'HEAD'])
  return sha && await recordDelegated(port, [sha], branch) ? succeed(sha) : fail(`${made} was made on ${branch} but is not recorded as delegated — tell the user.`)
}

/**
 * Claims a window's new commits as delegated when a delegated unit made them unsigned on its own branch, recording each by its change.
 * The window qualifies only when the unit's branch is the sole moved ref and stays checked out in this session's worktree.
 * @param port - The engine calls.
 * @param before - The opening refs.
 * @param after - The closing refs.
 * @param shas - The window's judged commits.
 * @returns The claimed commits, all of them or none.
 */
export async function claimDelegatedCommits(port: EnginePort, before: RefSnapshot, after: RefSnapshot, shas: string[]): Promise<string[]> {
  if (!shas.length) return []
  // why: an unread scope claims nothing, so the commits stay judged as any session's.
  const unit = await readDelegatedUnit(port, true).catch(() => null)
  if (!unit) return []
  const ref = `refs/heads/${unit.branch}`
  const moved = [...new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])].filter(name => before.refs[name] !== after.refs[name])
  const isHeld = (snapshot: RefSnapshot): boolean => snapshot.worktrees.some(wt => wt.root === snapshot.root && wt.branch === ref)
  const isDetachedMoved = after.worktrees.some(wt => !wt.branch && before.worktrees.find(held => held.root === wt.root)?.head !== wt.head)
  if (moved.length !== 1 || moved[0] !== ref || !isHeld(before) || !isHeld(after) || isDetachedMoved) return []
  if (!await recordDelegated(port, shas, unit.branch)) return []
  logEvent(port, await readSession(port), 'delegated-commit', { shas: shas.join(' ') })
  return shas
}

/**
 * Records unsigned commits as delegated on a branch, each by its change, all of them or none.
 * @param port - The engine calls.
 * @param shas - The commits.
 * @param branch - The branch they were made on.
 * @returns Whether every commit was recorded; a signed commit or an unreadable change records none.
 */
export async function recordDelegated(port: EnginePort, shas: string[], branch: string): Promise<boolean> {
  const common = await readCommonDir(port)
  if (!common || (await readUnsigned(port, shas))?.length !== shas.length) return false
  const records = await Promise.all(shas.map(async sha => ({ sha, key: await readChangeKey(port, sha) })))
  if (records.some(record => record.key === null)) return false
  for (const { sha, key } of records) await atomicReplace(port, recordsPath(common, bucket, `${key}.json`), JSON.stringify({ v: 1, key, sha, branch }))
  return true
}

/**
 * Finds, after the user's re-sign, the commit that replaced a delegated commit a unit's recorded base names.
 * @param port - The engine calls.
 * @param base - The recorded base, no longer in the branch's history.
 * @param tip - The branch tip.
 * @returns The replacing commit, or null when the base was no delegated commit or no commit carries its change.
 */
export async function remapDelegatedBase(port: EnginePort, base: string, tip: string): Promise<string | null> {
  const record = (await readDelegatedCommits(port))?.find(entry => entry.sha === base)
  if (!record) return null
  const commits = await readGitOutput(port.processes, ['rev-list', tip, '--not', base])
  for (const sha of commits?.split('\n').filter(Boolean) ?? []) if (await readChangeKey(port, sha) === record.key) return sha
  return null
}

/**
 * Composes the commands that sign and push every branch still holding unsigned delegated commits, parent chains in order.
 * @param port - The engine calls.
 * @returns The commands, empty when nothing is left to sign.
 */
export async function composeSigningReturn(port: EnginePort): Promise<string[]> {
  const git = await readGit(port)
  const worktrees = await readWorktrees(port.processes)
  if (!git || !worktrees) return []
  const defaultRef = await readDefaultRef(port.processes, git.base)
  const records = await readDelegatedCommits(port) ?? []
  const recorded = new Set(records.map(record => record.sha))
  const named = [...new Set(records.map(record => record.branch))]
  // why: A parent that merged a child, even by fast-forward, carries the child's unsigned commits without a record of its own.
  const parentOf = new Map(await Promise.all(named.map(async branch => [branch, await readParentBranch(port.processes, branch, git.base)] as const)))
  const pending = await Promise.all([...new Set([...named, ...[...parentOf.values()].filter(parent => parent !== null)])].map(async branch => {
    const history = await readGitOutput(port.processes, ['rev-list', `refs/heads/${branch}`, '--not', defaultRef])
    const held = history?.split('\n').filter(sha => recorded.has(sha)) ?? []
    const isUnsigned = held.length > 0 && !!(await readUnsigned(port, held))?.length
    return isUnsigned ? { branch, root: worktrees.find(wt => wt.branch === `refs/heads/${branch}`)?.root ?? null } : null
  }))
  const signing = pending.filter(entry => entry !== null)
  const names = signing.map(entry => entry.branch)
  const branches = await Promise.all(signing.map(async (entry): Promise<SigningBranch> => {
    const parent = parentOf.has(entry.branch) ? parentOf.get(entry.branch) : await readParentBranch(port.processes, entry.branch, git.base)
    if (!parent || !names.includes(parent)) return { ...entry, parent: null, isMerged: false }
    return { ...entry, parent, isMerged: await isAncestor(port.processes, entry.branch, parent) }
  }))
  return composeSigningCommands(branches, git.base)
}

/**
 * Tells whether a GitHub ruleset on the default branch requires signed commits, so an unsigned push would be refused.
 * @param port - The engine calls.
 * @returns Whether pushes are guarded; an unreadable answer counts as unguarded.
 */
export async function readPushGuard(port: EnginePort): Promise<boolean> {
  const git = await readGit(port)
  if (!git) return false
  const rulesets = await readBranchRulesets(port.processes, git.base)
  return rulesets.isOk && rulesets.value.some(ruleset => ruleset.types.includes('required_signatures'))
}
