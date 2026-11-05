import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

import { buildParentGraph } from '../support/builders'
import { mountPane, readFlowStatus, textOf } from '../support/helpers'
import { test } from '../support/kit'
import { parChild } from '../support/parallel-worktrees'
import { createWorld } from '../support/world'
import type { Checkout } from '../support/world'

/**
 * Checks out child `a`, past Commit, with `par` held by `/par` unless the parent is checked out nowhere.
 * @param isParentHeld - Whether a worktree holds `par`.
 * @returns The checkout.
 */
const childCheckout = (isParentHeld = true): Checkout => ({ branch: 'a', graph: buildParentGraph(),
  worktrees: { '/repo': { branch: 'a' }, ...(isParentHeld ? { '/par': { branch: 'par' } } : {}) } })

/**
 * Answers every copy with a result, and collects what was asked to be copied.
 * @param on - The hook registrar.
 * @param result - What the copy answers.
 * @returns The copies asked for.
 */
function answerCopies(on: On, result: { isCopied: true } | { isCopied: false; reason: 'no-clipboard' }): { text: string; surface?: string }[] {
  const copies: { text: string; surface?: string }[] = []
  on('ui.copy', (_$, e) => { copies.push({ text: e.text, surface: e.surface }); return { value: result } })
  return copies
}

test('the Merge row shows a copy button with hotkey m instead of the command', async ($, on) => {
  createWorld(on, childCheckout(), parChild())
  await readFlowStatus($)
  const ui = await mountPane($, { columns: 60 })
  const button = await ui.find({ key: 'copy' })
  expect(button?.props['hotkey']).toBe('m')
  expect(textOf(await ui.drawn())).not.toContain('--no-ff')
  await ui.unmount()
})

test('a unit with no pending merge has no copy button and no m hotkey', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { flow: 'small-feature', issues: [1], info: { 1: { title: 'a', labels: [] } } } })
  await readFlowStatus($)
  const ui = await mountPane($, { columns: 60 })
  expect(await ui.find({ key: 'copy' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Button' })).map(button => button.props['hotkey'])).not.toContain('m')
  await ui.unmount()
})

for (const [name, isParentHeld, command] of [['git -C', true, 'git -C /par merge --no-ff a'], ['git switch', false, 'git switch par && git merge --no-ff a']] as const) {
  test(`pressing copy copies the ${name} command on the surface of the press, the row reads copied and /flow status still names it`, async ($, on) => {
    createWorld(on, childCheckout(isParentHeld), parChild())
    const copies = answerCopies(on, { isCopied: true })
    await readFlowStatus($)
    const ui = await mountPane($, { columns: 60 })
    await ui.press({ key: 'copy' })
    expect(copies).toEqual([{ text: command, surface: 'terminal' }])
    expect(textOf(await ui.drawn())).toContain('copied')
    expect(await readFlowStatus($)).toContain(command)
    await ui.unmount()
  })
}

test('a refused copy shows its reason on the Merge row until the next refresh', async ($, on) => {
  createWorld(on, childCheckout(), parChild())
  answerCopies(on, { isCopied: false, reason: 'no-clipboard' })
  await readFlowStatus($)
  const ui = await mountPane($, { columns: 60 })
  await ui.press({ key: 'copy' })
  expect(textOf(await ui.drawn())).toContain('no-clipboard')
  await readFlowStatus($)
  expect(textOf(await ui.drawn())).not.toContain('no-clipboard')
  await ui.unmount()
})

test('the buttons the pane shows together never share a hotkey', async ($, on) => {
  createWorld(on, childCheckout(), { ...parChild(), session: { isLong: true } })
  await readFlowStatus($)
  const ui = await mountPane($, { columns: 60 })
  const hotkeys = (await ui.findAll({ type: 'Button' })).map(button => button.props['hotkey']).filter(Boolean)
  expect(hotkeys).toEqual(expect.arrayContaining(['m', 'c']))
  expect(new Set(hotkeys).size).toBe(hotkeys.length)
  await ui.unmount()
})
