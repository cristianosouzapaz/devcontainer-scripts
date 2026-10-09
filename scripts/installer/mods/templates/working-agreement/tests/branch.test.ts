import { expect, test } from 'claude-code/testing'

import { promptContext, setPermissionMode, writeCall } from './helpers'
import { root, world } from './world'

for (const permission of ['default', 'auto']) {
  test(`a repo write on the default branch is denied in ${permission} mode`, async ($, on) => {
    world(on, { branch: 'main' })
    await setPermissionMode($, permission)
    const r = await $.tool.call(writeCall(`${root}/src/a.ts`))
    expect(r.deny).toContain('git switch -c')
  })
}

test('a repo write on a feature branch is allowed and ties the issue to that branch', async ($, on) => {
  const git = { branch: 'feat-a' }
  world(on, git)
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(writeCall(`${root}/src/a.ts`))).deny).toBeUndefined()
  git.branch = 'feat-b'
  expect((await $.tool.call(writeCall(`${root}/src/a.ts`))).deny).toContain('work is on feat-a')
})

test('a unit saved on the default branch does not hold a feature branch back', async ($, on) => {
  world(on, { branch: 'feat-a' }, { unit: { branch: 'main' } })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(writeCall(`${root}/src/a.ts`))).deny).toBeUndefined()
})

test('a write outside the repository on the default branch is allowed', async ($, on) => {
  world(on, { branch: 'main' })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(writeCall('/tmp/notes.md'))).deny).toBeUndefined()
})

test('on the default branch, the Code step says to branch first', async ($, on) => {
  world(on, { branch: 'main' })
  const ctx = await promptContext($)
  expect(ctx).toContain('current step: Code')
  expect(ctx).toContain('create a branch for the issue (git switch -c <name>) first')
})

test('a unit saved with fields of the wrong type still gets its writes checked', async ($, on) => {
  world(on, { branch: 'main' }, { unit: { overrides: { step: 'code' }, skills: 'grilling', verify: 1, pr: 'open' } })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(writeCall(`${root}/src/a.ts`))).deny).toContain('git switch -c')
})
