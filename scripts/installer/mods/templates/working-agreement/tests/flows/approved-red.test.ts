import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { test } from '../support/kit'
import { diagnosisComment, noFlow } from '../support/builders'
import { declareFlow, readPaneCurrentStep, runFlowCommand } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Options, World } from '../support/world'

/** The unit an approved red leaves, for a test to drive further. */
interface ApprovedUnit { checkout: Checkout; options: Options; world: World }

const red = ['./check']
const regression = ['./regression']

/**
 * Records a red of the red argv, posts the diagnosis comment after it and approves it.
 * @param $ - The engine under test.
 * @param on - The kit's world hooks.
 * @returns The checkout, options and world to drive the rest of the unit with.
 */
async function approveRed($: Engine, on: On): Promise<ApprovedUnit> {
  const checkout: Checkout = { branch: 'fix', isDirty: true, tree: 'red' }
  const options: Options = { session: noFlow, issueLabels: { 1: ['ready-for-agent'] }, spawnCode: 1 }
  const world = createWorld(on, checkout, options)
  expect((await declareFlow($, 'fix', [1])).result).toContain('current step: Diagnose')
  await world.clock.advance(10)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv: red })).result).toContain('red recorded')
  await world.clock.advance(1)
  options.comments = { 1: [{ ...diagnosisComment, createdAt: new Date(world.clock.now() + 1).toISOString() }] }
  await world.clock.advance(10)
  expect((await runFlowCommand($, `approve ${diagnosisComment.url}`)).text).toContain('Diagnosis approved')
  expect(readPaneCurrentStep(world.views)).toBe('Code')
  return { checkout, options, world }
}

test('a regression test run after the approval neither reopens Diagnose nor keeps the red command from completing Code', async ($, on) => {
  const { checkout, options, world } = await approveRed($, on)
  await world.clock.advance(1)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv: regression })).result).toContain('red recorded')
  expect(readPaneCurrentStep(world.views)).toBe('Code')
  checkout.tree = 'fixed'
  options.spawnCode = 0
  await world.clock.advance(1)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv: red })).result).toContain('green after red: the approved fix passes')
  await world.clock.advance(1)
  await $.tool.call({ tool: 'mcp__working-agreement__run', argv: regression })
  expect(readPaneCurrentStep(world.views)).toBe('Verify')
})

test('many runs of other commands after the approval keep Diagnose done', async ($, on) => {
  const { options, world } = await approveRed($, on)
  for (const [index, code] of [1, 0, 1, 0, 1, 0].entries()) {
    options.spawnCode = code
    await world.clock.advance(1)
    await $.tool.call({ tool: 'mcp__working-agreement__run', argv: [`./other-${index % 3}`] })
  }
  expect(readPaneCurrentStep(world.views)).toBe('Code')
})

test("a different command going red to green after the approval does not stand in for the red command's green", async ($, on) => {
  const { checkout, options, world } = await approveRed($, on)
  await world.clock.advance(1)
  await $.tool.call({ tool: 'mcp__working-agreement__run', argv: regression })
  checkout.tree = 'fixed'
  options.spawnCode = 0
  await world.clock.advance(1)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv: regression })).result).not.toContain('green after red')
  expect(readPaneCurrentStep(world.views)).toBe('Code')
})

/**
 * Records a red of each argv in turn, one clock tick apart, then posts the diagnosis comment and approves it.
 * @param $ - The engine under test.
 * @param on - The kit's world hooks.
 * @param argvs - The red argvs, in the order they are run.
 * @returns The checkout, options and world to drive the rest of the unit with.
 */
async function approveAfterReds($: Engine, on: On, argvs: string[][]): Promise<ApprovedUnit> {
  const checkout: Checkout = { branch: 'fix', isDirty: true, tree: 'red' }
  const options: Options = { session: noFlow, issueLabels: { 1: ['ready-for-agent'] }, spawnCode: 1 }
  const world = createWorld(on, checkout, options)
  await declareFlow($, 'fix', [1])
  for (const argv of argvs) {
    await world.clock.advance(10)
    expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv })).result).toContain('red recorded')
  }
  options.comments = { 1: [{ ...diagnosisComment, createdAt: new Date(world.clock.now() + 1).toISOString() }] }
  await world.clock.advance(10)
  expect((await runFlowCommand($, `approve ${diagnosisComment.url}`)).text).toContain('Diagnosis approved')
  return { checkout, options, world }
}

for (const [name, setupMistake] of [['a different command', ['./check', 'wrong/path']], ['the same command', red]] as const) {
  test(`a setup-mistake red of ${name} before the diagnosed red does not keep the fix green from completing Code`, async ($, on) => {
    const { checkout, options, world } = await approveAfterReds($, on, [[...setupMistake], red])
    checkout.tree = 'fixed'
    options.spawnCode = 0
    await world.clock.advance(1)
    expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv: red })).result).toContain('green after red: the approved fix passes')
    expect(readPaneCurrentStep(world.views)).toBe('Verify')
  })
}
