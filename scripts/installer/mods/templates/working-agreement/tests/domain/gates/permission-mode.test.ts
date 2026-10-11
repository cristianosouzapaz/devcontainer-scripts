import { expect, test } from 'claude-code/testing'

import { buildBashCall, buildWriteCall } from '../../support/builders'
import { setPermissionMode, startSkill } from '../../support/helpers'
import { createWorld, root } from '../../support/world'

// A Small feature on #1 without ready-for-agent, nothing run yet: Grill is current and its gate asks.
const atGrill = { session: { info: { 1: { title: 'feat', labels: [] } } } }
const input = { file_path: `${root}/src/a.ts`, content: '' }
// At Code on #1 past an overridden Spec, since the issue's title and labels never came back from GitHub.
const unverified = { session: { info: {} }, unit: { skills: ['grilling', 'to-spec'], overrides: [{ step: 'spec', reason: 'GitHub is down' }] } }
const degraded = { unreachable: { failing: 'gh' }, 'logged out': { isLoggedOut: true } }

test('a step gate asks in default mode', async ($, on) => {
  createWorld(on, { branch: 'feat' }, atGrill)
  await setPermissionMode($, 'default')
  expect((await $.tool.call({ tool: 'Write', ...input })).deny).toBeUndefined()
  expect((await $.tool.check({ tool: 'Write', input })).decision).toBe('ask')
})

for (const permission of ['auto', 'acceptEdits', 'bypassPermissions']) {
  test(`a step gate that would ask is denied in ${permission} mode`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, atGrill)
    await setPermissionMode($, permission)
    expect((await $.tool.call({ tool: 'Write', ...input })).deny).toContain('Grill not done')
  })
}

test('gh issue create asks outside the issue-writing skills, and goes through inside them', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  const command = 'gh issue create --title t --body b'
  await setPermissionMode($, 'default')
  expect((await $.tool.check({ tool: 'Bash', input: { command } })).decision).toBe('ask')
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(buildBashCall(command))).deny).toContain('gh issue create outside')
  for (const skill of ['to-spec', 'triage']) {
    await startSkill($, skill)
    expect((await $.tool.call(buildBashCall(command))).deny, skill).toBeUndefined()
  }
})

for (const skill of ['to-spec', 'triage']) {
  test(`gh issue create goes through inside ${skill} after a nested skill starts`, async ($, on) => {
    createWorld(on, { branch: 'feat' })
    await setPermissionMode($, 'auto')
    await startSkill($, skill)
    await startSkill($, 'grilling')
    expect((await $.tool.call(buildBashCall('gh issue create --title t --body b'))).deny).toBeUndefined()
  })
}

for (const [state, gh] of Object.entries(degraded)) {
  test(`a write under an unverified issue asks while GitHub is ${state}, and local rules still deny`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { ...unverified, ...gh })
    await setPermissionMode($, 'default')
    expect((await $.tool.check({ tool: 'Write', input })).decision).toBe('ask')
    expect((await $.tool.call(buildWriteCall('PLAN.md'))).deny).toContain('ephemeral')
    await setPermissionMode($, 'auto')
    expect((await $.tool.call({ tool: 'Write', ...input })).deny).toContain('GitHub is unavailable')
  })
}
