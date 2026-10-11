import { keyWidth, panePadding, pillGap } from './theme'

/** The rows laid out so far, and the columns the last row has used. */
interface LabelLayout {
  rows: string[][]
  used: number
}

function pillWidth(label: string): number {
  return label.length + 2
}

/**
 * Lays the labels out as rows of pills, filling each row before starting the next.
 *
 * @param labels - The label names, in order.
 * @param width - The columns a row of pills may span.
 * @returns The rows; a pill wider than the width sits alone on its row.
 */
export function layoutLabelRows(labels: string[], width: number): string[][] {
  const initial: LabelLayout = { rows: [], used: 0 }
  return labels.reduce((layout, label) => {
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
