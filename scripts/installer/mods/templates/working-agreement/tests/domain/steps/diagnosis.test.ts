import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ToolRun } from '../../../hooks/core/command-observation'
import { buildBashCall, buildDiagnosis, noFlow } from '../../support/builders'
import { postComment, readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand } from '../../support/helpers'
import { createWorld, root } from '../../support/world'
import type { IssueComment } from '../../support/world'

const failed = { isError: true as const, result: { stdout: '', stderr: '', interrupted: false } }
const passed = { isError: undefined, result: { stdout: '', stderr: '', interrupted: false } }
const reproduction = 'bats test/fix.bats'
const composer = { kind: 'composer' } as const

// A Fix at Diagnose whose red and green are done in the worktree: the diagnosis comment is next.
async function atGreen($: Engine, on: Parameters<typeof createWorld>[0], files: string[] = ['test/fix.bats']) {
  const toolRun: ToolRun = { ...failed }
  const comments: Record<number, IssueComment[]> = {}
  const worktree = { name: 'diagnose-1', base: 'c0', changed: files, hashes: Object.fromEntries(files.map(file => [file, 'h1'])) }
  createWorld(on, { branch: 'fix', dirty: {} }, {
    session: { ...noFlow, flow: 'fix', issues: [1], info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
    unit: { skills: ['diagnosing-bugs'], start: 'c0' }, issueLabels: { 1: ['ready-for-agent'] }, worktree, cwd: root, toolRun, issueComments: comments,
  })
  await $.tool.call({ tool: 'EnterWorktree', name: 'diagnose-1' })
  await $.tool.call(buildBashCall(reproduction))
  Object.assign(toolRun, passed)
  await $.tool.call(buildBashCall(reproduction))
  return comments
}

test('after the green the instruction asks for the diagnosis comment, naming the headings, the red command and the red files', async ($, on) => {
  await atGreen($, on)
  const context = await readPromptContext($)
  expect(await readCurrentStep($)).toBe('Diagnose')
  for (const text of ['gh issue comment', 'Root cause, Evidence, Proposed fix, Regression test, Rejected hypotheses', reproduction, 'test/fix.bats']) expect(context).toContain(text)
})

test('Diagnose shows its four sub-steps, and Approval carries the hint', async ($, on) => {
  const comments = await atGreen($, on)
  expect(await readFlowStatus($)).toContain('▸ Diagnose\n    ✓ Red\n    ✓ Green\n    ▸ Diagnosis\n    ○ Approval\n        run /flow approve diagnose')
  await postComment($, comments, buildDiagnosis(reproduction))
  expect(await readFlowStatus($)).toContain('    ✓ Diagnosis\n    ▸ Approval')
  expect(await readPromptContext($)).toContain('/flow approve diagnose')
})

test('a diagnosis comment that falls short is denied with the list of what is missing', async ($, on) => {
  const comments = await atGreen($, on, ['test/fix.bats', 'test/other.bats'])
  const body = '## Root cause\nx\n## Evidence\nbats test/fix.bats\n## Proposed fix\nx\n## Regression test\ntest/fix.bats'
  const denial = (await postComment($, comments, body)).deny
  expect(denial).toContain('the heading "Rejected hypotheses"')
  expect(denial).toContain('the red file test/other.bats')
  expect(denial).not.toContain('the red command "')
  expect((await postComment($, comments, buildDiagnosis('bats other', ['test/fix.bats', 'test/other.bats']))).deny).toContain('the red command "bats test/fix.bats"')
  expect(await readFlowStatus($)).toContain('▸ Diagnosis')
})

test('a red with no files needs a Regression test section that explains why there is no test', async ($, on) => {
  const comments = await atGreen($, on, [])
  const empty = buildDiagnosis(reproduction, []).replace('None: the bug lives in a script no test reaches.\n', '')
  expect((await postComment($, comments, empty)).deny).toContain('a Regression test section that explains why there is no test')
  expect((await postComment($, comments, buildDiagnosis(reproduction, []))).deny).toBeUndefined()
})

test('a comment before the green is no diagnosis', async ($, on) => {
  const comments: Record<number, IssueComment[]> = {}
  createWorld(on, { branch: 'fix' }, { session: { ...noFlow, flow: 'fix', issues: [1], info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } }, unit: { start: 'c0' }, issueComments: comments })
  expect((await postComment($, comments, 'a remark')).deny).toBeUndefined()
  await runFlowCommand($, 'approve diagnose')
  expect(await readFlowStatus($)).not.toContain('✓ Diagnosis')
})

test('/flow approve diagnose from the composer approves the latest comment and finishes Diagnose', async ($, on) => {
  const comments = await atGreen($, on)
  await postComment($, comments, buildDiagnosis(reproduction))
  expect((await runFlowCommand($, 'approve diagnose', composer)).text).toContain('Diagnosis approved')
  expect(await readCurrentStep($)).toBe('Code')
})

test('/flow approve diagnose from any other origin is refused and approves nothing', async ($, on) => {
  const comments = await atGreen($, on)
  await postComment($, comments, buildDiagnosis(reproduction))
  const refused = await runFlowCommand($, 'approve diagnose', { kind: 'plugin', name: 'working-agreement' })
  expect(refused.text).toContain("is the user's to run from the prompt")
  expect(await readCurrentStep($)).toBe('Diagnose')
})

test('/flow approve diagnose with no diagnosis comment is refused', async ($, on) => {
  await atGreen($, on)
  expect((await runFlowCommand($, 'approve diagnose')).text).toContain('no diagnosis comment to approve')
})

test('a newer diagnosis comment voids an earlier approval', async ($, on) => {
  const comments = await atGreen($, on)
  await postComment($, comments, buildDiagnosis(reproduction))
  await runFlowCommand($, 'approve diagnose')
  expect(await readCurrentStep($)).toBe('Code')
  await postComment($, comments, buildDiagnosis(reproduction).replace('Stop one item later.', 'Stop two items later.'))
  expect(await readCurrentStep($)).toBe('Diagnose')
  expect(await readFlowStatus($)).toContain('▸ Approval')
  await runFlowCommand($, 'approve diagnose')
  expect(await readCurrentStep($)).toBe('Code')
})
