/** The only key the mod ever sends into a unit's session. */
export type DialogKey = 'Escape'

/**
 * One dialog Claude Code can stop an unattended session on: its id, the name a report gives it, the screen rows that identify it under
 * the renderer spawn sets, and the key that clears it without a side effect, or null where every key has one.
 */
export interface DialogEntry { id: string; name: string; rows: readonly RegExp[]; key: DialogKey | null }

/** What a unit's visible screen shows: a catalogued dialog, a selection dialog the catalogue does not know, or no dialog. */
export type Identification = { kind: 'known'; entry: DialogEntry } | { kind: 'unknown'; excerpt: string } | { kind: 'none' }

/**
 * The dialogs no setting prevents. A row pattern is matched against a whole screen row, its box border stripped, so a dialog's text quoted
 * in the transcript never identifies it; each entry pairs its title with one of its own option rows. Read from Claude Code 2.1.318, whose
 * update notices are a status line, not a dialog, so no entry names them.
 */
export const dialogCatalogue: readonly DialogEntry[] = [
  // why: its Esc is the Stay choice, the only one that neither exits nor moves the session out of its pane.
  { id: 'exit-background-work', name: 'the exit-with-background-work dialog', rows: [/^Background work is running$/, optionRow('Stay')], key: 'Escape' },
  // why: its Esc exits Claude Code, and every option either exits or drops the settings the unit was started with.
  { id: 'settings-error', name: 'the Settings Error dialog', rows: [/^Settings Error$/, optionRow('Exit and fix manually')], key: null },
  // why: its Esc is "Not now", which snoozes the offer for every session of the user for a week.
  { id: 'auto-mode-setup', name: 'the auto-mode setup dialog', rows: [/^Teach auto mode about your environment\?$/], key: null },
  // why: what its Esc does was not read from Claude Code, so the choice is the user's.
  { id: 'usage-limit', name: 'the usage-limit dialog', rows: [optionRow('Stop and wait for limit to reset')], key: null },
  // why: what its Esc does was not read from Claude Code, and its yes changes the user's default effort.
  { id: 'effort-nudge', name: 'the default-effort dialog', rows: [/^Switch your default effort to .+\?$/], key: null },
]

/** A selection dialog's highlighted option, as every Claude Code modal draws it. */
const cursorRow = /^❯\s*\d+\.\s+\S/
/** Box-drawing borders and padding around a row's text. */
const borders = /^[\s│┃╭╮╰╯─━]+|[\s│┃╭╮╰╯─━]+$/g
/** The most screen rows an unknown dialog's excerpt carries, enough for a dialog and short enough for a message. */
const excerptRows = 40

/**
 * Builds the pattern of one option row, highlighted or not.
 * @param label - The option's label.
 * @returns The pattern.
 */
function optionRow(label: string): RegExp {
  return new RegExp(`^(?:❯\\s*)?\\d+\\.\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
}

/**
 * Cuts the Flow pane off a screen: when it is docked, the transcript rows carry the pane's column after one `│` divider at the same column,
 * the column holding `│` on the most rows, while the prompt box, a dialog and the status rows below span the whole screen and keep every
 * character. Only a row with `│` at that column is cut, so a full-width dialog row is never cut short.
 * @param screen - The visible screen.
 * @returns The rows, each cut at the divider where it has one; every row whole when no column holds `│` on more than one row.
 */
export function cutFlowPane(screen: string): string[] {
  const rows = screen.split(/\r?\n/)
  while (rows.length && !rows.at(-1)?.trim()) rows.pop()
  const chars = rows.map(row => [...row])
  const counts = new Map<number, number>()
  for (const row of chars) row.forEach((char, index) => { if (char === '│') counts.set(index, (counts.get(index) ?? 0) + 1) })
  const [column, count] = [...counts].reduce((best, each) => each[1] > best[1] ? each : best, [-1, 0])
  if (count < 2) return rows
  return chars.map((row, index) => row[column] === '│' ? row.slice(0, column).join('').trimEnd() : rows[index] ?? '')
}

/**
 * Identifies the dialog a unit's visible screen shows: the first catalogue entry whose every row pattern matches some row, else an unknown
 * selection dialog when a row shows the highlighted numbered option every modal draws.
 * @param screen - The visible screen.
 * @returns The identification.
 */
export function identifyDialog(screen: string): Identification {
  const rows = cutFlowPane(screen)
  const texts = rows.map(row => row.replace(borders, ''))
  const entry = dialogCatalogue.find(each => each.rows.every(pattern => texts.some(text => pattern.test(text))))
  if (entry) return { kind: 'known', entry }
  if (!texts.some(text => cursorRow.test(text))) return { kind: 'none' }
  return { kind: 'unknown', excerpt: rows.filter(row => row.trim()).slice(-excerptRows).join('\n') }
}

/**
 * Finds a catalogue entry by id.
 * @param id - The id.
 * @returns The entry, or undefined.
 */
export function findDialog(id: string): DialogEntry | undefined {
  return dialogCatalogue.find(entry => entry.id === id)
}
