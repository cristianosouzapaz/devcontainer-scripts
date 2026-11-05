/** The left column's width on a docked screen: the transcript, before the Flow pane's divider. */
const leftWidth = 72

/**
 * The Flow pane's rows as it docks beside the transcript. Two of them quote a dialog's own rows beside an empty transcript row, which only
 * the divider cut keeps from identifying a dialog once the borders are stripped.
 */
const flowRows = ['Small feature #12', '✓ Grill', '▸ Code', 'Background work is running', '3. Stay', 'Settings Error', '❯ 1. Fix with Claude']

/** The transcript above a dialog, quoting dialog titles inside sentences, which never identify a dialog. */
const transcript = ['⏺ The unit read the issue: the Settings Error dialog and', '  "Background work is running" are both named there.', '']

/** The bar the fullscreen renderer draws between the docked transcript and a dialog, across the whole screen. */
const dialogBar = '▔'.repeat(leftWidth + 40)

/**
 * Each catalogue entry's dialog as the fullscreen renderer draws it below the transcript, across the whole screen, keyed by its catalogue
 * id. The exit-with-background-work and Settings Error rows are captures from Claude Code 2.1.318; the Settings Error dialog comes before
 * the renderer starts, so a live screen shows it undocked.
 */
export const dialogScreens: Record<string, string[]> = {
  'exit-background-work': ['   Background work is running', '   The following will stop when you exit:', '', '   shell · sleep 3600', '',
    '   ❯ 1. Exit and stop tasks', '     2. Move to background and exit', '     3. Stay', '', '   Enter to confirm · Esc to cancel'],
  'settings-error': ['  Settings Error', '', '  /home/user/.claude/settings.json', '  └ tui: Invalid value. Expected one of: "default", "fullscreen"', '',
    '  Valid values: "default", "fullscreen"', '', '', '  Files with errors are skipped entirely, not just the invalid settings.', '',
    '  ❯ 1. Fix with Claude', '    2. Exit and fix manually', '    3. Continue without these settings', '', '  Enter to confirm · Esc to cancel'],
  'auto-mode-setup': ['   Teach auto mode about your environment?', '', '   Claude Code reads this project, your recent Claude sessions, and',
    '   optionally your shell history.', '', '   ❯ 1. Yes', '     2. Not now', '     3. Don\'t show again'],
  'usage-limit': ['   You\'ve hit your limit · resets 6pm', '', '   ❯ 1. Stop and wait for limit to reset', '     2. Upgrade your plan'],
  'effort-nudge': ['   Switch your default effort to medium?', '', '   ❯ 1. Yes, use medium effort by default', '     2. No, keep high'],
}

/** A selection dialog the catalogue does not know. */
export const unknownDialog = ['   Pick a colour for the session', '', '   ❯ 1. Red', '     2. Blue']

/** A unit at its prompt with no dialog: the prompt box and status rows, across the whole screen. */
export const noDialog = ['─'.repeat(leftWidth + 40), '❯ ', '─'.repeat(leftWidth + 40), '  ⏵⏵ auto mode on (shift+tab to cycle)']

/**
 * Draws a screen as the fullscreen renderer shows it with the Flow pane docked: the transcript rows padded to the left column's width, the
 * `│` divider and the pane's column, then the bar and the given rows across the whole screen, as a dialog or the prompt box is drawn.
 * @param rows - The rows below the transcript.
 * @returns The visible screen.
 */
export function dockScreen(rows: string[]): string {
  const left = [...transcript, ...Array<string>(flowRows.length - transcript.length + 2).fill('')]
  const docked = left.map((row, index) => `${row.padEnd(leftWidth)}│  ${flowRows[index] ?? ''}`)
  return [...docked, dialogBar, ...rows].join('\n')
}
