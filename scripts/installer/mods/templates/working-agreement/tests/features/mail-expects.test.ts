import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { createEmptySession } from '../../hooks/domain/records'
import { callModTool, endTurn, inside, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { childCheckout, parChild } from '../support/parallel-worktrees'
import { coordinatorHost, createWorld, markSpawned, records, scopeFile } from '../support/world'
import type { World } from '../support/world'

/** A message as its file holds it. */
interface Mail { id: string; kind: string; from: string; to: string; issue: number; expects: string; attempt: number; body: string; author: string }

const unitBox = `${records}/mail/1`
const coordinatorBox = `${records}/mail/coordinator-coord`
const userBox = `${records}/mail/user`
const doorbell = '[working-agreement] Mail arrived in this session\'s mailbox; it is delivered with this prompt.'

/**
 * Builds child `a`, at Integrate, as the unit session sid of issue 1 that coordinator `coord` delegates; its session record is mirrored, so the
 * coordinator reads its flow.
 * @param $ - The engine.
 * @param on - The test's hook registration.
 * @returns The world, in the unit's session.
 */
async function arrange($: Engine, on: Parameters<typeof createWorld>[0]): Promise<World> {
  const world = createWorld(on, childCheckout(), { ...parChild(), herdrEnv: inside })
  world.files.set(scopeFile('coord'), JSON.stringify({ v: 1, sessionId: 'coord', issues: [1], coversCreated: false, host: coordinatorHost }))
  markSpawned(world, [1])
  world.seedChat('coord', { ...createEmptySession('coord'), role: 'coordinator' })
  await endTurn($)
  return world
}

/**
 * Moves the world to a session.
 * @param world - The world.
 * @param session - The unit's or the coordinator's.
 */
const become = (world: World, session: 'unit' | 'coordinator'): void => { world.chat.id = session === 'unit' ? 'sid' : 'coord' }

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
 * Has the coordinator send the unit a message with unit_prompt.
 * @param $ - The engine.
 * @param world - The world, back in the unit's session after.
 * @param args - The call's arguments beside the issue.
 * @returns The tool's answer.
 */
async function prompt($: Engine, world: World, args: Record<string, unknown>): ReturnType<typeof callModTool> {
  become(world, 'coordinator')
  const answer = await callModTool($, 'unit_prompt', { number: 1, ...args })
  become(world, 'unit')
  return answer
}

/**
 * Submits the doorbell's prompt in the unit's session and reads the mail block it entered with.
 * @param $ - The engine.
 * @returns The context, joined.
 */
const ring = async ($: Engine): Promise<string> =>
  ((await $.classic.UserPromptSubmit({ prompt: doorbell, permission_mode: 'default' } as never)) as { additionalContext?: string[] }).additionalContext?.join('\n') ?? ''

// contract: expects is refused at send for a cancel, for any form but step:<id>, and for a step the unit's flow does not have; nothing is sent
test('unit_prompt refuses an expects on a cancel, in another form, or naming an unknown step, and sends nothing', async ($, on) => {
  const world = await arrange($, on)
  expect((await prompt($, world, { text: 'Stop.', kind: 'cancel', expects: 'step:integrate' })).text).toContain('a cancel stops the unit whatever its step')
  expect((await prompt($, world, { text: 'x', expects: 'tree:abc' })).text).toContain('expects must be step:<id>')
  expect((await prompt($, world, { text: 'x', kind: 'assign', expects: 'step:cod' })).text).toContain('cod is not a step of #1\'s flow')
  expect(readBox(world, unitBox, 'new')).toEqual([])
})

// contract: a message whose expects holds at injection is delivered with it; one whose step no longer holds is never injected: a stale assign is dead-lettered as "stale" with its sender and the user told, a stale inform recorded and dropped, uncounted
test('expects is checked at injection: a held step delivers, a stale assign is dead-lettered and a stale inform dropped', async ($, on) => {
  const world = await arrange($, on)
  expect((await prompt($, world, { text: 'Merge the parent.', kind: 'assign', expects: 'step:integrate' })).isError).toBe(false)
  expect(readBox(world, unitBox, 'new')).toMatchObject([{ kind: 'assign', expects: 'step:integrate' }])
  expect(await ring($)).toContain('Merge the parent.')
  expect((await prompt($, world, { text: 'Write the code.', kind: 'assign', expects: 'step:code' })).isError).toBe(false)
  const [stale] = readBox(world, unitBox, 'new')
  expect((await prompt($, world, { text: 'FYI, code.', expects: 'step:code' })).isError).toBe(false)
  expect(await ring($)).toBe('')
  expect(readBox(world, unitBox, 'new')).toEqual([])
  expect(readBox(world, unitBox, 'cur').map(mail => mail.body)).toEqual(['Merge the parent.'])
  expect(readBox(world, userBox, 'new')).toMatchObject([{ kind: 'inform', from: '1', author: 'mod' }])
  expect(readBox(world, userBox, 'new')[0]!.body).toContain(`Dead letter: an assign ${stale!.id} from coordinator-coord to 1 about #1, stale`)
  expect(readBox(world, coordinatorBox, 'new').filter(mail => mail.body.includes('was dead-lettered'))).toMatchObject([{ from: '1', author: 'mod' }])
  become(world, 'coordinator')
  await runFlowCommand($, '')
  expect(world.views.at(-1)?.meta.find(row => row.key === 'Inbox')?.value).toContain('1 dead letter')
})
