import type { FlowRow, FlowStep, FlowView } from '../../types'
import { drawRule } from './pane-layout'
import { inlineGap, keyWidth, pillGap, sectionGap, statusColumns } from './theme'

/**
 * Aligns a status value beneath the shared key column.
 * @param key - The row label.
 * @param value - The complete displayed value.
 * @returns The padded label followed by the value.
 */
export function keyedLine(key: string, value: string): string {
  return `${key.padEnd(keyWidth)}${value}`
}

/**
 * Includes a pane row's suffix in its plain status line.
 * @param row - The pane row.
 * @returns The aligned row including its optional suffix.
 */
function rowLine(row: FlowRow): string {
  return keyedLine(row.key, `${row.value}${row.suffix ? ` · ${row.suffix.text}` : ''}`)
}

/**
 * Retains a flow step's symbol and optional detail in plain-text status.
 * @param step - The displayed flow step.
 * @returns The complete step line.
 */
function stepLine(step: FlowStep): string {
  return `${step.symbol} ${step.label}${step.detail ? ` · ${step.detail}` : ''}`
}

/**
 * Renders the Flow pane's view as plain text, for `/flow status`: the pane's sections in its order, one blank line between them.
 *
 * @param view - The view.
 * @returns The pane's lines, joined.
 */
export function renderStatusText(view: FlowView): string {
  const sections: string[][] = [
    [`${view.flow}${inlineGap}${view.progress}`, drawRule(statusColumns)],
    [...(view.pending ? [view.pending] : []), ...view.issues.flatMap(issue => [`#${issue.number}`, ...(issue.title ? [issue.title] : [])])],
    view.labels.length ? [keyedLine('Labels', view.labels.map(label => ` ${label} `).join(' '.repeat(pillGap)))] : [],
    view.meta.filter(row => row.key !== 'GitHub').map(rowLine),
    view.steps.map(stepLine),
    view.notes.map(rowLine),
    view.footer ? [view.footer.action === 'start' ? 'Start new session: /clear' : 'Continue in new session: /flow handoff'] : [],
  ]
  return sections.filter(section => section.length > 0).map(section => section.join('\n')).join('\n'.repeat(sectionGap + 1))
}
