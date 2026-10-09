import { expect, test } from 'claude-code/testing'

import { bashCall, declareFlow, endTurn, flowStatus, promptContext, startSkill, twoIssueCloseOut } from './helpers'
import { root, world } from './world'
import type { Options } from './world'

// On a Close out of #1 and #2 Verify is absent because the world places no verify file, so the PR checks are the only gate.
const created = { result: { stdout: 'https://github.com/o/r/pull/5\n', gitOperation: { pr: { number: 5, action: 'created' } } } }
const closes = 'Closes #1\nCloses #2'
const edit = bashCall(`gh pr edit 5 --body "${closes}"`)
// Read-backs of a gh pr edit under create-pr that must not confirm the update, each as the options it changes.
const unconfirmed: [string, Options][] = [
  ['a read-back body that lacks a Closes line leaves PR current', { prView: { body: 'Closes #1', headRefOid: 'c1' } }],
  ['a read-back head that is not the local HEAD leaves PR current', { prView: { body: closes, headRefOid: 'c0' } }],
  ['a failing gh pr edit leaves PR current', { toolRun: { isError: true, result: { stdout: '' } } }],
  ['a gh pr view that fails leaves PR current', { prView: { isFailing: true } }],
  ['a gh pr view that prints no JSON leaves PR current', { prView: { raw: 'not json' } }],
  ['a gh pr view whose JSON lacks headRefOid leaves PR current', { prView: { raw: JSON.stringify({ body: closes }) } }],
  ['a gh pr view whose JSON lacks body leaves PR current', { prView: { raw: JSON.stringify({ headRefOid: 'c1' }) } }],
]

const pr = (body: string) => bashCall(`gh pr create --title t ${body}`)
const editCall = (args: string) => bashCall(`gh pr edit 5 ${args}`)
// A Close out one commit ahead whose PR #5 is open: only the PR step is left.
const updating = (extra: Options = {}): Options => ({
  ...twoIssueCloseOut, unit: { skills: ['generate-commit'], pr: { number: 5, state: 'OPEN' } }, prView: { body: closes, headRefOid: 'c1' }, ...extra,
})

test('gh pr create needs a Closes line for every declared issue', async ($, on) => {
  world(on, { branch: 'feat' }, twoIssueCloseOut)
  expect((await $.tool.call(pr('--body "Closes #1"'))).deny).toContain('Closes #2')
  expect((await $.tool.call(pr('--body "Closes #1\nCloses #2"'))).deny).toBeUndefined()
})

test('gh pr create reads the Closes lines from --body-file', async ($, on) => {
  world(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: 'Closes #1\nCloses #2' } })
  expect((await $.tool.call(pr(`--body-file ${root}/one.md`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(pr(`--body-file ${root}/both.md`))).deny).toBeUndefined()
})

test('gh pr create on a dirty working tree is denied', async ($, on) => {
  world(on, { branch: 'feat', isDirty: true }, twoIssueCloseOut)
  expect((await $.tool.call(pr('--body "Closes #1\nCloses #2"'))).deny).toContain('working tree is dirty')
})

test('gh pr create in a follow-up on a merged PR needs a Refs line for its issue', async ($, on) => {
  world(on, { branch: 'feat' }, { session: { flow: 'follow-up-merged', followUp: 1 } })
  expect((await $.tool.call(pr('--body "Closes #1"'))).deny).toContain('lacks Refs #1')
  expect((await $.tool.call(pr('--body "Refs #1"'))).deny).toBeUndefined()
})

test('gh pr create in a follow-up that lost its issue is denied', async ($, on) => {
  world(on, { branch: 'feat' }, { session: { flow: 'follow-up-merged' } })
  expect((await $.tool.call(pr('--body "Refs #1"'))).deny).toContain('follow-up issue is unknown')
})

test('a failing gh pr create leaves PR current, and a create confirmed by read-back finishes the unit', async ($, on) => {
  const options: Options = { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prView: { body: closes, headRefOid: 'c1' }, toolRun: { isError: true, result: { stdout: '' } } }
  world(on, { branch: 'feat', ahead: 1 }, options)
  await startSkill($, 'create-pr')
  const create = pr('--body "Closes #1\nCloses #2"')
  await $.tool.call(create)
  expect(await promptContext($)).toContain('current step: PR')
  options.toolRun = created
  await $.tool.call(create)
  expect(await flowStatus($)).toContain('Unit finished.')
})

test('starting create-pr alone leaves PR current, and the instruction asks to update the open PR', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, updating())
  expect(await promptContext($)).toContain('Next action: run the create-pr skill to update PR #5 (body must carry Closes #1, Closes #2).')
  await startSkill($, 'create-pr')
  expect(await flowStatus($)).not.toContain('Unit finished.')
  expect(await promptContext($)).toContain('current step: Update PR #5')
})

test('a PR created without the create-pr skill active is not confirmed, and one created under it is', async ($, on) => {
  const options: Options = { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prView: { body: closes, headRefOid: 'c1' }, toolRun: created }
  world(on, { branch: 'feat', ahead: 1 }, options)
  await $.tool.call(pr('--body "Closes #1\nCloses #2"'))
  expect(await promptContext($)).toContain('Next action: run the create-pr skill')
  expect(await flowStatus($)).not.toContain('Unit finished.')
  await startSkill($, 'create-pr')
  await $.tool.call(pr('--body "Closes #1\nCloses #2"'))
  expect(await flowStatus($)).toContain('Unit finished.')
})

test('a successful gh pr edit under create-pr whose read-back carries every line at HEAD finishes the unit', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, updating())
  await startSkill($, 'create-pr')
  await $.tool.call(edit)
  const text = await flowStatus($)
  expect(text).toContain('Unit finished.')
  expect(text).not.toContain('stale')
})

for (const [name, extra] of unconfirmed) {
  test(name, async ($, on) => {
    world(on, { branch: 'feat', ahead: 1 }, updating(extra))
    await startSkill($, 'create-pr')
    await $.tool.call(edit)
    expect(await flowStatus($)).not.toContain('Unit finished.')
  })
}

test('a malformed stored prHead reads as absent: PR stays current and is not stale', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, updating({ unit: { skills: ['generate-commit'], pr: { number: 5, state: 'OPEN' }, prHead: 7 } }))
  const text = await flowStatus($)
  expect(text).toContain('Update PR #5')
  expect(text).not.toContain('stale')
  expect(await promptContext($)).toContain('current step: Update PR #5. Next action: run the create-pr skill to update')
})

test('a merged-PR follow-up with an open PR on record still reads PR and asks to open the PR', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, { session: { flow: 'follow-up-merged', followUp: 1 }, unit: { skills: ['generate-commit'], pr: { number: 5, state: 'OPEN' } } })
  expect(await flowStatus($)).not.toContain('Update PR')
  const line = await promptContext($)
  expect(line).toContain('current step: PR.')
  expect(line).not.toContain('update PR #5')
})

test('a gh pr edit after create-pr ran in an earlier turn leaves PR current', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, updating())
  await startSkill($, 'create-pr')
  await endTurn($)
  await $.tool.call(edit)
  expect(await flowStatus($)).not.toContain('Unit finished.')
})

test('a confirmed update goes stale when HEAD moves, and asks to push then run create-pr again', async ($, on) => {
  const git = { branch: 'feat', ahead: 1 }
  world(on, git, updating())
  await startSkill($, 'create-pr')
  await $.tool.call(edit)
  git.ahead = 2
  const text = await flowStatus($)
  expect(text).toMatch(/Update PR #5 {2}stale/)
  expect(text).not.toContain('Unit finished.')
  expect(await promptContext($)).toContain('push the branch, then run the create-pr skill again to update PR #5')
})

test('a confirmed update marks the PR written, so the session cannot declare another flow', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, updating())
  await startSkill($, 'create-pr')
  await $.tool.call(edit)
  expect((await declareFlow($, 'fix', [])).deny).toContain('PR was already created')
})

test('the PR step reads Update PR #<n> with an open PR on record, and PR without one', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'], pr: { number: 5, state: 'OPEN' } } })
  expect(await flowStatus($)).toContain('Update PR #5')
  expect(await promptContext($)).toContain('current step: Update PR #5')
})

test('the PR step reads PR with no PR on record', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] } })
  expect(await flowStatus($)).not.toContain('Update PR')
  expect(await promptContext($)).toContain('current step: PR.')
})

test('a unit with no recorded branch discovers its open PR from the current branch', async ($, on) => {
  const { clock } = world(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prs: [{ number: 7, state: 'OPEN' }] })
  await clock.advance(61000)
  expect(await flowStatus($)).toContain('Update PR #7')
})

test('no PR is discovered from the default branch', async ($, on) => {
  const { clock } = world(on, { branch: 'main', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prs: [{ number: 7, state: 'OPEN' }] })
  await clock.advance(61000)
  expect(await flowStatus($)).not.toContain('Update PR')
})

test('a Trivial change with an open PR pushes to it, never asks for create-pr, and is done once pushed', async ($, on) => {
  const git = { branch: 'feat', ahead: 1, isPushed: false }
  const { clock } = world(on, git, { session: { flow: 'trivial', issues: [], hadIssue: false, info: {} }, prs: [{ number: 5, state: 'OPEN' }] })
  await clock.advance(61000)
  expect(await flowStatus($)).toContain('Push to PR #5')
  const line = await promptContext($)
  expect(line).toContain('push the branch to PR #5')
  expect(line).not.toContain('create-pr')
  git.isPushed = true
  expect(await flowStatus($)).toContain('Unit finished.')
})

test('gh pr create reads the Closes lines from -b and -F', async ($, on) => {
  world(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes } })
  expect((await $.tool.call(pr('-b "Closes #1"'))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(pr(`-F ${root}/one.md`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(pr(`-b "${closes}"`))).deny).toBeUndefined()
  expect((await $.tool.call(pr(`-F ${root}/both.md`))).deny).toBeUndefined()
})

test('gh pr edit that sets the body needs a Closes line for every declared issue', async ($, on) => {
  world(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes } })
  expect((await $.tool.call(editCall('--body "Closes #1"'))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(editCall('-b "Closes #1"'))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(editCall(`--body-file ${root}/one.md`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(editCall(`--body-file=${root}/one.md`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(editCall(`-F ${root}/one.md`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(editCall(`--body "${closes}"`))).deny).toBeUndefined()
  expect((await $.tool.call(editCall(`-F ${root}/both.md`))).deny).toBeUndefined()
})

test('gh pr edit that only changes a label is not checked for Closes lines', async ($, on) => {
  world(on, { branch: 'feat' }, twoIssueCloseOut)
  expect((await $.tool.call(editCall('--add-label x'))).deny).toBeUndefined()
})

test('gh pr edit that sets the body on a dirty working tree is denied', async ($, on) => {
  world(on, { branch: 'feat', isDirty: true }, twoIssueCloseOut)
  expect((await $.tool.call(editCall(`--body "${closes}"`))).deny).toContain('working tree is dirty')
})

test('gh pr edit that only changes a label is not denied on a dirty working tree', async ($, on) => {
  world(on, { branch: 'feat', isDirty: true }, twoIssueCloseOut)
  expect((await $.tool.call(editCall('--add-label x'))).deny).toBeUndefined()
})
