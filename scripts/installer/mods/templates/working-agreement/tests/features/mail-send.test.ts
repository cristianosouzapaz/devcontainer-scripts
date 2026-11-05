import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { createEmptySession } from '../../hooks/domain/records'
import { coordinator } from '../support/builders'
import { callModTool, inside } from '../support/helpers'
import { test } from '../support/kit'
import { tickMs } from '../../hooks/core/timing'
import { buildScope, buildStat, coordinatorHost, createWorld, markSpawned, records, root, scopeFile } from '../support/world'
import type { World } from '../support/world'

/** A message as its file holds it. */
interface Mail { id: string; kind: string; from: string; to: string; issue: number; in_reply_to: string; body: string; refs: string[] }

const unitSession = 'unit-12'
const coordinatorBox = `${records}/mail/coordinator-sid`
const unitBox = `${records}/mail/12`
const doorbell = '[working-agreement] Mail arrived in this session\'s mailbox; it is delivered with this prompt.'

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
 * Sends a message with the mod's send tool.
 * @param $ - The engine.
 * @param args - The call's arguments.
 * @returns The tool's answer.
 */
const send = ($: Engine, args: Record<string, unknown>): ReturnType<typeof callModTool> => callModTool($, 'send', args)

/**
 * Submits the doorbell's prompt and reads the context it entered with.
 * @param $ - The engine.
 * @returns The context, joined.
 */
const ring = async ($: Engine): Promise<string> =>
  ((await $.classic.UserPromptSubmit({ prompt: doorbell, permission_mode: 'default' } as never)) as { additionalContext?: string[] }).additionalContext?.join('\n') ?? ''

/**
 * Has the coordinator assign work to the unit and returns the assign's id, read by the unit.
 * @param $ - The engine.
 * @param world - The world.
 * @returns The assign's id.
 */
async function assign($: Engine, world: World): Promise<string> {
  await callModTool($, 'unit_prompt', { number: 12, text: 'Build the store.', kind: 'assign' })
  const [message] = readBox(world, unitBox, 'new')
  become(world, 'unit')
  await ring($)
  return message!.id
}

// contract: a unit's question and blocked reach the coordinator's mailbox from the unit's own address and ring the coordinator's doorbell, whose prompt delivers them
test('a unit\'s question and blocked reach its coordinator, whose doorbell prompt delivers them', async ($, on) => {
  const world = arrange(on)
  become(world, 'unit')
  expect((await send($, { kind: 'question', body: 'Store A or B? I propose A.' })).isError).toBe(false)
  expect((await send($, { kind: 'blocked', body: 'Needs /to-spec from the user.', refs: ['https://example.test/1'] })).isError).toBe(false)
  const sent = readBox(world, coordinatorBox, 'new')
  expect(sent.map(({ kind, from, to, issue, in_reply_to: reply }) => ({ kind, from, to, issue, reply })).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
    { kind: 'blocked', from: '12', to: 'coordinator-sid', issue: 12, reply: '' },
    { kind: 'question', from: '12', to: 'coordinator-sid', issue: 12, reply: '' },
  ])
  become(world, 'coordinator')
  await $.classic.FileChanged({ file_path: `${coordinatorBox}/new/${sent[0]!.id}.1.json`, event: 'add' } as never)
  await world.clock.settle()
  expect(world.prompts.filter(prompt => prompt === doorbell)).toHaveLength(1)
  const block = await ring($)
  expect(block).toContain('Store A or B?')
  expect(block).toContain('Needs /to-spec')
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
})

// contract: the coordinator's answer goes back to the unit's mailbox with in_reply_to and an id derived from the question and its sender
test('the coordinator\'s answer reaches the unit, in reply to its question, under a derived id', async ($, on) => {
  const world = arrange(on)
  become(world, 'unit')
  await send($, { kind: 'question', body: 'Store A or B?' })
  const [question] = readBox(world, coordinatorBox, 'new')
  become(world, 'coordinator')
  await ring($)
  expect((await send($, { kind: 'answer', body: 'Take A.', in_reply_to: question!.id })).isError).toBe(false)
  const [answer] = readBox(world, unitBox, 'new')
  expect(answer).toMatchObject({ kind: 'answer', from: 'coordinator-sid', to: '12', issue: 12, in_reply_to: question!.id, id: `${question!.id}-re-coordinator-sid` })
  become(world, 'unit')
  expect(await ring($)).toContain('Take A.')
})

// contract: a second reply to one message collides on its derived id and is refused, even after the first one was read
test('a message is replied to once: a second reply is refused, even once the first was read', async ($, on) => {
  const world = arrange(on)
  become(world, 'unit')
  await send($, { kind: 'question', body: 'Store A or B?' })
  const [question] = readBox(world, coordinatorBox, 'new')
  become(world, 'coordinator')
  await ring($)
  await send($, { kind: 'answer', body: 'Take A.', in_reply_to: question!.id })
  become(world, 'unit')
  await ring($)
  become(world, 'coordinator')
  const second = await send($, { kind: 'answer', body: 'No, B.', in_reply_to: question!.id })
  expect(second.isError).toBe(true)
  expect(second.text).toContain('replied to once')
  expect(readBox(world, unitBox, 'new')).toEqual([])
})

// contract: send refuses every reply the legal-reply map forbids, including a reply to an inform, an answer or a done, and a blocked or question sent as a reply
test('send refuses a reply the legal-reply map forbids', async ($, on) => {
  const world = arrange(on)
  const assignId = await assign($, world)
  become(world, 'coordinator')
  await callModTool($, 'unit_prompt', { number: 12, text: 'FYI.' })
  const inform = readBox(world, unitBox, 'new')[0]!.id
  become(world, 'unit')
  await ring($)
  expect((await send($, { kind: 'answer', body: 'x', in_reply_to: assignId })).text).toContain('an assign is replied to only with done')
  expect((await send($, { kind: 'done', body: 'x', in_reply_to: inform })).text).toContain('an inform takes no reply')
  expect((await send($, { kind: 'blocked', body: 'x', in_reply_to: assignId })).text).toContain('never a reply')
  expect((await send($, { kind: 'question', body: 'x', in_reply_to: assignId })).text).toContain('never a reply')
  expect((await send($, { kind: 'done', body: 'x' })).text).toContain('in_reply_to must be the id')
  expect((await send($, { kind: 'done', body: 'x', in_reply_to: 'nothing-here' })).text).toContain('no message nothing-here')
  await send($, { kind: 'question', body: 'Store A or B?' })
  const question = readBox(world, coordinatorBox, 'new')[0]!.id
  become(world, 'coordinator')
  await ring($)
  expect((await send($, { kind: 'done', body: 'x', in_reply_to: question })).text).toContain('a question is replied to only with answer')
  await send($, { kind: 'answer', body: 'A.', in_reply_to: question })
  const answer = readBox(world, unitBox, 'new')[0]!.id
  become(world, 'unit')
  await ring($)
  expect((await send($, { kind: 'answer', body: 'x', in_reply_to: answer })).text).toContain('an answer takes no reply')
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
})

// contract: an assign stays open through a blocked: the blocked is answered on its own, and the assign still takes its done
test('an assign stays open through a blocked until its done', async ($, on) => {
  const world = arrange(on)
  const assignId = await assign($, world)
  await send($, { kind: 'blocked', body: 'Needs the user.' })
  const blocked = readBox(world, coordinatorBox, 'new')[0]!.id
  become(world, 'coordinator')
  await ring($)
  expect((await send($, { kind: 'answer', body: 'Lifted.', in_reply_to: blocked })).isError).toBe(false)
  become(world, 'unit')
  await ring($)
  expect((await send($, { kind: 'done', body: 'Built.', in_reply_to: assignId })).isError).toBe(false)
  expect(readBox(world, coordinatorBox, 'new')).toMatchObject([{ kind: 'done', in_reply_to: assignId, from: '12', issue: 12 }])
})

// contract: only a delegated unit opens a conversation with send: a coordinator, and a unit whose coordinator no longer runs, are refused
test('a coordinator opens no conversation with send, and a unit with no running coordinator is refused', async ($, on) => {
  const world = arrange(on)
  expect((await send($, { kind: 'question', body: 'x' })).text).toContain('a coordinator messages a unit with unit_prompt')
  world.files.delete(scopeFile('sid'))
  become(world, 'unit')
  expect((await send($, { kind: 'question', body: 'x' })).text).toContain('no running coordinator delegates #12')
  expect([...world.files.keys()].filter(path => path.includes('/new/'))).toEqual([])
})

/**
 * Replaces the coordinator's process, as a restart or a resume of its session does: the old process ends and a new one runs.
 * @param world - The world.
 * @param pid - The new process.
 * @param start - Its start time in clock ticks.
 * @param ended - The process that ends.
 */
function replaceProcess(world: World, pid: number, start: string, ended: number = coordinatorHost.pid): void {
  world.files.delete(`/proc/${ended}/stat`)
  world.files.set(`/proc/${pid}/stat`, buildStat(pid, start))
  world.files.set('/proc/self/stat', buildStat(pid, start))
}

// contract: a coordinator's start or resume records its new process at once, so a unit's send right after it, with no tick in between, reaches the coordinator
test('a unit\'s send right after its coordinator resumes reaches the coordinator', async ($, on) => {
  const world = arrange(on)
  replaceProcess(world, 321, '4500')
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  become(world, 'unit')
  expect((await send($, { kind: 'question', body: 'Store A or B?' })).isError).toBe(false)
  expect(readBox(world, coordinatorBox, 'new')).toMatchObject([{ kind: 'question', from: '12' }])
})

// contract: a coordinator whose process ended and that was not resumed is still judged gone, and a unit's send is refused
test('a unit\'s send is refused while its ended coordinator is not resumed', async ($, on) => {
  const world = arrange(on)
  world.files.delete(`/proc/${coordinatorHost.pid}/stat`)
  become(world, 'unit')
  expect((await send($, { kind: 'question', body: 'x' })).text).toContain('no running coordinator delegates #12')
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
})

// contract: the coordinator's tick still records its process when it changes after the start, as a reload does
test('the coordinator\'s tick records its new process after a reload, so a unit\'s send reaches it', async ($, on) => {
  const world = arrange(on)
  replaceProcess(world, 321, '4500')
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  replaceProcess(world, 555, '8000', 321)
  await world.clock.advance(tickMs)
  become(world, 'unit')
  expect((await send($, { kind: 'question', body: 'Store A or B?' })).isError).toBe(false)
  expect(readBox(world, coordinatorBox, 'new')).toMatchObject([{ kind: 'question', from: '12' }])
})

// contract: every session's start watches the mail root, so a session that becomes the coordinator later still hears its doorbell
test('a session watches the mail root from its start, so a coordinator made later hears its doorbell', async ($, on) => {
  const world = arrange(on)
  const start = await $.classic.SessionStart({ source: 'startup' } as never)
  expect((start as { watchPaths?: string[] }).watchPaths).toContain(`${records}/mail`)
  become(world, 'unit')
  await send($, { kind: 'question', body: 'x' })
  become(world, 'coordinator')
  const [question] = readBox(world, coordinatorBox, 'new')
  await $.classic.FileChanged({ file_path: `${coordinatorBox}/new/${question!.id}.1.json`, event: 'add' } as never)
  await world.clock.settle()
  expect(world.prompts.filter(prompt => prompt === doorbell)).toHaveLength(1)
})
