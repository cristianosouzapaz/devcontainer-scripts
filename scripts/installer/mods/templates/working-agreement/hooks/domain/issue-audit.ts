import type { AuditFinding, AuditResult } from '../../types'
import { isDecisionIssue, listLabelFamilies } from './issue-fields'
import type { IssuesConfig } from './issue-fields'
import { facts } from './facts'

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
 * Says what holds the unit's PR step back while the latest audit is not compliant: a finding, or an audit that proved nothing.
 * @param result - The latest audit result, absent before the first audit.
 * @returns The blocker, or undefined when nothing is held back.
 */
export function describeAuditBlocker(result: AuditResult | undefined): AuditBlocker | undefined {
  if (result?.state === 'violations') {
    const issues = listNonCompliant(result.findings)
    return { fact: facts.fixIssues(issues.length), detail: `${issues.map(issue => `#${issue}`).join(', ')} non-compliant — fix with issue_edit`, factCode: 'issues-non-compliant' }
  }
  return result?.state === 'pending' ? { fact: facts.auditPending, detail: `issue audit pending (${result.reason})`, factCode: 'issue-audit-pending' } : undefined
}
