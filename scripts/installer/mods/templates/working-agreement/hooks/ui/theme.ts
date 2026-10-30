import type { ThemeKey } from 'claude-code'
import type { FlowStepState, FlowTone } from '../../types'

/** The color of a row's value, by its tone. */
export const toneColor: Record<FlowTone, ThemeKey> = { text: 'text', warn: 'warning', error: 'error', inactive: 'inactive' }

/** The color of a step's symbol, by its state. */
export const symbolColor: Record<FlowStepState, ThemeKey> = {
  done: 'success', current: 'suggestion', pending: 'inactive', skipped: 'inactive',
}

/** The color of a step's label, by its state. */
export const labelColor: Record<FlowStepState, ThemeKey> = {
  done: 'text', current: 'text', pending: 'inactive', skipped: 'inactive',
}

/** The width of a row's key column, in characters: the longest key, `Delegating` or `Issue #410`, and one space. */
export const keyWidth = 11

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

/** The text between a flow's name and its progress in plain text. */
export const inlineGap = '  '

/** The columns `/flow status` lays out at. */
export const statusColumns = 40
