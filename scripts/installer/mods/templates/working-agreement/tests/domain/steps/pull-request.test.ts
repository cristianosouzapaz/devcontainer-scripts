import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { buildBashCall, buildWriteCall, noFlow, twoIssueCloseOut } from '../../support/builders'
import { declareFlow, endTurn, readFlowStatus, readPromptContext, runFlowCommand, startSkill } from '../../support/helpers'
import { createWorld, root } from '../../support/world'
import type { Options } from '../../support/world'

/** A PR sync held on `gh pr list`, and the clock to let it finish once released. */
interface PausedSync { release: () => void; clock: MockClock }

/** A read-back of a gh pr edit under create-pr that must not confirm the update, as the case title reads and the options it changes. */
interface UnconfirmedEdit { name: string; options: Options }

// On a Close out of #1 and #2 Verify is absent because the world places no verify file, so the PR checks are the only gate.
const created = { result: { stdout: 'https://github.com/o/r/pull/5\n', gitOperation: { pr: { number: 5, action: 'created' } } } }
const createdRefs = { result: { stdout: 'https://github.com/o/r/pull/6\n', gitOperation: { pr: { number: 6, action: 'created' } } } }
const closes = 'Closes #1\nCloses #2'
const prEditCall = buildBashCall(`gh pr edit 5 --body "${closes}"`)

const unconfirmedEdits: UnconfirmedEdit[] = [
  { name: 'a read-back body that lacks a Closes line leaves PR current', options: { prView: { body: 'Closes #1', headRefOid: 'c1' } } },
  { name: 'a read-back head that is not the local HEAD leaves PR current', options: { prView: { body: closes, headRefOid: 'c0' } } },
  { name: 'a failing gh pr edit leaves PR current', options: { toolRun: { isError: true, result: { stdout: '' } } } },
  { name: 'a gh pr view that fails leaves PR current', options: { prView: { isFailing: true } } },
  { name: 'a gh pr view that prints no JSON leaves PR current', options: { prView: { raw: 'not json' } } },
  { name: 'a gh pr view whose JSON lacks headRefOid leaves PR current', options: { prView: { raw: JSON.stringify({ body: closes }) } } },
  { name: 'a gh pr view whose JSON lacks body leaves PR current', options: { prView: { raw: JSON.stringify({ headRefOid: 'c1' }) } } },
]

// A Fix of #1 declared at HEAD on a branch that already carries the open PR #7 of other work.
const declaredOnOthersPr: Options = {
  session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } }, unit: { skills: [], start: 'c1' }, prs: [{ number: 7, state: 'OPEN' }],
}

function buildPrCreateCall(body: string) {
  return buildBashCall(`gh pr create --title t ${body}`)
}

function buildPrEditCall(args: string) {
  return buildBashCall(`gh pr edit 5 ${args}`)
}

// A Close out one commit ahead whose PR #5 is open: only the PR step is left.
function buildOpenPrOptions(extra: Options = {}): Options {
  return { ...twoIssueCloseOut, unit: { skills: ['generate-commit'], pr: { number: 5, state: 'OPEN' } }, prView: { body: closes, headRefOid: 'c1' }, ...extra }
}

// A merged-PR follow-up one commit ahead whose PR #6 is open; the read-back is what GitHub answers.
function buildMergedFollowUpOptions(prView?: Options['prView']): Options {
  return { session: { flow: 'follow-up-merged', followUp: 1 }, unit: { skills: ['generate-commit'], pr: { number: 6, state: 'OPEN', isCreated: true } }, prView }
}

// A Trivial change one commit ahead whose open PR #5 GitHub lists; the read-back is what `gh pr view` answers.
function buildTrivialOnOpenPrOptions(): Options {
  return { session: { flow: 'trivial', issues: [], info: {} }, prs: [{ number: 5, state: 'OPEN' }] }
}

// A PR sync in flight: the periodic refresh reads GitHub off the lock while `gh pr list` is held.
async function startPausedSync($: Engine, on: On): Promise<PausedSync> {
  const gate: { release: () => void } = { release: () => undefined }
  const options: Options = { ...twoIssueCloseOut, unit: {}, prs: [{ number: 5, state: 'OPEN' }] }
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
  options.prsGate = new Promise<void>(resolve => { gate.release = resolve })
  await clock.advance(61000)
  await $.tool.call(buildBashCall('echo hi'))
  await clock.settle()
  return { release: () => gate.release(), clock }
}

test('gh pr create needs a Closes line for every declared issue', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueCloseOut)
  expect((await $.tool.call(buildPrCreateCall('--body "Closes #1"'))).deny).toContain('Closes #2')
  expect((await $.tool.call(buildPrCreateCall('--body "Closes #1\nCloses #2"'))).deny).toBeUndefined()
})

test('gh pr create reads the Closes lines from --body-file', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: 'Closes #1\nCloses #2' } })
  expect((await $.tool.call(buildPrCreateCall(`--body-file ${root}/one.md`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildPrCreateCall(`--body-file ${root}/both.md`))).deny).toBeUndefined()
})

test('gh pr create written over several lines with backslash continuations reads its Closes lines', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueCloseOut)
  expect((await $.tool.call(buildBashCall(`gh pr create \\\n  --title t \\\n  --body 'Closes #1'`))).deny).toContain('Closes #2')
  expect((await $.tool.call(buildBashCall(`gh pr create \\\n  --title t \\\n  --body '${closes}'`))).deny).toBeUndefined()
})

test('gh pr create on a dirty working tree is denied', async ($, on) => {
  createWorld(on, { branch: 'feat', isDirty: true }, twoIssueCloseOut)
  expect((await $.tool.call(buildPrCreateCall('--body "Closes #1\nCloses #2"'))).deny).toContain('working tree is dirty')
})

test('gh pr create in a follow-up on a merged PR needs a Refs line for its issue', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { flow: 'follow-up-merged', followUp: 1 } })
  expect((await $.tool.call(buildPrCreateCall('--body "Closes #1"'))).deny).toContain('lacks Refs #1')
  expect((await $.tool.call(buildPrCreateCall('--body "Refs #1"'))).deny).toBeUndefined()
})

test('gh pr create in a follow-up that lost its issue is denied', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { flow: 'follow-up-merged' } })
  expect((await $.tool.call(buildPrCreateCall('--body "Refs #1"'))).deny).toContain('follow-up issue is unknown')
})

test('a failing gh pr create leaves PR current, and a create confirmed by read-back finishes the unit', async ($, on) => {
  const options: Options = { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prView: { body: closes, headRefOid: 'c1' }, toolRun: { isError: true, result: { stdout: '' } } }
  createWorld(on, { branch: 'feat', ahead: 1 }, options)
  await startSkill($, 'create-pr')
  const createCall = buildPrCreateCall('--body "Closes #1\nCloses #2"')
  await $.tool.call(createCall)
  expect(await readPromptContext($)).toContain('current step: PR')
  options.toolRun = created
  await $.tool.call(createCall)
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a PR the unit created under create-pr reads PR #<n>, not Update PR #<n>', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prView: { body: closes, headRefOid: 'c1' }, toolRun: created })
  await startSkill($, 'create-pr')
  await $.tool.call(buildPrCreateCall('--body "Closes #1\nCloses #2"'))
  const text = await readFlowStatus($)
  expect(text).toContain('PR #5')
  expect(text).not.toContain('Update PR')
})

test('a stored PR the unit created reads PR #<n>, and the periodic refresh keeps that when it rewrites the state', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'], pr: { number: 5, state: 'CLOSED', isCreated: true } }, prs: [{ number: 5, state: 'OPEN' }] })
  await clock.advance(61000)
  const text = await readFlowStatus($)
  expect(text).toContain('PR #5')
  expect(text).not.toContain('Update PR')
})

test('starting create-pr alone leaves PR current, and the instruction asks to update the open PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, buildOpenPrOptions())
  expect(await readPromptContext($)).toContain('Next action: run the create-pr skill to update PR #5 (body must carry Closes #1, Closes #2).')
  await startSkill($, 'create-pr')
  expect(await readFlowStatus($)).not.toContain('Unit finished.')
  expect(await readPromptContext($)).toContain('current step: Update PR #5')
})

test('a PR created without the create-pr skill active is not confirmed, and one created under it is', async ($, on) => {
  const options: Options = { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prView: { body: closes, headRefOid: 'c1' }, toolRun: created }
  createWorld(on, { branch: 'feat', ahead: 1 }, options)
  await $.tool.call(buildPrCreateCall('--body "Closes #1\nCloses #2"'))
  expect(await readPromptContext($)).toContain('Next action: run the create-pr skill')
  expect(await readFlowStatus($)).not.toContain('Unit finished.')
  await startSkill($, 'create-pr')
  await $.tool.call(buildPrCreateCall('--body "Closes #1\nCloses #2"'))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a successful gh pr edit under create-pr whose read-back carries every line at HEAD finishes the unit', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, buildOpenPrOptions())
  await startSkill($, 'create-pr')
  await $.tool.call(prEditCall)
  const text = await readFlowStatus($)
  expect(text).toContain('Unit finished.')
  expect(text).not.toContain('stale')
})

test('a gh pr create under create-pr after its nested generate-pr confirms the PR and finishes the unit', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prView: { body: closes, headRefOid: 'c1' }, toolRun: created })
  await startSkill($, 'create-pr')
  await startSkill($, 'generate-pr')
  await $.tool.call(buildPrCreateCall('--body "Closes #1\nCloses #2"'))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a gh pr edit under create-pr after its nested generate-pr confirms the update and finishes the unit', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, buildOpenPrOptions())
  await startSkill($, 'create-pr')
  await startSkill($, 'generate-pr')
  await $.tool.call(prEditCall)
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

for (const { name, options } of unconfirmedEdits) {
  test(name, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, buildOpenPrOptions(options))
    await startSkill($, 'create-pr')
    await $.tool.call(prEditCall)
    expect(await readFlowStatus($)).not.toContain('Unit finished.')
  })
}

test('a malformed stored prHead reads as absent: PR stays current and is not stale', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, buildOpenPrOptions({ unit: { skills: ['generate-commit'], pr: { number: 5, state: 'OPEN' }, prHead: 7 } }))
  const text = await readFlowStatus($)
  expect(text).toContain('Update PR #5')
  expect(text).not.toContain('stale')
  expect(await readPromptContext($)).toContain('current step: Update PR #5. Next action: run the create-pr skill to update')
})

test('a merged-PR follow-up with an open PR on record reads Update PR and asks to update it', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { session: { flow: 'follow-up-merged', followUp: 1 }, unit: { skills: ['generate-commit'], pr: { number: 5, state: 'OPEN' } } })
  expect(await readFlowStatus($)).toContain('Update PR #5')
  expect(await readPromptContext($)).toContain('update PR #5')
})

test('a merged-PR follow-up is done once a read-back confirms the head and the Refs line', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...buildMergedFollowUpOptions({ body: 'Refs #1', headRefOid: 'c1' }), toolRun: createdRefs })
  await startSkill($, 'create-pr')
  await $.tool.call(buildPrCreateCall('--body "Refs #1"'))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a merged-PR follow-up whose read-back lacks the Refs line stays on PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...buildMergedFollowUpOptions({ body: 'Closes #1', headRefOid: 'c1' }), toolRun: createdRefs })
  await startSkill($, 'create-pr')
  await $.tool.call(buildPrCreateCall('--body "Refs #1"'))
  expect(await readFlowStatus($)).not.toContain('Unit finished.')
})

test('a merged-PR follow-up whose read-back head is not HEAD stays on PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...buildMergedFollowUpOptions({ body: 'Refs #1', headRefOid: 'c0' }), toolRun: createdRefs })
  await startSkill($, 'create-pr')
  await $.tool.call(buildPrCreateCall('--body "Refs #1"'))
  expect(await readFlowStatus($)).not.toContain('Unit finished.')
})

test('a confirmed merged-PR follow-up goes stale on a new commit, and the instruction asks to run create-pr again', async ($, on) => {
  const git = { branch: 'feat', ahead: 1, isPushed: true }
  createWorld(on, git, { ...buildMergedFollowUpOptions({ body: 'Refs #1', headRefOid: 'c1' }), toolRun: createdRefs })
  await startSkill($, 'create-pr')
  await $.tool.call(buildPrCreateCall('--body "Refs #1"'))
  await $.tool.call(buildWriteCall('src/a.ts'))
  git.ahead = 2
  const text = await readFlowStatus($)
  expect(text).toMatch(/PR #6 {2}stale/)
  expect(text).not.toContain('Unit finished.')
  expect(await readPromptContext($)).toContain('run the create-pr skill again to update PR #6')
})

test('a gh pr edit in a later turn than the one create-pr started in finishes the unit', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, buildOpenPrOptions())
  await startSkill($, 'create-pr')
  await endTurn($)
  await $.tool.call(prEditCall)
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a gh pr create in a later turn than the one create-pr started in finishes the unit', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prView: { body: closes, headRefOid: 'c1' }, toolRun: created })
  await startSkill($, 'create-pr')
  await endTurn($)
  await $.tool.call(buildPrCreateCall('--body "Closes #1\nCloses #2"'))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a gh pr edit after create-pr started in an earlier turn leaves PR unconfirmed while another step is current', async ($, on) => {
  // Nothing is committed yet, so Commit is current while the PR's read-back would otherwise confirm it at HEAD.
  createWorld(on, { branch: 'feat' }, { ...twoIssueCloseOut, unit: { skills: [] }, prView: { body: closes, headRefOid: 'c0' } })
  await startSkill($, 'create-pr')
  await endTurn($)
  await $.tool.call(prEditCall)
  expect(await readPromptContext($)).toContain('current step: Commit')
  expect(await readFlowStatus($)).not.toContain('Unit finished.')
})

test('a confirmed update goes stale when HEAD moves, and asks the user to push before create-pr runs again', async ($, on) => {
  const git = { branch: 'feat', ahead: 1, isPushed: true }
  createWorld(on, git, buildOpenPrOptions())
  await startSkill($, 'create-pr')
  await $.tool.call(prEditCall)
  await $.tool.call(buildWriteCall('src/a.ts'))
  git.ahead = 2
  git.isPushed = false
  const text = await readFlowStatus($)
  expect(text).toMatch(/Update PR #5 {2}stale/)
  expect(text).not.toContain('Unit finished.')
  expect(await readPromptContext($)).toContain('stop and ask the user to push the branch, then run the create-pr skill again to update PR #5')
  git.isPushed = true
  expect(await readPromptContext($)).toContain('Next action: run the create-pr skill again to update PR #5')
})

test('a confirmed update marks the PR written, so the session cannot declare another flow', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, buildOpenPrOptions())
  await startSkill($, 'create-pr')
  await $.tool.call(prEditCall)
  expect((await declareFlow($, 'fix', [])).deny).toContain('PR was already created')
})

test('a unit with no recorded branch discovers its open PR from the current branch', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prs: [{ number: 7, state: 'OPEN' }] })
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('Update PR #7')
})

test('a unit with no commit of its own does not adopt the open PR of the current branch', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, declaredOnOthersPr)
  await clock.advance(61000)
  expect(await readFlowStatus($)).not.toContain('PR #7')
})

test('a unit adopts the open PR of the current branch once HEAD moves past its start', async ($, on) => {
  const git = { branch: 'feat', ahead: 1 }
  const { clock } = createWorld(on, git, declaredOnOthersPr)
  git.ahead = 2
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('Update PR #7')
})

test('an edit under create-pr does not record the open PR of the current branch for a unit with no commit of its own', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...declaredOnOthersPr, prView: { body: 'Closes #1', headRefOid: 'c1' }, toolRun: { result: { stdout: '' } } })
  await startSkill($, 'create-pr')
  await $.tool.call(buildBashCall('gh pr edit --body "Closes #1"'))
  expect(await readFlowStatus($)).not.toContain('PR #7')
})

test('no PR is discovered from the default branch', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'main', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] }, prs: [{ number: 7, state: 'OPEN' }] })
  await clock.advance(61000)
  expect(await readFlowStatus($)).not.toContain('Update PR')
})

test('a Trivial change with an open PR pushes to it, never asks for create-pr, and is done only once GitHub reads back HEAD', async ($, on) => {
  const git = { branch: 'feat', ahead: 1, isPushed: false }
  const options = buildTrivialOnOpenPrOptions()
  const { clock } = createWorld(on, git, options)
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('Push to PR #5')
  const line = await readPromptContext($)
  expect(line).toContain('push the branch to PR #5')
  expect(line).not.toContain('create-pr')
  git.isPushed = true
  expect(await readFlowStatus($)).not.toContain('Unit finished.')
  options.prView = { body: '', headRefOid: 'c1' }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a Trivial change whose PR reads back another head than HEAD stays on the PR step', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1, isPushed: true }, { ...buildTrivialOnOpenPrOptions(), prView: { body: '', headRefOid: 'c0' } })
  await clock.advance(61000)
  const text = await readFlowStatus($)
  expect(text).toContain('Push to PR #5')
  expect(text).not.toContain('Unit finished.')
})

test('a Trivial change confirmed against the PR goes stale on a new commit', async ($, on) => {
  const git = { branch: 'feat', ahead: 1, isPushed: true }
  const { clock } = createWorld(on, git, { ...buildTrivialOnOpenPrOptions(), prView: { body: '', headRefOid: 'c1' } })
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('Unit finished.')
  await $.tool.call(buildWriteCall('src/a.ts'))
  git.ahead = 2
  const text = await readFlowStatus($)
  expect(text).toMatch(/Push to PR #5 {2}stale/)
  expect(text).not.toContain('Unit finished.')
})

test('gh pr create reads the Closes lines from -b and -F', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes } })
  expect((await $.tool.call(buildPrCreateCall('-b "Closes #1"'))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildPrCreateCall(`-F ${root}/one.md`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildPrCreateCall(`-b "${closes}"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildPrCreateCall(`-F ${root}/both.md`))).deny).toBeUndefined()
})

test('gh pr edit that sets the body needs a Closes line for every declared issue', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes } })
  expect((await $.tool.call(buildPrEditCall('--body "Closes #1"'))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildPrEditCall('-b "Closes #1"'))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildPrEditCall(`--body-file ${root}/one.md`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildPrEditCall(`--body-file=${root}/one.md`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildPrEditCall(`-F ${root}/one.md`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildPrEditCall(`--body "${closes}"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildPrEditCall(`-F ${root}/both.md`))).deny).toBeUndefined()
})

test('gh pr create and gh pr edit read --body-file from a variable assigned earlier in the command', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes } })
  expect((await $.tool.call(buildBashCall(`f=${root}/both.md && gh pr create --title t --body-file "$f"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall(`f=${root}/one.md && gh pr create --title t --body-file "$f"`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildBashCall(`f=${root}/both.md && gh pr edit 5 --body-file "$f"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall(`f=${root}/one.md && gh pr edit 5 --body-file "$f"`))).deny).toContain('lacks Closes #2 —')
})

test('a variable in the body-file path resolves for ${NAME}, -F and --body-file=', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes } })
  expect((await $.tool.call(buildBashCall(`f=${root}/both.md && gh pr edit 5 --body-file "\${f}"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall(`f=${root}/one.md && gh pr edit 5 --body-file "\${f}"`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildBashCall(`f=${root}/both.md && gh pr create --title t -F "$f"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall(`f=${root}/one.md && gh pr create --title t -F "$f"`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildBashCall(`f=${root}/both.md && gh pr edit 5 --body-file="$f"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall(`f=${root}/one.md && gh pr edit 5 --body-file="$f"`))).deny).toContain('lacks Closes #2 —')
})

test('a variable assigned before ; or a newline resolves the body file', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes } })
  expect((await $.tool.call(buildBashCall(`f=${root}/both.md; gh pr edit 5 --body-file "$f"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall(`f=${root}/one.md; gh pr edit 5 --body-file "$f"`))).deny).toContain('lacks Closes #2 —')
  expect((await $.tool.call(buildBashCall(`f=${root}/both.md\ngh pr edit 5 --body-file "$f"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall(`f=${root}/one.md\ngh pr edit 5 --body-file "$f"`))).deny).toContain('lacks Closes #2 —')
})

test('a quoted assignment value is unquoted before the body file is read', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes } })
  expect((await $.tool.call(buildBashCall(`f="${root}/both.md" && gh pr edit 5 --body-file "$f"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall(`f='${root}/both.md' && gh pr edit 5 --body-file "$f"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall(`f="${root}/one.md" && gh pr edit 5 --body-file "$f"`))).deny).toContain('lacks Closes #2 —')
})

test('the last assignment before the body-file read decides which file is read', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes } })
  expect((await $.tool.call(buildBashCall(`f=${root}/one.md; f=${root}/both.md && gh pr edit 5 --body-file "$f"`))).deny).toBeUndefined()
  expect((await $.tool.call(buildBashCall(`f=${root}/both.md; f=${root}/one.md && gh pr edit 5 --body-file "$f"`))).deny).toContain('lacks Closes #2 —')
})

test('an unassigned variable in the body-file path keeps the command text as the body and is denied', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...twoIssueCloseOut, files: { [`${root}/one.md`]: 'Closes #1', [`${root}/both.md`]: closes } })
  expect((await $.tool.call(buildBashCall('gh pr edit 5 --body-file "$f"'))).deny).toContain('lacks Closes')
  expect((await $.tool.call(buildBashCall('gh pr create --title t --body-file "$f"'))).deny).toContain('lacks Closes')
})

test('gh pr edit that only changes a label is not checked for Closes lines', async ($, on) => {
  createWorld(on, { branch: 'feat' }, twoIssueCloseOut)
  expect((await $.tool.call(buildPrEditCall('--add-label x'))).deny).toBeUndefined()
})

test('gh pr edit that sets the body on a dirty working tree is denied', async ($, on) => {
  createWorld(on, { branch: 'feat', isDirty: true }, twoIssueCloseOut)
  expect((await $.tool.call(buildPrEditCall(`--body "${closes}"`))).deny).toContain('working tree is dirty')
})

test('gh pr edit that only changes a label is not denied on a dirty working tree', async ($, on) => {
  createWorld(on, { branch: 'feat', isDirty: true }, twoIssueCloseOut)
  expect((await $.tool.call(buildPrEditCall('--add-label x'))).deny).toBeUndefined()
})

test('an override typed while a PR sync is in flight survives it, and the sync still records the PR', async ($, on) => {
  const sync = await startPausedSync($, on)
  await runFlowCommand($, 'override verify skipped')
  sync.release()
  await sync.clock.settle()
  const text = await readFlowStatus($)
  expect(text).toContain('Update PR #5')
  expect(text).toContain('Override  Verify')
  expect(await readPromptContext($)).toContain('current step: Update PR #5')
})

test('declaring a flow while a PR exists for the branch records the PR and does not hang', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, { session: noFlow, prs: [{ number: 5, state: 'OPEN' }], unit: { skills: ['generate-commit'] } })
  const declaration = { isSettled: false }
  void declareFlow($, 'close-out', [1]).then(() => { declaration.isSettled = true })
  await clock.settle()
  expect(declaration.isSettled).toBe(true)
  expect(await readFlowStatus($)).toContain('Update PR #5')
})
