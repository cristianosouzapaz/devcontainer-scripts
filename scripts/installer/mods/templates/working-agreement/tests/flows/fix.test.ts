import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildBashCall, buildDiagnosis, buildWriteCall, noFlow, verifyFile } from '../support/builders'
import { declareFlow, postComment, readCurrentStep, readFlowStatus, runFlowCommand, startSkill } from '../support/helpers'
import { createWorld, root } from '../support/world'
import type { Checkout, IssueComment, Options, Worktree } from '../support/world'

const diagnosisLink = 'https://github.com/o/r/issues/1#issuecomment-1'
const prCreated = { result: { stdout: 'https://github.com/o/r/pull/5\n', gitOperation: { pr: { number: 5, action: 'created' } } } }

// Only the last diagnosis comment is approved, so the earlier ones are voided.
async function reachPullRequestStep($: Engine, on: On, extraDiagnoses = 0): Promise<Options> {
  const git: Checkout = { branch: 'fix' }
  const worktree: Worktree = { name: 'diagnose-1', base: 'c5', changed: [] }
  const options: Options = { session: noFlow, verifyFile, toolRun: { result: { stdout: '' } }, issueLabels: { 1: ['ready-for-agent'] }, worktree, cwd: root, issueComments: {} }
  createWorld(on, git, options)
  await declareFlow($, 'fix', [1])
  await startSkill($, 'diagnosing-bugs')
  await $.tool.call({ tool: 'EnterWorktree', name: 'diagnose-1' })
  Object.assign(worktree, { changed: ['test/fix.bats'], hashes: { 'test/fix.bats': 'h1' } })
  options.toolRun = { isError: true, result: { stdout: '', stderr: '', interrupted: false } }
  await $.tool.call(buildBashCall('bats test/fix.bats'))
  options.toolRun = { result: { stdout: '' } }
  await $.tool.call(buildBashCall('bats test/fix.bats'))
  for (const _ of Array.from({ length: extraDiagnoses + 1 })) await postComment($, options.issueComments as Record<number, IssueComment[]>, buildDiagnosis('bats test/fix.bats'))
  await runFlowCommand($, 'approve diagnose')
  await $.tool.call({ tool: 'ExitWorktree', action: 'keep' })
  Object.assign(git, { isDirty: true, changed: ['test/fix.bats', 'src/fix.sh'], hashes: { 'test/fix.bats': 'h1' } })
  Object.assign(worktree, { isRemoved: true, isBranchDeleted: true })
  await $.tool.call(buildWriteCall('src/fix.sh'))
  await $.tool.call(buildBashCall('./test/run.sh'))
  await startSkill($, 'generate-commit')
  Object.assign(git, { isDirty: false, ahead: 1, changed: undefined })
  await startSkill($, 'create-pr')
  return options
}

test('a Fix PR body without the approved diagnosis comment link is denied with the missing line, and with it the PR step is done', async ($, on) => {
  const options = await reachPullRequestStep($, on)
  const denied = await $.tool.call(buildBashCall('gh pr create --title t --body "Closes #1"'))
  expect(JSON.stringify(denied.deny)).toContain(`the approved diagnosis comment link ${diagnosisLink}`)
  expect(JSON.stringify(denied.deny)).toContain('add the approved diagnosis comment link')
  expect(JSON.stringify(denied.deny)).not.toContain('Closes #<n>')
  options.prView = { body: `Closes #1\n${diagnosisLink}`, headRefOid: 'c1' }
  options.toolRun = prCreated
  expect((await $.tool.call(buildBashCall(`gh pr create --title t --body "Closes #1 ${diagnosisLink}"`))).deny).toBeUndefined()
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

test('a Fix PR body linking an older, voided diagnosis comment still lacks the approved one', async ($, on) => {
  const options = await reachPullRequestStep($, on, 1)
  options.prView = { body: `Closes #1\n${diagnosisLink}`, headRefOid: 'c1' }
  options.toolRun = prCreated
  const denied = await $.tool.call(buildBashCall(`gh pr create --title t --body "Closes #1 ${diagnosisLink}"`))
  expect(JSON.stringify(denied.deny)).toContain('the approved diagnosis comment link https://github.com/o/r/issues/1#issuecomment-2')
})

test('a Fix on a triaged issue finds Triage done, diagnoses red to green in a worktree, and runs through Code, Verify and Commit to a PR that finishes the unit', async ($, on) => {
  const git: Checkout = { branch: 'fix' }
  const worktree: Worktree = { name: 'diagnose-1', base: 'c5', changed: [] }
  const options: Options = { session: noFlow, verifyFile, toolRun: { result: { stdout: '' } }, issueLabels: { 1: ['ready-for-agent'] }, worktree, cwd: root, issueComments: {} }
  const { readWorktreeHead } = createWorld(on, git, options)
  await declareFlow($, 'fix', [1])
  expect(await readCurrentStep($)).toBe('Diagnose')
  expect(await readFlowStatus($)).toContain('✓ Triage')

  await startSkill($, 'diagnosing-bugs')
  await $.tool.call({ tool: 'EnterWorktree', name: 'diagnose-1' })
  expect(readWorktreeHead()).toBe('c0')
  expect((await $.tool.call(buildWriteCall('test/fix.bats'))).deny).toBeDefined()
  expect((await $.tool.call(buildWriteCall(`${root}/.claude/worktrees/diagnose-1/test/fix.bats`))).deny).toBeUndefined()
  Object.assign(worktree, { changed: ['test/fix.bats'], hashes: { 'test/fix.bats': 'h1' } })
  options.toolRun = { isError: true, result: { stdout: '', stderr: '', interrupted: false } }
  await $.tool.call(buildBashCall('bats test/fix.bats'))
  expect(await readFlowStatus($)).toContain('▸ Diagnose\n    ✓ Red\n    ▸ Green')
  options.toolRun = { result: { stdout: '' } }
  await $.tool.call(buildBashCall('bats test/fix.bats'))
  expect(await readFlowStatus($)).toContain('✓ Green\n    ▸ Diagnosis')
  await postComment($, options.issueComments as Record<number, IssueComment[]>, buildDiagnosis('bats test/fix.bats'))
  expect(await readFlowStatus($)).toContain('✓ Diagnosis\n    ▸ Approval')
  await runFlowCommand($, 'approve diagnose')
  expect(await readCurrentStep($)).toBe('Code')

  await $.tool.call({ tool: 'ExitWorktree', action: 'keep' })
  expect((await $.tool.call(buildWriteCall('src/fix.sh'))).deny).toBeUndefined()
  Object.assign(git, { isDirty: true, changed: ['test/fix.bats', 'src/fix.sh'], hashes: { 'test/fix.bats': 'h1' } })
  Object.assign(worktree, { isRemoved: true, isBranchDeleted: true })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await readCurrentStep($)).toBe('Commit')

  await startSkill($, 'generate-commit')
  Object.assign(git, { isDirty: false, ahead: 1, changed: undefined })
  expect(await readCurrentStep($)).toBe('PR')

  await startSkill($, 'create-pr')
  options.prView = { body: `Closes #1\n${diagnosisLink}`, headRefOid: 'c1' }
  options.toolRun = prCreated
  await $.tool.call(buildBashCall(`gh pr create --title t --body "Closes #1 ${diagnosisLink}"`))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})
