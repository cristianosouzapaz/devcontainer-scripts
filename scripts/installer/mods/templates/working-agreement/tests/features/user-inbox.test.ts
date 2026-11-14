import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { tickMs } from '../../hooks/core/timing'
import { createEmptySession } from '../../hooks/domain/records'
import { coordinator } from '../support/builders'
import { callModTool, inside, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { buildScope, createWorld, markSpawned, records, root, scopeFile } from '../support/world'
import type { Options, World } from '../support/world'

/** A message as its file holds it. */
interface Mail { id: string; kind: string; from: string; to: string; issue: number; in_reply_to: string; seq: number; body: string; author: string; options: string[] }

/** A comment the world's GitHub holds. */
interface Comment { url: string; createdAt: string; body: string }

/** A coordinator world, the comments its GitHub holds, and whether a comment post fails. */
interface InboxWorld { world: World; comments: Comment[]; failure: { isPostFailing: boolean } }

const unitSession = 'unit-12'
const coordinatorBox = `${records}/mail/coordinator-sid`
const unitBox = `${records}/mail/12`
const userBox = `${records}/mail/user`
const doorbell = '[working-agreement] Checking this session\'s mailbox; any mail comes with this prompt.'
const choices = ['Keep the store in memory', 'Write it to disk']

/**
 * Builds a coordinator world, session sid, that delegates issue 12 to the unit session spawn started for it; its GitHub records comments.
 * @param on - The test's hook registration.
 * @param changes - Further world options.
 * @returns The world, still in the coordinator's session.
 */
function arrange(on: Parameters<typeof createWorld>[0], changes: Options = {}): InboxWorld {
  const comments: Comment[] = []
  const failure = { isPostFailing: false }
  const gh = (args: string[]): { stdout?: string; exitCode?: number; stderr?: string } | undefined => {
    if (args[0] !== 'issue' || args[1] !== 'comment') return undefined
    if (failure.isPostFailing) return { exitCode: 1, stderr: 'HTTP 502' }
    const url = `https://github.com/o/r/issues/${args[2]}#issuecomment-${comments.length + 1}`
    comments.push({ url, createdAt: new Date(comments.length + 10).toISOString(), body: args[4] ?? '' })
    return { stdout: `${url}\n` }
  }
  const world = createWorld(on, { branch: 'main' }, { session: coordinator, herdrEnv: inside, gh, comments: { 12: comments as never }, ...changes })
  world.files.set(scopeFile('sid'), buildScope('sid', [12]))
  markSpawned(world, [12], unitSession)
  world.seedChat(unitSession, createEmptySession(unitSession))
  return { world, comments, failure }
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
 * Submits the doorbell's prompt and reads the mail block it entered with.
 * @param $ - The engine.
 * @returns The context, joined.
 */
const ring = async ($: Engine): Promise<string> =>
  ((await $.classic.UserPromptSubmit({ prompt: doorbell, permission_mode: 'default' } as never)) as { additionalContext?: string[] }).additionalContext?.join('\n') ?? ''

/**
 * Has the unit ask its coordinator a question with options, read by the coordinator, and returns it.
 * @param $ - The engine.
 * @param world - The world.
 * @param options - The question's options.
 * @returns The question as the coordinator's mailbox holds it.
 */
async function askCoordinator($: Engine, world: World, options: string[] = choices): Promise<Mail> {
  become(world, 'unit')
  expect((await send($, { kind: 'question', body: 'Where does the store live? I propose memory.', options })).isError).toBe(false)
  const [question] = readBox(world, coordinatorBox, 'new')
  become(world, 'coordinator')
  await ring($)
  return question!
}

/**
 * Reads the coordinator pane's Inbox row as the last refresh drew it.
 * @param $ - The engine.
 * @param world - The world.
 * @returns The row's value.
 */
async function readInboxRow($: Engine, world: World): Promise<string | undefined> {
  await runFlowCommand($, '')
  return world.views.at(-1)?.meta.find(row => row.key === 'Inbox')?.value
}

// contract: a coordinator forwards a unit's question to the user's mailbox unchanged but for its receiver, records the forward, raises a notification and records the question on the issue, with no pane read
test('a forwarded question reaches the user\'s mailbox unchanged, notifies the coordinator and is recorded on the issue', async ($, on) => {
  const { world, comments } = arrange(on)
  const question = await askCoordinator($, world)
  const forwarded = await send($, { kind: 'question', to: 'user', forward: question.id, body: 'A ⛳: storage is the user\'s call.' })
  expect(forwarded.isError).toBe(false)
  const [copy] = readBox(world, userBox, 'new')
  expect(copy).toEqual({ ...question, to: 'user' })
  expect(copy).toMatchObject({ from: '12', author: 'agent', options: choices })
  expect(world.files.has(`${records}/forwards/${question.id}.json`)).toBe(true)
  await $.classic.FileChanged({ file_path: `${userBox}/new/${question.id}.1.json`, event: 'add' } as never)
  expect(world.notifications).toEqual([`#12 asks you: Where does the store live? I propose memory. — /flow inbox`])
  expect(comments).toHaveLength(1)
  expect(comments[0]!.body).toStartWith('## Question for the user')
  expect(comments[0]!.body).toContain('a) Keep the store in memory')
  expect(comments[0]!.body).toContain(`<!-- mail:${question.id} -->`)
  expect(world.herdrCalls.filter(call => call.argv[1] === 'agent' || call.argv[1] === 'pane')).toEqual([])
})

// contract: /flow inbox shows each open question with its lettered options and moves the mail it showed to cur/; the user's answer goes to the asking unit as <id>-re-user, typed by the user, the forwarding coordinator is told, and the unit's doorbell delivers it
test('/flow inbox shows the question, and the user\'s answer reaches the unit, which is delivered it, and the coordinator is told', async ($, on) => {
  const { world, comments } = arrange(on)
  const question = await askCoordinator($, world)
  await send($, { kind: 'question', to: 'user', forward: question.id, body: 'Your call.' })
  const inbox = (await runFlowCommand($, 'inbox')).text ?? ''
  expect(inbox).toContain('1 open question for you')
  expect(inbox).toContain('a) Keep the store in memory\nb) Write it to disk')
  expect(inbox).toContain(`/flow inbox answer ${question.id} <letter|no> [words]`)
  expect(readBox(world, userBox, 'new')).toEqual([])
  expect(await readInboxRow($, world)).toBe('1 open question for you · /flow inbox')
  const answered = await runFlowCommand($, `inbox answer ${question.id} b it must survive restarts`)
  expect(answered.text).toContain(`Answered ${question.id} to 12: Option b: Write it to disk.`)
  const [answer] = readBox(world, unitBox, 'new')
  expect(answer).toMatchObject({ kind: 'answer', from: 'user', author: 'user', to: '12', issue: 12, in_reply_to: question.id, id: `${question.id}-re-user`,
    body: 'Option b: Write it to disk\nUser\'s words: "b it must survive restarts"' })
  expect(readBox(world, coordinatorBox, 'new')).toMatchObject([{ kind: 'inform', from: 'user', author: 'mod', issue: 12 }])
  expect(comments.map(comment => comment.body.split('\n')[0])).toEqual(['## Question for the user', '## User answer'])
  expect(await readInboxRow($, world)).toBe('0 open questions for you')
  become(world, 'unit')
  const block = await ring($)
  expect(block).toContain('Option b: Write it to disk')
  expect(block).toContain('typed by the user in /flow inbox')
})

// contract: the user's answer reaches the unit even when the inform to the forwarding coordinator fails, and the reply says the coordinator was not told, with the error
test('a user answer whose inform to the forwarding coordinator fails says the coordinator was not told', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = arrange(on, { beforeRun: argv => {
    if (!fault.isArmed || argv[0] !== 'ln' || !(argv.at(-1) ?? '').startsWith(`${coordinatorBox}/new/`)) return
    fault.isArmed = false
    throw new Error('disk full')
  } })
  const question = await askCoordinator($, world)
  await send($, { kind: 'question', to: 'user', forward: question.id, body: 'Your call.' })
  await runFlowCommand($, 'inbox')
  fault.isArmed = true
  const answered = await runFlowCommand($, `inbox answer ${question.id} b`)
  expect(answered.text).toContain(`Answered ${question.id} to 12`)
  expect(answered.text).toMatch(/coordinator-sid was not told \([^)]+\)/)
  expect(readBox(world, unitBox, 'new')).toMatchObject([{ kind: 'answer', in_reply_to: question.id }])
  expect(readBox(world, coordinatorBox, 'new').filter(mail => mail.body.startsWith('The user answered'))).toEqual([])
})

// contract: after a forward the coordinator's own answer to the question is refused, a unit cannot address the user, and a question to the user needs at least two options
test('a forwarded question takes only the user\'s answer, a unit cannot address the user, and a question to the user needs two options', async ($, on) => {
  const { world } = arrange(on)
  const question = await askCoordinator($, world)
  await send($, { kind: 'question', to: 'user', forward: question.id, body: 'Your call.' })
  const late = await send($, { kind: 'answer', body: 'Take memory.', in_reply_to: question.id })
  expect(late.isError).toBe(true)
  expect(late.text).toContain('was forwarded to the user')
  expect(await send($, { kind: 'question', to: 'user', issue: 12, body: 'One way only?', options: ['Yes'] })).toMatchObject({ isError: true })
  const single = await askCoordinator($, world, ['Only memory'])
  expect((await send($, { kind: 'question', to: 'user', forward: single.id, body: 'Your call.' })).text).toContain('needs at least 2')
  become(world, 'unit')
  const direct = await send($, { kind: 'question', to: 'user', body: 'Disk?', options: choices })
  expect(direct.isError).toBe(true)
  expect(direct.text).toContain('a unit asks its coordinator only')
  expect(readBox(world, userBox, 'new').map(mail => mail.id)).toEqual([question.id])
})

// contract: an answer whose first word is neither a declared letter nor no is sent as No (unrecognised answer) with the words verbatim; an unknown or already answered id is refused
test('an unrecognised answer is a no, and an unknown or answered id is refused', async ($, on) => {
  const { world } = arrange(on)
  expect((await send($, { kind: 'question', to: 'user', issue: 12, body: 'Ship tonight?', options: ['Ship', 'Wait'] })).isError).toBe(false)
  const [question] = readBox(world, userBox, 'new')
  expect((await runFlowCommand($, 'inbox answer nope a')).text).toContain('no question nope is in your inbox')
  expect((await runFlowCommand($, `inbox answer ${question!.id} maybe later`)).text).toContain('No (unrecognised answer)')
  const [answer] = readBox(world, coordinatorBox, 'new')
  expect(answer).toMatchObject({ from: 'user', author: 'user', body: 'No (unrecognised answer)\nUser\'s words: "maybe later"' })
  expect((await runFlowCommand($, `inbox answer ${question!.id} a`)).text).toContain('already answered')
  expect((await runFlowCommand($, `inbox answer ${question!.id}`)).text).toContain('Usage: /flow inbox answer')
})

// contract: /flow inbox, in every form, is the user's to type: from any other origin it is refused and moves no mail
test('/flow inbox is refused unless typed at the prompt', async ($, on) => {
  const { world } = arrange(on)
  await send($, { kind: 'question', to: 'user', issue: 12, body: 'Ship tonight?', options: ['Ship', 'Wait'] })
  const [question] = readBox(world, userBox, 'new')
  for (const args of ['inbox', `inbox answer ${question!.id} a`]) {
    expect((await runFlowCommand($, args, { kind: 'plugin', name: 'working-agreement' })).text).toContain('is the user\'s to run at the local terminal')
  }
  expect(readBox(world, userBox, 'new')).toHaveLength(1)
  expect(readBox(world, coordinatorBox, 'new')).toEqual([])
})

// contract: the user's mailbox is no session's own: its mail is never injected into a coordinator's or a unit's model
test('mail for the user is never delivered to a session\'s model', async ($, on) => {
  const { world } = arrange(on)
  await send($, { kind: 'question', to: 'user', issue: 12, body: 'PROBE-USER-ONLY', options: ['Ship', 'Wait'] })
  expect(await ring($)).not.toContain('PROBE-USER-ONLY')
  become(world, 'unit')
  expect(await ring($)).not.toContain('PROBE-USER-ONLY')
  expect(readBox(world, userBox, 'new')).toHaveLength(1)
})

// contract: a question to the user never expires: it carries no expectation and stays open, and counted on the coordinator's pane, however long it waits
test('a question to the user never expires', async ($, on) => {
  const { world } = arrange(on)
  await send($, { kind: 'question', to: 'user', issue: 12, body: 'Ship tonight?', options: ['Ship', 'Wait'] })
  const [question] = readBox(world, userBox, 'new') as (Mail & { expects: string })[]
  expect(question!.expects).toBe('')
  await world.clock.advance(30 * 24 * 60 * 60 * 1000)
  expect(await readInboxRow($, world)).toBe('1 open question for you · /flow inbox')
  expect((await runFlowCommand($, 'inbox')).text).toContain('1 open question for you')
})

// contract: a failed issue comment never blocks the message: it is recorded as owed, shown on the coordinator's pane, and posted once by the coordinator's tick, never twice
test('a failed issue comment is shown as owed and posted once by the coordinator\'s tick', async ($, on) => {
  const { world, comments, failure } = arrange(on)
  // why: the retry runs on the session's tick, which session start registers.
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  failure.isPostFailing = true
  const sent = await send($, { kind: 'question', to: 'user', issue: 12, body: 'Ship tonight?', options: ['Ship', 'Wait'] })
  expect(sent.isError).toBe(false)
  expect(sent.text).toContain('Recording it on #12 failed')
  expect(readBox(world, userBox, 'new')).toHaveLength(1)
  expect(await readInboxRow($, world)).toBe('1 open question for you · /flow inbox · 1 not recorded on the issue')
  failure.isPostFailing = false
  await world.clock.advance(tickMs)
  await world.clock.settle()
  expect(comments).toHaveLength(1)
  await world.clock.advance(tickMs)
  await world.clock.settle()
  expect(comments).toHaveLength(1)
  expect(await readInboxRow($, world)).toBe('1 open question for you · /flow inbox')
})

// contract: a retried comment whose marker the issue already carries is not posted again
test('a retry finds the comment already posted by its marker and does not post it again', async ($, on) => {
  const { world, comments, failure } = arrange(on)
  // why: the retry runs on the session's tick, which session start registers.
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  failure.isPostFailing = true
  await send($, { kind: 'question', to: 'user', issue: 12, body: 'Ship tonight?', options: ['Ship', 'Wait'] })
  const [question] = readBox(world, userBox, 'new')
  comments.push({ url: 'https://github.com/o/r/issues/12#issuecomment-99', createdAt: new Date(99).toISOString(), body: `posted elsewhere <!-- mail:${question!.id} -->` })
  failure.isPostFailing = false
  await world.clock.advance(tickMs)
  await world.clock.settle()
  expect(comments).toHaveLength(1)
  expect(await readInboxRow($, world)).toBe('1 open question for you · /flow inbox')
})

// contract: with no live coordinator for their issues, a session's start tells the user, never the model, how many questions wait for them; with one, it says nothing
test('a session start with no live coordinator reminds the user of waiting questions, and stays quiet while one runs', async ($, on) => {
  const { world } = arrange(on)
  await send($, { kind: 'question', to: 'user', issue: 12, body: 'Ship tonight?', options: ['Ship', 'Wait'] })
  become(world, 'unit')
  const started = await $.classic.SessionStart({ source: 'startup' }) as { additionalContext?: string[] }
  expect(world.toasts).toEqual([])
  world.files.delete(scopeFile('sid'))
  const restarted = await $.classic.SessionStart({ source: 'resume' }) as { additionalContext?: string[] }
  expect(world.toasts).toEqual(['1 question for you waits in /flow inbox.'])
  expect([...started.additionalContext ?? [], ...restarted.additionalContext ?? []].join('\n')).not.toContain('Ship tonight?')
})

// contract: while a live coordinator delegates a waiting question's issue, no session's start reminds the user: not a plain session, not the coordinator, not another issue's unit; once none does, a plain session's start reminds the user, never the model
test('no session start reminds the user of a question whose issue a live coordinator delegates, and a plain one does once none does', async ($, on) => {
  const { world } = arrange(on)
  await send($, { kind: 'question', to: 'user', issue: 12, body: 'Ship tonight?', options: ['Ship', 'Wait'] })
  markSpawned(world, [13], 'unit-13')
  for (const id of ['plain', 'unit-13']) world.seedChat(id, createEmptySession(id))
  for (const id of ['plain', 'sid', 'unit-13']) {
    world.chat.id = id
    await $.classic.SessionStart({ source: 'startup' })
  }
  expect(world.toasts).toEqual([])
  world.files.delete(scopeFile('sid'))
  world.chat.id = 'plain'
  const started = await $.classic.SessionStart({ source: 'startup' }) as { additionalContext?: string[] }
  expect(world.toasts).toEqual(['1 question for you waits in /flow inbox.'])
  expect((started.additionalContext ?? []).join('\n')).not.toContain('Ship tonight?')
})
