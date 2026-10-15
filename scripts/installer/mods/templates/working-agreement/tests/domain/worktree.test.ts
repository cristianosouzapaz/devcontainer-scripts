import { expect, test } from 'claude-code/testing'

import { buildWriteCall } from '../support/builders'
import { readFlowStatus, readPromptContext, setPermissionMode } from '../support/helpers'
import { createWorld, root } from '../support/world'
import type { Worktree } from '../support/world'

/** A worktree on its own branch, at the unit's start, holding a change the main checkout lacks. */
const worktree: Worktree = { name: 'diagnose-1', base: 'c1', changed: ['src/a.test.ts'], hashes: { 'src/a.test.ts': 'h-test' } }

test('from a worktree, a repo write while the main checkout is on the default branch is denied', async ($, on) => {
  createWorld(on, { branch: 'main' }, { worktree })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(buildWriteCall(`${root}/src/a.ts`))).deny).toContain('git switch -c')
})

test('from a worktree, the Code step says to branch first while the main checkout is on the default branch', async ($, on) => {
  createWorld(on, { branch: 'main' }, { worktree })
  expect(await readPromptContext($)).toContain('create a branch for the issue (git switch -c <name>) first')
})

test('from a worktree, the unit-branch gate judges the main checkout\'s branch', async ($, on) => {
  const git = { branch: 'feat-a' }
  createWorld(on, git, { unit: { branch: 'feat-a' }, worktree })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call(buildWriteCall(`${root}/src/a.ts`))).deny).toBeUndefined()
  git.branch = 'feat-b'
  expect((await $.tool.call(buildWriteCall(`${root}/src/a.ts`))).deny).toContain('work is on feat-a')
})

test('from a worktree, the unit\'s own commits are counted on the main checkout', async ($, on) => {
  createWorld(on, { branch: 'feat-a', ahead: 2 }, { unit: { start: 'c1', branch: 'feat-a' }, worktree })
  const status = await readFlowStatus($)
  expect(status).toContain('feat-a · 2 ahead of main')
  expect(status).toContain('✓ Commit')
})
