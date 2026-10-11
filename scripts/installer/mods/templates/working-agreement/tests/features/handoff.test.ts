import { expect, test } from 'claude-code/testing'

import { endTurn, readFlowStatus, readPromptContext, runFlowCommand } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Options } from '../support/world'

// What the document search finds: nothing, or two candidates where the handoff needs exactly one.
for (const [what, documents] of [['no', ''], ['two', '/tmp/a.md\n/tmp/b.md']] as const) {
  test(`a handoff that finds ${what} document fails without running /clear`, async ($, on) => {
    const { commands, clock } = createWorld(on, { branch: 'feat' }, { documents })
    await runFlowCommand($, 'handoff')
    await clock.settle()
    expect(commands).toEqual(['handoff'])
    await $.prompt.submit({ text: '/handoff', wait: false, origin: { kind: 'plugin', name: 'working-agreement' } })
    await endTurn($)
    await clock.settle()
    expect(commands).toEqual(['handoff'])
  })
}

test('a handoff whose /handoff turn leaves one document clears and continues from it in a new session', async ($, on) => {
  const { commands, prompts, clock } = createWorld(on, { branch: 'feat', isDirty: true }, { documents: '/tmp/handoff.md' })
  await runFlowCommand($, 'handoff')
  await clock.settle()
  await $.prompt.submit({ text: '/handoff', wait: false, origin: { kind: 'plugin', name: 'working-agreement' } })
  await endTurn($)
  await clock.settle()
  expect(commands).toEqual(['handoff', 'clear'])
  expect(prompts.join('\n')).toContain('Continue from the handoff document at /tmp/handoff.md')
})

test('a handoff cancelled with /flow handoff cancel runs no /clear', async ($, on) => {
  const { commands, clock } = createWorld(on, { branch: 'feat' }, { documents: '/tmp/handoff.md' })
  await runFlowCommand($, 'handoff')
  await clock.settle()
  expect((await runFlowCommand($, 'handoff cancel')).text).toContain('Handoff reset')
  await $.prompt.submit({ text: '/handoff', wait: false, origin: { kind: 'plugin', name: 'working-agreement' } })
  await endTurn($)
  await clock.settle()
  expect(commands).toEqual(['handoff'])
})

// The handoff reads the checkout before it records itself; an issue sync landing meanwhile must survive that write.
test('labels an issue sync stores while a handoff starts survive the handoff\'s own write', async ($, on) => {
  const options: Options = { issueLabels: { 1: ['ready-for-agent'] } }
  const { clock } = createWorld(on, { branch: 'feat', isDirty: true }, options)
  const release: { open: () => void } = { open: () => undefined }
  options.statusGate = new Promise<void>(resolve => { release.open = resolve })
  const starting = runFlowCommand($, 'handoff')
  await clock.settle()
  options.issueLabels = { 1: ['ready-for-agent', 'bug'] }
  await clock.advance(61000)
  await readPromptContext($)
  release.open()
  await starting
  expect(await readFlowStatus($)).toContain('bug')
})
