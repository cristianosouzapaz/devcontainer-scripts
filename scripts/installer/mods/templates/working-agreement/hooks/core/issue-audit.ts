import type { AuditFinding, AuditResult } from '../../types'
import { auditIssue } from '../domain/issue-audit'
import type { AuditedIssue } from '../domain/issue-audit'
import { isRecord, isStringArray } from '../lib/guards'
import { parseJson, toStringOrEmpty } from '../lib/json'
import type { ProcessPort } from '../lib/process'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { runGh } from '../lib/github'
import type { EnginePort } from './engine-port'
import { readIssuesConfig } from './issue-write'
import { readSession, updateSession } from './record-store'
import { withRecordLock } from './session-memory'

/** When this process's session started; the record keeps it from the first audit write, so a resumed session keeps its window. */
interface AuditWindow { startedAt: number | null }

const auditWindow: AuditWindow = { startedAt: null }

/**
 * Opens the session's audit window at its start, without writing the record: startup leaves a mirror it cannot read untouched.
 * @param port - The engine calls.
 * @returns Once the start is held.
 */
export async function openAuditWindow(port: EnginePort): Promise<void> {
  auditWindow.startedAt = await port.now()
}

/**
 * Names when the audit window opened: on record, else at this process's session start, else now.
 * @param port - The engine calls.
 * @param recorded - The window on record, if any.
 * @returns The window's start, in epoch milliseconds.
 */
const readWindowStart = async (port: EnginePort, recorded: number | undefined): Promise<number> => recorded ?? auditWindow.startedAt ?? await port.now()

/**
 * Adds an issue an issue tool wrote to the ones the audit re-reads.
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns Once the issue is on record.
 */
export async function trackIssue(port: EnginePort, issue: number): Promise<void> {
  const since = await readWindowStart(port, undefined)
  await withRecordLock(() => updateSession(port, session => {
    const audit = session.audit ?? { since, issues: [] }
    return audit.issues.includes(issue) ? null : { ...session, audit: { ...audit, issues: [...audit.issues, issue] } }
  }))
}

/**
 * Finds the issues the user's account opened since the window opened whose body references one of the unit's issues,
 * the trace of a write that bypassed the issue tools.
 * @param processes - The engine's process runner.
 * @param since - When the window opened, in epoch milliseconds.
 * @param referenced - The unit's issues.
 * @returns The issue numbers, or the read failure.
 */
async function findAuthored(processes: ProcessPort, since: number, referenced: number[]): Promise<Result<number[]>> {
  if (!referenced.length) return succeed([])
  const created = new Date(since).toISOString().replace(/\.\d+Z$/, 'Z')
  // why: search reads the creation date and the author, which the issues endpoint cannot filter on; gh fills {owner}/{repo} in the endpoint.
  const query = `repo:{owner}/{repo} is:issue author:@me created:>=${created}`
  const listed = await runGh(processes, ['api', `search/issues?per_page=100&q=${encodeURIComponent(query).replace(/%7B/g, '{').replace(/%7D/g, '}')}`,
    '--jq', `.items[] | select((.body // "") | test("#(${referenced.join('|')})\\b")) | .number`])
  return listed.isOk ? succeed(listed.value.split('\n').filter(Boolean).map(Number)) : fail(`cannot list the issues opened this session: ${listed.error}`)
}

/**
 * Reads back the fields the audit checks.
 * @param processes - The engine's process runner.
 * @param issue - The issue number.
 * @returns The issue, or the read failure.
 */
async function readAuditedIssue(processes: ProcessPort, issue: number): Promise<Result<AuditedIssue>> {
  const viewed = await runGh(processes, ['api', `repos/{owner}/{repo}/issues/${issue}`, '--jq', '{title, body, labels: [.labels[].name], assignees: [.assignees[].login]}'])
  const data = viewed.isOk ? parseJson(viewed.value) : viewed
  if (!data.isOk) return fail(`cannot read #${issue}: ${data.error}`)
  if (!isRecord(data.value) || !isStringArray(data.value.labels) || !isStringArray(data.value.assignees)) return fail(`cannot read #${issue}: unreadable gh output`)
  return succeed({ number: issue, title: toStringOrEmpty(data.value.title), body: toStringOrEmpty(data.value.body), labels: data.value.labels, assignees: data.value.assignees })
}

/**
 * Re-reads every issue the session wrote, through the issue tools or around them, and checks it against the issues config.
 * @param port - The engine calls.
 * @param tracked - The issues the issue tools wrote.
 * @param referenced - The unit's issues, which a bypassing write references.
 * @param since - When the window opened.
 * @returns The audit's result, pending on any failed read; undefined when the session wrote no issue.
 */
async function auditSession(port: EnginePort, tracked: number[], referenced: number[], since: number): Promise<AuditResult | undefined> {
  const authored = await findAuthored(port.processes, since, referenced)
  if (!authored.isOk) return { state: 'pending', reason: authored.error }
  const issues = [...new Set([...tracked, ...authored.value])].sort((a, b) => a - b)
  if (!issues.length) return undefined
  const config = await readIssuesConfig(port)
  if (!config.isOk) return { state: 'pending', reason: config.error }
  const findings: AuditFinding[] = []
  for (const issue of issues) {
    const read = await readAuditedIssue(port.processes, issue)
    if (!read.isOk) return { state: 'pending', reason: read.error }
    findings.push(...auditIssue(config.value, read.value))
  }
  return findings.length ? { state: 'violations', findings } : { state: 'compliant' }
}

/**
 * Audits the session's issues and records the result, so the pane lists every finding and the PR step waits on them.
 * @param port - The engine calls.
 * @returns Once the result is on record.
 */
export async function runIssueAudit(port: EnginePort): Promise<void> {
  const session = await readSession(port)
  const since = await readWindowStart(port, session.audit?.since)
  const result = await auditSession(port, session.audit?.issues ?? [], session.issues, since)
  await withRecordLock(() => updateSession(port, current => {
    const audit = current.audit ?? { since, issues: [] }
    const { result: previous, ...rest } = audit
    if (JSON.stringify(previous) === JSON.stringify(result)) return null
    return { ...current, audit: result ? { ...rest, result } : rest }
  }))
}
