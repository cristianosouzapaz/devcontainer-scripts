import { expect, test } from 'claude-code/testing'

import { bashCall, flow, flowStatus, noFlow, startSkill, writeCall } from './helpers'
import { world } from './world'
import type { Options } from './world'

// Every test starts with no flow declared, as a follow-up starts only in a new session; with no prompt yet the permission mode is unknown, so an ask denies.
const write = writeCall('src/a.ts')

const pr = (state: string, body = 'Closes #1') => ({ number: 5, state, headRefName: 'feat-1', headRefOid: 'c3', body })
const prCreate = (body: string) => bashCall(`gh pr create --title t --body "${body}"`)
const prEdit = (body: string) => bashCall(`gh pr edit 5 --body "${body}"`)

test('a follow-up is refused for an issue no PR resolves', async ($, on) => {
  world(on, { branch: 'feat' }, { session: noFlow, prs: [pr('OPEN', 'Closes #2')] })
  expect((await flow($, 'follow-up #1')).text).toContain('has no PR')
  expect((await $.tool.call(write)).deny).toContain('no flow declared')
})

test('a follow-up on an open PR continues on the PR head branch', async ($, on) => {
  const git = { branch: 'other', ahead: 3 }
  world(on, git, { session: noFlow, prs: [pr('OPEN')] })
  await flow($, 'follow-up #1')
  expect((await $.tool.call(write)).deny).toContain('is on feat-1')
  git.branch = 'feat-1'
  expect((await $.tool.call(write)).deny).toBeUndefined()
})

test('a follow-up on a merged PR needs a Refs line on its own PR', async ($, on) => {
  world(on, { branch: 'feat-2' }, { session: noFlow, prs: [pr('MERGED')] })
  await flow($, 'follow-up #1')
  expect((await $.tool.call(prCreate('Closes #1'))).deny).toContain('lacks Refs #1')
  expect((await $.tool.call(prCreate('Refs #1'))).deny).toBeUndefined()
})

test('a follow-up on an open PR ends on updating that PR', async ($, on) => {
  world(on, { branch: 'feat-1' }, { session: noFlow, prs: [pr('OPEN')] })
  await flow($, 'follow-up #1')
  expect(await flowStatus($)).toContain('Update PR #5')
})

test('a follow-up on an open PR is done once an update keeps a line linking its issue', async ($, on) => {
  const options: Options = { session: noFlow, prs: [pr('OPEN')], prView: { body: 'no link', headRefOid: 'c4' } }
  world(on, { branch: 'feat-1', ahead: 4 }, options)
  await flow($, 'follow-up #1')
  await startSkill($, 'generate-commit')
  await startSkill($, 'create-pr')
  await $.tool.call(prEdit('Refs #1'))
  expect(await flowStatus($)).not.toContain('Unit finished.')
  options.prView = { body: 'Refs #1', headRefOid: 'c4' }
  await $.tool.call(prEdit('Refs #1'))
  expect(await flowStatus($)).toContain('Unit finished.')
})

test('a follow-up on an open PR denies an edit whose body drops the line linking its issue', async ($, on) => {
  world(on, { branch: 'feat-1' }, { session: noFlow, prs: [pr('OPEN')] })
  await flow($, 'follow-up #1')
  expect((await $.tool.call(prEdit('no link'))).deny).toContain('lacks Closes|Refs|Fixes|Resolves #1')
  expect((await $.tool.call(prEdit('no link'))).deny).toContain('keep a line linking #1 (Closes, Refs, Fixes or Resolves)')
  expect((await $.tool.call(prEdit('Fixes #1'))).deny).toBeUndefined()
  expect((await $.tool.call(prEdit('Closes #1'))).deny).toBeUndefined()
})
