import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { buildChanged, verifyFile } from '../support/builders'
import { endTurn, enterOwnPrompt } from '../support/helpers'
import { createWorld, root, seedDelegation } from '../support/world'
import type { World } from '../support/world'

const wake = 'The user approved the Verify config this unit waited on, from their own terminal: call the verify tool.'

/**
 * Lets the periodic refresh, which a started session runs, go once and the prompts it defers be submitted.
 * @param world - The test world.
 */
async function tick(world: Pick<World, 'clock'>): Promise<void> {
  await world.clock.advance(61000)
  await world.clock.settle()
}

/**
 * Counts the wake prompts submitted to the session.
 * @param world - The test world.
 * @returns How many wake prompts it holds.
 */
const wakes = (world: Pick<World, 'prompts'>): number => world.prompts.filter(prompt => prompt.includes(wake)).length

test('a delegated unit waiting for its config is prompted once to call Verify after the user\'s terminal approval', async ($, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  seedDelegation(world, 'coord', [1])
  await endTurn($)
  world.approveConfig(verifyFile)
  await tick(world)
  expect(wakes(world)).toBe(1)
  await tick(world)
  await endTurn($)
  await tick(world)
  expect(wakes(world)).toBe(1)
})

// contract: the wake enters with the flow line and the delegated unit's routing, as a typed prompt does
test('the wake prompt enters with the flow line and the delegated routing', async ($, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  seedDelegation(world, 'coord', [1])
  await endTurn($)
  world.approveConfig(verifyFile)
  await tick(world)
  const prompt = world.prompts.find(text => text.includes(wake))!
  const context = await enterOwnPrompt($, prompt)
  expect(context).toContain('current step:')
  expect(context).toContain('This unit is delegated')
})

test('no wake reaches a delegated unit while its turn runs; it comes once the turn ends', async ($, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  seedDelegation(world, 'coord', [1])
  await endTurn($)
  await $.turn.start({ text: 'go', turnId: 'next' })
  world.approveConfig(verifyFile)
  await tick(world)
  expect(wakes(world)).toBe(0)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 'next' })
  await world.clock.settle()
  expect(wakes(world)).toBe(1)
})

test('outside delegation no prompt is sent: the pane notes that the config is approved and Verify is next', async ($, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await endTurn($)
  world.approveConfig(verifyFile)
  await tick(world)
  expect(wakes(world)).toBe(0)
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Approve', value: 'config approved · Verify is next', tone: 'text' })
})

test('a delegated unit whose config is still unapproved is not woken', async ($, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  seedDelegation(world, 'coord', [1])
  await endTurn($)
  await tick(world)
  await tick(world)
  expect(wakes(world)).toBe(0)
})

// contract: a delegated unit whose mod's tools failed to register gets no wake, the approval stays awaited, and a start that registers them wakes it once
test('no wake reaches a delegated unit whose tools did not register; a start that registers them wakes it once', async ($, on) => {
  const failure = { isArmed: true }
  const world = createWorld(on, buildChanged(), { verifyFile, beforeToolRegister: () => { if (failure.isArmed) throw new Error('registry closed') } })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  seedDelegation(world, 'coord', [1])
  await endTurn($)
  world.approveConfig(verifyFile)
  await tick(world)
  expect(wakes(world)).toBe(0)
  failure.isArmed = false
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await tick(world)
  expect(wakes(world)).toBe(1)
})
