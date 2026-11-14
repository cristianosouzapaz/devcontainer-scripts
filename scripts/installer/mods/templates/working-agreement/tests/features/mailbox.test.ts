import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { sweepMailStaging } from '../../hooks/core/mailbox'
import { createEmptySession } from '../../hooks/domain/records'
import { coordinator } from '../support/builders'
import { callModTool, inside, readFlowStatus, readStatusRow, startSession } from '../support/helpers'
import { test } from '../support/kit'
import { common, createTestPort, createWorld, markSpawned, records } from '../support/world'
import type { Options, World } from '../support/world'

/** A promise the test holds a host call on, until it opens it. */
interface Gate { promise: Promise<void>; open: () => void }

const unitSession = 'unit-12'
const box = `${records}/mail/12`
const doorbell = '[working-agreement] Checking this session\'s mailbox; any mail comes with this prompt.'

/**
 * Creates a closed gate.
 * @returns The gate.
 */
function createGate(): Gate {
  const opener = { open: (): void => {} }
  const promise = new Promise<void>(resolve => { opener.open = resolve })
  return { promise, open: () => { opener.open() } }
}

/**
 * Builds a coordinator world whose issue 12 has a spawned unit.
 * @param on - The test's hook registration.
 * @param extra - More world options.
 * @returns The world.
 */
function arrange(on: Parameters<typeof createWorld>[0], extra: Options = {}): World {
  const world = createWorld(on, { branch: 'main' }, { session: coordinator, herdrEnv: inside, herdrReply: () => '{}', ...extra })
  markSpawned(world, [12], unitSession)
  return world
}

/**
 * Moves the world to the unit's own session, which spawn started for issue 12.
 * @param world - The world.
 */
function becomeUnit(world: World): void {
  world.seedChat(unitSession, createEmptySession(unitSession))
  world.chat.id = unitSession
}

/**
 * Lists the file names of a mailbox directory.
 * @param world - The world.
 * @param directory - The directory under the unit's mailbox.
 * @returns The names.
 */
const listBox = (world: World, directory: string): string[] => [...world.files.keys()].filter(path => path.startsWith(`${box}/${directory}/`)).map(path => path.slice(box.length + directory.length + 2))

/**
 * Raises the watched file event of a path.
 * @param $ - The engine.
 * @param path - The file.
 * @param event - The event's type.
 */
const fileEvent = async ($: Engine, path: string, event: 'add' | 'unlink' | 'change'): Promise<void> => {
  await $.classic.FileChanged({ file_path: path, event } as never)
}

/**
 * Raises the engine's prompt submit event for a prompt, as it does for the user's and for the mod's own.
 * @param $ - The engine.
 * @param prompt - The prompt's text.
 * @returns What the hooks answered.
 */
const submit = ($: Engine, prompt: string): Promise<{ additionalContext?: string[]; block?: string }> => $.classic.UserPromptSubmit({ prompt, permission_mode: 'default' } as never)

/**
 * Submits a prompt the user typed and reads the context it entered with.
 * @param $ - The engine.
 * @returns The context, joined.
 */
const typed = async ($: Engine): Promise<string> => (await submit($, 'go')).additionalContext?.join('\n') ?? ''

/**
 * Counts the doorbell prompts submitted.
 * @param world - The world.
 * @returns How many.
 */
const rings = (world: World): number => world.prompts.filter(prompt => prompt === doorbell).length

/**
 * Lets the deferred work run.
 * @param world - The world.
 */
const settle = (world: World): Promise<void> => world.clock.settle()

test('unit_prompt sends an inform, or an assign when asked, into the unit\'s mailbox, from the coordinator\'s own address, without herdr', async ($, on) => {
  const world = arrange(on)
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Take option A.', from: 'user' })).isError).toBe(false)
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'Then B.', kind: 'assign' })).isError).toBe(false)
  const mail = listBox(world, 'new').map(name => JSON.parse(world.files.get(`${box}/new/${name}`) ?? '{}') as Record<string, unknown>)
  expect(mail.map(({ kind, from, to, issue, seq, body, attempt, v }) => ({ kind, from, to, issue, seq, body, attempt, v })).sort((a, b) => Number(a.seq) - Number(b.seq))).toEqual([
    { kind: 'inform', from: 'coordinator-sid', to: '12', issue: 12, seq: 1, body: 'Take option A.', attempt: 1, v: 2 },
    { kind: 'assign', from: 'coordinator-sid', to: '12', issue: 12, seq: 2, body: 'Then B.', attempt: 1, v: 2 },
  ])
  expect(world.herdrCalls.filter(call => call.argv[1] === 'agent' && call.argv[2] === 'prompt')).toEqual([])
  expect(listBox(world, 'tmp')).toEqual([])
})

test('unit_prompt refuses a unit spawn never started, a text over the cap, another kind and a slash command', async ($, on) => {
  const world = arrange(on)
  expect((await callModTool($, 'unit_prompt', { number: 13, text: 'x' })).text).toContain('no unit spawn started')
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'x'.repeat(8001) })).text).toContain('over the 8000')
  expect((await callModTool($, 'unit_prompt', { number: 12, text: 'x', kind: 'answer' })).text).toContain('kind must be inform, assign or cancel')
  expect((await callModTool($, 'unit_prompt', { number: 12, text: '/to-spec' })).text).toContain('a message cannot run a slash command')
  expect(listBox(world, 'new')).toEqual([])
  expect(world.herdrCalls).toEqual([])
})

test('unit_prompt refuses /flow skip and /flow follow-up, naming their tools, and neither types nor mails them', async ($, on) => {
  const world = arrange(on)
  for (const [text, tool] of [['/flow skip Spec', 'skip_unit'], ['/flow follow-up #12', 'follow_up_unit']] as const) {
    const result = await callModTool($, 'unit_prompt', { number: 12, text })
    expect(result.isError).toBe(true)
    expect(result.text).toContain(tool)
  }
  expect(world.herdrCalls.filter(call => call.argv.includes('prompt'))).toEqual([])
  expect(listBox(world, 'new')).toEqual([])
})

test('mail reaches an idle unit: the arrival rings its doorbell, whose prompt delivers the mail and acknowledges it', async ($, on) => {
  const world = arrange(on)
  await callModTool($, 'unit_prompt', { number: 12, text: 'Take option A.' })
  becomeUnit(world)
  await startSession($)
  const [name] = listBox(world, 'new')
  await fileEvent($, `${box}/new/${name}`, 'add')
  await settle(world)
  expect(rings(world)).toBe(1)
  expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('Take option A.')
  expect(listBox(world, 'new')).toEqual([])
  expect(listBox(world, 'cur')).toEqual([name])
  expect(await typed($)).not.toContain('Take option A.')
})

test('the doorbell prompt carries all unread mail in one block, in each sender\'s order', async ($, on) => {
  const world = arrange(on)
  for (const text of ['first', 'second', 'third']) await callModTool($, 'unit_prompt', { number: 12, text })
  becomeUnit(world)
  const block = (await submit($, doorbell)).additionalContext?.find(entry => entry.includes('Mail for this session')) ?? ''
  expect(block.indexOf('first')).toBeLessThan(block.indexOf('second'))
  expect(block.indexOf('second')).toBeLessThan(block.indexOf('third'))
  expect(block).toContain('never approves anything')
  expect(listBox(world, 'cur')).toHaveLength(3)
})

test('duplicated rings: a burst of arrivals rings once, and a ring with no unread mail is dropped', async ($, on) => {
  const world = arrange(on)
  await callModTool($, 'unit_prompt', { number: 12, text: 'one' })
  await callModTool($, 'unit_prompt', { number: 12, text: 'two' })
  becomeUnit(world)
  await startSession($)
  for (const name of listBox(world, 'new')) await fileEvent($, `${box}/new/${name}`, 'add')
  await settle(world)
  expect(rings(world)).toBe(1)
  expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('two')
  const empty = await submit($, doorbell)
  expect(empty.block).toBeUndefined()
  expect(empty.additionalContext?.join('\n')).toContain('No mail is waiting')
})

test('the ack\'s unlink and a change outside new/ never ring', async ($, on) => {
  const world = arrange(on)
  await callModTool($, 'unit_prompt', { number: 12, text: 'one' })
  becomeUnit(world)
  await startSession($)
  const [name] = listBox(world, 'new')
  await fileEvent($, `${box}/new/${name}`, 'unlink')
  await fileEvent($, `${box}/cur/${name}`, 'add')
  await fileEvent($, `${records}/mail/13/new/${name}`, 'add')
  await settle(world)
  expect(rings(world)).toBe(0)
})

test('a busy unit gets its mail at the Stop, once, and never again as new', async ($, on) => {
  const world = arrange(on)
  becomeUnit(world)
  await $.turn.start({ text: 'work', turnId: 't' })
  world.chat.id = 'sid'
  await callModTool($, 'unit_prompt', { number: 12, text: 'Busy news.' })
  world.chat.id = unitSession
  const stop = await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  expect(stop.block).toContain('Busy news.')
  expect(listBox(world, 'new')).toEqual([])
  expect((await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as never)).block ?? '').not.toContain('Busy news.')
  expect(await typed($)).not.toContain('Busy news.')
})

// contract: mail a busy unit's turn end already delivered is never rung for, so no empty doorbell prompt is ever sent, and it is delivered once
test('mail that arrives mid-turn and is delivered at the Stop rings no doorbell after the turn ends', async ($, on) => {
  const world = arrange(on)
  becomeUnit(world)
  await startSession($)
  await $.turn.start({ text: 'work', turnId: 't' })
  world.chat.id = 'sid'
  await callModTool($, 'unit_prompt', { number: 12, text: 'Busy news.' })
  world.chat.id = unitSession
  const [name] = listBox(world, 'new')
  await fileEvent($, `${box}/new/${name}`, 'add')
  expect((await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)).block).toContain('Busy news.')
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  await settle(world)
  expect(rings(world)).toBe(0)
  expect(listBox(world, 'cur')).toEqual([name])
})

// contract: no ring is made while a turn is live, so mail arriving after its Stop is rung for once the turn ends, not left to the idle tick
test('mail that arrives after the Stop rings once the turn ends', async ($, on) => {
  const world = arrange(on)
  becomeUnit(world)
  await startSession($)
  await $.turn.start({ text: 'work', turnId: 't' })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)
  world.chat.id = 'sid'
  await callModTool($, 'unit_prompt', { number: 12, text: 'Late news.' })
  world.chat.id = unitSession
  const [name] = listBox(world, 'new')
  await fileEvent($, `${box}/new/${name}`, 'add')
  await settle(world)
  expect(rings(world)).toBe(0)
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  await settle(world)
  expect(rings(world)).toBe(1)
  expect(await typed($)).toContain('Late news.')
})

// contract: a turn interrupted with no Stop still rings at its end for mail that arrived during it, and the mail is delivered once
test('mail that arrives during a turn the user interrupts rings once the turn ends, and is delivered once', async ($, on) => {
  const world = arrange(on)
  becomeUnit(world)
  await startSession($)
  await $.turn.start({ text: 'work', turnId: 't' })
  world.chat.id = 'sid'
  await callModTool($, 'unit_prompt', { number: 12, text: 'Interrupted news.' })
  world.chat.id = unitSession
  const [name] = listBox(world, 'new')
  await fileEvent($, `${box}/new/${name}`, 'add')
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 0, isAborted: true, turnId: 't' })
  await settle(world)
  expect(rings(world)).toBe(1)
  expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('Interrupted news.')
  expect(listBox(world, 'cur')).toEqual([name])
  expect(await typed($)).not.toContain('Interrupted news.')
})

// contract: a doorbell prompt the engine drops never entered, so the tick rings again, and the mail is delivered once
test('a doorbell prompt dropped by the engine after an interrupted turn is rung again by the tick, and the mail is delivered once', async ($, on) => {
  const answered: string[] = []
  // why: the first doorbell meets the interrupted session's answer; every later one enters.
  const world = arrange(on, { promptAnswer: text => text === doorbell && !answered.length ? (answered.push(text), { drop: 'a Stop stands' }) : undefined })
  becomeUnit(world)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.turn.start({ text: 'work', turnId: 't' })
  world.chat.id = 'sid'
  await callModTool($, 'unit_prompt', { number: 12, text: 'Held news.' })
  world.chat.id = unitSession
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 0, isAborted: true, turnId: 't' })
  await settle(world)
  expect(answered).toHaveLength(1)
  expect(rings(world)).toBe(0)
  expect(world.logs.map(log => log.text).join('\n')).toContain('a Stop stands')
  await world.clock.advance(61000)
  await settle(world)
  expect(rings(world)).toBe(1)
  expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('Held news.')
  expect(listBox(world, 'new')).toEqual([])
  expect(listBox(world, 'cur')).toHaveLength(1)
})

// contract: a doorbell prompt the engine never answers may still enter, so it is never rung again: the session is held, /flow status names it with how to check it, and a typed prompt delivers the mail and, handing the doorbell over to the user, ends the hold
test('a doorbell prompt held without settling holds the session as unknown until a typed prompt, which delivers the mail once', async ($, on) => {
  const answered: string[] = []
  const world = arrange(on, { promptAnswer: text => text === doorbell && !answered.length ? (answered.push(text), 'held') : undefined })
  becomeUnit(world)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.turn.start({ text: 'work', turnId: 't' })
  world.chat.id = 'sid'
  await callModTool($, 'unit_prompt', { number: 12, text: 'Held news.' })
  world.chat.id = unitSession
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 0, isAborted: true, turnId: 't' })
  await settle(world)
  await world.clock.advance(61000)
  await settle(world)
  await world.clock.advance(61000)
  await settle(world)
  expect(answered).toHaveLength(1)
  expect(rings(world)).toBe(0)
  const status = await readFlowStatus($) ?? ''
  expect(status).toContain('the mailbox doorbell prompt')
  expect(status).toContain('whether it entered is unknown')
  expect(await typed($)).toContain('Held news.')
  await settle(world)
  expect(await readFlowStatus($) ?? '').not.toContain('held:')
  expect(listBox(world, 'cur')).toHaveLength(1)
})

for (const source of ['startup', 'resume'] as const) {
  // contract: a start never rings, so the host sees the session idle first; the idle tick rings for mail waiting since before
  test(`mail unread at a ${source} session start is neither injected nor rung there: the idle tick rings, and its prompt carries and acknowledges it`, async ($, on) => {
    const world = arrange(on)
    await callModTool($, 'unit_prompt', { number: 12, text: 'Waiting since before.' })
    becomeUnit(world)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const start = await $.classic.SessionStart({ source } as never)
    expect(start.additionalContext?.join('\n') ?? '').not.toContain('Waiting since before.')
    expect(start.watchPaths).toContain(`${box}/new`)
    await settle(world)
    expect(rings(world)).toBe(0)
    expect(listBox(world, 'new')).toHaveLength(1)
    await world.clock.advance(61000)
    await settle(world)
    expect(rings(world)).toBe(1)
    expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('Waiting since before.')
    expect(listBox(world, 'cur')).toHaveLength(1)
  })
}

test('a command-line start prompt takes the mail unread at startup, and no ring follows it', async ($, on) => {
  const world = arrange(on)
  await callModTool($, 'unit_prompt', { number: 12, text: 'Before the first prompt.' })
  becomeUnit(world)
  await startSession($)
  await $.classic.SessionStart({ source: 'startup' } as never)
  expect(await typed($)).toContain('Before the first prompt.')
  await settle(world)
  expect(rings(world)).toBe(0)
  expect(listBox(world, 'cur')).toHaveLength(1)
})

test('mail unread at a compaction is injected into the turn that goes on, without a ring, and new/ is watched', async ($, on) => {
  const world = arrange(on)
  await callModTool($, 'unit_prompt', { number: 12, text: 'Waiting since before.' })
  becomeUnit(world)
  await startSession($)
  const start = await $.classic.SessionStart({ source: 'compact' } as never)
  expect(start.additionalContext?.join('\n')).toContain('Waiting since before.')
  expect(start.watchPaths).toContain(`${box}/new`)
  expect(listBox(world, 'cur')).toHaveLength(1)
  await settle(world)
  expect(rings(world)).toBe(0)
})

test('a cleared session watches its mailbox but carries no mail into its new conversation', async ($, on) => {
  const world = arrange(on)
  await callModTool($, 'unit_prompt', { number: 12, text: 'Older conversation.' })
  becomeUnit(world)
  const start = await $.classic.SessionStart({ source: 'clear' } as never)
  expect(start.additionalContext?.join('\n') ?? '').not.toContain('Older conversation.')
  expect(start.watchPaths).toContain(`${box}/new`)
  expect(listBox(world, 'new')).toHaveLength(1)
})

test('a lost ring is recovered by the periodic tick while the session is idle', async ($, on) => {
  const world = arrange(on)
  becomeUnit(world)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  world.chat.id = 'sid'
  await callModTool($, 'unit_prompt', { number: 12, text: 'No ring came.' })
  world.chat.id = unitSession
  await world.clock.advance(61000)
  await settle(world)
  expect(rings(world)).toBe(1)
  expect(await typed($)).toContain('No ring came.')
})

/**
 * Builds a coordinator world whose issue 12 has a spawned unit, keeping the options object, so a fault set on it later reaches the world.
 * @param on - The test's hook registration.
 * @returns The world and its options.
 */
function arrangeFaulty(on: Parameters<typeof createWorld>[0]): { world: World; options: Options } {
  const options: Options = { session: coordinator, herdrEnv: inside, herdrReply: () => '{}' }
  const world = createWorld(on, { branch: 'main' }, options)
  markSpawned(world, [12], unitSession)
  return { world, options }
}

for (const [name, fault] of [
  ['bucket cannot be listed', { listFails: (directory: string) => directory === `${records}/spawn` }],
  ['record cannot be read', { failRead: (path: string) => path === `${records}/spawn/12.json` }],
  ['bucket can be neither listed nor stat-ed, nor its parent listed', { listFails: (directory: string) => directory === `${records}/spawn` || directory === records,
    statFails: (path: string) => path === `${records}/spawn` }],
] as const) {
  // contract: a spawn bucket or record this session cannot read at a prompt leaves whether mail waits unknown, said in the mail note, never no mail
  test(`a unit whose spawn ${name} is told at a prompt that whether mail waits is unknown`, async ($, on) => {
    const { world, options } = arrangeFaulty(on)
    await callModTool($, 'unit_prompt', { number: 12, text: 'Unread behind the fault.' })
    becomeUnit(world)
    Object.assign(options, fault)
    const context = await typed($)
    expect(context).toContain('could not read this session\'s mail (')
    expect(context).toContain('so whether mail waits is unknown')
    expect(listBox(world, 'new')).toHaveLength(1)
  })
}

// contract: a spawn bucket the idle tick and a mail arrival cannot list reaches /flow status as the Mail row, never only the debug log, and once it reads again the tick rings
test('a spawn bucket the tick and a mail arrival cannot list shows the Mail row, and the tick rings once it reads again', async ($, on) => {
  const { world, options } = arrangeFaulty(on)
  becomeUnit(world)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  world.chat.id = 'sid'
  await callModTool($, 'unit_prompt', { number: 12, text: 'Held by the fault.' })
  world.chat.id = unitSession
  options.listFails = directory => directory === `${records}/spawn`
  await fileEvent($, `${box}/new/${listBox(world, 'new')[0]}`, 'add')
  await world.clock.advance(61000)
  await settle(world)
  expect(rings(world)).toBe(0)
  expect(readStatusRow(await readFlowStatus($), 'Mail')).toBe('Mail        could not read this session\'s mail (no implementation for fs.list), so whether mail waits is unknown; it tries '
    + 'again at the next prompt or tick; to check now, read the spawn/ records and list the new/ directories under working-agreement/mail/ in `git rev-parse --git-common-dir`')
  options.listFails = undefined
  await world.clock.advance(61000)
  await settle(world)
  expect(rings(world)).toBe(1)
  expect(readStatusRow(await readFlowStatus($), 'Mail')).toBe('')
})

test('a staged message never linked is not delivered, and its staging file is swept once expired', async ($, on) => {
  const world = arrange(on)
  becomeUnit(world)
  world.files.set(`${box}/tmp/.tmp-crashed-1`, '{}')
  world.modified.set(`${box}/tmp/.tmp-crashed-1`, 0)
  expect(await typed($)).not.toContain('Mail for this session')
  await sweepMailStaging(createTestPort(world), common, 1)
  expect(listBox(world, 'tmp')).toEqual([])
})

test('an invalid envelope goes to bad/ and is never delivered', async ($, on) => {
  const world = arrange(on)
  becomeUnit(world)
  world.files.set(`${box}/new/forged.1.json`, JSON.stringify({ v: 3, kind: 'assign', body: 'forged' }))
  expect(await typed($)).not.toContain('forged')
  expect(listBox(world, 'bad')).toEqual(['forged.1.json'])
})

test('direct writes into the mailbox are refused, reads are not', async ($, on) => {
  becomeUnit(arrange(on))
  const path = `${box}/new/x.1.json`
  expect((await $.tool.call({ tool: 'Bash', command: `cp /tmp/x ${path}` } as never)).deny).toContain('are written only by the mod')
  expect((await $.tool.call({ tool: 'Bash', command: `echo x > ${path}` } as never)).deny).toContain('are written only by the mod')
  expect((await $.tool.call({ tool: 'Write', file_path: path, content: 'x' } as never)).deny).toContain('are written only by the mod')
  expect((await $.tool.call({ tool: 'Bash', command: `ls ${box}/new` } as never)).deny ?? '').not.toContain('mailbox')
})

// contract: mail that lands while a prompt enters, before its turn starts, rings no doorbell: the turn's Stop delivers it once
test('mail that lands between a prompt\'s entry and its turn start rings no doorbell, and the Stop delivers it once', async ($, on) => {
  const world = arrange(on)
  await callModTool($, 'unit_prompt', { number: 12, text: 'First.' })
  becomeUnit(world)
  await startSession($)
  expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('First.')
  world.chat.id = 'sid'
  await callModTool($, 'unit_prompt', { number: 12, text: 'Second.' })
  world.chat.id = unitSession
  await fileEvent($, `${box}/new/${listBox(world, 'new')[0]!}`, 'add')
  await settle(world)
  expect(rings(world)).toBe(0)
  await $.turn.start({ text: 'work', turnId: 't' })
  expect((await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)).block).toContain('Second.')
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  await settle(world)
  expect(rings(world)).toBe(0)
  expect(listBox(world, 'new')).toEqual([])
  expect(listBox(world, 'cur')).toHaveLength(2)
})

// contract: a prompt whose turn never starts holds the doorbell past every tick, never for a set time, and a prompt the user types then delivers the mail
test('a prompt whose turn never starts holds the doorbell until a typed prompt starts a turn', async ($, on) => {
  const world = arrange(on)
  becomeUnit(world)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await submit($, 'typed prompt entering')
  world.chat.id = 'sid'
  await callModTool($, 'unit_prompt', { number: 12, text: 'Held by the gate.' })
  world.chat.id = unitSession
  await fileEvent($, `${box}/new/${listBox(world, 'new')[0]!}`, 'add')
  await settle(world)
  for (const minutes of [1, 2, 3]) await world.clock.advance(minutes * 61000)
  await settle(world)
  const held = rings(world)
  expect({ held, delivered: (await typed($)).includes('Held by the gate.') }).toEqual({ held: 0, delivered: true })
})

for (const source of ['startup', 'resume'] as const) {
  // contract: a spawned or resumed unit's start mail that lands while its session start is still slow on the host submits no prompt before the mod's tools are registered and the process state is adopted, and the idle tick rings it once
  test(`a start mail delivered during a slow ${source} session start rings no doorbell before the mod's tools are registered`, async ($, on) => {
    const toolsAtSubmit: number[] = []
    const slow = { isArmed: false, gate: createGate() }
    const world = arrange(on, {
      beforePromptSubmit: () => { toolsAtSubmit.push(world.registeredTools.length) },
      // why: the host refresh reads the pid namespace during session start; holding that read is a start slowed by a loaded host.
      beforeRun: argv => slow.isArmed && argv.join(' ') === 'readlink /proc/self/ns/pid' ? slow.gate.promise : undefined,
    })
    await callModTool($, 'unit_prompt', { number: 12, text: 'Start on #12.', kind: 'assign' })
    becomeUnit(world)
    // why: the test engine already started the coordinator's session; only the registrations of the unit's own start count.
    world.registeredTools.length = 0
    slow.isArmed = true
    const starting = $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    await $.classic.SessionStart({ source } as never)
    await settle(world)
    await fileEvent($, `${box}/new/${listBox(world, 'new')[0]!}`, 'add')
    await settle(world)
    slow.gate.open()
    await starting
    await settle(world)
    // why: mail that lands while the start adopts the process state waits for the idle tick, as a start never rings.
    await world.clock.advance(61000)
    await settle(world)
    expect(toolsAtSubmit.filter(count => count === 0)).toEqual([])
    expect(rings(world)).toBe(1)
    expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('Start on #12.')
  })
}

// contract: a ring held for the mod's tools stays held however long their registration takes, past any tick, and rings once after it
test('a doorbell held for a registration slower than a tick rings once, after the tools are registered', async ($, on) => {
  const toolsAtSubmit: number[] = []
  const slow = { isArmed: false, gate: createGate() }
  const world = arrange(on, {
    beforePromptSubmit: () => { toolsAtSubmit.push(world.registeredTools.length) },
    beforeToolRegister: () => slow.isArmed ? slow.gate.promise : undefined,
  })
  await callModTool($, 'unit_prompt', { number: 12, text: 'Held past the tick.', kind: 'assign' })
  becomeUnit(world)
  world.registeredTools.length = 0
  slow.isArmed = true
  const starting = $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await fileEvent($, `${box}/new/${listBox(world, 'new')[0]!}`, 'add')
  await world.clock.advance(3 * 61000)
  await settle(world)
  expect(rings(world)).toBe(0)
  slow.gate.open()
  await starting
  await world.clock.advance(61000)
  await settle(world)
  expect(rings(world)).toBe(1)
  expect(toolsAtSubmit.filter(count => count === 0)).toEqual([])
  expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('Held past the tick.')
})

// contract: a session start whose tool registration fails submits no mod prompt for its mail, even at the idle tick, and names the cause on its pane, in /flow status and in the activity its coordinator reads
test('a failed tool registration starts no doorbell turn and names the cause where the user and the coordinator look', async ($, on) => {
  const failure = { isArmed: false }
  const world = arrange(on, { beforeToolRegister: () => { if (failure.isArmed) throw new Error('registry closed') } })
  await callModTool($, 'unit_prompt', { number: 12, text: 'Never rung.', kind: 'assign' })
  becomeUnit(world)
  failure.isArmed = true
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await fileEvent($, `${box}/new/${listBox(world, 'new')[0]!}`, 'add')
  await world.clock.advance(3 * 61000)
  await settle(world)
  expect(rings(world)).toBe(0)
  expect(listBox(world, 'new')).toHaveLength(1)
  const note = world.views.at(-1)?.notes.find(row => row.key === 'Tools')
  expect(note?.value).toMatch(/^the mod's tools did not register: .+; no mod prompt will start a turn$/)
  expect(note?.tone).toBe('error')
  expect(world.toasts).toContain(note?.value)
  expect(world.opened.length).toBeGreaterThan(0)
  expect(await readFlowStatus($)).toContain(note?.value ?? 'no Tools note')
  expect(JSON.parse(world.files.get(`${records}/activity/${unitSession}.json`) ?? '{}')).toMatchObject({ toolsError: expect.any(String) })
})

// contract: a later session start, as a plugin reload or a restart raises, registers the tools again and releases the mod's held prompts, so a session never holds them forever
test('a start after a failed registration registers the tools, clears the failure and rings the held mail', async ($, on) => {
  const failure = { isArmed: false }
  const world = arrange(on, { beforeToolRegister: () => { if (failure.isArmed) throw new Error('registry closed') } })
  await callModTool($, 'unit_prompt', { number: 12, text: 'Rung after the reload.', kind: 'assign' })
  becomeUnit(world)
  failure.isArmed = true
  await startSession($)
  await fileEvent($, `${box}/new/${listBox(world, 'new')[0]!}`, 'add')
  await world.clock.advance(61000)
  await settle(world)
  expect(rings(world)).toBe(0)
  failure.isArmed = false
  await startSession($)
  await world.clock.advance(61000)
  await settle(world)
  // why: both starts run in this test's one module, so two ticks ring; a reload loads a fresh module and cancels the old one's timers.
  expect(rings(world)).toBeGreaterThan(0)
  expect(await readFlowStatus($)).not.toContain('did not register')
  expect(JSON.parse(world.files.get(`${records}/activity/${unitSession}.json`) ?? '{}')).not.toHaveProperty('toolsError')
  expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('Rung after the reload.')
})

// contract: a registration that does not answer within its bound holds back neither the start nor the tick: the session shows its tools as not registered, rings nothing, and applies the registration once it answers
test('a registration that hangs past its bound is shown as not registered, rings nothing, and is applied once it answers', async ($, on) => {
  const hang = { isArmed: false, gate: createGate() }
  const world = arrange(on, { beforeToolRegister: () => hang.isArmed ? hang.gate.promise : undefined })
  await callModTool($, 'unit_prompt', { number: 12, text: 'Rung once registered.', kind: 'assign' })
  becomeUnit(world)
  hang.isArmed = true
  const starting = startSession($)
  await fileEvent($, `${box}/new/${listBox(world, 'new')[0]!}`, 'add')
  await world.clock.advance(30000)
  await starting
  await world.clock.advance(61000)
  await settle(world)
  expect(rings(world)).toBe(0)
  expect(world.views.at(-1)?.notes.find(row => row.key === 'Tools')?.value).toContain('no answer within 30 s')
  expect(JSON.parse(world.files.get(`${records}/activity/${unitSession}.json`) ?? '{}')).toMatchObject({ toolsError: expect.stringContaining('30 s') })
  hang.gate.open()
  await settle(world)
  await world.clock.advance(61000)
  await settle(world)
  expect(rings(world)).toBe(1)
  expect(await readFlowStatus($)).not.toContain('did not register')
  expect(JSON.parse(world.files.get(`${records}/activity/${unitSession}.json`) ?? '{}')).not.toHaveProperty('toolsError')
})

// contract: a failure an earlier process recorded is cleared from the unit's activity before its session start refreshes the host record, so its coordinator never reads a live process with that stale failure
test('a start clears a registration failure an earlier process recorded before it refreshes the host record', async ($, on) => {
  const slow = { isArmed: false, gate: createGate() }
  const world = arrange(on, { beforeRun: argv => slow.isArmed && argv.join(' ') === 'readlink /proc/self/ns/pid' ? slow.gate.promise : undefined })
  becomeUnit(world)
  world.files.set(`${records}/activity/${unitSession}.json`, JSON.stringify({ v: 1, isTurn: false, at: world.clock.now(), isDialog: false, toolsError: 'registry closed' }))
  slow.isArmed = true
  const starting = startSession($)
  await settle(world)
  expect(JSON.parse(world.files.get(`${records}/activity/${unitSession}.json`) ?? '{}')).not.toHaveProperty('toolsError')
  slow.gate.open()
  await starting
})
