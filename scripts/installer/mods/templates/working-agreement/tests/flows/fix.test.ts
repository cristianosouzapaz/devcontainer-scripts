import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { diagnosisComment, noFlow, verifyFile } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, readPaneCurrentStep, readPromptContext, runFlowCommand, startSkill } from '../support/helpers'
import { completeDelivery } from '../support/delivery'
import { createWorld, linearGraph } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a Fix on a triaged issue starts at Diagnose', async ($, on) => {
  const git: Checkout = { branch: 'fix' }
  const options: Options = { session: noFlow, verifyFile, issueLabels: { 1: ['ready-for-agent'] } }
  createWorld(on, git, options)
  await declareFlow($, 'fix', [1])
  expect(await readCurrentStep($)).toBe('Diagnose')
  expect(await readFlowStatus($)).toContain('✓ Triage')
  const instruction = await readPromptContext($)
  expect(instruction).toContain('reproduce the bug with a failing red command through the run tool')
  expect(instruction).toContain('run the diagnosing-bugs skill through its Phases 1–4')
  expect(instruction).toContain('preferably a failing test or a small harness')
  expect(instruction).toContain('do not apply the fix in Diagnose')
  expect(instruction).not.toContain('do not change code')
  expect(instruction).toContain('cause, the red command, and the regression test')
  expect(instruction).not.toContain('then its green')
  expect(instruction).toContain('/flow approve <comment URL>')
  expect(instruction).toContain('/flow skip diagnose <reason>')
})

test('a Fix unit runs from Triage to a merged PR', async ($, on) => {
  const graph = linearGraph({ feat: 0 }, verifyFile, 1)
  graph.commits.c1!.files['test/a.test.ts'] = 'green'
  const git: Checkout = { branch: 'feat', graph }
  const options: Options = { session: noFlow, verifyFile, approvedConfig: verifyFile, issueLabels: { 1: ['needs-triage'] } }
  const { clock, views } = createWorld(on, git, options)
  expect((await declareFlow($, 'fix', [1])).result).toContain('current step: Triage')
  await startSkill($, 'triage')
  options.issueLabels = { 1: ['ready-for-agent'] }
  await clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Diagnose')
  await startSkill($, 'diagnosing-bugs')
  git.dirty = { 'test/a.test.ts': 'red' }
  options.spawnCode = 1
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./check'] })).result).toContain('red recorded')
  expect(readPaneCurrentStep(views)).toBe('Diagnose')
  await clock.advance(1)
  options.comments = { 1: [{ ...diagnosisComment, createdAt: new Date(clock.now() + 1).toISOString() }] }
  expect((await runFlowCommand($, `approve ${diagnosisComment.url}`)).text).toContain('Diagnosis approved')
  expect(readPaneCurrentStep(views)).toBe('Code')
  await clock.advance(10)
  git.dirty = { 'test/a.test.ts': 'green', 'src/a.ts': 'tree' }
  options.spawnCode = 0
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./check'] })).result).toContain('green after red: the approved fix passes; call the verify tool')
  expect(readPaneCurrentStep(views)).toBe('Code')
  expect(await readFlowStatus($)).toContain('▸ Code · no Verify run yet')
  await completeDelivery($, { git, options, clock, views })
})
