import { expect, test } from 'claude-code/testing'

import { buildBashCall, noFlow, verifyFile } from '../support/builders'
import { declareFlow, endTurn, readPromptContext, runFlowCommand, startSkill } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Options } from '../support/world'

const prefix = '[working-agreement]'

// What the user reads: a plain sentence, no prefix of the mod's name, opening with a capital, a hash or a slash.
function isPlain(text: string | undefined): boolean {
  return !!text && !text.includes('working-agreement') && /^[A-Z#/]/.test(text) && text.endsWith('.')
}

test('a declare_flow refusal is a deny the agent reads under the mod prefix', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  expect((await declareFlow($, 'no-such-flow')).deny).toMatch(/^\[working-agreement\] /)
})

test('a declare_flow success opens with the mod prefix once', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  const result = String((await declareFlow($, 'small-feature', [1])).result)
  expect(result.startsWith(`${prefix} Flow declared:`)).toBe(true)
  expect(result.split(prefix)).toHaveLength(2)
})

test('every prompt context line starts with the mod prefix, with no flow and with one declared', async ($, on) => {
  const options: Options = { session: noFlow }
  createWorld(on, { branch: 'feat' }, options)
  for (const isDeclared of [false, true]) {
    if (isDeclared) await declareFlow($, 'small-feature', [1])
    const lines = (await readPromptContext($)).split('\n').filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line.startsWith(`${prefix} `), line).toBe(true)
  }
})

test('/flow trivial answers plainly, refused and accepted', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { output: true } })
  const refused = (await runFlowCommand($, 'trivial')).text
  expect(isPlain(refused), refused).toBe(true)
  expect(refused).toContain('output')
})

test('/flow trivial accepted answers plainly', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  const accepted = (await runFlowCommand($, 'trivial')).text
  expect(isPlain(accepted), accepted).toBe(true)
  expect(accepted).toContain('Trivial')
})

test('/flow override answers plainly, refused and accepted', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  const refused = (await runFlowCommand($, 'override verify #9 x')).text
  expect(isPlain(refused), refused).toBe(true)
  expect(refused).toContain('not a declared issue')
  const accepted = (await runFlowCommand($, 'override verify skipped')).text
  expect(isPlain(accepted), accepted).toBe(true)
  expect(accepted).toContain('Override logged')
})

test('/flow follow-up answers plainly, refused and accepted', async ($, on) => {
  const pullRequest = { number: 5, state: 'OPEN', headRefName: 'feat-1', headRefOid: 'c3', body: 'Closes #1' }
  createWorld(on, { branch: 'feat-1', ahead: 3 }, { prs: [pullRequest] })
  const refused = (await runFlowCommand($, 'follow-up #1')).text
  expect(isPlain(refused), refused).toBe(true)
  expect(refused).toContain('new session')
  const usage = (await runFlowCommand($, 'follow-up')).text
  expect(usage).not.toContain('working-agreement')
  expect(usage).toMatch(/^[A-Z].*\.$/)
})

test('/flow follow-up accepted answers plainly', async ($, on) => {
  const pullRequest = { number: 5, state: 'OPEN', headRefName: 'feat-1', headRefOid: 'c3', body: 'Closes #1' }
  createWorld(on, { branch: 'feat-1', ahead: 3 }, { session: noFlow, prs: [pullRequest] })
  const accepted = (await runFlowCommand($, 'follow-up #1')).text
  expect(isPlain(accepted), accepted).toBe(true)
  expect(accepted).toContain('#1')
})

test('a handoff whose follow-up is refused toasts the plain reason and resumes from the document', async ($, on) => {
  const git: Checkout = { branch: 'feat', isDirty: true }
  const options: Options = {
    session: noFlow, verifyFile, toolRun: { result: { stdout: '' } },
    documents: '/tmp/handoff.md',
  }
  const { commands, prompts, clock } = createWorld(on, git, options)
  const toasts: string[] = []
  on('ui.toast', (_$, e) => { toasts.push(e.text); return { value: undefined } })
  await declareFlow($, 'close-out', [1])
  await $.tool.call(buildBashCall('./test/run.sh'))
  await startSkill($, 'generate-commit')
  git.isDirty = false
  git.ahead = 1
  await startSkill($, 'create-pr')
  options.prView = { body: 'Closes #1', headRefOid: 'c1' }
  options.toolRun = { result: { stdout: 'https://github.com/o/r/pull/5\n', gitOperation: { pr: { number: 5, action: 'created' } } } }
  await $.tool.call(buildBashCall('gh pr create --title t --body "Closes #1"'))

  await runFlowCommand($, 'handoff')
  await clock.settle()
  await $.prompt.submit({ text: '/handoff', wait: false, origin: { kind: 'plugin', name: 'working-agreement' } })
  await endTurn($)
  await clock.settle()
  expect(commands).toContain('clear')
  expect(toasts.length).toBe(1)
  expect(isPlain(toasts[0]), toasts[0]).toBe(true)
  const resumed = prompts.find(text => text.includes('/tmp/handoff.md'))
  expect(resumed).toContain('Continue from the handoff document')
  expect(resumed).not.toContain('follow-up on')
})
