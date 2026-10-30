import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { buildWriteCall } from '../support/builders'
import { endTurn, readPaneCurrentStep } from '../support/helpers'
import { createWorld } from '../support/world'

for (const tool of ['Write', 'Edit'] as const) {
  test(`${tool} leaves the pane unchanged until turn end catches up with worktree edits`, async ($, on) => {
    const checkout = { branch: 'feature', isDirty: false }
    const { views, clock } = createWorld(on, checkout, { afterTool: () => { checkout.isDirty = true } })
    await endTurn($)
    const before = [...views]
    expect(before.at(-1)?.steps.find(step => step.label === 'Code')?.state).toBe('current')
    const input = tool === 'Write' ? buildWriteCall('src/a.ts')
      : { tool: 'Edit' as const, file_path: '/repo/src/a.ts', old_string: 'before', new_string: 'after' }
    expect((await $.tool.call(input)).deny).toBeUndefined()
    await clock.settle()
    expect(views).toEqual(before)
    await endTurn($)
    expect(views.at(-1)?.steps.find(step => step.label === 'Code')?.state).toBe('done')
    expect(readPaneCurrentStep(views)).toBe('Verify')
  })
}

for (const [name, input, output, appears] of [
  ['a worktree subagent', { isolation: 'worktree' }, { status: 'started' }, true],
  ['a teammate without isolation', {}, { status: 'teammate_spawned' }, true],
  ['a plain Agent call', {}, { status: 'started' }, false],
] as const) {
  test(`Agent call notes worktree visibility for ${name}`, async ($, on) => {
    on('tool.call', { tool: 'Agent' }, () => ({ result: output }))
    createWorld(on, { branch: 'feature' })
    const context = (await $.tool.call({ tool: 'Agent', description: 'help', prompt: 'help', ...input } as never)).context?.join('') ?? ''
    if (appears) expect(context).toContain("does not see the unit's uncommitted changes")
    else expect(context).not.toContain("does not see the unit's uncommitted changes")
  })
}

test('a tool call whose check fails is denied with the error that failed it', async ($, on) => {
  createWorld(on, { branch: 'feature' }, { failing: 'git rev-parse --path-format=absolute --git-common-dir' })
  const deny = (await $.tool.call(buildWriteCall('src/a.ts'))).deny ?? ''
  expect(deny).toContain('The check failed')
  expect(deny).toContain('process.run')
})
