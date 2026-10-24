import { expect, test } from 'claude-code/testing'
import { runFlowCommand } from '../support/helpers'
import { createWorld, root } from '../support/world'

const userOnly = ['trivial', 'follow-up #1', 'handoff', 'skip code reviewed']
test('the user-only /flow subcommands are refused unless typed at the prompt', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  for (const args of userOnly) {
    const result = await runFlowCommand($, args, { kind: 'plugin', name: 'working-agreement' })
    expect(result.text, args).toContain("is the user's to run from the prompt")
  }
})

test('/flow registration names every handler subcommand', async ($, on) => {
  const { registeredCommands } = createWorld(on, { branch: 'feat' })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  const flow = registeredCommands.find(command => command.name === 'flow')
  for (const subcommand of ['status', 'handoff', 'trivial', 'follow-up', 'skip', 'approve']) {
    expect(flow?.description).toContain(subcommand)
    expect(flow?.argumentHint).toContain(subcommand)
  }
})
