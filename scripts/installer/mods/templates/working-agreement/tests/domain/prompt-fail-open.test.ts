import { expect, test } from 'claude-code/testing'

import { noFlow } from '../support/builders'
import { readPromptContext } from '../support/helpers'
import { createWorld } from '../support/world'

const notice = 'could not be read'
const atCode = { unit: { skills: ['grilling', 'to-spec'] } }

test('a prompt goes through with the notice when the session cannot be read', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, isRepoBroken: true })
  expect(await readPromptContext($)).toContain(notice)
})

test('a prompt goes through with the notice when the store cannot be read', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...atCode, isStoreBroken: true })
  const context = await readPromptContext($)
  expect(context).toContain(notice)
  expect(context).not.toContain('current step:')
})

test('the notice names why the flow state could not be read', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...atCode, isStoreBroken: true })
  expect(await readPromptContext($)).toContain('(store read session')
})

test('the notice is a single line in the prompt context', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...atCode, isStoreBroken: true })
  expect((await readPromptContext($)).split(notice)).toHaveLength(2)
})
