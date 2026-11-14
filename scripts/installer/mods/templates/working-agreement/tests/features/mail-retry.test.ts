import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { minuteMs, replyDeadlineMs, tickMs } from '../../hooks/core/timing'
import { createEmptySession } from '../../hooks/domain/records'
import { coordinator } from '../support/builders'
import { callModTool, inside, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { buildScope, buildStat, coordinatorHost, createWorld, markSpawned, records, root, scopeFile } from '../support/world'
import type { Options, World } from '../support/world'

/** A message as its file holds it. */
interface Mail { id: string; kind: string; from: string; to: string; issue: number; in_reply_to: string; attempt: number; body: string; author: string }

/** A dead letter as its record holds it. */
interface DeadLetter { id: string; reason: string; replies: string[]; envelope: Mail; untold?: string[] }

const unitSession = 'unit-12'
const coordinatorBox = `${records}/mail/coordinator-sid`
const unitBox = `${records}/mail/12`
const userBox = `${records}/mail/user`
const doorbell = '[working-agreement] Checking this session\'s mailbox; any mail comes with this prompt.'

/**
 * Builds a coordinator world, session sid, that delegates issue 12 to the unit session spawn started for it, with the tick registered.
 * @param $ - The engine.
 * @param on - The test's hook registration.
 * @param changes - Further world options.
 * @returns The world, in the coordinator's session.
 */
async function arrange($: Engine, on: Parameters<typeof createWorld>[0], changes: Options = {}): Promise<World> {
  const world = createWorld(on, { branch: 'main' }, { session: coordinator, herdrEnv: inside, herdrReply: () => '{}', ...changes })
  world.files.set(scopeFile('sid'), buildScope('sid', [12]))
  // why: the coordinator's start records its own process in the scope, so it runs as the process the scope names.
  world.files.set('/proc/self/stat', buildStat(coordinatorHost.pid, coordinatorHost.pidStart))
  markSpawned(world, [12], unitSession)
  world.seedChat(unitSession, createEmptySession(unitSession))
  // why: the retry runs on the session's tick, which session start registers.
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
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
 * Submits the doorbell's prompt in the world's session and reads the mail block it entered with.
 * @param $ - The engine.
 * @returns The context, joined.
 */
const ring = async ($: Engine): Promise<string> =>
  ((await $.classic.UserPromptSubmit({ prompt: doorbell, permission_mode: 'default' } as never)) as { additionalContext?: string[] }).additionalContext?.join('\n') ?? ''

/**
 * Lets the clock run tick by tick in the world's session.
 * @param world - The world.
 * @param ms - How long.
 */
async function wait(world: World, ms: number): Promise<void> {
  if (ms <= 0) return
  await world.clock.advance(tickMs)
  await world.clock.settle()
  await wait(world, ms - tickMs)
}

/**
 * Lets a question's reply deadline pass in the unit's session, then has the coordinator read the repeat.
 * @param $ - The engine.
 * @param world - The world, in the unit's session, and again in it after.
 */
async function letRepeatArrive($: Engine, world: World): Promise<void> {
  await wait(world, replyDeadlineMs)
  become(world, 'coordinator')
  await ring($)
  become(world, 'unit')
}

/**
 * Reads a message's dead letter.
 * @param world - The world.
 * @param id - The message's id.
 * @returns The record, or undefined when none was written.
 */
const readDeadLetter = (world: World, id: string): DeadLetter | undefined => {
  const text = world.files.get(`${records}/deadletters/${id}.json`)
  return text === undefined ? undefined : JSON.parse(text) as DeadLetter
}

/**
 * Has the unit ask its coordinator a question, read by the coordinator; the world ends in the unit's session.
 * @param $ - The engine.
 * @param world - The world.
 * @returns The question's id.
 */
async function askAndRead($: Engine, world: World): Promise<string> {
  become(world, 'unit')
  expect((await callModTool($, 'send', { kind: 'question', body: 'Memory or disk?', options: ['Memory', 'Disk'] })).isError).toBe(false)
  const [question] = readBox(world, coordinatorBox, 'new')
  become(world, 'coordinator')
  expect(await ring($)).toContain('Memory or disk?')
  become(world, 'unit')
  return question!.id
}

/**
 * Reads the coordinator pane's Inbox row as a refresh draws it.
 * @param $ - The engine.
 * @param world - The world.
 * @returns The row's value.
 */
async function readInboxRow($: Engine, world: World): Promise<string | undefined> {
  become(world, 'coordinator')
  await runFlowCommand($, '')
  return world.views.at(-1)?.meta.find(row => row.key === 'Inbox')?.value
}

// contract: every conversation ends in a reply or a dead letter: a question acked and not answered gets a repeat once per reply deadline, and after attempt 3 is dead-lettered to the user's mailbox with its reason, its sender told, the coordinator's pane counting it
test('an unanswered question is repeated once per deadline and dead-lettered to the user after three attempts', async ($, on) => {
  const world = await arrange($, on)
  const id = await askAndRead($, world)
  await wait(world, replyDeadlineMs - tickMs)
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
  for (const attempt of [2, 3]) {
    await wait(world, tickMs)
    expect(readBox(world, coordinatorBox, 'new').map(mail => [mail.id, mail.attempt])).toEqual([[id, attempt]])
    become(world, 'coordinator')
    expect(await ring($)).toContain(`repeat, attempt ${attempt}`)
    become(world, 'unit')
    await wait(world, replyDeadlineMs - tickMs)
  }
  expect(readDeadLetter(world, id)).toBeUndefined()
  await wait(world, tickMs)
  expect(readDeadLetter(world, id)).toMatchObject({ id, reason: 'not replied to after 3 attempts', replies: [] })
  expect(readBox(world, userBox, 'new')).toMatchObject([{ kind: 'inform', from: '12', author: 'mod', issue: 12 }])
  expect(readBox(world, userBox, 'new')[0]!.body).toContain(`Dead letter: a question ${id} from 12 to coordinator-sid about #12, not replied to after 3 attempts`)
  expect(readBox(world, unitBox, 'new')).toMatchObject([{ kind: 'inform', from: '12', author: 'mod' }])
  expect(readBox(world, unitBox, 'new')[0]!.body).toContain(`Your question ${id} to coordinator-sid about #12 was dead-lettered`)
  await wait(world, 3 * replyDeadlineMs)
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
  expect(readBox(world, userBox, 'new')).toHaveLength(1)
  expect(await readInboxRow($, world)).toBe('0 open questions for you · 1 dead letter')
})

// contract: a dead letter whose inform to the user fails is still recorded, its sender is told the user was not told, with the error, and the dead letter keeps who was not told
test('a dead letter whose inform to the user fails tells its sender the user was not told', async ($, on) => {
  const fault = { isArmed: false }
  const world = await arrange($, on, { beforeRun: argv => {
    if (!fault.isArmed || argv[0] !== 'ln' || !(argv.at(-1) ?? '').startsWith(`${userBox}/new/`)) return
    fault.isArmed = false
    throw new Error('disk full')
  } })
  const id = await askAndRead($, world)
  await letRepeatArrive($, world)
  await letRepeatArrive($, world)
  fault.isArmed = true
  await wait(world, replyDeadlineMs)
  expect(readDeadLetter(world, id)).toMatchObject({ id, reason: 'not replied to after 3 attempts' })
  expect(readBox(world, userBox, 'new')).toEqual([])
  const told = readBox(world, unitBox, 'new').find(mail => mail.body.startsWith(`Your question ${id}`))
  expect(told?.body).toMatch(/the user was not told \([^)]+\)/)
  expect(told?.body).toContain('the dead letter is kept, and /flow status lists it')
  expect(readDeadLetter(world, id)?.untold).toEqual([expect.stringMatching(/^the user was not told \(/)])
})

// contract: a dead letter that cannot keep who was not told tells its sender where it is, never that /flow status lists it
test('a dead letter that cannot keep who was not told names its record to the sender instead of /flow status', async ($, on) => {
  const fault = { isArmed: false }
  const world = await arrange($, on, {
    beforeRun: argv => {
      if (!fault.isArmed || argv[0] !== 'ln' || !(argv.at(-1) ?? '').startsWith(`${userBox}/new/`)) return
      fault.isArmed = false
      throw new Error('disk full')
    },
    failRun: argv => fault.isArmed || argv[0] !== 'mv' || !(argv.at(-1) ?? '').startsWith(`${records}/deadletters/`) ? undefined : { exitCode: 1, stderr: 'read-only file system' },
  })
  const id = await askAndRead($, world)
  await letRepeatArrive($, world)
  await letRepeatArrive($, world)
  fault.isArmed = true
  await wait(world, replyDeadlineMs)
  const told = readBox(world, unitBox, 'new').find(mail => mail.body.startsWith(`Your question ${id}`))
  expect(told?.body).toContain(`the dead letter is at ${records}/deadletters/${id}.json, which /flow status cannot list (`)
  expect(told?.body).not.toContain('/flow status lists it')
})

// contract: a dead letter whose notice to its sender fails is marked on the coordinator pane's dead-letter count and named by /flow status
test('a dead letter whose notice to its sender fails is shown on the pane and by /flow status', async ($, on) => {
  const fault = { isArmed: false }
  const world = await arrange($, on, { beforeRun: argv => {
    if (!fault.isArmed || argv[0] !== 'ln' || !(argv.at(-1) ?? '').startsWith(`${unitBox}/new/`)) return
    fault.isArmed = false
    throw new Error('disk full')
  } })
  const id = await askAndRead($, world)
  await letRepeatArrive($, world)
  await letRepeatArrive($, world)
  fault.isArmed = true
  await wait(world, replyDeadlineMs)
  expect(readDeadLetter(world, id)).toBeDefined()
  expect(readBox(world, unitBox, 'new').find(mail => mail.body.startsWith(`Your question ${id}`))).toBeUndefined()
  expect(await readInboxRow($, world)).toBe('0 open questions for you · 1 dead letter · 1 with a notice not delivered · /flow status')
  expect((await runFlowCommand($, 'status')).text).toMatch(new RegExp(`dead letter ${id} about #12 · 12 was not told \\(`))
})

// contract: a reply after its message's dead letter is delivered to the sender and recorded on the dead letter, never lost
test('a reply after the dead letter reaches the sender and is recorded on the dead letter', async ($, on) => {
  const world = await arrange($, on)
  const id = await askAndRead($, world)
  await letRepeatArrive($, world)
  await letRepeatArrive($, world)
  await wait(world, replyDeadlineMs)
  expect(readDeadLetter(world, id)).toBeDefined()
  become(world, 'coordinator')
  const late = await callModTool($, 'send', { kind: 'answer', body: 'Memory.', in_reply_to: id })
  expect(late.isError).toBe(false)
  expect(late.text).toContain('recorded on that dead letter')
  expect(readBox(world, unitBox, 'new').filter(mail => mail.kind === 'answer')).toMatchObject([{ in_reply_to: id, body: 'Memory.' }])
  expect(readDeadLetter(world, id)!.replies).toEqual([`${id}-re-coordinator-sid`])
})

// contract: a late reply, after a deadline but before the dead letter, closes its conversation: no further attempt and no dead letter
test('a late answer after a repeat closes the question', async ($, on) => {
  const world = await arrange($, on)
  const id = await askAndRead($, world)
  await wait(world, replyDeadlineMs)
  become(world, 'coordinator')
  expect(await ring($)).toContain('repeat, attempt 2')
  expect((await callModTool($, 'send', { kind: 'answer', body: 'Disk.', in_reply_to: id })).text).not.toContain('dead letter')
  become(world, 'unit')
  await wait(world, 3 * replyDeadlineMs)
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
  expect(readDeadLetter(world, id)).toBeUndefined()
  expect(readBox(world, userBox, 'new')).toEqual([])
})

// contract: an assign not acked waits in new/ on the receiver's liveness, never repeated nor dead-lettered however long its turn, and is delivered once
test('an unacknowledged assign to a unit in one long turn stays in new/ and is delivered once at its Stop', async ($, on) => {
  const world = await arrange($, on)
  become(world, 'unit')
  await $.turn.start({ text: 'verify', turnId: 't' })
  become(world, 'coordinator')
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Then B.', kind: 'assign' })).isError).toBe(false)
  const [assign] = readBox(world, unitBox, 'new')
  await wait(world, 10 * minuteMs)
  expect(readBox(world, unitBox, 'new').map(mail => [mail.id, mail.attempt])).toEqual([[assign!.id, 1]])
  expect(readDeadLetter(world, assign!.id)).toBeUndefined()
  expect(readBox(world, userBox, 'new')).toEqual([])
  become(world, 'unit')
  expect((await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)).block).toContain('Then B.')
  expect(readBox(world, unitBox, 'new')).toEqual([])
  expect(readBox(world, unitBox, 'cur').map(mail => mail.id)).toEqual([assign!.id])
})

// contract: a unit's inform, read by its coordinator and never answered, gets no new attempt and no dead letter
test('a unit\'s inform read and never answered is neither repeated nor dead-lettered', async ($, on) => {
  const world = await arrange($, on)
  become(world, 'unit')
  expect((await callModTool($, 'send', { kind: 'inform', body: 'Found a fact.' })).isError).toBe(false)
  const [inform] = readBox(world, coordinatorBox, 'new')
  become(world, 'coordinator')
  expect(await ring($)).toContain('Found a fact.')
  become(world, 'unit')
  await wait(world, 4 * replyDeadlineMs)
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
  expect(readBox(world, coordinatorBox, 'cur').map(mail => [mail.id, mail.attempt])).toEqual([[inform!.id, 1]])
  expect(readDeadLetter(world, inform!.id)).toBeUndefined()
  expect(readBox(world, userBox, 'new')).toEqual([])
})

// contract: a done after a cancel is a valid terminal of the cancel: neither the cancel nor the assign it stopped is repeated or dead-lettered
test('a done after a cancel ends both the cancel and the assign it stopped', async ($, on) => {
  const world = await arrange($, on)
  await callModTool($, 'unit_prompt', { number: 12, text: 'Build A.', kind: 'assign' })
  become(world, 'unit')
  await ring($)
  become(world, 'coordinator')
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Stop.', kind: 'cancel' })).isError).toBe(false)
  const [cancel] = readBox(world, unitBox, 'new')
  become(world, 'unit')
  await ring($)
  expect((await callModTool($, 'send', { kind: 'done', body: 'Stopped.', in_reply_to: cancel!.id })).isError).toBe(false)
  become(world, 'coordinator')
  await wait(world, 4 * replyDeadlineMs)
  expect(readBox(world, unitBox, 'new')).toEqual([])
  expect(readBox(world, userBox, 'new')).toEqual([])
  expect(world.files.has(`${records}/deadletters/${cancel!.id}.json`)).toBe(false)
})
