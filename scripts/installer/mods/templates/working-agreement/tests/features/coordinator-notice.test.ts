import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { composeTurnNotice } from '../../hooks/domain/notice'
import type { UnitTurn } from '../../hooks/domain/notice'
import { coordinator } from '../support/builders'
import { callModTool, endTurn, inside, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { childCheckout, delegationCheckout, parChild, seedDelegatedChild } from '../support/parallel-worktrees'
import { coordinatorHost, createWorld, markSpawned, records, scopeFile } from '../support/world'
import type { Options, World } from '../support/world'

/** A delegated unit's world and the options it runs on. */
interface ChildWorld { world: World; options: Options }

const coordinatorPane = 'w22:p8'
const doorbell = '[working-agreement] Mail arrived in this session\'s mailbox; it is delivered with this prompt.'
const turn: UnitTurn = { issues: [7], step: { id: 'code', label: 'Code', isHuman: false }, reason: 'answer' }
// why: a Fix keeps Triage, the user's step, current until GitHub labels its issue.
const atTriage: Options = { session: { flow: 'fix', info: { 1: { title: 'bug', labels: [] } } }, issueLabels: { 1: [] }, unit: { base: 'p1', baseBranch: 'par' } }
const triageNotice = '#1 is at the user\'s step Triage: run it in that unit\'s own terminal.'

/**
 * Builds child `a` as a unit inside herdr, delegated by coordinator `coord` from its pane unless told otherwise.
 * @param on - The test's engine hooks.
 * @param scope - The scope file, or null for none.
 * @param changes - Further world options.
 * @returns The world, and its options, which a test may change while the world runs.
 */
function createChild(on: Parameters<typeof createWorld>[0], scope: object | null = { v: 1, sessionId: 'coord', issues: [1], coversCreated: false, paneId: coordinatorPane, host: coordinatorHost },
  changes: Options = {}): ChildWorld {
  const options: Options = { ...parChild(), herdrEnv: inside, ...changes }
  const world = createWorld(on, childCheckout(), options)
  // The engine answers no classic hook itself; the session that hears the notification is the end of its chain.
  on('classic.Notification', () => ({}))
  if (scope) world.files.set(scopeFile('coord'), JSON.stringify(scope))
  markSpawned(world, [1])
  return { world, options }
}

/**
 * Reads the messages delivered to the coordinator's mailbox.
 * @param world - The world.
 * @returns The messages.
 */
const coordinatorMail = (world: World): Record<string, unknown>[] =>
  [...world.files.entries()].filter(([path]) => path.startsWith(`${records}/mail/coordinator-coord/new/`)).map(([, text]) => JSON.parse(text) as Record<string, unknown>)

/**
 * Reads the messages delivered to the user's mailbox.
 * @param world - The world.
 * @returns The messages.
 */
const userMail = (world: World): Record<string, unknown>[] =>
  [...world.files.entries()].filter(([path]) => path.startsWith(`${records}/mail/user/new/`)).map(([, text]) => JSON.parse(text) as Record<string, unknown>)

/**
 * Delivers a message from the coordinator into the unit's mailbox, as its send leaves it.
 * @param world - The world.
 * @param id - The message's id.
 * @param kind - Its kind.
 * @param body - Its text.
 */
function deliver(world: World, id: string, kind: string, body: string): void {
  world.files.set(`${records}/mail/1/new/${id}.1.json`, JSON.stringify({ v: 1, id, kind, from: 'coordinator-coord', to: '1', issue: 1, in_reply_to: '', seq: 1,
    created_at: '2026-11-03T00:00:00.000Z', expects: '', attempt: 1, body, refs: [], author: 'agent' }))
}

/**
 * Raises the main agent's stop.
 * @param $ - The engine.
 * @param isActive - Whether the stop continues from an earlier block.
 * @returns What the hooks answered.
 */
const stop = ($: Engine, isActive = false): Promise<{ block?: string }> =>
  $.classic.Stop({ stop_hook_active: isActive, background_tasks: [] } as never) as Promise<{ block?: string }>

/**
 * Lists the prompts the mod sent to the coordinator's pane.
 * @param world - The world.
 * @returns Each prompt's text.
 */
const notices = (world: World): string[] =>
  world.herdrCalls.filter(call => call.argv[1] === 'agent' && call.argv[2] === 'prompt' && call.argv[3] === coordinatorPane).map(call => call.argv[4] ?? '')

test('a delegated unit at Integrate is not announced on its coordinator\'s pane: its Stop hook asks for its done', async ($, on) => {
  const { world } = createChild(on)
  await $.turn.start({ text: 'work', turnId: 't' })
  expect((await stop($)).block).toContain('turn ends at Integrate with no message to its coordinator')
  await endTurn($)
  expect(notices(world)).toEqual([])
})

// contract: a delegated unit at one of the user's steps tells the user's mailbox once per step with a mod-written inform, never the coordinator's pane, and a unit no scope delegates sends nothing
test('a unit at the user\'s step tells the user\'s mailbox once, never through herdr, and a unit no scope delegates sends nothing', async ($, on) => {
  const { world } = createChild(on, null, atTriage)
  await endTurn($)
  expect(userMail(world)).toEqual([])
  world.files.set(scopeFile('coord'), JSON.stringify({ v: 1, sessionId: 'coord', issues: [1], coversCreated: false, host: coordinatorHost }))
  await endTurn($)
  await endTurn($)
  expect(userMail(world)).toMatchObject([{ kind: 'inform', author: 'mod', from: '1', to: 'user', issue: 1, in_reply_to: '', body: triageNotice }])
  expect(notices(world)).toEqual([])
  expect(coordinatorMail(world)).toEqual([])
})

test('a session spawn did not start, though it declares a delegated issue, sends its coordinator nothing', async ($, on) => {
  const { world } = createChild(on)
  markSpawned(world, [1], 'unit')
  await endTurn($)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  expect(notices(world)).toEqual([])
})

test('a failed send is logged and sent again at the next turn end', async ($, on) => {
  const { world, options } = createChild(on, undefined, { ...atTriage, failing: `mkdir -p -- ${records}/mail/user` })
  await endTurn($)
  expect(userMail(world)).toHaveLength(0)
  delete options.failing
  await endTurn($)
  await endTurn($)
  expect(userMail(world)).toHaveLength(1)
  await world.clock.settle()
  const log = [...world.files].filter(([path]) => path.startsWith(`${records}/log/`)).map(([, text]) => text).join('')
  expect(log).toContain('"event":"notice"')
  expect(log).toContain('"error":')
})

test('a permission dialog in a delegated unit sends its coordinator a mod-written inform, never typed into its pane', async ($, on) => {
  const { world } = createChild(on)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  expect(notices(world)).toEqual([])
  expect(coordinatorMail(world)).toMatchObject([{ kind: 'inform', author: 'mod', from: '1', to: 'coordinator-coord', issue: 1, in_reply_to: '',
    body: '#1 is blocked on a permission dialog: read its pane.' }])
})

test('a turn ending on an API error sends its coordinator one mod-written inform, without herdr', async ($, on) => {
  const { world } = createChild(on, undefined, { herdrEnv: {} })
  await $.turn.complete({ reason: 'error', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  await $.turn.complete({ reason: 'error', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  expect(coordinatorMail(world)).toMatchObject([{ kind: 'inform', author: 'mod', body: '#1 is blocked: its turn ended on an API error; read its pane.' }])
})

test('/flow report lists the notices a unit sent', async ($, on) => {
  const world = createWorld(on, delegationCheckout(), { session: coordinator })
  await seedDelegatedChild(world)
  world.files.set(`${records}/notices/a.json`, JSON.stringify({ v: 1, key: 'k', text: 't', isSent: true, sent: ['#2 reached Commit: Verify passed on abcdef0; it commits next.'] }))
  const text = (await runFlowCommand($, 'report')).text ?? ''
  expect(text).toContain('Notice      #2 reached Commit: Verify passed on abcdef0; it commits next.')
  expect(text).toMatch(/#1 · par\n[^#]*Notice\s+none/)
})

test('the same turn composes byte-identical notices, only for what the agent does not report', () => {
  expect(composeTurnNotice(turn)).toEqual(composeTurnNotice({ ...turn }))
  expect(composeTurnNotice({ ...turn, step: { id: 'integrate', label: 'Integrate', isHuman: false } })).toBeNull()
  expect(composeTurnNotice({ ...turn, step: { id: 'spec', label: 'Spec', isHuman: true } }))
    .toEqual({ key: 'user:spec', text: '#7 is at the user\'s step Spec: run it in that unit\'s own terminal.', to: 'user' })
  expect(composeTurnNotice({ ...turn, reason: 'error' }))
    .toEqual({ key: 'blocked:error', text: '#7 is blocked: its turn ended on an API error; read its pane.', to: 'coordinator' })
  expect(composeTurnNotice(turn)).toBeNull()
  expect(composeTurnNotice({ ...turn, step: { id: 'commit', label: 'Commit', isHuman: false } })).toBeNull()
  expect(composeTurnNotice({ ...turn, reason: 'aborted' })).toBeNull()
})

test('a unit ending its turns away from the user\'s steps is never announced: its agent reports with send', async ($, on) => {
  const { world } = createChild(on, undefined, { unit: { base: 'p1', baseBranch: 'par' } })
  await endTurn($, 'Which store?')
  await endTurn($, 'Which branch?')
  expect(notices(world)).toEqual([])
  expect(coordinatorMail(world)).toEqual([])
})

test('a delegated unit whose turn ends with no message is asked once per state to send one', async ($, on) => {
  createChild(on, undefined, { unit: { base: 'p1', baseBranch: 'par' } })
  await $.turn.start({ text: 'work', turnId: 't' })
  expect((await stop($)).block).toContain('with no message to its coordinator')
  expect((await stop($, true)).block).toBeUndefined()
  await $.turn.start({ text: 'more work', turnId: 't2' })
  expect((await stop($)).block).toBeUndefined()
})

test('a turn that sent a message ends, and a unit waiting on its own question is not asked again', async ($, on) => {
  const { world } = createChild(on, undefined, { unit: { base: 'p1', baseBranch: 'par' } })
  await $.turn.start({ text: 'work', turnId: 't' })
  expect((await callModTool($, 'send', { kind: 'question', body: 'Store A or B?' })).isError).toBe(false)
  expect((await stop($)).block).toBeUndefined()
  await $.turn.start({ text: 'the user asks something else', turnId: 't2' })
  expect((await stop($)).block).toBeUndefined()
  expect(coordinatorMail(world)).toMatchObject([{ kind: 'question', author: 'agent', from: '1' }])
})

// contract: a question the retired session sent is neither awaited nor owed by the unit spawned after the retirement
test('a question sent before the unit\'s retirement no longer counts as awaited, so the new unit is asked for a message', async ($, on) => {
  const { world } = createChild(on, undefined, { unit: { base: 'p1', baseBranch: 'par' } })
  world.files.set(`${records}/mail/coordinator-coord/cur/q.1.json`, JSON.stringify({ v: 1, id: 'q', kind: 'question', from: '1', to: 'coordinator-coord', issue: 1,
    in_reply_to: '', seq: 1, created_at: '2026-11-03T00:00:00.000Z', expects: '', attempt: 1, body: 'A or B?', refs: [], author: 'agent' }))
  await $.turn.start({ text: 'work', turnId: 't' })
  expect((await stop($)).block).toBeUndefined()
  world.files.set(`${records}/retired/1-20261103T010000Z.json`, JSON.stringify({ v: 1, issue: 1, branch: 'a', ref: 'refs/retired/1/20261103T010000Z', patch: null, restore: 'r' }))
  await $.turn.start({ text: 'work', turnId: 't2' })
  expect((await stop($)).block).toContain('with no message to its coordinator')
})

// contract: an inform waiting at a resume is rung by the first idle tick, never at SessionStart, and that inform-only turn is not held
test('an inform waiting when the unit resumes is rung by the idle tick, not at its start, and its turn ends without being asked for a message', async ($, on) => {
  const { world } = createChild(on, undefined, { unit: { base: 'p1', baseBranch: 'par' } })
  deliver(world, 'fyi', 'inform', 'FYI: the parent moved.')
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  await $.classic.SessionStart({ source: 'resume' } as never)
  await world.clock.settle()
  expect(world.prompts.filter(prompt => prompt === doorbell)).toHaveLength(0)
  await world.clock.advance(61000)
  await world.clock.settle()
  expect(world.prompts.filter(prompt => prompt === doorbell)).toHaveLength(1)
  const prompt = await $.classic.UserPromptSubmit({ prompt: doorbell, permission_mode: 'default' } as never) as { additionalContext?: string[] }
  expect(prompt.additionalContext?.join('\n')).toContain('FYI: the parent moved.')
  await $.turn.start({ text: doorbell, turnId: 't' })
  expect((await stop($)).block).toBeUndefined()
})

test('a unit at one of the user\'s steps is not asked for a message', async ($, on) => {
  createChild(on, undefined, atTriage)
  await $.turn.start({ text: 'work', turnId: 't' })
  expect((await stop($)).block).toBeUndefined()
})

test('a doorbell turn that delivered only informs ends without being asked for a message', async ($, on) => {
  const { world } = createChild(on, undefined, { unit: { base: 'p1', baseBranch: 'par' } })
  deliver(world, 'fyi', 'inform', 'FYI: the parent moved.')
  const prompt = await $.classic.UserPromptSubmit({ prompt: doorbell, permission_mode: 'default' } as never) as { additionalContext?: string[] }
  expect(prompt.additionalContext?.join('\n')).toContain('FYI: the parent moved.')
  await $.turn.start({ text: doorbell, turnId: 't' })
  expect((await stop($)).block).toBeUndefined()
})

test('a unit back in a state it was already asked about is not asked again', async ($, on) => {
  const { world } = createChild(on, undefined, { unit: { base: 'p1', baseBranch: 'par' } })
  await $.turn.start({ text: 'work', turnId: 't' })
  expect((await stop($)).block).toContain('with no message to its coordinator')
  deliver(world, 'job', 'assign', 'Build it.')
  await $.classic.UserPromptSubmit({ prompt: doorbell, permission_mode: 'default' } as never)
  await $.turn.start({ text: doorbell, turnId: 't2' })
  expect((await stop($)).block).toContain('Open and owed a reply: assign job.')
  expect((await callModTool($, 'send', { kind: 'done', in_reply_to: 'job', body: 'Built.' })).isError).toBe(false)
  await $.turn.start({ text: 'later', turnId: 't3' })
  expect((await stop($)).block).toBeUndefined()
})
