import type { DelegationScope, FlowView, GithubFailure } from '../../types'
import type { KeyedRow } from './theme'
import type { Session } from '../domain/records'
import { formatLocalTime } from '../lib/time'
import { firstLineOf } from '../lib/result'
import { formatStepLabel, isUnitFinished, listDeclaredLabels, markStep, projectDisplayStates } from '../domain/step-states'
import type { Position } from '../domain/step-states'
import { facts } from '../domain/facts'
import { describeAuditNote } from '../domain/issue-audit'
import { symbol } from './symbols'
import { pluralize } from '../domain/messages'

/** Holds the user's open questions, the answers not yet recorded on their issues, the dead letters, and those whose notice was not delivered. */
interface InboxCounts { open: number; unrecorded: number; deadLetters: number; untold: number }

/**
 * Lists issue numbers, a run of three or more consecutive ones as a range, so a wide scope stays a few pane lines.
 * @param issues - The issue numbers, ascending.
 * @returns The numbers, `#<first>–#<last>` for a run.
 */
function formatIssueRanges(issues: number[]): string {
  const runs = issues.reduce<number[][]>((found, issue) => {
    const last = found.at(-1)
    return last && last.at(-1) === issue - 1 ? [...found.slice(0, -1), [...last, issue]] : [...found, [issue]]
  }, [])
  return runs.flatMap(run => run.length >= 3 ? [`#${run[0]}–#${run.at(-1)}`] : run.map(issue => `#${issue}`)).join(' ')
}

/**
 * Words a coordinator's scope as its pane rows: what it delegates, then the issues whose triage it handed over.
 * @param scope - The coordinator's scope.
 * @returns The Delegating row, and a Triage row while triage is handed over.
 */
export function scopeRows(scope: DelegationScope): KeyedRow[] {
  const value = [formatIssueRanges(scope.issues), scope.coversCreated ? 'issues it creates' : '', scope.isPushUnguarded ? 'no signed-commit ruleset' : ''].filter(Boolean).join(' · ')
  return [{ key: 'Delegating', value, tone: 'text' },
    ...scope.triage?.length ? [{ key: 'Triage' as const, value: formatIssueRanges(scope.triage), tone: 'text' as const }] : []]
}

/**
 * Words a coordinator's inbox row: the questions waiting for the user, which never expire, the issue comments not yet recorded, and the
 * messages about its issues dead-lettered to the user, marking those whose notice was not delivered.
 * @param counts - The open questions, the unrecorded comments, the dead letters and those with an undelivered notice.
 * @returns The Inbox row.
 */
export function inboxRow(counts: InboxCounts): KeyedRow {
  const value = [`${pluralize(counts.open, 'open question')} for you`, ...counts.open ? ['/flow inbox'] : [],
    ...counts.unrecorded ? [`${counts.unrecorded} not recorded on the issue`] : [], ...counts.deadLetters ? [pluralize(counts.deadLetters, 'dead letter')] : [],
    ...counts.untold ? [`${counts.untold} with a notice not delivered · /flow status`] : []].join(' · ')
  return { key: 'Inbox', value, tone: counts.open || counts.unrecorded || counts.deadLetters ? 'warn' : 'text' }
}

/**
 * Keeps handoff failures visible even when carry-over left no declared unit.
 * @param session - The current session.
 * @returns The failure note, or no notes after success.
 */
export function handoffNotes(session: Session): KeyedRow[] {
  return session.handoff?.state === 'failed' ? [{ key: 'Handoff', value: `not completed · ${session.handoff.reason}`, tone: 'error' }] : []
}

/**
 * Lists every finding of the session's issue audit, or why the audit is pending, so a non-compliant issue is never hidden; while the
 * record may lack the last audit's result, a note says so above what the record holds.
 * @param session - The current session.
 * @returns One note per finding, one for a pending audit, which keeps the findings it established, one for a result not on the record,
 * one for a window a handoff left unsearched, or none.
 */
export function auditNotes(session: Session): KeyedRow[] {
  const result = session.audit?.result
  const unrecorded: KeyedRow[] = session.auditNote ? [{ key: 'Issue audit', value: describeAuditNote(session.auditNote), tone: 'error' }] : []
  // why: the unsearched window is told, never held: no later read can search it, so it names the search to run by hand instead.
  const unsearched: KeyedRow[] = session.audit?.unsearched ? [{ key: 'Issue audit', value: session.audit.unsearched, tone: 'warn' }] : []
  const pending: KeyedRow[] = result?.state === 'pending' ? [{ key: 'Issue audit', value: `pending · ${result.reason}`, tone: 'warn' }] : []
  const findings = result?.state === 'violations' || result?.state === 'pending' ? result.findings ?? [] : []
  return [...unrecorded, ...unsearched, ...pending,
    ...findings.map((finding): KeyedRow => ({ key: `Issue #${finding.issue}`, value: `${finding.field}: expected ${finding.expected}, has ${finding.actual}`, tone: 'error' }))]
}

/**
 * Words a GitHub failure for the pane's GitHub row, in the phrase `/flow status` uses.
 * @param failure - The failure.
 * @returns The row's text: the reason's first line, as the row is one line of the pane, and the time of the kept issue facts when known.
 */
function formatGithubFailure(failure: GithubFailure): string {
  return `read failed (${firstLineOf(failure.reason)})${failure.readAt === null ? '' : ` · facts from ${formatLocalTime(failure.readAt, false)}`}`
}

/**
 * Builds what the Flow pane shows for the session's unit.
 *
 * @param session - The session.
 * @param position - The unit's position.
 * @param githubFailure - Why the latest GitHub read failed, null while GitHub answers.
 * @param isTreeChanged - Whether the last Verify run changed the tree and so left no record.
 * @returns The pane's view.
 */
export function buildView(session: Session, position: Position, githubFailure: GithubFailure | null, isTreeChanged: boolean): FlowView {
  const meta: KeyedRow[] = []
  const notes: KeyedRow[] = []
  if (session.unit || position.git) {
    const state = position.slice?.isRewritten ? { suffix: 'rewritten', tone: 'error' as const }
      : position.integration?.state === 'unknown-end' || position.integration?.state === 'deleted-unmerged' ? { suffix: 'deleted', tone: 'warn' as const }
      : position.slice?.isFrozen ? { suffix: 'frozen', tone: 'inactive' as const } : { tone: 'text' as const }
    meta.push({ key: 'Branch', value: session.unit?.branch ?? position.git?.branch ?? '', ...state })
  }
  if (session.unit && position.git && session.unit.branch !== position.git.branch) {
    notes.push({ key: 'Checkout', value: `${position.git.branch}, not this unit's branch`, tone: 'warn' })
  }
  if (githubFailure) meta.push({ key: 'GitHub', value: formatGithubFailure(githubFailure), tone: 'warn' })
  const { edits } = session.blocked
  if (edits) {
    notes.push({ key: 'Blocked', value: pluralize(edits, 'edit'), tone: 'error' })
  }
  const merge = position.current?.step.observe === 'integrated' && position.integration?.state === 'pending' ? position.integration.command : undefined
  if (merge) notes.push({ key: 'Merge', value: merge, tone: 'text' })
  // why: a queued call waits only for another session's call or for CI, so nobody has to act and it keeps the plain tone.
  if (position.verify.queued) notes.push({ key: 'Queue', value: position.verify.queued.pane, tone: 'text' })
  // why: the approval is the user's, in their own terminal, so the note names the command and warns once the unit waits for it.
  if (position.verify.approval) notes.push({ key: 'Approve', value: position.verify.approval, tone: position.verify.isWaitingApproval && !position.isWorking ? 'warn' : 'text' })
  notes.push(...handoffNotes(session), ...auditNotes(session))
  const isFinished = !position.slice?.isRewritten && isUnitFinished(position)
  const states = projectDisplayStates(position.states)
  // why: every step before the current one is settled and none after it has been reached, so the current index counts the settled steps.
  const currentIndex = states.findIndex(entry => entry.state === 'current')
  const settled = currentIndex >= 0 ? currentIndex : states.filter(entry => entry.state !== 'pending').length
  return {
    flow: position.flow.label,
    progress: `${settled}/${states.length}`,
    issues: session.issues.map(issueNumber => {
      const info = session.info[issueNumber]
      return info && 'title' in info ? { number: issueNumber, title: info.title, url: info.url ?? '' } : { number: issueNumber, title: '', url: '' }
    }),
    pending: !session.issues.length && position.flow.issue === 'produced' ? 'issue not yet created' : null,
    meta,
    labels: listDeclaredLabels(session),
    steps: states.map(entry => {
      const { mark, isMerged, isFailed, isRunUnrecorded, isRewritten } = markStep(entry, position, isTreeChanged)
      const isCurrentFact = !isRewritten && !isRunUnrecorded && !isMerged && entry.state === 'current'
      return {
        id: entry.step.id,
        symbol: symbol[mark],
        label: formatStepLabel(entry.step, position.pullRequest),
        state: entry.state,
        isError: isFailed,
        isMerged,
        isRewritten,
        detail: isRewritten ? undefined : isRunUnrecorded ? facts.verifyTreeChangedInRun : isMerged ? (entry.step.observe === 'integrated' ? entry.fact : facts.merged)
          : entry.state === 'skipped' ? entry.reason
          : entry.state === 'current' ? entry.fact
          // why: an integrated child's Integrate names where its delivery stands, because the unit is finished and shows no current step.
          : entry.state === 'done' && entry.step.observe === 'integrated' ? entry.fact
          // why: a Verify done with nothing run locally passed on no command, so it keeps saying its checks were left to CI.
          : entry.state === 'done' && entry.fact === facts.leftToCi ? entry.fact : undefined,
        ...(entry.detail && (isCurrentFact || (!isRewritten && entry.state === 'skipped') || (entry.state === 'done' && entry.step.observe === 'integrated')) ? { fullDetail: entry.detail } : {}),
      }
    }),
    notes,
    footer: isFinished || session.isLong || session.handoff
      ? { action: session.handoff?.state === 'running' ? 'continue' : isFinished ? 'start' : 'continue', isRunning: session.handoff?.state === 'running' }
      : null,
  }
}
