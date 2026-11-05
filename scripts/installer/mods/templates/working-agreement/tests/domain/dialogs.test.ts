import { expect } from 'claude-code/testing'

import { cutFlowPane, dialogCatalogue, identifyDialog } from '../../hooks/domain/dialogs'
import { dialogScreens, dockScreen, noDialog, unknownDialog } from '../support/dialog-screens'
import { test } from '../support/kit'

// group: Identification
for (const entry of dialogCatalogue) {
  // contract: each catalogue entry is identified by its screen rows, with the Flow pane docked or not
  test(`${entry.id} is identified by its rows, docked or not`, () => {
    const rows = dialogScreens[entry.id] ?? []
    expect(identifyDialog(dockScreen(rows))).toEqual({ kind: 'known', entry })
    expect(identifyDialog(rows.join('\n'))).toEqual({ kind: 'known', entry })
  })
}

// contract: every catalogue entry has a fixture screen, so a new entry cannot ship untested
test('every catalogue entry has a fixture screen', () => {
  expect(Object.keys(dialogScreens).sort()).toEqual(dialogCatalogue.map(entry => entry.id).sort())
})

// contract: Esc is allowed only on the exit-with-background-work dialog, whose Esc is Stay; the auto-mode setup and Settings Error dialogs allow no key
test('Esc is allowed only where it has no side effect', () => {
  expect(dialogCatalogue.filter(entry => entry.key).map(entry => entry.id)).toEqual(['exit-background-work'])
})

// contract: dialog titles quoted in the transcript, or shown in the docked Flow pane's column beside an empty transcript row, identify no dialog
test('quoted titles and the Flow pane column identify nothing', () => {
  expect(identifyDialog(dockScreen(noDialog))).toEqual({ kind: 'none' })
})

// contract: a highlighted numbered option the catalogue does not know is an unknown dialog, its excerpt without the Flow pane column
test('an unknown selection dialog yields its excerpt without the Flow pane', () => {
  const seen = identifyDialog(dockScreen(unknownDialog))
  expect(seen.kind).toBe('unknown')
  const excerpt = seen.kind === 'unknown' ? seen.excerpt : ''
  expect(excerpt).toContain('❯ 1. Red')
  expect(excerpt).not.toContain('│')
  expect(excerpt).not.toContain('Small feature #12')
})

// group: Flow pane divider
// contract: the cut keeps the left column of each docked row, keeps full-width rows whole, and leaves a screen with no shared divider whole
test('the divider cut keeps the left column of docked rows only', () => {
  expect(cutFlowPane('ab   │ pane\ncd │   pane')).toEqual(['ab   │ pane', 'cd │   pane'])
  expect(cutFlowPane('ab │ pane\ncd │ pane\n')).toEqual(['ab', 'cd'])
  expect(cutFlowPane('ab │ pane\n   │ pane\n   Settings Error')).toEqual(['ab', '', '   Settings Error'])
})
