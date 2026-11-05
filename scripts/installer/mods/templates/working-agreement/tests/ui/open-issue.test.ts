import { expect } from 'claude-code/testing'

import { mountPane, readFlowStatus, textOf } from '../support/helpers'
import { test } from '../support/kit'
import { createWorld } from '../support/world'

const unit = { session: { flow: 'small-feature', issues: [1], info: { 1: { title: 'a', labels: [] } } } }
const isOpen = (args: string[]): boolean => args.join(' ') === 'issue view 1 --web'

test('a failed open shows the first line of the error and the issue URL until the next refresh', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...unit, gh: args => isOpen(args) ? { exitCode: 1, stderr: 'connect ECONNREFUSED /run/helper.sock\nmore detail' } : undefined })
  await readFlowStatus($)
  const ui = await mountPane($, { columns: 60 })
  await ui.press({ key: 'open-1' })
  const text = textOf(await ui.drawn())
  expect(text).toContain('connect ECONNREFUSED /run/helper.sock · https://github.com/o/r/issues/1')
  expect(text).not.toContain('more detail')
  await readFlowStatus($)
  expect(textOf(await ui.drawn())).not.toContain('ECONNREFUSED')
  await ui.unmount()
})

test('a successful open shows no note', async ($, on) => {
  const opened: string[][] = []
  createWorld(on, { branch: 'feat' }, { ...unit, gh: args => { if (isOpen(args)) { opened.push(args); return { exitCode: 0 } } return undefined } })
  await readFlowStatus($)
  const ui = await mountPane($, { columns: 60 })
  const before = textOf(await ui.drawn())
  await ui.press({ key: 'open-1' })
  expect(opened).toHaveLength(1)
  expect(textOf(await ui.drawn())).toBe(before)
  await ui.unmount()
})
