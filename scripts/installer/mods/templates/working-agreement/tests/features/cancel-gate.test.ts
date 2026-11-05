import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { createEmptySession } from '../../hooks/domain/records'
import { buildChangedCheckout, coordinator } from '../support/builders'
import { callModTool, inside, runFlowCommand, seedVerifyHolder } from '../support/helpers'
import { test } from '../support/kit'
import { buildScope, createWorld, markSpawned, records, scopeFile, seedDelegation } from '../support/world'
import type { Gate, Options, World } from '../support/world'

/** A message as its file holds it. */
interface Mail { id: string; kind: string; from: string; in_reply_to: string; body: string; author: string }

const unitSession = 'unit-12'
const coordinatorBox = `${records}/mail/coordinator-sid`
const unitBox = `${records}/mail/12`
const doorbell = '[working-agreement] Mail arrived in this session\'s mailbox; it is delivered with this prompt.'
const verify = { tool: 'mcp__working-agreement__verify' } as const
const changed = buildChangedCheckout()

/**
 * Builds a coordinator world, session sid, that delegates issue 12 to the unit session spawn started for it.
 * @param on - The test's hook registration.
 * @returns The world, still in the coordinator's session.
 */
function arrange(on: Parameters<typeof createWorld>[0]): World {
  const world = createWorld(on, { branch: 'main' }, { session: coordinator, herdrEnv: inside })
  world.files.set(scopeFile('sid'), buildScope('sid', [12]))
  markSpawned(world, [12], unitSession)
  world.seedChat(unitSession, createEmptySession(unitSession))
  return world
}

/**
 * Moves the world to a session.
 * @param world - The world.
 * @param session - The unit's or the coordinator's.
 */
const become = (world: World, session: 'unit' | 'coordinator'): void => { world.chat.id = session === 'unit' ? unitSession : 'sid' }

/**
 * Reads the messages of a mailbox directory.
 * @param world - The world.
 * @param box - The mailbox.
 * @param directory - new or cur.
 * @returns The messages.
 */
const readBox = (world: World, box: string, directory: 'new' | 'cur'): Mail[] =>
  [...world.files.entries()].filter(([path]) => path.startsWith(`${box}/${directory}/`)).map(([, text]) => JSON.parse(text) as Mail)

/**
 * Submits the doorbell's prompt and reads the context it entered with.
 * @param $ - The engine.
 * @returns The context, joined.
 */
const ring = async ($: Engine): Promise<string> =>
  ((await $.classic.UserPromptSubmit({ prompt: doorbell, permission_mode: 'default' } as never)) as { additionalContext?: string[] }).additionalContext?.join('\n') ?? ''

/**
 * Has the coordinator assign work to the unit, the unit read it, then the coordinator cancel it; the world ends in the unit's session.
 * @param $ - The engine.
 * @param world - The world.
 * @returns The assign's and the cancel's ids.
 */
async function assignThenCancel($: Engine, world: World): Promise<{ assignId: string; cancelId: string }> {
  await callModTool($, 'unit_prompt', { number: 12, text: 'Build the store.', kind: 'assign' })
  const assignId = readBox(world, unitBox, 'new')[0]!.id
  become(world, 'unit')
  await ring($)
  become(world, 'coordinator')
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Stop: the store moved to #13.', kind: 'cancel' })).isError).toBe(false)
  const cancelId = readBox(world, unitBox, 'new')[0]!.id
  become(world, 'unit')
  return { assignId, cancelId }
}

/**
 * Writes a cancel into the mailbox of the world session's unit, issue 1, as a coordinator's unit_prompt leaves it.
 * @param world - The world.
 * @param id - The cancel's id.
 */
function deliverCancel(world: World, id: string): void {
  world.files.set(`${records}/mail/1/new/${id}.1.json`, JSON.stringify({ v: 1, id, kind: 'cancel', from: 'coordinator-coord', to: '1', issue: 1, in_reply_to: '', seq: 1,
    created_at: '2026-01-01T00:00:00.000Z', expects: '', attempt: 1, body: 'Stop.', refs: [], author: 'agent' }))
}

// contract: with an unanswered cancel, every tool but send is denied on the main thread, and the deny names send, done and the cancel's in_reply_to
test('a cancel denies every tool but send until the unit replies done', async ($, on) => {
  const world = arrange(on)
  const { cancelId } = await assignThenCancel($, world)
  const denied = (await $.tool.call({ tool: 'Bash', command: 'ls' })).deny ?? ''
  expect(denied).toContain(`send with kind done and in_reply_to ${cancelId}`)
  expect((await $.tool.call(verify)).deny).toContain(cancelId)
  expect((await $.tool.call({ tool: 'Write', file_path: '/repo/a.txt', content: 'x' })).deny).toContain(cancelId)
  expect((await callModTool($, 'send', { kind: 'done', body: 'Stopped before the store.', in_reply_to: cancelId })).isError).toBe(false)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
})

// contract: a main-thread deny is an injection point: it delivers the unread mail in its text and acks it, so the next deny and prompt deliver it no more
test('a main-thread deny delivers and acks the unread mail exactly once', async ($, on) => {
  const world = arrange(on)
  const { cancelId } = await assignThenCancel($, world)
  const first = (await $.tool.call({ tool: 'Bash', command: 'ls' })).deny ?? ''
  expect(first).toContain('Stop: the store moved to #13.')
  expect(readBox(world, unitBox, 'new')).toEqual([])
  expect(readBox(world, unitBox, 'cur').map(mail => mail.id)).toContain(cancelId)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).not.toContain('Stop: the store moved')
  expect(await ring($)).not.toContain('Stop: the store moved')
})

// contract: a subagent's tool call is denied too, without acking the unread mail, since the subagent's context is not the session's turn
test('a subagent deny acks nothing', async ($, on) => {
  const world = arrange(on)
  const { cancelId } = await assignThenCancel($, world)
  const denied = (await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'helper' })).deny ?? ''
  expect(denied).toContain(cancelId)
  expect(denied).not.toContain('Stop: the store moved')
  expect(readBox(world, unitBox, 'new').map(mail => mail.id)).toEqual([cancelId])
})

// contract: a subagent's deny tells it to hand its report back with SubagentHandback, and that handback goes through
test('a cancelled subagent hands its report back', async ($, on) => {
  const world = arrange(on)
  const { cancelId } = await assignThenCancel($, world)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'helper' })).deny).toContain('hand your report back with SubagentHandback')
  expect((await $.tool.call({ tool: 'SubagentHandback', message: 'Stopped at step 3.', agentId: 'helper' } as never)).deny).toBeUndefined()
  expect(readBox(world, unitBox, 'new').map(mail => mail.id)).toEqual([cancelId])
})

// contract: the handback allowance is a subagent's only: the same call from the main thread is denied with the cancel
test('the main thread\'s SubagentHandback stays denied under a cancel', async ($, on) => {
  const world = arrange(on)
  const { cancelId } = await assignThenCancel($, world)
  expect((await $.tool.call({ tool: 'SubagentHandback', message: 'Report.' } as never)).deny).toContain(cancelId)
})

// contract: a done to a cancel closes the assigns received before it: the unit owes none, so a further cancel is refused for lack of work
test('a done to a cancel also closes the assign it cancelled', async ($, on) => {
  const world = arrange(on)
  const { cancelId } = await assignThenCancel($, world)
  await callModTool($, 'send', { kind: 'done', body: 'Stopped.', in_reply_to: cancelId })
  become(world, 'coordinator')
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Stop again.', kind: 'cancel' })).text).toContain('owes no assign')
})

// contract: unit_prompt refuses a cancel to a unit that owes no assign, and a second cancel while one is unanswered
test('unit_prompt sends one cancel at a time, and only against an open assign', async ($, on) => {
  const world = arrange(on)
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Stop.', kind: 'cancel' })).text).toContain('owes no assign')
  await assignThenCancel($, world)
  become(world, 'coordinator')
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Stop now.', kind: 'cancel' })).text).toContain('still unanswered')
  expect(readBox(world, unitBox, 'new')).toHaveLength(1)
})

// contract: the user's /flow lift in the unit's terminal lifts the gate, tells the coordinator with a mod-written inform, and leaves the cancel owed
test('the user\'s /flow lift lifts the gate and tells the coordinator', async ($, on) => {
  const world = arrange(on)
  const { cancelId } = await assignThenCancel($, world)
  expect((await runFlowCommand($, 'lift')).text).toContain(`Lifted the tool gate of cancel ${cancelId}`)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  expect(readBox(world, coordinatorBox, 'new')).toMatchObject([{ kind: 'inform', author: 'mod' }])
  expect(readBox(world, coordinatorBox, 'new')[0]!.body).toContain(cancelId)
  expect((await callModTool($, 'send', { kind: 'done', body: 'Stopped.', in_reply_to: cancelId })).isError).toBe(false)
})

// contract: /flow lift is the user's alone: refused from a non-prompt origin and with no gating cancel, and an agent typing it through herdr is denied
test('/flow lift is refused unless the user types it against an open cancel', async ($, on) => {
  const world = arrange(on)
  become(world, 'unit')
  expect((await runFlowCommand($, 'lift')).text).toContain('nothing to lift')
  become(world, 'coordinator')
  await assignThenCancel($, world)
  expect((await runFlowCommand($, 'lift', { kind: 'model' } as never)).text).toContain('the user\'s to run from the prompt')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeDefined()
  become(world, 'coordinator')
  expect((await $.tool.call({ tool: 'Bash', command: 'herdr agent prompt issue-12 "/flow lift"' })).deny).toContain('/flow lift is the user\'s alone')
})

// contract: a lift is recorded by the cancel's id: a later cancel gates again
test('a new cancel gates again after a lift', async ($, on) => {
  const world = arrange(on)
  const { cancelId } = await assignThenCancel($, world)
  await runFlowCommand($, 'lift')
  await callModTool($, 'send', { kind: 'done', body: 'Stopped.', in_reply_to: cancelId })
  become(world, 'coordinator')
  await callModTool($, 'unit_prompt', { number: 12, text: 'Restart the store.', kind: 'assign' })
  await callModTool($, 'unit_prompt', { number: 12, text: 'Stop once more.', kind: 'cancel' })
  become(world, 'unit')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toContain('in_reply_to')
})

for (const [label, call] of [
  ['Verify', verify],
  ['a run', { tool: 'mcp__working-agreement__run', argv: ['check'] }],
] as const) {
  // contract: a unit queued behind another session's Verify stops waiting within one poll step of a cancel, leaving no ticket
  test(`${label} queued behind another session stops waiting when a cancel arrives`, async ($, on) => {
    const file = JSON.stringify({ always: [['check']] })
    const world = createWorld(on, { ...changed }, { verifyFile: file, approvedConfig: file, herdrEnv: inside })
    seedDelegation(world, 'coord', [1])
    seedVerifyHolder(world)
    const waiting = $.tool.call(call)
    await world.clock.settle()
    deliverCancel(world, 'cancel-1')
    await world.clock.advance(1000)
    expect((await waiting).result).toContain('Stopped waiting for the Verify queue: cancel cancel-1')
    expect(await world.boundaries.files.list(`${records}/verify/q`)).toHaveLength(1)
  })
}

// contract: a Verify waiting for a CI job on its runner stops waiting within one poll step of a cancel
test('a Verify waiting on CI stops waiting when a cancel arrives', async ($, on) => {
  const config = JSON.stringify({ always: [['check']], waitForCiLabels: ['home'] })
  const options: Options = { verifyFile: config, approvedConfig: config, actionsJobs: [{ status: 'in_progress', labels: ['home'] }], herdrEnv: inside }
  const world = createWorld(on, { ...changed }, options)
  seedDelegation(world, 'coord', [1])
  const waiting = $.tool.call(verify)
  await world.clock.settle()
  deliverCancel(world, 'cancel-1')
  await world.clock.advance(1000)
  expect((await waiting).result).toContain('Stopped waiting for CI: cancel cancel-1')
})

// contract: a cancel arriving while a Verify command already runs lets it finish and record its result
test('a command already running finishes after a cancel', async ($, on) => {
  const gate: Gate = {}
  const file = JSON.stringify({ always: [['check']] })
  const world = createWorld(on, { ...changed }, { verifyFile: file, approvedConfig: file, herdrEnv: inside,
    spawnGate: new Promise<void>(resolve => { gate.open = resolve }) })
  seedDelegation(world, 'coord', [1])
  const running = $.tool.call(verify)
  await world.clock.settle()
  deliverCancel(world, 'cancel-1')
  gate.open?.()
  expect((await running).result).toContain('Verify passed')
})
