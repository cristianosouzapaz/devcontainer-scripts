import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { approvalCommand, noFlow, verifyFile } from '../support/builders'
import { buildScope, createWorld, markSpawned, scopeFile } from '../support/world'
import type { Options } from '../support/world'

const sessions: [string, Options, boolean][] = [
  ['a session with no flow', { session: noFlow }, false],
  ['a declared unit', { verifyFile }, false],
  ['a delegated unit', { verifyFile }, true],
]

const commands = [
  ['the script run directly', approvalCommand()],
  ['the script run by its bare name', 'approve-verify.sh 0123456789ab'],
  ['herdr typing into a pane', `herdr pane send-text w1:p2 '${approvalCommand()}'`],
  ['herdr sending keys to a pane', 'herdr pane send-keys w1:p2 approve-verify.sh Enter'],
  ['herdr running it in a pane', `herdr pane run w1:p2 "${approvalCommand()}"`],
  ['herdr prompting an agent with it', `herdr agent prompt unit-1 '! ${approvalCommand()}'`],
] as const

for (const [session, options, isDelegated] of sessions) {
  for (const [name, command] of commands) {
    test(`in ${session}, the Bash guard refuses ${name}`, async ($, on) => {
      const world = createWorld(on, { branch: 'feat' }, { ...options })
      if (isDelegated) {
        world.files.set(scopeFile('coord'), buildScope('coord', [1]))
        markSpawned(world, [1])
      }
      const result = await $.tool.call({ tool: 'Bash', command })
      expect(result.deny).toContain('The Verify config approval is the user\'s alone')
    })
  }
}

test('a subagent\'s Bash call naming the approval script is refused too', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { verifyFile })
  expect((await $.tool.call({ tool: 'Bash', command: approvalCommand(), agentId: 'helper' })).deny).toContain('The Verify config approval is the user\'s alone')
})

test('herdr typing that does not name the approval script is left to the other guards', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { verifyFile })
  for (const command of ['herdr pane send-text w1:p2 hello', 'herdr agent prompt unit-1 \'/flow approve verify 0123456789ab\'']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny ?? '').not.toContain('The Verify config approval is the user\'s alone')
  }
})
