import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { recordToolsOutcome, reportStalledUnits } from '../../hooks/core/liveness'
import { clearFault, raiseFault } from '../../hooks/core/fault-registry'
import { sessionMemory } from '../../hooks/core/session-memory'
import { tickMs } from '../../hooks/core/timing'
import { createEmptySession } from '../../hooks/domain/records'
import { coordinator } from '../support/builders'
import { dialogScreens, dockScreen, noDialog, unknownDialog } from '../support/dialog-screens'
import { callModTool, holdSpawnLock, inside, readFlowStatus, releaseSpawnLock } from '../support/helpers'
import { test } from '../support/kit'
import { buildScope, buildStat, coordinatorHost, createTestPort, createWorld, markSpawned, records, root, scopeFile } from '../support/world'
import type { Options, World } from '../support/world'

/**
 * What the fake herdr host shows of the unit: whether its workspace is open, whether a close ends once the next listing is answered,
 * whether herdr reads its agent as blocked, and its visible screen.
 */
interface FakeHost { isOpen: boolean; isClosing: boolean; isBlocked: boolean; screen: string }

/** A coordinator world delegating issue 12 to a running unit, and the unit's host as herdr shows it. */
interface LivenessWorld { world: World; host: FakeHost }

const unitSession = 'unit-12'
const unitProcess = { pid: 300, pidStart: '8000' }
const minuteMs = 60000
// why: the world has no Verify config, so the 30-minute default gives max(2 × 30, 10) + 5 minutes.
const turnLimitMs = 65 * minuteMs
/** The stall record of issue 12. */
const stallFile = `${records}/stalls/12.json`

/**
 * Builds a coordinator world, session sid, that delegates issue 12 to the unit session spawn started for it, running in a herdr workspace.
 * @param on - The test's hook registration.
 * @param options - Options added to the world's, such as a fault.
 * @returns The world, still in the coordinator's session, and the unit's fake host.
 */
function arrange(on: Parameters<typeof createWorld>[0], options: Options = {}): LivenessWorld {
  const host: FakeHost = { isOpen: true, isClosing: false, isBlocked: false, screen: '' }
  const herdrReply = (args: string[]): string | { exitCode: number; stderr: string } => {
    const [noun, verb] = args
    if (noun === 'workspace' && verb === 'list') {
      const listed = JSON.stringify({ result: { workspaces: host.isOpen ? [{ workspace_id: 'w1', label: 'wa-spawn:12', worktree: { checkout_path: '/wt/12' } }] : [] } })
      if (host.isClosing) host.isOpen = false
      return listed
    }
    if (noun === 'pane' && verb === 'list') return JSON.stringify({ result: { panes: [{ pane_id: 'w1:p1', agent: 'claude' }] } })
    if (noun === 'agent' && verb === 'wait') return args.includes('blocked') && host.isBlocked ? '{}' : { exitCode: 1, stderr: 'timeout' }
    if (noun === 'agent' && verb === 'read') return host.screen
    return '{}'
  }
  const world = createWorld(on, { branch: 'main' }, { session: coordinator, herdrEnv: inside, herdrReply, ...options })
  world.files.set(scopeFile('sid'), buildScope('sid', [12]))
  markSpawned(world, [12], unitSession)
  world.seedChat(unitSession, createEmptySession(unitSession))
  world.files.set(`${records}/host/${unitSession}.json`, JSON.stringify({ ...coordinatorHost, ...unitProcess }))
  world.files.set(`/proc/${unitProcess.pid}/stat`, buildStat(unitProcess.pid, unitProcess.pidStart))
  return { world, host }
}

/**
 * Records the unit's activity as its own mod leaves it.
 * @param world - The world.
 * @param activity - Whether a turn runs, how long ago its last event came, and whether a permission dialog holds it.
 */
function seedActivity(world: World, activity: { isTurn: boolean; ageMs: number; isDialog?: boolean }): void {
  world.files.set(`${records}/activity/${unitSession}.json`, JSON.stringify({ v: 1, isTurn: activity.isTurn, at: world.clock.now() - activity.ageMs, isDialog: !!activity.isDialog }))
}

/**
 * Leaves a message from the coordinator unread in the unit's mailbox.
 * @param world - The world.
 * @param ageMs - How long ago it was sent.
 * @param id - The message's id.
 */
function seedUnreadMail(world: World, ageMs: number, id = 'm1'): void {
  world.files.set(`${records}/mail/12/new/${id}.1.json`, JSON.stringify({ v: 2, id, kind: 'assign', from: 'coordinator-sid', to: '12', issue: 12, in_reply_to: '', seq: 1,
    created_at: new Date(world.clock.now() - ageMs).toISOString(), expects: '', attempt: 1, body: 'work on it', refs: [], author: 'agent', options: [] }))
}

/**
 * Runs ticks of the coordinator after a restart: this test's own instance of the mod's modules stands for the new process, its memory
 * emptied as a new process starts, so it knows of earlier reports only through the records. The engine's clock is not moved, so the
 * coordinator before the restart sends nothing more.
 * @param world - The world.
 * @param ticks - How many ticks run.
 * @returns Once they ran.
 */
async function tickAfterRestart(world: World, ticks: number): Promise<void> {
  sessionMemory.stallReports.clear()
  sessionMemory.blockedUnits.clear()
  await tickRestarted(world, ticks)
}

/**
 * Runs ticks of the restarted coordinator without emptying its memory again.
 * @param world - The world.
 * @param ticks - How many ticks run.
 * @returns Once they ran.
 */
async function tickRestarted(world: World, ticks: number): Promise<void> {
  if (ticks === 0) return
  await reportStalledUnits(createTestPort(world))
  await tickRestarted(world, ticks - 1)
}


/**
 * Reads the bodies of the messages delivered to the user's mailbox.
 * @param world - The world.
 * @returns The bodies.
 */
const userReports = (world: World): string[] =>
  [...world.files.entries()].filter(([path]) => path.startsWith(`${records}/mail/user/new/`)).map(([, text]) => (JSON.parse(text) as { body: string }).body)

/**
 * Starts the coordinator's session, which registers its tick, then lets ticks run; a session already started only ticks.
 * @param $ - The engine.
 * @param world - The world.
 * @param ticks - How many ticks run.
 * @param isStarted - Whether the session already started.
 */
async function runTicks($: Engine, world: World, ticks: number, isStarted = false): Promise<void> {
  if (!isStarted) await $.session.start({ cwd: root, surface: null, isInteractive: false })
  if (ticks === 0) return
  await world.clock.advance(tickMs)
  await world.clock.settle()
  await runTicks($, world, ticks - 1, true)
}

// group: Stalled units
// contract: an idle unit holding mail unread for longer than T is reported stalled to the user's mailbox once, naming the clause
test('an idle unit holding unread mail past T is reported once, naming the clause', async ($, on) => {
  const { world } = arrange(on)
  seedActivity(world, { isTurn: false, ageMs: 10 * minuteMs })
  seedUnreadMail(world, 6 * minuteMs)
  await runTicks($, world, 2)
  expect(userReports(world)).toEqual(['#12 is stalled: it is idle and has held mail unread for over 5 min; read its pane.'])
})

// contract: a unit whose activity record is missing or unreadable, holding mail unread for longer than T, is reported with its turn state unknown, never as idle
test('a unit with no readable activity record holding unread mail past T is reported with its turn state unknown', async ($, on) => {
  const { world } = arrange(on)
  seedUnreadMail(world, 6 * minuteMs)
  await runTicks($, world, 2)
  expect(userReports(world)).toEqual([`#12 is stalled: it has held mail unread for over 5 min and its turn state is unknown: its session left no readable activity record at ${records}/activity/${unitSession}.json; read its pane.`])
})

// contract: a unit whose mod's tools failed to register is reported for that cause, never as dead or as stalled on its unread mail
test('a unit whose tools did not register is reported for it, not as a mail stall', async ($, on) => {
  const { world } = arrange(on)
  world.files.set(`${records}/activity/${unitSession}.json`, JSON.stringify({ v: 1, isTurn: false, at: world.clock.now() - 10 * minuteMs, isDialog: false, toolsError: 'registry closed' }))
  seedUnreadMail(world, 6 * minuteMs)
  await runTicks($, world, 2)
  expect(userReports(world)).toEqual(['#12 is stalled: the mod\'s tools did not register in its session, so no mod prompt will start a turn, and a restart of its session retries the registration; read its pane.'])
})

// contract: a tools stall is one episode while its cause stands, so a unit the user drives by hand, whose activity keeps moving, is reported once
test('a unit whose tools did not register is reported once while its activity moves', async ($, on) => {
  const { world } = arrange(on)
  const seedTools = (): void => { world.files.set(`${records}/activity/${unitSession}.json`, JSON.stringify({ v: 1, isTurn: true, at: world.clock.now(), isDialog: false, toolsError: 'registry closed' })) }
  seedTools()
  await runTicks($, world, 1)
  seedTools()
  await runTicks($, world, 1, true)
  seedTools()
  await runTicks($, world, 1, true)
  expect(userReports(world)).toHaveLength(1)
})

// contract: unread mail younger than T is no stall, nor is mail a working unit has not reached yet
test('mail younger than T, or waiting for a working unit, is not reported', async ($, on) => {
  const { world } = arrange(on)
  seedActivity(world, { isTurn: false, ageMs: 0 })
  seedUnreadMail(world, 2 * minuteMs)
  await runTicks($, world, 1)
  seedActivity(world, { isTurn: true, ageMs: 0 })
  seedUnreadMail(world, 30 * minuteMs)
  await runTicks($, world, 1, true)
  expect(userReports(world)).toEqual([])
})

// contract: a unit herdr reports blocked on two ticks in a row is reported stalled once, naming herdr's blocked
test('a unit herdr reports blocked is reported once', async ($, on) => {
  const { world, host } = arrange(on)
  seedActivity(world, { isTurn: true, ageMs: 0 })
  host.isBlocked = true
  await runTicks($, world, 1)
  expect(userReports(world)).toEqual([])
  await runTicks($, world, 2, true)
  expect(userReports(world)).toEqual(['#12 is stalled: herdr reports it blocked; read its pane.'])
})

// contract: a running turn with no tool or turn event for longer than T2 is reported stalled once, naming the clause
test('a turn silent for longer than T2 is reported once', async ($, on) => {
  const { world } = arrange(on)
  seedActivity(world, { isTurn: true, ageMs: turnLimitMs })
  await runTicks($, world, 2)
  expect(userReports(world)).toEqual(['#12 is stalled: its turn has shown no tool or turn event for over 65 min; read its pane.'])
})

// contract: a running record whose turn a reloaded load cannot vouch for is never reported as a silent turn, as no turn may be running
test('an unknown running record silent past T2 is not reported as a silent turn', async ($, on) => {
  const { world } = arrange(on)
  world.files.set(`${records}/activity/${unitSession}.json`, JSON.stringify({ v: 1, isTurn: true, at: world.clock.now() - turnLimitMs, isDialog: false, isUnknown: true }))
  await runTicks($, world, 2)
  expect(userReports(world)).toEqual([])
})

// contract: recording whether the tools registered, failed or recovered, changes that field alone and keeps the record's reload uncertainty
test('a registration outcome keeps an activity record unknown', async (_$, on) => {
  const { world } = arrange(on)
  const path = `${records}/activity/sid.json`
  world.files.set(path, JSON.stringify({ v: 1, isTurn: false, at: world.clock.now(), isDialog: false, isUnknown: true, epoch: 3 }))
  raiseFault('tools', { row: 'Tools', text: 'registry closed', cause: 'registry closed' })
  await recordToolsOutcome(createTestPort(world))
  const failed = JSON.parse(world.files.get(path) ?? '{}') as { isUnknown?: boolean; toolsError?: string }
  clearFault('tools')
  await recordToolsOutcome(createTestPort(world))
  const recovered = JSON.parse(world.files.get(path) ?? '{}') as { isUnknown?: boolean; toolsError?: string }
  expect({ failed: [failed.isUnknown, failed.toolsError], recovered: [recovered.isUnknown, recovered.toolsError] }).toEqual({ failed: [true, 'registry closed'], recovered: [true, undefined] })
})

// contract: a unit inside the longest legitimate Verify or Bash call, silent for up to T2, is never reported
test('a unit inside a long Verify or Bash call is not reported', async ($, on) => {
  const { world } = arrange(on)
  seedActivity(world, { isTurn: true, ageMs: turnLimitMs - 2 * tickMs })
  await runTicks($, world, 1)
  expect(userReports(world)).toEqual([])
})

// contract: a unit that recovers is reported again when it stalls again
test('a unit that recovers and stalls again is reported again', async ($, on) => {
  const { world, host } = arrange(on)
  seedActivity(world, { isTurn: true, ageMs: 0 })
  host.isBlocked = true
  await runTicks($, world, 2)
  host.isBlocked = false
  await runTicks($, world, 1, true)
  host.isBlocked = true
  await runTicks($, world, 2, true)
  expect(userReports(world)).toHaveLength(2)
})

// group: Dead unit vs dialog
// contract: a unit whose recorded process ended is reported as dead, once, never as stalled, even while herdr still shows it blocked
test('a unit whose process ended is reported dead, not stalled', async ($, on) => {
  const { world, host } = arrange(on)
  seedActivity(world, { isTurn: true, ageMs: turnLimitMs })
  host.isBlocked = true
  world.files.delete(`/proc/${unitProcess.pid}/stat`)
  await runTicks($, world, 2)
  expect(userReports(world)).toEqual(['#12 is dead: its session\'s process ended; spawn resumes it.'])
})

// contract: a unit held by a permission dialog, which already told the coordinator, is reported neither through herdr's blocked nor through its silent turn
test('a unit stuck on a permission dialog is not reported again', async ($, on) => {
  const { world, host } = arrange(on)
  seedActivity(world, { isTurn: true, ageMs: turnLimitMs, isDialog: true })
  host.isBlocked = true
  await runTicks($, world, 1)
  expect(userReports(world)).toEqual([])
})

// contract: herdr shows a permission dialog blocked before the engine's notification marks it, so a dialog that the next tick finds marked is never reported
test('a permission dialog herdr shows blocked before its notification arrives is not reported', async ($, on) => {
  const { world, host } = arrange(on)
  seedActivity(world, { isTurn: true, ageMs: 0 })
  host.isBlocked = true
  await runTicks($, world, 1)
  seedActivity(world, { isTurn: true, ageMs: 0, isDialog: true })
  await runTicks($, world, 2, true)
  expect(userReports(world)).toEqual([])
})

// contract: a unit whose workspace its host no longer lists, as after merge_child closed it, is not watched
test('a unit whose workspace is closed is not reported', async ($, on) => {
  const { world, host } = arrange(on)
  host.isOpen = false
  world.files.delete(`/proc/${unitProcess.pid}/stat`)
  await runTicks($, world, 1)
  expect(userReports(world)).toEqual([])
})

// contract: a dead unit judged while the spawn lock is held is reported neither now nor lost: once the lock is released, it is reported dead once
test('a dead unit seen under a held spawn lock is reported once the lock is released', async ($, on) => {
  const { world } = arrange(on)
  seedActivity(world, { isTurn: false, ageMs: 0 })
  world.files.delete(`/proc/${unitProcess.pid}/stat`)
  holdSpawnLock(world)
  await runTicks($, world, 2)
  expect(userReports(world)).toEqual([])
  expect(world.files.has(stallFile)).toBe(false)
  releaseSpawnLock(world)
  await runTicks($, world, 2, true)
  expect(userReports(world)).toEqual(['#12 is dead: its session\'s process ended; spawn resumes it.'])
})

/**
 * Makes the spawn lock's state unreadable while the fault is on, as the lock script exits on a lock file it cannot open.
 * @param fault - Whether the fault is on.
 * @returns The world's failing runs.
 */
const unreadableLock = (fault: { isOn: boolean }): Options => ({ failRun: argv => fault.isOn && argv[0] === 'perl' && argv[2] === 'list'
  ? { exitCode: 2, stderr: 'host-lock: cannot open lock: Is a directory' } : undefined })

// contract: a unit the sweep cannot tell spawn is starting is reported to the user once, naming why and how to check, and that report is cleared once the sweep judges the unit again
test('a unit the stall check cannot tell spawn is starting is reported once, and the report cleared once it can', async ($, on) => {
  const fault = { isOn: true }
  const { world } = arrange(on, unreadableLock(fault))
  seedActivity(world, { isTurn: false, ageMs: 0 })
  world.files.set(`${records}/spawn/12.starting`, 'sid')
  await runTicks($, world, 3)
  expect(userReports(world)).toEqual([expect.stringContaining('The mod cannot tell whether spawn is starting #12 (the lock ')])
  expect(userReports(world)[0]).toContain('Check that no spawn of #12 is still running')
  expect(world.files.has(stallFile)).toBe(true)
  fault.isOn = false
  await runTicks($, world, 1, true)
  expect(world.files.has(stallFile)).toBe(false)
  expect(userReports(world)).toHaveLength(1)
})

// contract: a dead unit whose spawn lock cannot be read is reported to the user once as undecided, never dropped, and reported dead once the lock reads
test('a dead unit whose spawn lock cannot be read is reported once as undecided, then dead once the lock reads', async ($, on) => {
  const fault = { isOn: true }
  const { world } = arrange(on, unreadableLock(fault))
  seedActivity(world, { isTurn: false, ageMs: 0 })
  world.files.delete(`/proc/${unitProcess.pid}/stat`)
  await runTicks($, world, 3)
  expect(userReports(world)).toEqual([expect.stringContaining('#12\'s session process has ended, but the mod cannot tell whether a close or retirement ended it on purpose')])
  fault.isOn = false
  await runTicks($, world, 2, true)
  expect(userReports(world)).toEqual([expect.stringContaining('cannot tell'), '#12 is dead: its session\'s process ended; spawn resumes it.'])
})

// contract: a dead unit whose workspace a close removed after the sweep listed it is not reported, and its stall record is cleared
test('a dead unit whose workspace closed during the sweep is not reported', async (_$, on) => {
  const { world, host } = arrange(on)
  seedActivity(world, { isTurn: false, ageMs: 0 })
  world.files.set(stallFile, JSON.stringify({ v: 1, session: unitSession, stall: 'turn', key: `${unitSession}:turn:1` }))
  world.files.delete(`/proc/${unitProcess.pid}/stat`)
  host.isClosing = true
  await reportStalledUnits(createTestPort(world))
  expect(userReports(world)).toEqual([])
  expect(world.files.has(stallFile)).toBe(false)
})

// group: Activity record
// contract: a unit's own mod records a turn as running from its start, a permission dialog as holding it, and the turn's end as idle
test('a unit records its turn, its permission dialog and its turn end', async ($, on) => {
  const { world } = arrange(on)
  // why: the engine answers no classic hook itself; the session that hears the notification is the end of its chain.
  on('classic.Notification', () => ({}))
  world.chat.id = unitSession
  const read = (): Record<string, unknown> => JSON.parse(world.files.get(`${records}/activity/${unitSession}.json`) ?? '{}') as Record<string, unknown>
  await $.turn.start({ text: 'work', turnId: 't' })
  expect(read()).toMatchObject({ isTurn: true, isDialog: false })
  await $.classic.Notification({ message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' } as never)
  expect(read()).toMatchObject({ isTurn: true, isDialog: true })
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  expect(read()).toMatchObject({ isTurn: false, isDialog: false })
})

// contract: a session start records the unit idle, so a turn its crashed process left marked running never hides its unread mail from the stall check
test('a resumed unit whose process crashed mid-turn is recorded idle at its start', async ($, on) => {
  const { world } = arrange(on)
  seedActivity(world, { isTurn: true, ageMs: 10 * minuteMs })
  world.chat.id = unitSession
  // why: the resumed process can read its own identity, which tells it apart from the crashed one the host record names.
  world.files.set('/proc/self/stat', buildStat(unitProcess.pid + 1, '9000'))
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect(JSON.parse(world.files.get(`${records}/activity/${unitSession}.json`) ?? '{}')).toMatchObject({ isTurn: false, isDialog: false })
})

// contract: a resumed process that cannot read its own identity never takes the turn its predecessor recorded for idle, and says why it holds
test('a resumed unit that cannot read its own identity keeps the recorded turn and holds its prompts', async ($, on) => {
  const { world } = arrange(on)
  seedActivity(world, { isTurn: true, ageMs: 10 * minuteMs })
  world.chat.id = unitSession
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect(JSON.parse(world.files.get(`${records}/activity/${unitSession}.json`) ?? '{}')).toMatchObject({ isTurn: true })
  expect(await readFlowStatus($)).toContain('could not read its own identity')
})

for (const [clause, stall] of [
  ['mail', (world: World): void => { seedActivity(world, { isTurn: false, ageMs: 0 }); seedUnreadMail(world, 6 * minuteMs) }],
  ['blocked', (world: World, host: FakeHost): void => { seedActivity(world, { isTurn: true, ageMs: 0 }); host.isBlocked = true }],
  ['turn', (world: World): void => seedActivity(world, { isTurn: true, ageMs: turnLimitMs })],
  ['dead', (world: World): void => { seedActivity(world, { isTurn: false, ageMs: 0 }); world.files.delete(`/proc/${unitProcess.pid}/stat`) }],
] as const) {
  // group: Reports across a coordinator restart
  // contract: a stall still in place after a coordinator restart is not reported again
  test(`a ${clause} stall still in place after a coordinator restart is not reported again`, async ($, on) => {
    const { world, host } = arrange(on)
    stall(world, host)
    await runTicks($, world, 2)
    expect(userReports(world)).toHaveLength(1)
    await tickAfterRestart(world, 3)
    expect(userReports(world)).toHaveLength(1)
  })
}

// contract: a new episode of the same clause is reported without a healthy tick between: a new oldest unread message
test('a new oldest unread message is a new mail stall, reported again', async ($, on) => {
  const { world } = arrange(on)
  seedActivity(world, { isTurn: false, ageMs: 0 })
  seedUnreadMail(world, 6 * minuteMs)
  await runTicks($, world, 1)
  world.files.delete(`${records}/mail/12/new/m1.1.json`)
  seedUnreadMail(world, 6 * minuteMs, 'm2')
  await runTicks($, world, 1, true)
  expect(userReports(world)).toHaveLength(2)
})

// contract: a new episode of the same clause is reported without a healthy tick between: a dead unit whose recorded process changed
test('a dead unit whose recorded process changed is reported dead again', async ($, on) => {
  const { world } = arrange(on)
  world.files.delete(`/proc/${unitProcess.pid}/stat`)
  await runTicks($, world, 1)
  world.files.set(`${records}/host/${unitSession}.json`, JSON.stringify({ ...coordinatorHost, ...unitProcess, pidStart: '9000' }))
  await runTicks($, world, 1, true)
  expect(userReports(world)).toEqual(['#12 is dead: its session\'s process ended; spawn resumes it.', '#12 is dead: its session\'s process ended; spawn resumes it.'])
})

// contract: a stall record that cannot be read counts as none, so the stall is reported again rather than lost
test('a corrupt stall record leads to a new report', async ($, on) => {
  const { world, host } = arrange(on)
  seedActivity(world, { isTurn: true, ageMs: 0 })
  host.isBlocked = true
  await runTicks($, world, 2)
  world.files.set(stallFile, 'not json')
  await tickAfterRestart(world, 2)
  expect(userReports(world)).toHaveLength(2)
})

/**
 * Reads the messages delivered to the user's mailbox.
 * @param world - The world.
 * @returns Each message's kind, body and options.
 */
const userMail = (world: World): Array<{ kind: string; body: string; options: string[] }> =>
  [...world.files.entries()].filter(([path]) => path.startsWith(`${records}/mail/user/new/`)).map(([, text]) => JSON.parse(text) as { kind: string; body: string; options: string[] })

/**
 * Lists the herdr calls that read a unit's screen or send it a key.
 * @param world - The world.
 * @returns Each call's verb and its last argument.
 */
const paneCalls = (world: World): string[][] =>
  world.herdrCalls.filter(call => call.argv[1] === 'agent' && (call.argv[2] === 'read' || call.argv[2] === 'send-keys')).map(call => [call.argv[2] ?? '', call.argv.at(-1) ?? ''])

/**
 * Stalls the unit on a silent turn while its pane shows a screen, and lets the coordinator report it.
 * @param $ - The engine.
 * @param world - The world.
 * @param host - The unit's fake host.
 * @param rows - The left column of the unit's screen.
 * @returns Once the report was sent.
 */
async function stallOn($: Engine, world: World, host: FakeHost, rows: string[]): Promise<void> {
  host.screen = dockScreen(rows)
  seedActivity(world, { isTurn: true, ageMs: turnLimitMs })
  await runTicks($, world, 1)
}

// group: Naming the dialog
// contract: a stalled unit's report names the catalogued dialog its pane shows and says that dismiss_dialog clears it with Esc
test('a stall on the exit-with-background-work dialog is reported naming it', async ($, on) => {
  const { world, host } = arrange(on)
  await stallOn($, world, host, dialogScreens['exit-background-work'] ?? [])
  expect(userReports(world)).toEqual(['#12 is stalled: its turn has shown no tool or turn event for over 65 min; its pane shows the exit-with-background-work dialog '
    + '(exit-background-work): dismiss_dialog exit-background-work clears it with Esc.'])
})

// contract: a dialog the catalogue allows no key on is named, and the report says the mod sends it none
test('a stall on the Settings Error dialog is named, with no key offered', async ($, on) => {
  const { world, host } = arrange(on)
  await stallOn($, world, host, dialogScreens['settings-error'] ?? [])
  expect(userReports(world)[0]).toContain('its pane shows the Settings Error dialog (settings-error): the mod sends it no key: answer it in the unit\'s pane.')
})

// contract: a spawned unit with no process record is still judged: mail it holds unread past T is a stall, and the report names the dialog its pane shows
test('a unit with no process record holding mail past T is reported, naming the dialog its pane shows', async ($, on) => {
  const { world, host } = arrange(on)
  world.files.delete(`${records}/host/${unitSession}.json`)
  host.screen = dockScreen(dialogScreens['settings-error'] ?? [])
  seedUnreadMail(world, 6 * minuteMs)
  await runTicks($, world, 1)
  expect(userReports(world)).toEqual([`#12 is stalled: it has held mail unread for over 5 min and its turn state is unknown: its session left no readable activity record at ${records}/activity/${unitSession}.json; its pane shows the Settings Error dialog (settings-error): `
    + 'the mod sends it no key: answer it in the unit\'s pane.'])
})

// contract: a unit just spawned, with no process record or activity yet, is not reported while its start assignment is young
test('a unit just spawned, with no process record or activity yet, is not reported', async ($, on) => {
  const { world } = arrange(on)
  world.files.delete(`${records}/host/${unitSession}.json`)
  seedUnreadMail(world, minuteMs)
  await runTicks($, world, 2)
  expect(userReports(world)).toEqual([])
})

// contract: an unknown dialog is never touched: it becomes a question to the user carrying the pane excerpt, and no key is sent
test('an unknown dialog becomes a question to the user with the excerpt, and nothing is sent', async ($, on) => {
  const { world, host } = arrange(on)
  await stallOn($, world, host, unknownDialog)
  const [question] = userMail(world)
  expect(question?.kind).toBe('question')
  expect(question?.body).toContain('its pane shows a dialog the mod does not know, so it sent no key')
  expect(question?.body).toContain('❯ 1. Red')
  expect(question?.options).toHaveLength(2)
  expect(paneCalls(world).filter(([verb]) => verb === 'send-keys')).toEqual([])
})

// contract: no detection path reads a pane: a unit that is not stalled, or dead, is never read, and a reported stall is read once, not on every tick
test('only identification after a stall report reads the pane, once per report', async ($, on) => {
  const { world, host } = arrange(on)
  host.screen = dockScreen(dialogScreens['exit-background-work'] ?? [])
  seedActivity(world, { isTurn: true, ageMs: 0 })
  host.isBlocked = true
  await runTicks($, world, 1)
  expect(paneCalls(world)).toEqual([])
  await runTicks($, world, 3, true)
  expect(paneCalls(world)).toEqual([['read', 'visible']])
  world.files.delete(`/proc/${unitProcess.pid}/stat`)
  await runTicks($, world, 2, true)
  expect(userReports(world).at(-1)).toContain('is dead')
  expect(paneCalls(world)).toEqual([['read', 'visible']])
})

// group: Clearing it with dismiss_dialog
// contract: dismiss_dialog sends Esc to a dialog a report named and the catalogue allows it on, after reading the pane again, and forgets the report
test('dismiss_dialog sends Esc to the named dialog and forgets the report', async ($, on) => {
  const { world, host } = arrange(on)
  await stallOn($, world, host, dialogScreens['exit-background-work'] ?? [])
  const outcome = await callModTool($, 'dismiss_dialog', { number: 12, dialog: 'exit-background-work' })
  expect(outcome).toMatchObject({ isError: false, text: expect.stringContaining('Sent Esc to #12') })
  expect(paneCalls(world).filter(([verb]) => verb === 'send-keys')).toEqual([['send-keys', 'esc']])
  expect((await callModTool($, 'dismiss_dialog', { number: 12, dialog: 'exit-background-work' })).isError).toBe(true)
})

for (const [name, named, args] of [
  ['the auto-mode setup dialog, even when a report named it', 'auto-mode-setup', { dialog: 'auto-mode-setup' }],
  ['any key but Esc', 'exit-background-work', { dialog: 'exit-background-work', key: 'Enter' }],
  ['a dialog no report named', 'exit-background-work', { dialog: 'settings-error' }],
] as const) {
  // contract: dismiss_dialog refuses the auto-mode setup dialog even when asked, any key but Esc, and a dialog the report did not name, and sends nothing
  test(`dismiss_dialog refuses ${name}`, async ($, on) => {
    const { world, host } = arrange(on)
    await stallOn($, world, host, dialogScreens[named] ?? [])
    expect(userReports(world)[0]).toContain(`(${named})`)
    expect((await callModTool($, 'dismiss_dialog', { number: 12, ...args })).isError).toBe(true)
    expect(paneCalls(world).filter(([verb]) => verb === 'send-keys')).toEqual([])
  })
}

// contract: dismiss_dialog refuses a pane that changed between the report and the call, and sends nothing
test('dismiss_dialog refuses a pane that changed since the report', async ($, on) => {
  const { world, host } = arrange(on)
  await stallOn($, world, host, dialogScreens['exit-background-work'] ?? [])
  host.screen = dockScreen(noDialog)
  expect(await callModTool($, 'dismiss_dialog', { number: 12, dialog: 'exit-background-work' })).toMatchObject({ isError: true, text: expect.stringContaining('no longer shows') })
  expect(paneCalls(world).filter(([verb]) => verb === 'send-keys')).toEqual([])
})
