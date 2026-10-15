import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildWriteCall } from '../../support/builders'
import { endTurn, readPromptContext, setPermissionMode } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Checkout } from '../../support/world'

// A Fix session at Diagnose on #1, where the main checkout is read-only.
const atDiagnose = { session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } }, unit: { skills: ['diagnosing-bugs'], start: 'c0' } }

// The verdict a Monitor call running this command gets, in a mode that never asks, so an ask shows as a deny.
const judge = async ($: Engine, command: string): Promise<string | undefined> =>
  (await $.tool.call({ tool: 'Monitor', description: 'watch', timeout_ms: 1000, command })).deny

for (const [command, step] of [['git commit -m x', 'git commit'], ['git push', 'git push'], ['gh pr merge 5 --squash', 'gh pr merge']]) {
  test(`a Monitor running ${step} is denied as the user's step`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 })
    await setPermissionMode($, 'auto')
    expect(await judge($, command ?? '')).toContain(`${step} is the user's step`)
  })
}

test('a Monitor handing an interpreter inline code is denied while a step holds writes back', async ($, on) => {
  createWorld(on, { branch: 'fix', dirty: {} }, atDiagnose)
  await setPermissionMode($, 'auto')
  expect(await judge($, "python3 -c 'patch()'")).toContain('Diagnose not done')
})

test('a Monitor running a plain command runs', async ($, on) => {
  createWorld(on, { branch: 'fix', dirty: {} }, atDiagnose)
  await setPermissionMode($, 'auto')
  expect(await judge($, 'tail -f log/app.log')).toBeUndefined()
})

test('a Monitor with only a websocket runs no command and is not judged', async ($, on) => {
  createWorld(on, { branch: 'main' })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call({ tool: 'Monitor', description: 'watch', timeout_ms: 1000, ws: { url: 'ws://localhost:1/x' } })).deny).toBeUndefined()
})

test('a change between turns while a Monitor task is in flight is not absorbed at the user\'s prompt', async ($, on) => {
  const git: Checkout = { branch: 'fix', dirty: {} }
  createWorld(on, git, { ...atDiagnose, toolRun: () => ({ result: { taskId: 'm1', timeoutMs: 1000 } }) })
  await setPermissionMode($, 'auto')
  await judge($, 'tail -f log/app.log')
  await endTurn($)
  git.dirty = { 'src/app.ts': 'h2' }
  await readPromptContext($)
  expect((await $.tool.call(buildWriteCall('test/more.bats'))).deny).toContain('src/app.ts changed outside Edit or Write')
})
