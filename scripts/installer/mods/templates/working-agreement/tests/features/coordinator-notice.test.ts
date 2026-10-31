import { expect } from 'claude-code/testing'

import { composeTurnNotice } from '../../hooks/domain/notice'
import type { UnitTurn } from '../../hooks/domain/notice'
import { coordinator } from '../support/builders'
import { endTurn, inside, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { childCheckout, delegationCheckout, parChild, seedDelegatedChild } from '../support/parallel-worktrees'
import { coordinatorHost, createWorld, markSpawned, records, scopeFile } from '../support/world'
import type { Options, World } from '../support/world'

/** A delegated unit's world and the options it runs on. */
interface ChildWorld { world: World; options: Options }

const coordinatorPane = 'w22:p8'
const turn: UnitTurn = { issues: [7], step: { id: 'code', label: 'Code', isHuman: false }, tree: 'abcdef0123', verifyFact: null, reason: 'answer', answer: 'Which store?', last: null }

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
 * Lists the prompts the mod sent to the coordinator's pane.
 * @param world - The world.
 * @returns Each prompt's text.
 */
const notices = (world: World): string[] =>
  world.herdrCalls.filter(call => call.argv[1] === 'agent' && call.argv[2] === 'prompt' && call.argv[3] === coordinatorPane).map(call => call.argv[4] ?? '')

test('a delegated unit reaching Integrate sends its coordinator one fixed notice, and none while the state is unchanged', async ($, on) => {
  const { world } = createChild(on)
  await endTurn($)
  await endTurn($)
  expect(notices(world)).toEqual(['#1 reached Integrate without a Verify pass (no verify command configured); ready for merge_child.'])
})

test('a unit no scope delegates, or whose scope names no pane, sends nothing', async ($, on) => {
  const { world } = createChild(on, null)
  await endTurn($)
  world.files.set(scopeFile('coord'), JSON.stringify({ v: 1, sessionId: 'coord', issues: [1], coversCreated: false }))
  await endTurn($)
  expect(notices(world)).toEqual([])
})

test('a session spawn did not start, though it declares a delegated issue, sends its coordinator nothing', async ($, on) => {
  const { world } = createChild(on)
  markSpawned(world, [1], 'unit')
  await endTurn($)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  expect(notices(world)).toEqual([])
})

test('a failed send is logged and sent again at the next turn end', async ($, on) => {
  const { world, options } = createChild(on, undefined, { herdrResult: { exitCode: 1, stderr: 'no server' } })
  await endTurn($)
  expect(notices(world)).toHaveLength(1)
  delete options.herdrResult
  await endTurn($)
  await endTurn($)
  expect(notices(world)).toHaveLength(2)
  await world.clock.settle()
  const log = [...world.files].filter(([path]) => path.startsWith(`${records}/log/`)).map(([, text]) => text).join('')
  expect(log).toContain('"event":"notice"')
  expect(log).toContain('no server')
})

test('a permission dialog in a delegated unit sends a blocked notice', async ($, on) => {
  const { world } = createChild(on)
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  expect(notices(world)).toEqual(['#1 is blocked on a permission dialog: read its pane.'])
})

test('/flow report lists the notices a unit sent', async ($, on) => {
  const world = createWorld(on, delegationCheckout(), { session: coordinator })
  await seedDelegatedChild(world)
  world.files.set(`${records}/notices/a.json`, JSON.stringify({ v: 1, key: 'k', text: 't', isSent: true, sent: ['#2 reached Commit: Verify passed on abcdef0; it commits next.'] }))
  const text = (await runFlowCommand($, 'report')).text ?? ''
  expect(text).toContain('Notice     #2 reached Commit: Verify passed on abcdef0; it commits next.')
  expect(text).toMatch(/#1 · par\n[^#]*Notice\s+none/)
})

test('the same turn composes byte-identical notices, each kind fixed', () => {
  expect(composeTurnNotice(turn)).toEqual(composeTurnNotice({ ...turn }))
  expect(composeTurnNotice({ ...turn, step: { id: 'integrate', label: 'Integrate', isHuman: false } })?.text)
    .toBe('#7 reached Integrate: Verify passed on abcdef0; ready for merge_child.')
  expect(composeTurnNotice({ ...turn, step: { id: 'commit', label: 'Commit', isHuman: false } })?.text)
    .toBe('#7 ended its turn at Commit without committing: Verify passed on abcdef0; read its pane and have it commit with the commit tool.')
  expect(composeTurnNotice(turn)?.text).toBe('#7 ended its turn at Code on a decision or a question: read its pane and answer through the delegated-decision path.')
  expect(composeTurnNotice({ ...turn, step: { id: 'spec', label: 'Spec', isHuman: true } })?.text).toBe('#7 ended its turn on the user\'s step Spec: read its pane and run it there.')
  expect(composeTurnNotice({ ...turn, reason: 'error' })?.text).toBe('#7 is blocked: its turn ended on an API error; read its pane.')
  expect(composeTurnNotice({ ...turn, reason: 'aborted' })).toBeNull()
})

test('a unit waiting again at the same step on a new question is a new state', async ($, on) => {
  const { world } = createChild(on, undefined, { unit: { base: 'p1', baseBranch: 'par' } })
  await endTurn($, 'Which store?')
  await endTurn($, 'Which store?')
  await endTurn($, 'Which branch?')
  expect(notices(world)).toHaveLength(2)
})

test('a unit at Integrate that ends a later turn on a new question wakes its coordinator again', async ($, on) => {
  const { world } = createChild(on)
  await endTurn($, 'Ready for merge_child.')
  await endTurn($, 'Which files conflict?')
  await endTurn($, 'Which files conflict?')
  expect(notices(world)).toEqual(['#1 reached Integrate without a Verify pass (no verify command configured); ready for merge_child.',
    '#1 ended its turn at Integrate on a decision or a question: read its pane and answer through the delegated-decision path.'])
})
