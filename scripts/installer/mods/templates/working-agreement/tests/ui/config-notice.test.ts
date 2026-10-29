import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { noFlow } from '../support/builders'
import { readFlowStatus, readPromptContext } from '../support/helpers'
import { createWorld, root } from '../support/world'
import type { World } from '../support/world'

const configFile = `${root}/.claude/working-agreement.json`

/**
 * Reads the Config note of the pane's latest view.
 * @param world - The test world.
 * @returns The note's text, or undefined without one.
 */
const readConfigNote = (world: World): string | undefined => world.views.at(-1)?.notes.find(note => note.key === 'Config')?.value

const invalid: [string, string, string][] = [
  ['an old config with the retired verify field', JSON.stringify({ verify: [['make', 'test']] }), 'verify: retired field'],
  ['an old config with the retired full field', JSON.stringify({ full: [['make', 'test']] }), 'full: retired field'],
  ['an unknown field', JSON.stringify({ always: [], extra: true }), 'extra: unknown field'],
  ['malformed JSON', '{ "always": [', '$: invalid JSON'],
]

for (const [name, text, error] of invalid) {
  test(`${name} opens the pane at session start with a short notice, and the prompt and /flow status carry the full error`, async ($, on) => {
    const world = createWorld(on, { branch: 'main' }, { session: noFlow })
    world.files.set(configFile, text)
    await $.session.start({ cwd: root, surface: null, isInteractive: false })
    expect(readConfigNote(world)).toBe('config invalid — see /flow status')
    expect(world.opened.length).toBeGreaterThan(0)
    expect(await readPromptContext($)).toContain(`is invalid for the installed mod (${error}`)
    expect(await readFlowStatus($)).toContain(`in the working tree · invalid: ${error}`)
  })
}

test('a fixed config clears the notice at the next refresh, with nothing kept from the earlier read', async ($, on) => {
  const world = createWorld(on, { branch: 'main' }, { session: noFlow })
  world.files.set(configFile, '{')
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  world.files.set(configFile, JSON.stringify({ always: [['make', 'test']] }))
  expect(await readPromptContext($)).not.toContain('is invalid for the installed mod')
  expect(await readFlowStatus($)).not.toContain('in the working tree · invalid')
})

test('a missing config is no error: nothing is shown and Verify is just not configured', async ($, on) => {
  const world = createWorld(on, { branch: 'main' }, { session: noFlow })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect(readConfigNote(world)).toBeUndefined()
  expect(await readPromptContext($)).not.toContain('is invalid for the installed mod')
})
