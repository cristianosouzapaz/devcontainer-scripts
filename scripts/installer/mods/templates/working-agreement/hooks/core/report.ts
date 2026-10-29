import { listDecisions } from '../domain/delegated-decision'
import { describeSigning } from '../domain/delegated-commits'
import type { DelegatedCommit } from '../domain/delegated-commits'
import { isUnitFinished } from '../domain/step-states'
import { isAncestor } from '../lib/git'
import { keyedLine } from '../ui/status-text'
import { bestEffort } from './best-effort'
import { composeSigningReturn, readDelegatedCommits } from './delegated-commits'
import { readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { readMarkedComments } from '../lib/github'
import { locatePosition } from './position'
import { readDeclaration, readSessionMirrors } from './record-store'
import type { SessionMirror } from './record-store'

const unknown = 'unknown'

/**
 * Lists one issue's facts: its unit's step and Verify result, the unit's delegated commits and merge, and the issue's decisions.
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
  const merge = !unit ? 'none' : !position ? unknown : !parent ? 'none'
    : await isAncestor(port.processes, `refs/heads/${unit.branch}`, `refs/heads/${parent}`) ? `into ${parent}` : 'none'
  const comments = await readMarkedComments(port.processes, issue)
  const decisions = comments.isOk ? listDecisions(comments.value) : null
  return [
    `#${issue}${unit ? ` · ${unit.branch}` : ''}`,
    keyedLine('Step', step),
    keyedLine('Verify', position ? position.verify.fact || unknown : !unit && mirrors ? 'none' : unknown),
    keyedLine('Commits', !unit ? 'none' : !shas ? unknown : shas.join(' ') || 'none'),
    keyedLine('Merge', merge),
    ...decisions ? decisions.length ? decisions.map(entry => keyedLine('Decision', `${entry.cost} · ${entry.question} · ${entry.url}`)) : [keyedLine('Decision', 'none')]
      : [keyedLine('Decision', unknown)],
  ]
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
    : ['This coordinator delegates no issue.']
  const signing = await bestEffort(port, 'signing commands', () => composeSigningReturn(port), null)
  return `${sections.join('\n\n')}${signing ? describeSigning(signing) : `\n\nSigning commands: ${unknown}`}`
}
