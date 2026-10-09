import { expect, test } from 'claude-code/testing'

import { bashCall, setPermissionMode, startSkill, writeCall } from './helpers'
import { root, world } from './world'

// A Small feature on #1 without ready-for-agent, nothing run yet: Grill is current and its gate asks.
const atGrill = { session: { info: { 1: { title: 'feat', labels: [] } } } }
const input = { file_path: `${root}/src/a.ts`, content: '' }
// At Code on #1, whose title and labels never came back from GitHub.
const unverified = { session: { info: {} }, unit: { skills: ['grilling', 'to-spec'], produced: ['to-spec'] } }
const degraded = { unreachable: { failing: 'gh' }, 'logged out': { isLoggedOut: true } }

test('a step gate asks in default mode', async ($, on) => {
  world(on, { branch: 'feat' }, atGrill)
  await setPermissionMode($, 'default')
  expect((await $.tool.call({ tool: 'Write', ...input })).deny).toBeUndefined()
  expect((await $.tool.check({ tool: 'Write', input })).decision).toBe('ask')
})

for (const permission of ['auto', 'acceptEdits', 'bypassPermissions']) {
  test(`a step gate that would ask is denied in ${permission} mode`, async ($, on) => {
    world(on, { branch: 'feat' }, atGrill)
    await setPermissionMode($, permission)
    expect((await $.tool.call({ tool: 'Write', ...input })).deny).toContain('Grill not done')
  })
}

test('gh issue create asks outside the issue-writing skills, and goes through inside them', async ($, on) => {
  world(on, { branch: 'feat' })
  const command = 'gh issue create --title t --body b'
  await setPermissionMode($, 'default')
  expect((await $.tool.check({ tool: 'Bash', input: { command } })).decision).toBe('ask')
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(bashCall(command))).deny).toContain('gh issue create outside')
  for (const skill of ['to-spec', 'triage']) {
    await startSkill($, skill)
    expect((await $.tool.call(bashCall(command))).deny, skill).toBeUndefined()
  }
})

for (const [state, gh] of Object.entries(degraded)) {
  test(`a write under an unverified issue asks while GitHub is ${state}, and local rules still deny`, async ($, on) => {
    world(on, { branch: 'feat' }, { ...unverified, ...gh })
    await setPermissionMode($, 'default')
    expect((await $.tool.check({ tool: 'Write', input })).decision).toBe('ask')
    expect((await $.tool.call(writeCall('PLAN.md'))).deny).toContain('ephemeral')
    await setPermissionMode($, 'auto')
    expect((await $.tool.call({ tool: 'Write', ...input })).deny).toContain('GitHub is unavailable')
  })
}
