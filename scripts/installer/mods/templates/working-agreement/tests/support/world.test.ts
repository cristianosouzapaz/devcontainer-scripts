import { expect } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'

import { test } from './kit'
import { noFlow } from './builders'
import { declareFlow, startSkill } from './helpers'
import { configBlob, createWorld, root } from './world'

// A test cannot read the session store itself, but any plugin may read another's value through it.
const reader: Plugin = { name: 'reader', register: on => {
  on('command.run', { command: 'read-twice' }, async $ => {
    const first = (await $.state.get({ plugin: 'working-agreement', key: 'session' })).version
    await $.clock.sleep(1000)
    const second = (await $.state.get({ plugin: 'working-agreement', key: 'session' })).version
    return { text: `${first} ${second}` }
  })
} }

test('a dispatch reads one moment of the session while another dispatch writes it', { plugins: [reader] }, async ($, on) => {
  const world = createWorld(on, { branch: 'fix' }, { session: noFlow })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await declareFlow($, 'fix', [1])
  const reading = $.command.run({ command: 'read-twice', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  await world.clock.settle()
  await startSkill($, 'diagnosing-bugs')
  await world.clock.advance(1000)
  const [first, second] = (await reading).text?.split(' ') ?? []
  expect(first).toBeDefined()
  expect(second).toBe(first)
})

test('a fixture names a blob as git hash-object does', () => {
  expect(configBlob('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  expect(configBlob('hello')).toBe('b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0')
  expect(configBlob('x'.repeat(200))).toBe('debcf03c10222209e6ac75be3fa2c1796d204d91')
})
