import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { readPromptContext } from '../support/helpers'
import { createWorld } from '../support/world'

const notice = 'could not be read'
const atCode = { unit: { skills: ['grilling', 'to-spec'] }, failing: 'git rev-parse --path-format=absolute --git-common-dir' }

test('a prompt goes through with the notice when the state cannot be read', async ($, on) => {
  createWorld(on, { branch: 'feat' }, atCode)
  const context = await readPromptContext($)
  expect(context).toContain(notice)
  expect(context).not.toContain('current step:')
})

test('the notice names why the flow state could not be read', async ($, on) => {
  createWorld(on, { branch: 'feat' }, atCode)
  expect(await readPromptContext($)).toContain('process.run')
})

test('the notice is a single line in the prompt context', async ($, on) => {
  createWorld(on, { branch: 'feat' }, atCode)
  const context = await readPromptContext($)
  expect(context).toContain(notice)
  expect(context.split('\n')).toHaveLength(1)
})
