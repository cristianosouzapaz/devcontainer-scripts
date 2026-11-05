import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { buildChangedCheckout, verifyFile } from '../support/builders'
import { test } from '../support/kit'
import { createWorld, records, seedDelegation } from '../support/world'
import type { Checkout, Options, World } from '../support/world'

/** A Verify call's outcome. */
type VerifyKind = 'pass' | 'fail'

/** A delegated unit's world, with the checkout and options a test moves. */
interface UnitWorld { world: World; checkout: Checkout; options: Options }

const verify = { tool: 'mcp__working-agreement__verify' } as const
const cheap = { model: 'sonnet', effort: 'medium', reason: 'routine typing' }
const escalated = { effort: 'high', reason: 'escalated: two consecutive red Verifies' }

/**
 * Starts the world's session as the delegated unit of issue 1 at a spawn level.
 * @param on - The test's hook registration.
 * @param level - The spawn record's level fields.
 * @returns The world, its checkout and its options.
 */
function startUnit(on: On, level: Record<string, string>): UnitWorld {
  const checkout = buildChangedCheckout()
  const options: Options = { verifyFile, approvedConfig: verifyFile }
  const world = createWorld(on, checkout, options)
  seedDelegation(world, 'coord', [1])
  setLevel(world, level)
  return { world, checkout, options }
}

/**
 * Rewrites the spawn record of issue 1 with a level, as spawn or an escalation leaves it.
 * @param world - The world.
 * @param level - The level fields.
 */
function setLevel(world: World, level: Record<string, string>): void {
  world.files.set(`${records}/spawn/1.json`, JSON.stringify({ isStarted: true, isPrompted: true, mode: 'default', sessionId: 'sid', ...level }))
}

/**
 * Calls Verify once per outcome, each on a new tree, oldest first.
 * @param $ - The test's engine.
 * @param unit - The unit's world.
 * @param outcomes - Each call's outcome.
 */
async function runVerifies($: Engine, unit: UnitWorld, outcomes: VerifyKind[]): Promise<void> {
  for (const [index, kind] of outcomes.entries()) {
    unit.checkout.tree = `t${index}`
    unit.options.spawnCode = kind === 'pass' ? 0 : 1
    expect((await $.tool.call(verify)).result).toContain(kind === 'pass' ? 'Verify passed' : 'Verify failed')
  }
  unit.checkout.tree = 'next'
  unit.options.spawnCode = 0
}

/**
 * Reads the tree of the unit's latest recorded Verify run.
 * @param world - The world.
 * @returns The tree, or undefined without a run.
 */
const readLatestTree = (world: World): string | undefined => world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.tree

// contract: a unit below the top level is refused its third Verify after two reds, with the reason and the move, and may end its turn
test('two red Verifies on a unit below the top level refuse the next Verify with the reason, and its stop is not blocked', async ($, on) => {
  const unit = startUnit(on, cheap)
  await runVerifies($, unit, ['pass', 'fail', 'fail'])
  const refused = await $.tool.call(verify)
  expect(refused.result).toContain('two consecutive red Verifies')
  expect(refused.result).toContain('End the turn now')
  expect(refused.result).toContain("user's default model with effort high")
  expect(readLatestTree(unit.world)).toBe('t2')
  expect((await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)).block).toBeUndefined()
})

for (const [label, level] of [['at the top level', { effort: 'high', reason: 'hard' }], ['spawned without a choice', {}]] as const) {
  // contract: a unit that cannot be escalated runs its Verify after two reds
  test(`a unit ${label} is not refused Verify after two reds`, async ($, on) => {
    const unit = startUnit(on, level)
    await runVerifies($, unit, ['fail', 'fail'])
    expect((await $.tool.call(verify)).result).toContain('Verify passed')
    expect(readLatestTree(unit.world)).toBe('next')
  })
}

// contract: once the escalation raises the unit, its next Verify runs
test('after the sweep escalates the unit, its next Verify is accepted', async ($, on) => {
  const unit = startUnit(on, cheap)
  await runVerifies($, unit, ['fail', 'fail'])
  expect((await $.tool.call(verify)).result).toContain('two consecutive red Verifies')
  setLevel(unit.world, escalated)
  expect((await $.tool.call(verify)).result).toContain('Verify passed')
  expect(readLatestTree(unit.world)).toBe('next')
})

// contract: a pass between two reds resets the count
test('a pass between two reds lets the next Verify run', async ($, on) => {
  const unit = startUnit(on, cheap)
  await runVerifies($, unit, ['fail', 'pass', 'fail'])
  expect((await $.tool.call(verify)).result).toContain('Verify passed')
  expect(readLatestTree(unit.world)).toBe('next')
})
