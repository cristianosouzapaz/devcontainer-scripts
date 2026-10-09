import { expect, test } from 'claude-code/testing'

import { endTurn, flow } from './helpers'
import { world } from './world'

// What the document search finds: nothing, or two candidates where the handoff needs exactly one.
for (const [what, documents] of [['no', ''], ['two', '/tmp/a.md\n/tmp/b.md']] as const) {
  test(`a handoff that finds ${what} document fails without running /clear`, async ($, on) => {
    const { commands, clock } = world(on, { branch: 'feat' }, { documents })
    await flow($, 'handoff')
    await clock.settle()
    expect(commands).toEqual(['handoff'])
    await $.prompt.submit({ text: '/handoff', wait: false, origin: { kind: 'plugin', name: 'working-agreement' } })
    await endTurn($)
    await clock.settle()
    expect(commands).toEqual(['handoff'])
  })
}
