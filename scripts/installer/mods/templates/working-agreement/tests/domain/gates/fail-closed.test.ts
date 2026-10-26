import { expect } from 'claude-code/testing'

import { test } from '../../support/kit'
import { buildWriteCall } from '../../support/builders'
import { declareFlow } from '../../support/helpers'
import { createWorld } from '../../support/world'

// With git answering, these feature-branch writes are allowed.
const atCode = { unit: { skills: ['grilling', 'to-spec'] } }
const write = buildWriteCall('src/a.ts')

test('a repository write is denied when git cannot be run', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...atCode, failing: 'git' })
  expect((await $.tool.call(write)).deny).toContain('check failed')
})

test('declare_flow is denied when the session cannot be read', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...atCode, failing: 'git rev-parse --path-format=absolute --git-common-dir' })
  expect((await declareFlow($, 'fix', [3])).deny).toContain('check failed')
})

test('a scratch write is also denied when git cannot be run', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { failing: 'git' })
  expect((await $.tool.call(buildWriteCall('/tmp/notes.md'))).deny).toContain('check failed')
})
