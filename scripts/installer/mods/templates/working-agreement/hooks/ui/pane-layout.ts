import { keyWidth, panePadding, pillGap } from './theme'

/** The rows laid out so far, and the columns the last row has used. */
interface LabelLayout {
  rows: string[][]
  used: number
}

/**
 * The body columns of the dock at its default width in a 144-column terminal, the narrowest where a pane opened unasked
 * docks: the engine opens the dock at min(45%, 90, terminal − 70) columns, one of them its grip.
 */
const defaultDockColumns = Math.min(Math.floor(144 * 0.45), 90, 144 - 70) - 1

/** The columns a step's mark and its space take. */
const factMarkColumns = 2
/** The columns of the ` · ` between a step's label and its fact. */
const factSeparatorColumns = 3

/** The longest step label, `Integrate` or a five-digit `PR #12345`. */
const longestLabelColumns = 'PR #12345'.length

/** The columns reserved before a fact: the mark and its space, the longest label, and ` · `. */
export const factPrefixColumns = factMarkColumns + longestLabelColumns + factSeparatorColumns

/** The longest fact a step shows, so a fact at the default dock width is never cut. */
export const maxFactLength = defaultDockColumns - 2 * panePadding.x - factPrefixColumns

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
 * Measures the columns the pills of a label row, or a keyed row's value, may span beside the key column.
 *
 * @param bodyColumns - The width of the pane's body.
 * @returns The width left of the body after its padding and the key column, at least 1.
 */
export function measureLabelWidth(bodyColumns: number): number {
  return Math.max(bodyColumns - 2 * panePadding.x - keyWidth, 1)
}

/**
 * Wraps a value into lines of whole words, since the engine does not wrap a value drawn beside the key column.
 * @param value - The value.
 * @param width - The columns a line may span.
 * @returns The lines; a word wider than the width takes a line of its own, which the engine may still break.
 */
export function wrapWords(value: string, width: number): string[] {
  return value.split(' ').filter(Boolean).reduce<string[]>((lines, word) => {
    const last = lines.at(-1)
    return last !== undefined && last.length + 1 + word.length <= width ? [...lines.slice(0, -1), `${last} ${word}`] : [...lines, word]
  }, [])
}

/**
 * Fits a fact into the columns left beside its step, cutting at a word boundary so no word is split.
 * @param fact - The fact.
 * @param width - The columns left after the step's prefix.
 * @returns The fact, or its first whole words and an ellipsis.
 */
export function fitFact(fact: string, width: number): string {
  if (fact.length <= width) return fact
  // A space at the last column still ends a whole word, which the ellipsis then replaces.
  const space = fact.slice(0, width).lastIndexOf(' ')
  const head = space > 0 ? fact.slice(0, space) : fact.slice(0, Math.max(width - 1, 0))
  return `${head.replace(/[\s:,—]+$/, '')}…`
}

/**
 * Measures the columns a step's fact may span beside its mark, label and separator.
 * @param bodyColumns - The width of the pane's body.
 * @param label - The step's label.
 * @returns The columns left of the body after its padding and the step's prefix, none in a pane too narrow for them.
 */
export function measureFactWidth(bodyColumns: number, label: string): number {
  return Math.max(bodyColumns - 2 * panePadding.x - (factMarkColumns + label.length + factSeparatorColumns), 0)
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
