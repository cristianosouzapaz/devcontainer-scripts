import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { buildChangedCheckout, buildVerifyRun, verifyFile } from '../support/builders'
import { test } from '../support/kit'
import { seedUnit } from '../support/parallel-worktrees'
import { buildScope, coordinatorHost, createWorld, records, scopeFile, seedDelegation } from '../support/world'
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

/**
 * Starts a unit below the top level whose earlier session passed Verify on t0, then runs two reds and moves its tree, so that pass is
 * stale and the newest run is red.
 * @param $ - The test's engine.
 * @param on - The test's hook registration.
 * @returns The unit's world.
 */
async function startStaleRedUnit($: Engine, on: On): Promise<UnitWorld> {
  const unit = startUnit(on, cheap)
  await unit.world.ready
  const identity = unit.world.sessions.get('sid')?.unit
  if (!identity) throw new Error('the world declares no unit')
  // why: each session keeps only its own latest run, so the pass comes from an earlier session of the unit, before the reds.
  await seedUnit(unit.world, 'earlier', identity, { verifyRuns: [buildVerifyRun({ tree: 't0', runId: 'earlier', at: -1 })] })
  await runVerifies($, unit, ['fail', 'fail'])
  return unit
}

// contract: a unit below the top level is refused its third Verify after two reds, with the reason and the move, and may end its turn
test('two red Verifies on a unit below the top level refuse the next Verify with the reason, and its stop is not blocked', async ($, on) => {
  const unit = startUnit(on, cheap)
  await runVerifies($, unit, ['pass', 'fail', 'fail'])
  const refused = await $.tool.call(verify)
  expect(refused.result).toContain('two consecutive red Verifies')
  expect(refused.result).toContain('End the turn now')
  expect(refused.result).toContain("the coordinator's mod will try to resume this session on the user's default model with effort high")
  expect(refused.result).toContain('If it cannot, the coordinator is told, not this session: while this session stays below the top level and that coordinator runs, '
    + 'its next Verify is refused again.')
  expect(refused.result).not.toContain('the mod resumes this session')
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

for (const [label, unseat] of [
  ['whose coordinator is gone', (world: World) => world.files.delete(`/proc/${coordinatorHost.pid}/stat`)],
  ['with no scope', (world: World) => world.files.delete(scopeFile('coord'))],
] as const) {
  // contract: a unit below the top level with two reds and no live coordinator to escalate it runs Verify, told to ask the user
  test(`two red Verifies on a unit ${label} run the next Verify and tell it to ask the user`, async ($, on) => {
    const unit = startUnit(on, cheap)
    await runVerifies($, unit, ['fail', 'fail'])
    unseat(unit.world)
    const ran = (await $.tool.call(verify)).result
    expect(ran).toContain('Verify passed')
    expect(ran).toContain('no live coordinator can escalate this session')
    expect(ran).toContain('Tell the user, who can run `/flow coordinate`, then `/flow delegate 1` there, then `escalate_unit 1`')
    expect(ran).not.toContain('End the turn now')
    expect(readLatestTree(unit.world)).toBe('next')
  })
}

// contract: a unit below the top level with two reds whose coordinator's liveness cannot be judged runs Verify, with why no escalation is awaited
test('two red Verifies on a unit whose coordinator cannot be judged run the next Verify with the cannot-tell note', async ($, on) => {
  const unit = startUnit(on, cheap)
  await runVerifies($, unit, ['fail', 'fail'])
  unit.world.files.set(scopeFile('coord'), buildScope('coord', [1], null))
  const ran = (await $.tool.call(verify)).result
  expect(ran).toContain('Verify passed')
  expect(ran).toContain('the mod cannot tell whether a coordinator is running (coordinator coord: no process is recorded for it), so it does not wait for an escalation')
  expect(ran).not.toContain('End the turn now')
  expect(readLatestTree(unit.world)).toBe('next')
})

// contract: a unit below the top level with two reds whose scope cannot be read runs Verify with the cannot-tell note, never the tell-the-user one
test('two red Verifies on a unit whose scope cannot be read run the next Verify with the cannot-tell note naming the read', async ($, on) => {
  const unit = startUnit(on, cheap)
  await runVerifies($, unit, ['fail', 'fail'])
  unit.options.failRead = path => path === scopeFile('coord')
  const ran = (await $.tool.call(verify)).result
  expect(ran).toContain('Verify passed')
  expect(ran).toContain('the mod cannot tell whether a coordinator is running (the delegation scopes cannot be read: ')
  expect(ran).not.toContain('no live coordinator')
})

// contract: a scope bucket whose listing and stat both fail is unreadable, never absent: Verify runs with the cannot-tell note, not the no-coordinator one
test('two red Verifies on a unit whose scope bucket can be neither listed nor stat-ed run the next Verify with the cannot-tell note', async ($, on) => {
  const unit = startUnit(on, cheap)
  await runVerifies($, unit, ['fail', 'fail'])
  const bucket = `${records}/delegation`
  unit.options.listFails = directory => directory === bucket
  unit.options.statFails = path => path === bucket
  const ran = (await $.tool.call(verify)).result
  expect(ran).toContain('Verify passed')
  expect(ran).toMatch(/the mod cannot tell whether a coordinator is running \(the delegation scopes cannot be read: [^)]+\), so it does not wait for an escalation/)
  expect(ran).not.toContain('no live coordinator')
})

// contract: a unit refused Verify for a live coordinator's escalation is not held by the Stop's stale-Verify block, since it cannot rerun Verify
test('a unit refused Verify for a live coordinator\'s escalation is not held by a stale Verify at its Stop', async ($, on) => {
  await startStaleRedUnit($, on)
  expect((await $.tool.call(verify)).result).toContain("the coordinator's mod will try to resume this session")
  expect((await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)).block ?? '').not.toContain('Verify is stale')
})

// contract: a unit given only the no-coordinator note can rerun Verify, so the Stop's stale-Verify block holds it as any unit
test('a unit with two reds whose coordinator is gone is held by a stale Verify at its Stop', async ($, on) => {
  const unit = await startStaleRedUnit($, on)
  unit.world.files.delete(`/proc/${coordinatorHost.pid}/stat`)
  expect((await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)).block).toContain('Verify is stale')
})
