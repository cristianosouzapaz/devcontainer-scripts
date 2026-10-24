import { expect, test } from 'claude-code/testing'

import { noFlow } from '../support/builders'
import { readFlowStatus, runFlowCommand } from '../support/helpers'
import { createWorld } from '../support/world'

const closing = { number: 5, state: 'OPEN', headRefName: 'feature', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }

for (const state of ['OPEN', 'CLOSED']) {
  test(`Follow-up accepts a ${state.toLowerCase()} issue with an open closing PR on the checkout branch`, async ($, on) => {
    const { sessions } = createWorld(on, { branch: 'feature', ahead: 2 }, { session: noFlow, issues: { 1: state }, closingPrs: { 1: [closing] } })
    const reply = (await runFlowCommand($, 'follow-up #1')).text
    expect(reply).toContain('Flow declared: Follow-up')
    expect(reply).toContain('2 commits already on this branch are not counted for this unit')
    expect(sessions.get('sid')?.units[0]?.base).toBe('c2')
    expect(await readFlowStatus($)).not.toContain('Refs')
  })
}

for (const prs of [[], [{ ...closing, state: 'CLOSED' }], [{ ...closing, isCrossRepository: true }], [{ ...closing, baseRepository: { nameWithOwner: 'another/repo' } }]]) {
  test(`Follow-up without an eligible closing PR is refused: ${JSON.stringify(prs)}`, async ($, on) => {
    createWorld(on, { branch: 'feature' }, { session: noFlow, closingPrs: { 1: prs } })
    expect((await runFlowCommand($, 'follow-up #1')).text).toContain('declare its own flow')
  })
}

test('an open closing PR requires checkout of one of its head branches even if another PR merged', async ($, on) => {
  createWorld(on, { branch: 'elsewhere' }, { session: noFlow, closingPrs: { 1: [closing, { ...closing, state: 'MERGED', headRefName: 'elsewhere' }] } })
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('check out its head branch (feature)')
})

test('after merge a Follow-up may use a different branch and takes the declaration tip as base', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'new-branch', ahead: 3 }, { session: noFlow, issues: { 1: 'CLOSED' }, closingPrs: { 1: [{ ...closing, state: 'MERGED' }] } })
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('Flow declared')
  expect(sessions.get('sid')?.units[0]?.base).toBe('c3')
})

for (const extra of [{ isLoggedOut: true }, { failing: 'gh api graphql' }, { closingHasNextPage: true }]) {
  test(`an unreadable or partial Follow-up lookup is refused: ${JSON.stringify(extra)}`, async ($, on) => {
    createWorld(on, { branch: 'feature' }, { session: noFlow, closingPrs: { 1: [closing] }, ...extra })
    expect((await runFlowCommand($, 'follow-up #1')).text).toContain('GitHub unreachable — retry')
  })
}

test('a missing issue is still refused for Follow-up', async ($, on) => {
  createWorld(on, { branch: 'feature' }, { session: noFlow, missing: [1] })
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('check the number')
})
