import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { sweepMailStaging } from '../../hooks/core/mailbox'
import { createEmptySession } from '../../hooks/domain/records'
import { coordinator } from '../support/builders'
import { callModTool, inside } from '../support/helpers'
import { test } from '../support/kit'
import { common, createTestPort, createWorld, markSpawned, records } from '../support/world'
import type { Options, World } from '../support/world'

const unitSession = 'unit-12'
const box = `${records}/mail/12`
const doorbell = '[working-agreement] Mail arrived in this session\'s mailbox; it is delivered with this prompt.'

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
  for (const name of listBox(world, 'new')) await fileEvent($, `${box}/new/${name}`, 'add')
  await settle(world)
  expect(rings(world)).toBe(1)
  expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('two')
  expect((await submit($, doorbell)).block).toContain('No unread mail')
})

test('the ack\'s unlink and a change outside new/ never ring', async ($, on) => {
  const world = arrange(on)
  await callModTool($, 'unit_prompt', { number: 12, text: 'one' })
  becomeUnit(world)
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

for (const [label, answer] of [['held without settling', 'held'], ['dropped by the engine', { drop: 'a Stop stands' }]] as const) {
  // contract: a doorbell prompt the engine holds or drops never blocks the next ring: the tick rings again, and the mail is delivered once
  test(`a doorbell prompt ${label} after an interrupted turn is rung again by the tick, and the mail is delivered once`, async ($, on) => {
    const answered: string[] = []
    // why: the first doorbell meets the interrupted session's answer; every later one enters.
    const world = arrange(on, { promptAnswer: text => text === doorbell && !answered.length ? (answered.push(text), answer) : undefined })
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
    if (answer !== 'held') expect(world.logs.map(log => log.text).join('\n')).toContain('a Stop stands')
    await world.clock.advance(61000)
    await settle(world)
    expect(rings(world)).toBe(1)
    expect((await submit($, doorbell)).additionalContext?.join('\n')).toContain('Held news.')
    expect(listBox(world, 'new')).toEqual([])
    expect(listBox(world, 'cur')).toHaveLength(1)
  })
}

// contract: a doorbell prompt that reaches the session with no unread mail left enters nothing and shows nothing
test('an empty doorbell prompt is dropped before it enters, with nothing shown and no turn started', async ($, on) => {
  const world = arrange(on)
  becomeUnit(world)
  await $.prompt.submit({ text: doorbell, wait: false, origin: { kind: 'plugin', name: 'working-agreement', asUser: true } })
  expect(rings(world)).toBe(0)
  expect(world.toasts).toEqual([])
  expect(world.notifications).toEqual([])
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
