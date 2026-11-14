import type { AuditFinding, AuditResult } from '../../types'
import type { Result } from '../lib/result'
import { formatIssueReferences } from './messages'
import { isDecisionIssue, listLabelFamilies } from './issue-fields'
import type { IssuesConfig } from './issue-fields'
import { facts } from './facts'
import type { AuditNote } from './records'

/** An issue's fields as the audit reads them back from GitHub. */
export interface AuditedIssue { number: number; title: string; body: string; labels: string[]; assignees: string[] }

/** What holds the PR step back while the audit is not compliant, and the code that selects the agent's action. */
export interface AuditBlocker { fact: string; detail: string; factCode: 'issues-non-compliant' | 'issue-audit-pending' }

/**
 * Checks that an issue carries exactly one label of a family.
 * @param issue - The audited issue.
 * @param field - The family's name.
 * @param allowed - The family's labels.
 * @returns The finding, or none when exactly one is present.
 */
function auditFamily(issue: AuditedIssue, field: string, allowed: string[]): AuditFinding[] {
  const carried = issue.labels.filter(label => allowed.includes(label))
  return carried.length === 1 ? [] : [{ issue: issue.number, field, expected: `one of ${allowed.join(', ')}`, actual: carried.join(', ') || 'none' }]
}

/**
 * Checks that the body carries every heading of at least one configured kind; a wayfinder decision needs none.
 * @param config - The issues config.
 * @param issue - The audited issue.
 * @returns The finding, or none when one kind's headings are all present.
 */
function auditBody(config: IssuesConfig, issue: AuditedIssue): AuditFinding[] {
  const kinds = Object.entries(config.sections).filter(([, headings]) => headings.length)
  if (!kinds.length || isDecisionIssue(issue.labels)) return []
  const headings = [...issue.body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map(match => match[1] ?? '')
  if (kinds.some(([, required]) => required.every(heading => headings.includes(heading)))) return []
  return [{ issue: issue.number, field: 'body', expected: `the sections of one kind (${kinds.map(([kind]) => kind).join(', ')})`, actual: headings.length ? `sections ${headings.join(', ')}` : 'no sections' }]
}

/**
 * Checks an issue as GitHub holds it against the fields every issue write requires.
 * @param config - The issues config.
 * @param issue - The issue read back.
 * @returns Each field that does not meet the config, with what it expects and what the issue has.
 */
export function auditIssue(config: IssuesConfig, issue: AuditedIssue): AuditFinding[] {
  return [
    ...(isDecisionIssue(issue.labels) || config.title.test(issue.title) ? [] : [{ issue: issue.number, field: 'title', expected: `matches ${config.title.source}`, actual: issue.title }]),
    ...listLabelFamilies(config).flatMap(({ family, allowed }) => auditFamily(issue, family, allowed)),
    ...(issue.assignees.length ? [] : [{ issue: issue.number, field: 'assignee', expected: 'at least one', actual: 'none' }]),
    ...auditBody(config, issue),
  ]
}

/**
 * Lists the issue numbers of findings, each once, in ascending order.
 * @param findings - The audit's findings.
 * @returns The non-compliant issues.
 */
const listNonCompliant = (findings: AuditFinding[]): number[] => [...new Set(findings.map(finding => finding.issue))].sort((a, b) => a - b)

/**
 * Words how the record's result may be stale: the last audit's writes failed, or whether they did cannot be read.
 * @param note - Why the result may be missing from the record.
 * @returns The phrase, with its cause.
 */
const describeNote = (note: AuditNote): string => `${note.kind === 'unrecorded' ? 'not recorded' : 'recording unknown'} (${note.reason})`

/**
 * Words what clears a note: a written result clears one whose writes failed, while one whose recording is unknown waits on the process
 * state, which no audit writes while it cannot be read.
 * @param note - The note.
 * @returns The clause.
 */
const describeNoteClear = (note: AuditNote): string => note.kind === 'unrecorded' ? 'the next turn end\'s audit writes a result and clears this'
  : 'this clears once the process state reads again (see the Process row)'

/**
 * Says what holds the unit's PR step back while the latest audit is not compliant: a finding, an audit that proved nothing, or an
 * audit whose result is not on the record.
 * @param result - The latest audit result on the record, absent before the first audit.
 * @param note - Why the record may lack the last audit's result, if it may.
 * @returns The blocker, or undefined when nothing is held back.
 */
export function describeAuditBlocker(result: AuditResult | undefined, note?: AuditNote): AuditBlocker | undefined {
  if (note) {
    return { fact: note.kind === 'unrecorded' ? facts.auditUnrecorded : facts.auditUnknown, detail: `issue audit ${describeNote(note)}; ${describeNoteClear(note)}`, factCode: 'issue-audit-pending' }
  }
  const findings = result?.state === 'violations' || result?.state === 'pending' ? result.findings ?? [] : []
  const pending = result?.state === 'pending' ? `issue audit pending (${result.reason})` : null
  if (findings.length) {
    const issues = listNonCompliant(findings)
    const detail = `${formatIssueReferences(issues, ', ')} non-compliant — fix with issue_edit${pending ? `; ${pending}` : ''}`
    return { fact: facts.fixIssues(issues.length), detail, factCode: 'issues-non-compliant' }
  }
  return pending ? { fact: facts.auditPending, detail: pending, factCode: 'issue-audit-pending' } : undefined
}

/**
 * Words the audit note the pane shows while the record may lack the last audit's result.
 * @param note - Why it may.
 * @returns The note's text.
 */
export const describeAuditNote = (note: AuditNote): string => `${describeNote(note)}; the result shown may be from an earlier turn`

/**
 * Words the record's result while a turn-end audit runs, so a result written before it never stands as this turn's.
 * @param at - When the audit started, in epoch milliseconds.
 * @returns The pending reason.
 */
export const describeAuditRunning = (at: number): string => `audit running since ${formatUtc(at)}`

/**
 * Words the record's result when a turn-end audit's result could not be written.
 * @param why - Why the write failed.
 * @returns The pending reason.
 */
export const describeAuditUnfinished = (why: string): string => `the audit did not finish (${why}); it runs again at the next turn end`

/**
 * Words the pending reason of an audit that could not read the session's start, with the search to run by hand.
 * @param why - Why the start could not be read.
 * @param repository - The repository's owner/name, or why it could not be read.
 * @param day - The UTC day the unit's flow was declared, or why it could not be read.
 * @returns The pending reason.
 */
export function describeStartUnread(why: string, repository: Result<string>, day: Result<string>): string {
  return `the session start could not be read (${why}), so issues created outside the issue tools were not searched; check with ${describeSearchCheck(repository, day)}`
}

/**
 * Words the note a handoff leaves when neither the session's start nor the unit's declaration could be read, so no later audit searches
 * the window before it, which earlier audits did; it names the search to run by hand and holds nothing back.
 * @param at - Where the searched window starts, the handoff's time, in epoch milliseconds.
 * @param why - Why the session's start could not be read.
 * @param repository - The repository's owner/name, or why it could not be read.
 * @param day - The UTC day the unit's flow was declared, or why it could not be read.
 * @returns The note.
 */
export function describeUnsearchedBefore(at: number, why: string, repository: Result<string>, day: Result<string>): string {
  return `issues created before ${formatUtc(at)} are no longer searched (the session start could not be read: ${why}); check them by hand with ${describeSearchCheck(repository, day)}`
}

/**
 * Words the search by hand for the issues the user's account created since the unit's declaration, with a placeholder, and why, for
 * a repository or a day that could not be read.
 * @param repository - The repository's owner/name, or why it could not be read.
 * @param day - The UTC day the unit's flow was declared, or why it could not be read.
 * @returns The command and its gaps.
 */
function describeSearchCheck(repository: Result<string>, day: Result<string>): string {
  const gaps = [...repository.isOk ? [] : [`the repository could not be read: ${repository.error}`], ...day.isOk ? [] : [`the declaration date could not be read: ${day.error}`]]
  const check = `gh search issues --repo ${repository.isOk ? repository.value : '<this repository>'} --author @me --created ">=${day.isOk ? day.value : "<the date this unit's flow was declared>"}"`
  return `${check}${gaps.length ? ` (${gaps.join('; ')})` : ''}`
}

/**
 * Words an issue tool's answer when its write landed and the audit could not track the issue it wrote.
 * @param outcome - The tool's own outcome.
 * @param issue - The written issue.
 * @param why - Why the tracking write failed.
 * @param repository - The repository's owner/name, or why it could not be read.
 * @returns The answer's text.
 */
export function describeTrackingFailure(outcome: string, issue: number, why: string, repository: Result<string>): string {
  const check = `gh issue view ${issue} --repo ${repository.isOk ? repository.value : '<this repository>'}`
  return `${outcome}, but the issue audit could not record #${issue} (${why}), so the turn-end audit will not re-read it; check its fields with ${check}${repository.isOk ? '' : ` (the repository could not be read: ${repository.error})`}`
}

/**
 * Writes a time as UTC to the second.
 * @param at - The time, in epoch milliseconds.
 * @returns The ISO time without milliseconds.
 */
function formatUtc(at: number): string {
  return new Date(at).toISOString().replace(/\.\d+Z$/, 'Z')
}
