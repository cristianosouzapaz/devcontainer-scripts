import type { RunCommandStatus } from '../../types'
import type { StepMarkKind } from '../domain/step-states'

/** The legend: every surface draws a state with these marks, and each mark keeps one meaning on all of them. */
export const symbol: Readonly<Record<StepMarkKind, string>> = { done: '✓', current: '▸', pending: '○', skipped: '↷', failed: '✗', rewritten: '?', waitingApproval: '●' }

/** The mark of a run command, by its status, in the legend's terms. */
export const commandSymbol: Record<RunCommandStatus, string> = {
  waiting: symbol.pending, running: symbol.current, passed: symbol.done, failed: symbol.failed, timeout: symbol.failed, cancelled: symbol.skipped,
}

/** The selected row's cursor, outside the legend because it marks a row, not a state. */
export const selectionCursor = '❯'
