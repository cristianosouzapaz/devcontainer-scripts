import { expect, test } from 'claude-code/testing'

import { buildBashCall, buildWriteCall, noFlow } from '../support/builders'
import { readFlowStatus, runFlowCommand, startSkill } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Options } from '../support/world'

// Every test starts with no flow declared, as a follow-up starts only in a new session; with no prompt yet the permission mode is unknown, so an ask denies.
const write = buildWriteCall('src/a.ts')

const buildPr = (state: string, body = 'Closes #1') => ({ number: 5, state, headRefName: 'feat-1', headRefOid: 'c3', body })
const buildPrCreate = (body: string) => buildBashCall(`gh pr create --title t --body "${body}"`)
const buildPrEdit = (body: string) => buildBashCall(`gh pr edit 5 --body "${body}"`)

test('a follow-up is refused for an issue no PR resolves', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, prs: [buildPr('OPEN', 'Closes #2')] })
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('has no PR')
  expect((await $.tool.call(write)).deny).toContain('no flow declared')
})

test('a follow-up on an open PR continues on the PR head branch', async ($, on) => {
  const git = { branch: 'other', ahead: 3 }
  createWorld(on, git, { session: noFlow, prs: [buildPr('OPEN')] })
  await runFlowCommand($, 'follow-up #1')
  expect((await $.tool.call(write)).deny).toContain('is on feat-1')
  git.branch = 'feat-1'
  expect((await $.tool.call(write)).deny).toBeUndefined()
})

test('a follow-up on a merged PR needs a Refs line on its own PR', async ($, on) => {
  createWorld(on, { branch: 'feat-2' }, { session: noFlow, prs: [buildPr('MERGED')] })
  await runFlowCommand($, 'follow-up #1')
  expect((await $.tool.call(buildPrCreate('Closes #1'))).deny).toContain('lacks Refs #1')
  expect((await $.tool.call(buildPrCreate('Refs #1'))).deny).toBeUndefined()
})

test('a follow-up on an open PR ends on updating that PR', async ($, on) => {
  createWorld(on, { branch: 'feat-1' }, { session: noFlow, prs: [buildPr('OPEN')] })
  await runFlowCommand($, 'follow-up #1')
  expect(await readFlowStatus($)).toContain('Update PR #5')
})

test('a follow-up on an open PR is done once an update keeps a line linking its issue', async ($, on) => {
  const options: Options = { session: noFlow, prs: [buildPr('OPEN')], prView: { body: 'no link', headRefOid: 'c4' } }
  createWorld(on, { branch: 'feat-1', ahead: 4 }, options)
  await runFlowCommand($, 'follow-up #1')
  await startSkill($, 'generate-commit')
  await startSkill($, 'create-pr')
  await $.tool.call(buildPrEdit('Refs #1'))
  expect(await readFlowStatus($)).not.toContain('Unit finished.')
  options.prView = { body: 'Refs #1', headRefOid: 'c4' }
  await $.tool.call(buildPrEdit('Refs #1'))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a follow-up on an open PR denies an edit whose body drops the line linking its issue', async ($, on) => {
  createWorld(on, { branch: 'feat-1' }, { session: noFlow, prs: [buildPr('OPEN')] })
  await runFlowCommand($, 'follow-up #1')
  expect((await $.tool.call(buildPrEdit('no link'))).deny).toContain('lacks Closes|Refs|Fixes|Resolves #1')
  expect((await $.tool.call(buildPrEdit('no link'))).deny).toContain('keep a line linking #1 (Closes, Refs, Fixes or Resolves)')
  expect((await $.tool.call(buildPrEdit('Fixes #1'))).deny).toBeUndefined()
  expect((await $.tool.call(buildPrEdit('Closes #1'))).deny).toBeUndefined()
})
