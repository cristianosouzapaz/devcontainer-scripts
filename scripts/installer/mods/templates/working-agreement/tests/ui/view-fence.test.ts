import { expect } from 'claude-code/testing'

import { buildParentGraph } from '../support/builders'
import { mountPane, readFlowStatus } from '../support/helpers'
import { test } from '../support/kit'
import { parChild } from '../support/parallel-worktrees'
import { createWorld } from '../support/world'
import type { Checkout } from '../support/world'

/**
 * Whether a stored view value draws no Flow view: the bare null, or a publication that carries none.
 * @param value - The value the mod set.
 * @returns True when it holds no view.
 */
const isEmptyView = (value: unknown): boolean => value === null || (typeof value === 'object' && 'seq' in value && 'view' in value && value.view === null)

// contract: a load's paint that lands after a newer load published an empty view never replaces it, as the empty view carries the newer load's number
test('a stale paint never lands over a newer load\'s empty view', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { flow: 'small-feature', issues: [1], info: { 1: { title: 'a', labels: [] } } } })
  const newer = { isStanding: false }
  const written: unknown[] = []
  // why: a newer load's publication is stood in for by reading it back while it stands, in the stored form of the tree under test, as one published by a load numbered above this one.
  on('state.get', { plugin: 'working-agreement', key: 'view' }, async (_$, e, next) => {
    const read = await next(e) as { value: { value?: unknown; version: number } }
    if (!newer.isStanding) return read as never
    const stored = read.value.value
    const empty = stored && typeof stored === 'object' && 'seq' in stored && typeof stored.seq === 'number' ? { seq: stored.seq + 1, view: null } : null
    return { ...read, value: { ...read.value, value: empty } } as never
  })
  on('state.set', { plugin: 'working-agreement', key: 'view' }, (_$, e, next) => {
    if (newer.isStanding) { written.push(e.value); newer.isStanding = false }
    return next(e)
  })
  await readFlowStatus($)
  newer.isStanding = true
  await readFlowStatus($)
  expect(written.filter(value => !isEmptyView(value))).toEqual([])
})

// contract: the Merge copy action records its outcome on the view current when the copy answers, and only while that view's Merge command is the one copied, so a paint that landed meanwhile stands and a newer command is never marked copied
test('a Merge copy that answers after a newer paint keeps that paint and marks no newer command copied', async ($, on) => {
  const checkout: Checkout = { branch: 'a', graph: buildParentGraph(), worktrees: { '/repo': { branch: 'a' }, '/par': { branch: 'par' } } }
  const world = createWorld(on, checkout, parChild())
  const copying = { open: (): void => {}, isAsked: false }
  const answer = new Promise<void>(resolve => { copying.open = resolve })
  on('ui.copy', async () => { copying.isAsked = true; await answer; return { value: { isCopied: true } } })
  await readFlowStatus($)
  const ui = await mountPane($, { columns: 60 })
  const pressed = ui.press({ key: 'copy' })
  await world.clock.settle()
  const isAskedFirst = copying.isAsked
  checkout.worktrees = { '/repo': { branch: 'a' } }
  await readFlowStatus($)
  copying.open()
  await pressed
  await ui.unmount()
  const last = world.views.at(-1)
  expect({ isAskedFirst, merge: last?.notes.find(note => note.key === 'Merge')?.value, mergeCopy: last?.mergeCopy })
    .toEqual({ isAskedFirst: true, merge: 'git switch par && git merge --no-ff a', mergeCopy: undefined })
})
