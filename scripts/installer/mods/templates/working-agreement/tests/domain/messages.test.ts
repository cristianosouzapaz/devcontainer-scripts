import { expect, test } from 'claude-code/testing'

import { noFlow } from '../support/builders'
import { declareFlow, readPromptContext, runFlowCommand } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Options } from '../support/world'

const prefix = '[working-agreement]'

// What the user reads: a plain sentence, no prefix of the mod's name, opening with a capital, a hash or a slash.
function isPlain(text: string | undefined): boolean {
  return !!text && !text.includes(prefix) && /^[A-Z#/]/.test(text) && text.endsWith('.')
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

test('/flow trivial accepted answers plainly', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  const accepted = (await runFlowCommand($, 'trivial')).text
  expect(isPlain(accepted), accepted).toBe(true)
  expect(accepted).toContain('Trivial')
  expect(accepted).toContain('○ Verify')
  expect(accepted).toContain('call the verify tool')
})

test('/flow follow-up refusal and usage answer plainly', async ($, on) => {
  createWorld(on, { branch: 'feat-1', ahead: 3 }, { issues: { 1: 'CLOSED' } })
  const refused = (await runFlowCommand($, 'follow-up #1')).text
  expect(isPlain(refused), refused).toBe(true)
  expect(refused).toContain('declare its own flow')
  const usage = (await runFlowCommand($, 'follow-up')).text
  expect(usage).not.toContain('working-agreement')
  expect(usage).toMatch(/^[A-Z].*\.$/)
})

test('/flow follow-up accepted answers plainly', async ($, on) => {
  createWorld(on, { branch: 'feat-1', ahead: 3 }, { session: noFlow, closingPrs: { 1: [{ number: 5, state: 'OPEN', headRefName: 'feat-1', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }] } })
  const accepted = (await runFlowCommand($, 'follow-up #1')).text
  expect(isPlain(accepted), accepted).toBe(true)
  expect(accepted).toContain('#1')
  expect(accepted).toContain('current step: Code')
})
