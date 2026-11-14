import type { ThemeKey } from 'claude-code'
import type { FlowRow, FlowStepState, FlowTone } from '../../types'

/** A keyed row's label: a fixed one, or an issue's number, which holds `Issue #<n>` up to a four-digit number before it fills the key column. */
export type KeyLabel = (typeof keyLabels)[number] | `Issue #${number}`

/** A pane row whose key is a known label, so a producer cannot build a row that `keyWidth` was not checked against. */
export interface KeyedRow extends Omit<FlowRow, 'key'> { key: KeyLabel }

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

/** The width of a row's key column, in characters: the longest key, `Issue audit`, and one space. */
export const keyWidth = 12

/** Every fixed label a keyed row can carry, on the pane, in the run log and in `/flow status`; each is shorter than `keyWidth`. */
export const keyLabels = [
  'Approve', 'Blocked', 'Branch', 'CI', 'Changed', 'Checkout', 'Checks', 'Classic', 'Commits', 'Config', 'Cwd', 'Decision', 'Delegating', 'Delegation',
  'File', 'GitHub', 'Guards', 'Handoff', 'Inbox', 'Issue', 'Issue audit', 'Issues', 'Labels', 'Level', 'Log', 'Mail', 'Merge', 'Mod', 'Notice', 'PR', 'Process',
  'Queue', 'Records', 'Retired', 'Retries', 'Rulesets', 'Run', 'Selection', 'Slice', 'Spawned', 'Start', 'Step', 'Tools', 'Tree', 'Triage', 'Unchecked', 'Verify', 'Violation',
  'Worktree', 'herdr',
] as const

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
