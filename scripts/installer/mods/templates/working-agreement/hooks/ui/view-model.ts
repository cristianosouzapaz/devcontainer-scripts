import type { FlowRow, FlowView } from '../../types'
import type { GithubStatus, Session } from '../domain/records'
import { isDeliveryStep } from '../domain/flow-definitions'
import { formatStepLabel, isUnitFinished, listDeclaredLabels, projectDisplayStates } from '../domain/step-states'
import type { DiagnoseNeed, Position } from '../domain/step-states'
import { stepSymbol } from './theme'

/**
 * Uses the pane's short wording for the resolved Diagnose requirement.
 * @param need - The first unmet Diagnose requirement, if any.
 * @param fact - The domain fact used for all other requirements.
 * @returns The pane detail without rejudging the unit.
 */
function describeDiagnoseFact(need: DiagnoseNeed | undefined, fact: string | undefined): string | undefined {
  return need === 'red' ? 'no red run yet'
    : need === 'approval' ? 'needs /flow approve' : fact
}

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
 * Builds what the Flow pane shows for the session's unit.
 *
 * @param session - The session.
 * @param position - The unit's position.
 * @param github - Whether GitHub is reachable.
 * @returns The pane's view.
 */
export function buildView(session: Session, position: Position, github: GithubStatus): FlowView {
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
  if (github === 'unauth') meta.push({ key: 'GitHub', value: 'not authenticated — run gh auth login', tone: 'warn' })
  if (github === 'unreachable') meta.push({ key: 'GitHub', value: 'unreachable · not refreshed', tone: 'warn' })
  const { edits } = session.blocked
  if (edits) {
    notes.push({ key: 'Blocked', value: pluralize(edits, 'edit'), tone: 'error' })
  }
  const merge = position.current?.step.observe === 'integrated' && position.integration?.state === 'pending' ? position.integration.command : undefined
  if (merge) notes.push({ key: 'Merge', value: merge, tone: 'text' })
  notes.push(...handoffNotes(session))
  const isFinished = !position.slice?.isRewritten && isUnitFinished(position)
  const states = projectDisplayStates(position.states)
  // Every step before the current one is settled, and none after it has been reached.
  const currentIndex = states.findIndex(entry => entry.state === 'current')
  const settled = currentIndex >= 0 ? currentIndex : states.filter(entry => entry.state !== 'pending').length
  return {
    flow: position.flow.label,
    progress: `${position.slice?.isRewritten ? '?' : settled}/${states.length}`,
    issues: session.issues.map(issueNumber => {
      const info = session.info[issueNumber]
      return { number: issueNumber, title: info && 'title' in info ? info.title : '' }
    }),
    pending: !session.issues.length && position.flow.issue === 'produced' ? 'issue not yet created' : null,
    meta,
    labels: [...new Set(listDeclaredLabels(session))],
    steps: states.map(entry => {
      const isMerged = position.isConcluded && isDeliveryStep(entry.step) && !!position.pullRequest
      const isError = !position.slice?.isRewritten && entry.isError && entry.state === 'current' && (entry.step.observe === 'verify.passed' || isDeliveryStep(entry.step))
      const diagnoseFact = describeDiagnoseFact(entry.need, entry.fact)
      return {
        id: entry.step.id,
        symbol: isMerged ? '✓' : position.slice?.isRewritten ? '?' : isError ? '✗' : stepSymbol[entry.state],
        label: formatStepLabel(entry.step, position.pullRequest, entry.state === 'current'),
        state: entry.state,
        isError,
        isMerged,
        // The PR step's label already names its PR; Integrate's fact names the parent's.
        detail: position.slice?.isRewritten ? undefined : isMerged ? (entry.step.observe === 'integrated' ? entry.fact : 'merged')
          : entry.state === 'skipped' ? entry.reason || 'optional'
          : entry.state === 'current' ? diagnoseFact
          // An integrated child's Integrate names where its delivery stands, because the unit is finished and shows no current step.
          : entry.state === 'done' && entry.step.observe === 'integrated' ? entry.fact : undefined,
      }
    }),
    notes,
    footer: isFinished || session.isLong || session.handoff
      ? { action: session.handoff?.state === 'running' ? 'continue' : isFinished ? 'start' : 'continue', isRunning: session.handoff?.state === 'running' }
      : null,
  }
}
