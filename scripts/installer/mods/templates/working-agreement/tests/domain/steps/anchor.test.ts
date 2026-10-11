import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildBashCall, buildWriteCall, verifyFile } from '../../support/builders'
import { readCurrentStep, readFlowStatus } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Checkout } from '../../support/world'

// A small feature whose agent wrote, verified and had the user commit; the first observation of the clean checkout is the one the test makes next.
async function arrangeCommittedUnit($: Engine, on: On, git: Checkout): Promise<void> {
  createWorld(on, git, { verifyFile, toolRun: { result: { stdout: '' } }, unit: { start: 'c8', skills: ['generate-commit'] } })
  await $.tool.call(buildWriteCall('src/a.ts'))
  await $.tool.call(buildBashCall('./test/run.sh'))
  git.ahead = 9
  git.isDirty = false
  expect(await readCurrentStep($)).toBe('PR')
}

test('another session dirtying the working copy leaves the finished Code, Verify and Commit done', async ($, on) => {
  const git: Checkout = { branch: 'feat', ahead: 8, isDirty: true }
  await arrangeCommittedUnit($, on, git)
  Object.assign(git, { isDirty: true, tree: 'tree-b', changed: ['src/b.ts'] })
  expect(await readCurrentStep($)).toBe('PR')
  expect(await readFlowStatus($)).not.toContain('stale')
})

test('another session committing leaves an up-to-date PR done', async ($, on) => {
  const git: Checkout = { branch: 'feat', ahead: 9 }
  createWorld(on, git, { unit: { start: 'c8', skills: ['generate-commit'], pr: { number: 7, state: 'OPEN' }, prHead: 'c9' } })
  expect(await readFlowStatus($)).toContain('Unit finished.')
  git.ahead = 10
  const text = await readFlowStatus($)
  expect(text).toContain('Unit finished.')
  expect(text).not.toContain('stale')
})

test('a write by this session after its commit makes Commit stale', async ($, on) => {
  const git: Checkout = { branch: 'feat', ahead: 8, isDirty: true }
  await arrangeCommittedUnit($, on, git)
  await $.tool.call(buildWriteCall('src/c.ts'))
  Object.assign(git, { isDirty: true, tree: 'tree-a2' })
  expect(await readFlowStatus($)).toMatch(/Commit {2}stale/)
  expect(await readCurrentStep($)).not.toBe('PR')
})

test('a later commit by this session moves the anchor, and later dirt from another session leaves the steps done', async ($, on) => {
  const git: Checkout = { branch: 'feat', ahead: 8, isDirty: true }
  await arrangeCommittedUnit($, on, git)
  await $.tool.call(buildWriteCall('src/c.ts'))
  Object.assign(git, { isDirty: true, tree: 'tree-a2' })
  await $.tool.call(buildBashCall('./test/run.sh'))
  Object.assign(git, { ahead: 10, isDirty: false, commitTrees: { c10: 'tree-a2' } })
  expect(await readCurrentStep($)).toBe('PR')
  Object.assign(git, { isDirty: true, tree: 'tree-b' })
  expect(await readCurrentStep($)).toBe('PR')
  expect(await readFlowStatus($)).not.toContain('stale')
})

test('an amended commit moves the anchor, and later dirt from another session leaves the steps done', async ($, on) => {
  const git: Checkout = { branch: 'feat', ahead: 8, isDirty: true }
  await arrangeCommittedUnit($, on, git)
  Object.assign(git, { head: 'a9', commitTrees: { a9: 'tree' } })
  expect(await readCurrentStep($)).toBe('PR')
  Object.assign(git, { isDirty: true, tree: 'tree-b' })
  expect(await readCurrentStep($)).toBe('PR')
  expect(await readFlowStatus($)).not.toContain('stale')
})

test('a unit never seen clean, with a dirty tree, has a stale Commit', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 9, isDirty: true }, { unit: { start: 'c8' } })
  expect(await readFlowStatus($)).toMatch(/Commit {2}stale/)
  expect(await readCurrentStep($)).not.toBe('PR')
})

test('a rewritten commit with a dirty tree falls back to the live checkout', async ($, on) => {
  const git: Checkout = { branch: 'feat', ahead: 8, isDirty: true }
  await arrangeCommittedUnit($, on, git)
  Object.assign(git, { head: 'a9', isDirty: true, tree: 'tree-b' })
  expect(await readFlowStatus($)).toMatch(/Commit {2}stale/)
})
