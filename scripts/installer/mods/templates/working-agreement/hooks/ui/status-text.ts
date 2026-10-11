import type { FlowRow, FlowView } from '../../types'
import { drawRule, layoutLabelRows, measureLabelWidth } from './pane-layout'
import { hintIndent, inlineGap, keyWidth, pillGap, pillRowGap, sectionGap, statusColumns } from './theme'

function keyedLine(row: FlowRow): string {
  return `${row.key.padEnd(keyWidth)}${row.value}`
}

/**
 * Renders the Flow pane's view as plain text, for `/flow status`: the pane's sections in its order, one blank line between them.
 *
 * @param view - The view.
 * @returns The pane's lines, joined.
 */
export function renderStatusText(view: FlowView): string {
  const labelRows = layoutLabelRows(view.labels, measureLabelWidth(statusColumns))
  const labelLines = labelRows.map((row, index) => (index === 0 ? 'Labels'.padEnd(keyWidth) : ' '.repeat(keyWidth)) + row.map(label => ` ${label} `).join(' '.repeat(pillGap)))
  const sections: string[][] = [
    [`${view.flow}${inlineGap}${view.progress}`, drawRule(statusColumns)],
    [...(view.pending ? [view.pending] : []), ...view.issues.flatMap(issue => [`#${issue.number}`, ...(issue.title ? [issue.title] : [])])],
    // A blank line between pill rows, as the pane has.
    labelLines.flatMap((line, index) => (index === 0 ? [line] : [...Array<string>(pillRowGap).fill(''), line])),
    view.meta.map(keyedLine),
    view.steps.flatMap(step => [`${step.symbol} ${step.label}${step.isStale ? `${inlineGap}stale` : ''}`, ...(step.hint ? [`${' '.repeat(hintIndent)}${step.hint}`] : [])]),
    view.notes.map(keyedLine),
    view.footer ? [`${view.footer.text ? `${view.footer.text} ` : ''}Continue in new session: /flow handoff`] : [],
  ]
  return sections.filter(section => section.length > 0).map(section => section.join('\n')).join('\n'.repeat(sectionGap + 1))
}
