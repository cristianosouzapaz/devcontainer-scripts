import type { FlowRow, FlowView } from '../../types'
import type { GithubStatus, Session } from '../domain/records'
import { formatStepLabel, isCiWait, isUnitFinished, listDeclaredLabels } from '../domain/step-states'
import type { Position, StepState } from '../domain/step-states'
import { stepSymbol } from './theme'

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
 * Builds what the Flow pane shows for the session's unit.
 *
 * @param session - The session.
 * @param position - The unit's position.
 * @param github - Whether GitHub is reachable.
 * @returns The pane's view.
 */
export function buildView(session: Session, position: Position, github: GithubStatus): FlowView {
  const isRunning = (entry: StepState): boolean =>
    entry.state === 'current' && ((!!position.verify.running && entry.step.observe === 'verify.passed') || (!!position.testRun && position.red !== 'holds' && !!entry.step.isTestExempt))
  const meta: FlowRow[] = []
  const notes: FlowRow[] = []
  if (position.git) {
    const bits = [position.git.branch, `${position.git.ahead} ahead of ${position.git.base}`]
    if (position.git.isDirty) bits.push('uncommitted')
    meta.push({ key: 'Branch', value: bits.join(' · '), tone: 'text' })
    if (position.unit.branch && position.unit.branch !== position.git.branch) {
      notes.push({ key: 'Branch', value: `issue work is on ${position.unit.branch} — writes here ask`, tone: 'warn' })
    }
  }
  if (session.followUp) meta.push({ key: 'Refs', value: `#${session.followUp}`, tone: 'text' })
  if (github === 'unauth') meta.push({ key: 'GitHub', value: 'not authenticated — run gh auth login', tone: 'warn' })
  if (github === 'unreachable') {
    const isUnverified = session.issues.some(issue => !session.info[issue])
    meta.push({ key: 'GitHub', value: isUnverified ? 'unreachable — writes ask until the declared issue is verified' : 'unreachable — issue labels and PR state are not refreshed', tone: 'warn' })
  }
  for (const override of position.unit.overrides) {
    const label = position.flow.steps.find(step => step.id === override.step)?.label ?? override.step
    notes.push({ key: 'Override', value: `${label} — "${override.reason}" (by user)`, tone: 'warn' })
  }
  const { edits, shell } = session.blocked
  if (edits + shell) {
    const parts = [edits && pluralize(edits, 'edit'), shell && pluralize(shell, 'shell write')]
    notes.push({ key: 'Blocked', value: parts.filter(Boolean).join(', '), tone: 'error' })
  }
  if (session.handoff?.state === 'failed') {
    notes.push({ key: 'Handoff', value: `not completed — ${session.handoff.reason}. Nothing cleared.`, tone: 'error' })
  }
  const isFinished = isUnitFinished(session, position)
  const settled = position.states.filter(entry => entry.state !== 'current' && entry.state !== 'pending').length
  return {
    flow: position.flow.label,
    progress: `${settled}/${position.states.length}`,
    issues: session.issues.map(issueNumber => ({ number: issueNumber, title: session.info[issueNumber]?.title ?? '' })),
    pending: !session.issues.length && position.flow.issue === 'produced' ? 'issue not yet created' : null,
    meta,
    labels: [...new Set(listDeclaredLabels(session))],
    steps: position.states.map(entry => ({
      symbol: stepSymbol[entry.state],
      label: formatStepLabel(entry.step, position.unit.pr) + (isRunning(entry) ? ' — running' : ''),
      state: entry.state,
      hint: entry.state === 'current' && entry.step.isHuman && entry.step.skill ? `run /${entry.step.skill}`
        : entry.state === 'current' && isCiWait(position) ? `waiting for CI (${position.checks})` : undefined,
      isStale: entry.isStale && !isRunning(entry),
    })),
    notes,
    footer: isFinished || session.isLong || session.handoff
      ? { text: isFinished ? 'Unit finished.' : null, isRunning: session.handoff?.state === 'running' }
      : null,
  }
}
