import type { FlowRow, FlowView, GithubFailure } from '../../types'
import type { Session } from '../domain/records'
import { formatLocalTime } from '../lib/time'
import { formatStepLabel, isUnitFinished, listDeclaredLabels, markStep, projectDisplayStates } from '../domain/step-states'
import type { Position } from '../domain/step-states'
import { facts } from '../domain/facts'
import { symbol } from './symbols'

/**
 * Counts a noun in English.
 *
 * @param count - The count.
 * @param word - The singular noun.
 * @returns The count and the noun, plural unless the count is one.
 */
function pluralize(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/**
 * Keeps handoff failures visible even when carry-over left no declared unit.
 * @param session - The current session.
 * @returns The failure note, or no notes after success.
 */
export function handoffNotes(session: Session): FlowRow[] {
  return session.handoff?.state === 'failed' ? [{ key: 'Handoff', value: `not completed — ${session.handoff.reason}.`, tone: 'error' }] : []
}

/**
 * Lists every finding of the session's issue audit, or why the audit is pending, so a non-compliant issue is never hidden.
 * @param session - The current session.
 * @returns One note per finding, one for a pending audit, or none.
 */
export function auditNotes(session: Session): FlowRow[] {
  const result = session.audit?.result
  if (result?.state === 'pending') return [{ key: 'Issue audit', value: `pending — ${result.reason}`, tone: 'warn' }]
  return result?.state === 'violations'
    ? result.findings.map((finding): FlowRow => ({ key: `Issue #${finding.issue}`, value: `${finding.field}: expected ${finding.expected}, has ${finding.actual}`, tone: 'error' }))
    : []
}

/**
 * Words a GitHub failure for the pane's GitHub row, in the phrase `/flow status` uses.
 * @param failure - The failure.
 * @returns The row's text: the reason, and the time of the kept issue facts when known.
 */
function formatGithubFailure(failure: GithubFailure): string {
  return `read failed (${failure.reason})${failure.readAt === null ? '' : ` · facts from ${formatLocalTime(failure.readAt, false)}`}`
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
  const meta: FlowRow[] = []
  const notes: FlowRow[] = []
  if (session.unit || position.git) {
    const suffix = position.slice?.isRewritten ? { text: 'rewritten', tone: 'error' as const }
      : position.integration?.state === 'unknown-end' || position.integration?.state === 'deleted-unmerged' ? { text: 'deleted', tone: 'warn' as const }
      : position.slice?.isFrozen ? { text: 'frozen', tone: 'inactive' as const } : undefined
    meta.push({ key: 'Branch', value: session.unit?.branch ?? position.git?.branch ?? '', tone: 'text', ...(suffix ? { suffix } : {}) })
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
  if (position.verify.queued) notes.push({ key: 'Verify', value: position.verify.queued, tone: 'warn' })
  notes.push(...handoffNotes(session), ...auditNotes(session))
  const isFinished = !position.slice?.isRewritten && isUnitFinished(position)
  const states = projectDisplayStates(position.states)
  // Every step before the current one is settled, and none after it has been reached.
  const currentIndex = states.findIndex(entry => entry.state === 'current')
  const settled = currentIndex >= 0 ? currentIndex : states.filter(entry => entry.state !== 'pending').length
  return {
    flow: position.flow.label,
    progress: `${position.slice?.isRewritten ? symbol.rewritten : settled}/${states.length}`,
    issues: session.issues.map(issueNumber => {
      const info = session.info[issueNumber]
      return { number: issueNumber, title: info && 'title' in info ? info.title : '' }
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
          : entry.state === 'skipped' ? entry.reason || facts.optional
          : entry.state === 'current' ? entry.fact
          // An integrated child's Integrate names where its delivery stands, because the unit is finished and shows no current step.
          : entry.state === 'done' && entry.step.observe === 'integrated' ? entry.fact : undefined,
        ...(entry.detail && (isCurrentFact || (!isRewritten && entry.state === 'skipped') || (entry.state === 'done' && entry.step.observe === 'integrated')) ? { fullDetail: entry.detail } : {}),
      }
    }),
    notes,
    footer: isFinished || session.isLong || session.handoff
      ? { action: session.handoff?.state === 'running' ? 'continue' : isFinished ? 'start' : 'continue', isRunning: session.handoff?.state === 'running' }
      : null,
  }
}
