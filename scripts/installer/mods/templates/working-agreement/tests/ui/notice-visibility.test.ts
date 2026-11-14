import { expect } from 'claude-code/testing'

import { readShownNotices } from '../../hooks/ui/pane-layout'
import type { FlowView } from '../../types'
import { test } from '../support/kit'

const noticeId = '12345678-aaaa-bbbb-cccc-1234567890ab'

/**
 * Builds a view whose one notice note follows the notes a case puts before it.
 * @param before - The values of the notes above the notice's.
 * @returns The view.
 */
const viewWith = (before: string[]): FlowView => ({
  flow: 'Fix', progress: '', issues: [], pending: null, meta: [], labels: [], steps: [], footer: null,
  notes: [...before.map(value => ({ key: 'Process', value, tone: 'text' as const })), { key: 'Start', value: `/flow coordinate [${noticeId.slice(0, 8)}]: whether it entered is unknown`, tone: 'text' as const }],
  notices: [`${noticeId}@r1`],
})

// contract: a render acknowledges a notice only when the whole view's extent above it, as drawn, is certainly within the window: never while a live run or a failed issue open, drawn above the notes, may push it down, never for a body too narrow to bound, and line breaks count as rows
test('a notice is acknowledged only when its extent is known to fit: no live run, a body wide enough, and every line break counted', () => {
  const view = viewWith([])
  expect({
    fits: readShownNotices(view, 80, { offset: 0, rows: 50 }, false),
    live: readShownNotices(view, 80, { offset: 0, rows: 50 }, true),
    narrow: readShownNotices(view, 20, { offset: 0, rows: 50 }, false),
    multiline: readShownNotices(viewWith([Array.from({ length: 40 }, () => 'x').join('\n')]), 80, { offset: 0, rows: 50 }, false),
    openFailure: readShownNotices({ ...view, openFailure: { issue: 7, reason: 'no browser', url: 'https://github.com/o/r/issues/7' } }, 80, { offset: 0, rows: 50 }, false),
  }).toEqual({ fits: [`${noticeId}@r1`], live: [], narrow: [], multiline: [], openFailure: [] })
})
