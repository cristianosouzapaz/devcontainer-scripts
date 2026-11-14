import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { createEmptySession } from '../../hooks/domain/records'
import { coordinator } from '../support/builders'
import { callModTool, inside, startSession } from '../support/helpers'
import { test } from '../support/kit'
import { tickMs } from '../../hooks/core/timing'
import { buildScope, buildStat, coordinatorHost, createWorld, markSpawned, records, root, scopeFile } from '../support/world'
import type { Options, World } from '../support/world'

/** A message as its file holds it. */
interface Mail { id: string; kind: string; from: string; to: string; issue: number; in_reply_to: string; body: string; refs: string[] }

const unitSession = 'unit-12'
const coordinatorBox = `${records}/mail/coordinator-sid`
const unitBox = `${records}/mail/12`
const doorbell = '[working-agreement] Checking this session\'s mailbox; any mail comes with this prompt.'

/**
 * Builds a coordinator world, session sid, that delegates issue 12 to the unit session spawn started for it.
 * @param on - The test's hook registration.
 * @param changes - Further world options.
 * @returns The world, still in the coordinator's session.
 */
function arrange(on: Parameters<typeof createWorld>[0], changes: Options = {}): World {
  const world = createWorld(on, { branch: 'main' }, { session: coordinator, herdrEnv: inside, ...changes })
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
  await startSession($)
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

// contract: a send from a session whose spawn records cannot be read is refused with the read's error, sends nothing, and never says the session has no mailbox
test('a send whose own mailbox addresses cannot be read is refused, naming the error, and sends nothing', async ($, on) => {
  const world = arrange(on, { listFails: directory => directory === `${records}/spawn` })
  become(world, 'unit')
  const sent = await send($, { kind: 'inform', body: 'Found: the parser also drops tabs.' })
  expect(sent).toEqual({ isError: true, text: expect.stringMatching(/^\[working-agreement\] send refused: this session's mailbox addresses could not be read \(.+\), so nothing was sent; retry the send/) })
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
})

// contract: a unit that owes nothing reports with an inform: it reaches the live coordinator's new/ as the agent's, opens no conversation, and a reply to it is refused
test('a unit that owes nothing sends its coordinator an inform, which takes no reply', async ($, on) => {
  const world = arrange(on)
  become(world, 'unit')
  const sent = await send($, { kind: 'inform', body: 'Found: the parser also drops tabs.' })
  const [inform] = readBox(world, coordinatorBox, 'new')
  expect(inform).toMatchObject({ kind: 'inform', from: '12', to: 'coordinator-sid', issue: 12, in_reply_to: '', author: 'agent' })
  expect(sent.isError).toBe(false)
  expect(sent.text).toContain(`Sent inform ${inform!.id} to the coordinator (coordinator-sid); it takes no reply.`)
  become(world, 'coordinator')
  expect(await ring($)).toContain('the parser also drops tabs')
  expect((await send($, { kind: 'answer', body: 'Thanks.', in_reply_to: inform!.id })).text).toContain('an inform takes no reply')
  expect(readBox(world, unitBox, 'new')).toEqual([])
})

// contract: an inform is refused, with nothing written, while the unit owes an assign its done, as a reply, and from a coordinator
test('an inform is refused while an assign is owed, as a reply, and from a coordinator', async ($, on) => {
  const world = arrange(on)
  expect((await send($, { kind: 'inform', body: 'x' })).text).toContain('a coordinator messages a unit with unit_prompt')
  const assignId = await assign($, world)
  const owed = await send($, { kind: 'inform', body: 'Found a fact.' })
  expect(owed).toMatchObject({ isError: true })
  expect(owed.text).toContain(`assign ${assignId} is open: put this in its done`)
  expect((await send($, { kind: 'inform', body: 'x', in_reply_to: assignId })).text).toContain('an inform opens no conversation and is never a reply')
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
})

// contract: an open cancel is the one an inform's refusal names, since its done closes the assign it stopped too
test('an inform is refused while a cancel is owed, naming the cancel', async ($, on) => {
  const world = arrange(on)
  await assign($, world)
  become(world, 'coordinator')
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Stop.', kind: 'cancel' })).isError).toBe(false)
  const [cancel] = readBox(world, unitBox, 'new')
  become(world, 'unit')
  await ring($)
  const refused = await send($, { kind: 'inform', body: 'Found a fact.' })
  expect(refused).toMatchObject({ isError: true })
  expect(refused.text).toContain(`cancel ${cancel!.id} is open: put this in its done`)
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
})

// contract: a unit mailbox that cannot be listed leaves whether an assign is open unknown: the inform is refused as unknown, with how to check, and nothing is written
test('an inform is refused as unknown when the unit\'s mailbox cannot be listed', async ($, on) => {
  const fault = { isArmed: false }
  const world = arrange(on, { listFails: directory => fault.isArmed && directory === `${unitBox}/cur` })
  await assign($, world)
  fault.isArmed = true
  const refused = await send($, { kind: 'inform', body: 'Found a fact.' })
  expect(refused).toMatchObject({ isError: true })
  expect(refused.text).toContain('whether an assign or cancel is open is unknown')
  expect(refused.text).toContain(`the mod could not list ${unitBox}/cur, which this unit's owed mail is read from. Nothing was sent; check with ls ${unitBox}/cur, then send the inform again`)
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
})

// contract: a coordinator whose liveness cannot be established leaves the receiver unknown: an inform or question is refused as unknown, with how to check, never sent to the recorded address
test('a unit\'s inform or question is refused as unknown while its coordinator\'s liveness cannot be read', async ($, on) => {
  const world = arrange(on)
  world.files.set(scopeFile('sid'), buildScope('sid', [12], null))
  become(world, 'unit')
  for (const kind of ['inform', 'question']) {
    const refused = await send($, { kind, body: 'Found a fact.' })
    expect(refused).toMatchObject({ isError: true })
    expect(refused.text).toContain('whether a running coordinator delegates #12 is unknown: the process of coordinator-sid')
    expect(refused.text).toContain(`Nothing was sent, never to a recorded address; check that session sid still runs in its herdr pane, then send the ${kind} again`)
  }
  expect([...world.files.keys()].filter(path => path.includes('/new/'))).toEqual([])
})

// contract: a coordinator whose process record is present but cannot be read is not judged ended: the inform is refused as unknown, with how to check, and nothing is written
test('a unit\'s question or inform is refused as unknown, never as no running coordinator, while its coordinator\'s process cannot be read', async ($, on) => {
  const world = arrange(on, { failRead: path => path === `/proc/${coordinatorHost.pid}/stat` })
  become(world, 'unit')
  for (const kind of ['question', 'inform']) {
    const refused = await send($, { kind, body: 'Found a fact.' })
    expect(refused.isError).toBe(true)
    expect(refused.text).not.toContain('no running coordinator delegates')
    expect(refused.text).toContain('whether a running coordinator delegates #12 is unknown: the process of coordinator-sid')
    expect(refused.text).toContain(`check that session sid still runs in its herdr pane, then send the ${kind} again`)
  }
  expect([...world.files.keys()].filter(path => path.includes('/new/'))).toEqual([])
})

// contract: a coordinator whose process record cannot be read and whose existence check rejects is not judged ended: the send is refused as unknown, nothing written
test('a unit\'s question is refused as unknown while its coordinator\'s process cannot be read and its existence check rejects', async ($, on) => {
  const stat = `/proc/${coordinatorHost.pid}/stat`
  const world = arrange(on, { failRead: path => path === stat, existsFault: path => path === stat ? 'reject' : undefined })
  become(world, 'unit')
  const refused = await send($, { kind: 'question', body: 'Store A or B?' })
  expect(refused.isError).toBe(true)
  expect(refused.text).not.toContain('no running coordinator delegates')
  expect(refused.text).toContain('whether a running coordinator delegates #12 is unknown: the process of coordinator-sid')
  expect([...world.files.keys()].filter(path => path.includes('/new/'))).toEqual([])
})

// contract: a coordinator whose process record cannot be read is judged ended only when no stat finds it: an exists that says absent while a stat finds it leaves it unknown
test('a unit\'s question is refused as unknown while its coordinator\'s unreadable process record is missed by exists but found by stat', async ($, on) => {
  const stat = `/proc/${coordinatorHost.pid}/stat`
  const world = arrange(on, { failRead: path => path === stat, existsFault: path => path === stat ? 'absent' : undefined })
  become(world, 'unit')
  const refused = await send($, { kind: 'question', body: 'Store A or B?' })
  expect(refused.isError).toBe(true)
  expect(refused.text).not.toContain('no running coordinator delegates')
  expect(refused.text).toContain('whether a running coordinator delegates #12 is unknown: the process of coordinator-sid')
  expect([...world.files.keys()].filter(path => path.includes('/new/'))).toEqual([])
})

// contract: a step whose done the mod still owes never blocks the unit's inform
test('a unit owing only a step sends its inform', async ($, on) => {
  const world = arrange(on)
  world.files.set(`${unitBox}/cur/st.1.json`, JSON.stringify({ v: 2, id: 'st', kind: 'step', from: 'coordinator-sid', to: '12', issue: 12, in_reply_to: '', seq: 1,
    created_at: '2026-11-03T00:00:00.000Z', expects: '', attempt: 1, body: '/flow approve x', refs: [], author: 'agent', options: [] }))
  become(world, 'unit')
  expect((await send($, { kind: 'inform', body: 'Found a fact.' })).isError).toBe(false)
  expect(readBox(world, coordinatorBox, 'new')).toMatchObject([{ kind: 'inform', from: '12', body: 'Found a fact.' }])
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
  await startSession($)
  const [question] = readBox(world, coordinatorBox, 'new')
  await $.classic.FileChanged({ file_path: `${coordinatorBox}/new/${question!.id}.1.json`, event: 'add' } as never)
  await world.clock.settle()
  expect(world.prompts.filter(prompt => prompt === doorbell)).toHaveLength(1)
})
