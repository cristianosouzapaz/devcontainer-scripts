import { expect, test } from 'claude-code/testing'

import { buildWriteCall } from '../../support/builders'
import { readPromptContext, setPermissionMode } from '../../support/helpers'
import { createWorld, root } from '../../support/world'

for (const permission of ['default', 'auto']) {
  test(`a repo write on the default branch is denied in ${permission} mode`, async ($, on) => {
    createWorld(on, { branch: 'main' })
    await setPermissionMode($, permission)
    const result = await $.tool.call(buildWriteCall(`${root}/src/a.ts`))
    expect(result.deny).toContain('git switch -c')
  })
}

test('a repo write on a feature branch is allowed and ties the issue to that branch', async ($, on) => {
  const git = { branch: 'feat-a' }
  createWorld(on, git)
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(buildWriteCall(`${root}/src/a.ts`))).deny).toBeUndefined()
  git.branch = 'feat-b'
  expect((await $.tool.call(buildWriteCall(`${root}/src/a.ts`))).deny).toContain('work is on feat-a')
})

test('a unit saved on the default branch does not hold a feature branch back', async ($, on) => {
  createWorld(on, { branch: 'feat-a' }, { unit: { branch: 'main' } })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(buildWriteCall(`${root}/src/a.ts`))).deny).toBeUndefined()
})

test('a write outside the repository on the default branch is allowed', async ($, on) => {
  createWorld(on, { branch: 'main' })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(buildWriteCall('/tmp/notes.md'))).deny).toBeUndefined()
})

test('on the default branch, the Code step says to branch first', async ($, on) => {
  createWorld(on, { branch: 'main' })
  const context = await readPromptContext($)
  expect(context).toContain('current step: Code')
  expect(context).toContain('create a branch for the issue (git switch -c <name>) first')
})

test('a unit saved with fields of the wrong type still gets its writes checked', async ($, on) => {
  createWorld(on, { branch: 'main' }, { unit: { overrides: { step: 'code' }, skills: 'grilling', verify: 1, pr: 'open' } })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(buildWriteCall(`${root}/src/a.ts`))).deny).toContain('git switch -c')
})
