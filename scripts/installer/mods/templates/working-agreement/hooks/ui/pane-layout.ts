import { keyWidth, panePadding, pillGap } from './theme'

/** The rows laid out so far, and the columns the last row has used. */
interface LabelLayout {
  rows: string[][]
  used: number
}

/**
 * Reserves the label's surrounding padding during pill layout.
 * @param label - The displayed label.
 * @returns The columns occupied by the padded pill.
 */
function pillWidth(label: string): number {
  return label.length + 2
}

/**
 * Truncates a label at the end so its padded pill fits the row, since a wrapped pill splits its padding from its text.
 * @param label - The label name.
 * @param width - The columns a row of pills may span.
 * @returns The label, or its start and an ellipsis.
 */
function fitLabel(label: string, width: number): string {
  return pillWidth(label) <= width ? label : `${label.slice(0, Math.max(width - 3, 0))}…`
}

/**
 * Lays the labels out as rows of pills, filling each row before starting the next.
 *
 * @param labels - The label names, in order.
 * @param width - The columns a row of pills may span.
 * @returns The rows of displayed labels; a label wider than the width is truncated to fill its own row.
 */
export function layoutLabelRows(labels: string[], width: number): string[][] {
  const initial: LabelLayout = { rows: [], used: 0 }
  return labels.map(label => fitLabel(label, width)).reduce((layout, label) => {
    const row = layout.rows[layout.rows.length - 1]
    const extended = layout.used + pillGap + pillWidth(label)
    return row && extended <= width
      ? { rows: [...layout.rows.slice(0, -1), [...row, label]], used: extended }
      : { rows: [...layout.rows, [label]], used: pillWidth(label) }
  }, initial).rows
}

/**
 * Measures the columns the pills of a label row may span.
 *
 * @param bodyColumns - The width of the pane's body.
 * @returns The width left of the body after its padding and the key column, at least 1.
 */
export function measureLabelWidth(bodyColumns: number): number {
  return Math.max(bodyColumns - 2 * panePadding.x - keyWidth, 1)
}

/**
 * Draws the horizontal rule across a body of this width, inside the pane's padding.
 *
 * @param columns - The width of the body, in characters.
 * @returns The rule.
 */
export function drawRule(columns: number): string {
  return '─'.repeat(Math.max(columns - 2 * panePadding.x, 1))
}
