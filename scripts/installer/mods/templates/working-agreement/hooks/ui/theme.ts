import type { FlowStepState, FlowTone } from '../../types'

/** The Flow pane's colors. */
export const palette = {
  bg: '#23272e', text: '#d8dee9', muted: '#616e88', accent: '#88c0d0',
  done: '#a3be8c', warn: '#ebcb8b', error: '#bf616a', pill: '#3b4252',
}

/** The color of a row's value, by its tone. */
export const toneColor: Record<FlowTone, string> = { text: palette.text, warn: palette.warn, error: palette.error }

/** The color of a step's symbol, by its state. */
export const symbolColor: Record<FlowStepState, string> = {
  done: palette.done, current: palette.accent, pending: palette.muted, skipped: palette.muted, override: palette.warn,
}

/** The color of a step's label, by its state. */
export const labelColor: Record<FlowStepState, string> = {
  done: palette.text, current: palette.accent, pending: palette.muted, skipped: palette.muted, override: palette.text,
}

/** The mark the pane draws beside a step in each state. */
export const stepSymbol: Record<FlowStepState, string> = { done: '✓', current: '▸', pending: '○', skipped: '↷', override: '⚑' }

/** The width of a row's key column, in characters. */
export const keyWidth = 10

/** The pane's padding: columns on each side, rows above. */
export const panePadding = { x: 2, top: 1 }

/** The blank rows between two sections. */
export const sectionGap = 1

/** The columns between two pills of a row. */
export const pillGap = 2

/** The blank rows between two rows of pills. */
export const pillRowGap = 1

/** The columns between an issue's number and its button. */
export const issueGap = 2

/** The columns a step's hint is indented by. */
export const hintIndent = 4

/** The text between a flow's name and its progress, and between a step's label and its stale marker. */
export const inlineGap = '  '

/** The columns `/flow status` lays out at. */
export const statusColumns = 40
