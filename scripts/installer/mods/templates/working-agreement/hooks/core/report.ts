import { listDecisions } from '../domain/delegated-decision'
import { describeSigning } from '../domain/delegated-commits'
import { describeEmptyScope } from '../domain/delegation'
import type { DelegatedCommit } from '../domain/delegated-commits'
import { facts } from '../domain/facts'
import { isUnitFinished } from '../domain/step-states'
import { readGitOutput, runGit } from '../lib/git'
import type { ProcessPort } from '../lib/process'
import { keyedLine } from '../ui/status-text'
import type { KeyLabel } from '../ui/theme'
import { bestEffort } from './best-effort'
import { readNotices } from './coordinator-notice'
import { composeSigningReturn, readDelegatedCommits } from './delegated-commits'
import { readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { readMarkedComments } from '../lib/github'
import { locatePosition } from './position'
import { readDeclaration, readSessionMirrors } from './record-store'
import { readArchives } from './retire'
import { describeLevel, readSpawnStart } from './spawn'
import type { SessionMirror } from './record-store'

const unknown = 'unknown'

/**
 * Lists one issue's facts: its unit's step and Verify result, the unit's delegated commits and merge, the issue's decisions, the notices its unit sent,
 * and each retired unit with its restore command.
 * @param port - The engine calls.
 * @param issue - The issue.
 * @param commits - Every delegated-commit record, or null when they are unreadable.
 * @param mirrors - Every session mirror, or null when they are unreadable.
 * @returns The issue's lines; a fact that cannot be read shows as unknown.
 */
async function reportIssue(port: EnginePort, issue: number, commits: DelegatedCommit[] | null, mirrors: SessionMirror[] | null): Promise<string[]> {
  const record = mirrors?.filter(mirror => mirror.session.unit?.issues.includes(issue))
    .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))[0]?.session
  const unit = record?.unit
  const declaration = unit ? await bestEffort(port, 'report declaration', () => readDeclaration(port, unit), null) : null
  const position = record && unit && declaration
    ? await bestEffort(port, 'report position', () => locatePosition(port, { ...record, flow: declaration.flow, issues: unit.issues }, true), null) : null
  const step = !mirrors ? unknown : !unit ? 'no unit' : !position ? unknown : position.current?.step.label ?? (isUnitFinished(position) ? 'finished' : unknown)
  const shas = unit && commits ? commits.filter(entry => entry.branch === unit.branch).map(entry => entry.sha.slice(0, 7)) : null
  const parent = position?.unit.baseBranch
  const merge = !unit ? 'none' : !position ? unknown : !parent ? 'none' : await describeMerge(port.processes, unit.branch, parent)
  const comments = await readMarkedComments(port.processes, issue)
  const decisions = comments.isOk ? listDecisions(comments.value) : null
  const notices = unit ? await bestEffort(port, 'report notices', async () => (await readNotices(port, unit.branch))?.sent ?? [], null) : []
  const archives = await bestEffort(port, 'report retirements', () => readArchives(port, issue), null)
  const level = await bestEffort(port, 'report level', async () => (await readSpawnStart(port, [issue]))?.level, null)
  return [
    `#${issue}${unit ? ` · ${unit.branch}` : ''}`,
    keyedLine('Step', step),
    ...level === undefined ? [] : [keyedLine('Level', level ? describeLevel(level) : unknown)],
    keyedLine('Verify', position ? position.verify.fact || facts.verifyNotRun : !unit && mirrors ? 'none' : unknown),
    keyedLine('Commits', !unit ? 'none' : !shas ? unknown : shas.join(' ') || 'none'),
    keyedLine('Merge', merge),
    ...listRows('Decision', decisions, entry => `${entry.cost} · ${entry.question} · ${entry.url}`),
    ...listRows('Notice', notices, text => text),
    ...archives ? archives.map(archive => keyedLine('Retired', `${archive.ref} · resume: ${archive.restore}${archive.reclaim ? ` · reclaim: ${archive.reclaim}` : ''}`)) : [keyedLine('Retired', unknown)],
  ]
}

/**
 * Words whether a unit's branch is merged into its parent: a branch inside its parent counts as merged only when its reflog proves it
 * moved past the commit it was cut at, since a branch with no commit since its cut is inside its parent too.
 * @param processes - The engine's process runner.
 * @param branch - The unit's branch.
 * @param parent - The branch it was cut from.
 * @returns `into <parent>`, `none`, `none (no commits since the cut)`, or the unknown state with how to check it.
 */
async function describeMerge(processes: ProcessPort, branch: string, parent: string): Promise<string> {
  const unproven = `merge state unknown (branch history unavailable); check with git log ${parent}..${branch}`
  // why: --is-ancestor exits 1 for a branch outside its parent; any other failure says nothing either way.
  const ancestry = await runGit(processes, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${parent}`]).catch(() => null)
  if (ancestry?.exitCode === 1) return 'none'
  if (ancestry?.exitCode !== 0) return unproven
  const reflog = await readGitOutput(processes, ['log', '--walk-reflogs', '--format=%H%x09%gs', `refs/heads/${branch}`, '--'])
  const tip = await readGitOutput(processes, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  // why: only the creation entry names the cut; an expired or rewritten reflog's oldest entry is some later move.
  const cut = /^(\S+)\tbranch: Created from \S/.exec(reflog?.split('\n').at(-1) ?? '')?.[1]
  if (!tip || !cut) return unproven
  return tip === cut ? 'none (no commits since the cut)' : `into ${parent}`
}

/**
 * Words a list of facts as one keyed row each, `none` for an empty list and unknown for an unreadable one.
 * @param key - The rows' key.
 * @param values - The facts, or null when they could not be read.
 * @param render - Words one fact.
 * @returns The rows.
 */
function listRows<T>(key: KeyLabel, values: T[] | null, render: (value: T) => string): string[] {
  if (!values) return [keyedLine(key, unknown)]
  return values.length ? values.map(value => keyedLine(key, render(value))) : [keyedLine(key, 'none')]
}

/**
 * Gathers, for each issue this coordinator delegates in number order, the facts of its unit and decisions, then the signing commands.
 * @param port - The engine calls.
 * @returns The report, the same text for the same records.
 */
export async function composeReport(port: EnginePort): Promise<string> {
  const scope = await bestEffort(port, 'report scope', () => readOwnScope(port), undefined)
  const commits = await bestEffort(port, 'report commits', () => readDelegatedCommits(port), null)
  const mirrors = await bestEffort(port, 'report mirrors', () => readSessionMirrors(port), null)
  const issues = scope === undefined ? null : [...scope?.issues ?? []].sort((a, b) => a - b)
  const sections = issues === null ? [`Delegated issues: ${unknown}`] : issues.length
    ? await Promise.all(issues.map(async issue => (await reportIssue(port, issue, commits, mirrors)).join('\n')))
    : [describeEmptyScope(scope)]
  const signing = await bestEffort(port, 'signing plan', () => composeSigningReturn(port), undefined)
  return `${sections.join('\n\n')}${signing === undefined ? `\n\nSigning: ${unknown}` : describeSigning(signing)}`
}
