import { expect } from 'claude-code/testing'
import type { Next } from 'claude-code'

import { recordActivity } from '../../hooks/core/liveness'
import { followApproval } from '../../hooks/core/approval-wake'
import { ringDoorbell } from '../../hooks/core/mailbox'
import { sendTyped } from '../../hooks/core/mail-send'
import { decodeProcessState, readProcessState } from '../../hooks/core/process-state'
import { refreshView, reread } from '../../hooks/core/pane-view'
import { mirrorSession, updateSession } from '../../hooks/core/record-store'
import { publishLockPath } from '../../hooks/core/session-publish'
import { tickMs } from '../../hooks/core/timing'
import { recoverStarts, runApproveStep, scheduleStart, submitStart } from '../../hooks/core/user-steps'
import { createEmptySession } from '../../hooks/domain/records'
import { handleMailPromptSubmit } from '../../hooks/handlers/mail'
import { handleToolCall } from '../../hooks/handlers/tool-call'
import { handleTurnComplete, handleTurnStart } from '../../hooks/handlers/turn'
import { handleStop } from '../../hooks/handlers/worktree'
import { buildChanged, coordinator, diagnoseRuns, diagnosisComment, verifyFile } from '../support/builders'
import { inside } from '../support/helpers'
import { test } from '../support/kit'
import { handlePaneRender } from '../../hooks/handlers/pane-render'
import type { PaneElements } from '../../hooks/ui/pane-sections'
import { childCheckout, parChild } from '../support/parallel-worktrees'
import { createDispatchPort, createModuleHarness, faultyHost, newProcess, nextTurnId, reloadModule } from '../support/reload'
import type { ModuleHarness } from '../support/reload'
import { common, coordinatorHost, createWorld, markSpawned, records, scopeFile, seedDelegation } from '../support/world'
import type { World } from '../support/world'

/** A promise the test holds a host call on, until it opens it. */
interface Gate { promise: Promise<void>; open: () => void }

/** Deferred work the test holds, to run it when the scene needs it. */
interface HeldTimers { isHeld: boolean; queue: (() => void)[] }

const unitSession = 'unit-12'
const wake = 'The user approved the Verify config this unit waited on, from their own terminal: call the verify tool.'
const noMessage = 'with no message to its coordinator'
const doorbell = '[working-agreement] Checking this session\'s mailbox; any mail comes with this prompt.'

/**
 * Builds a Fix world whose diagnosis waits for its approval, so an approval keeps a start.
 * @param on - The test's hook registration.
 * @returns The world.
 */
function arrangeApproval(on: Parameters<typeof createWorld>[0]): World {
  return createWorld(on, { branch: 'fix' }, {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
    unit: { runs: [diagnoseRuns[0]!] }, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
  })
}

/**
 * Builds a coordinator world whose issue 12 runs in a spawned unit, and moves the world to the unit's own session.
 * @param on - The test's hook registration.
 * @returns The world, in the unit's session.
 */
function arrangeUnit(on: Parameters<typeof createWorld>[0]): World {
  const world = createWorld(on, { branch: 'main' }, { session: coordinator, herdrEnv: inside, herdrReply: () => '{}' })
  markSpawned(world, [12], unitSession)
  world.seedChat(unitSession, createEmptySession(unitSession))
  world.chat.id = unitSession
  return world
}

/**
 * Builds a closed gate, which a held host call waits on until the test opens it.
 * @returns The gate.
 */
function createGate(): Gate {
  const opener = { open: (): void => {} }
  const promise = new Promise<void>(resolve => { opener.open = resolve })
  return { promise, open: () => { opener.open() } }
}

/**
 * Builds a harness whose deferred work the test may hold, and whose next session read, once armed, waits on a gate, so a step start's
 * composition holds while the scene moves on.
 * @param world - The world.
 * @returns The harness, its held work and the gate's arming.
 */
function harnessWithHeldCompose(world: World): { harness: ModuleHarness; timers: HeldTimers; slow: { isArmed: boolean; gate: Gate } } {
  const timers: HeldTimers = { isHeld: false, queue: [] }
  const slow = { isArmed: false, gate: createGate() }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    defer: work => { if (timers.isHeld) timers.queue.push(work); else work() },
    readSessionState: async () => {
      if (slow.isArmed) { slow.isArmed = false; await slow.gate.promise }
      return base.readSessionState()
    },
  })
  return { harness, timers, slow }
}

/**
 * Counts the prompts that carry a text.
 * @param world - The world.
 * @param text - The text.
 * @returns How many.
 */
const countPrompts = (world: World, text: string): number => world.prompts.filter(prompt => prompt.includes(text)).length

/**
 * Reads the ids of the starts the session keeps, oldest first.
 * @param world - The world.
 * @returns The ids.
 */
const readKeptIds = (world: World): string[] => ((world.processState.value as { pendingStarts?: { id: string }[] }).pendingStarts ?? []).map(kept => kept.id)

/**
 * Reads the pane's Start rows as last painted.
 * @param world - The world.
 * @returns The rows.
 */
const readStartRows = (world: World): string[] => (world.views.at(-1)?.notes ?? []).filter(note => note.key === 'Start').map(note => note.value)

/**
 * Reads the pane's Process rows as last painted, the hold row among them.
 * @param world - The world.
 * @returns The rows.
 */
const readHoldRows = (world: World): string[] => (world.views.at(-1)?.notes ?? []).filter(note => note.key === 'Process').map(note => note.value)

/**
 * Draws the Flow pane once, as the host does while it is open, which acknowledges the notes the view shows.
 * @param harness - The direct-dispatch harness.
 * @returns Once drawn.
 */
async function renderFlow(harness: ModuleHarness): Promise<void> {
  await handlePaneRender(harness.port, { Box: () => null, Text: () => null, Button: () => null } as unknown as PaneElements,
    { bodyColumns: 80, scroll: { offset: 0, bodyRows: 200 } } as never, new AbortController().signal)
}

/**
 * Starts the main loop's turn, as the engine does after a prompt entered.
 * @param harness - The direct-dispatch harness.
 * @param turnId - The turn.
 * @returns Once the turn start settled.
 */
const startTurn = (harness: ModuleHarness, turnId = nextTurnId(harness)): Promise<unknown> =>
  handleTurnStart(harness.port, { text: 'go', turnId } as never, (async () => ({ turnId })) as unknown as Next<'turn.start'>)

/**
 * Ends the main loop's turn as the engine does.
 * @param harness - The direct-dispatch harness.
 * @param turnId - The turn.
 * @param isAborted - Whether the user interrupted it.
 * @returns Once the turn's end settled.
 */
async function completeTurn(harness: ModuleHarness, turnId = harness.turns.last, isAborted = false): Promise<void> {
  await handleTurnComplete(harness.port, { reason: isAborted ? 'aborted' : 'answer', answer: '', durationMs: 0, isAborted, turnId } as never,
    (async () => ({ text: '' })) as unknown as Next<'turn.complete'>)
  await harness.world.clock.settle()
}

/**
 * Raises the main agent's stop and reads its block.
 * @param harness - The direct-dispatch harness.
 * @returns The block's text, empty when the stop goes through.
 */
async function stop(harness: ModuleHarness): Promise<string> {
  const result = await handleStop(harness.port, { stop_hook_active: false, background_tasks: [] } as never, (async () => ({})) as unknown as Next<'classic.Stop'>)
  return (result as { block?: string }).block ?? ''
}

/**
 * Runs idle ticks, each a full tick apart.
 * @param harness - The direct-dispatch harness.
 * @param ticks - How many.
 * @returns Once they ran.
 */
async function tickIdle(harness: ModuleHarness, ticks: number): Promise<void> {
  if (ticks === 0) return
  await harness.world.clock.advance(tickMs)
  await harness.tick()
  await tickIdle(harness, ticks - 1)
}

/**
 * Runs the deferred work the harness held, all at once, then lets it settle.
 * @param harness - The direct-dispatch harness.
 * @param timers - The held work.
 * @returns Once it settled.
 */
async function runHeld(harness: ModuleHarness, timers: HeldTimers): Promise<void> {
  const work = timers.queue.splice(0)
  timers.isHeld = false
  for (const each of work) each()
  await harness.world.clock.settle()
}

// group: One transition for every change to the kept starts
// contract: a delivery whose dispatch reads a moment from before a turn started never submits into that turn: its claim judges the gate on the current state, its Stop carries nothing, and the turn's end delivers the start once
test('a delivery reading a stale moment never submits into a turn that started meanwhile', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, timers, slow } = harnessWithHeldCompose(world)
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(createDispatchPort(harness), { kind: 'step', lead: 'Stale lead.' })
  slow.isArmed = true
  await runHeld(harness, timers)
  await startTurn(harness)
  slow.gate.open()
  await world.clock.settle()
  const early = countPrompts(world, 'Stale lead.')
  const inBlock = (await stop(harness)).includes('Stale lead.')
  await completeTurn(harness)
  expect({ early, inBlock, delivered: countPrompts(world, 'Stale lead.') }).toEqual({ early: 0, inBlock: false, delivered: 1 })
})

// contract: a turn start whose process-state write failed holds the session busy until that turn change is written or adopted, though an unrelated write, as a command keeping a start, succeeds meanwhile
test('a failed turn start stays busy though a later unrelated write succeeds', async (_$, on) => {
  const world = arrangeApproval(on)
  const faults = { failedWrites: 0 }
  const harness = faultyHost(world, { failWrite: () => faults.failedWrites > 0 && faults.failedWrites-- > 0 })
  await newProcess(harness)
  faults.failedWrites = 1
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'busy words' })
  await world.clock.settle()
  expect(countPrompts(world, 'busy words')).toBe(0)
})

// contract: a message sent in a turn whose write to the turn failed still counts for that turn, so its Stop asks for none
test('a sent message whose turn write failed is not asked for again at the Stop', async (_$, on) => {
  const world = createWorld(on, childCheckout(), { ...parChild(), herdrEnv: inside })
  world.files.set(scopeFile('coord'), JSON.stringify({ v: 1, sessionId: 'coord', issues: [1], coversCreated: false, host: coordinatorHost }))
  markSpawned(world, [1])
  world.files.set(`${records}/mail/1/cur/a1.1.json`, JSON.stringify({ v: 1, id: 'a1', kind: 'assign', from: 'coordinator-coord', to: '1', issue: 1, in_reply_to: '', seq: 1,
    created_at: '2026-11-03T00:00:00.000Z', expects: '', attempt: 1, body: 'merge it', refs: [], author: 'agent' }))
  const faults = { isArmed: false }
  const harness = faultyHost(world, { staleRuns: true, failWrite: next => faults.isArmed && JSON.stringify(next).includes('"hasSent":true') && !(faults.isArmed = false) })
  await newProcess(harness)
  await startTurn(harness)
  faults.isArmed = true
  expect((await sendTyped(harness.port, { kind: 'done', body: 'merged', in_reply_to: 'a1' })).isOk).toBe(true)
  expect(await stop(harness)).not.toContain(noMessage)
})

// contract: a submit that fails with anything but the engine's answer that it dropped the prompt may have followed its entry, so its attempt is held as unknown, named on the hold row, and never submitted again
test('a submit that fails without a drop is shown unknown and never submitted again', async (_$, on) => {
  const world = arrangeApproval(on)
  const attempts = { count: 0 }
  const harness = createModuleHarness(world, {
    submitPrompt: async text => {
      if (text.includes('cut words')) {
        attempts.count += 1
        if (attempts.count === 1) throw new Error('the call was cut')
      }
      world.prompts.push(text)
    },
  })
  await newProcess(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'cut words' })
  await world.clock.settle()
  await tickIdle(harness, 3)
  await reread(harness.port, true)
  expect({ attempts: attempts.count, isUnknown: readHoldRows(world).some(row => row.includes('the call was cut') && row.includes('whether it entered is unknown')) })
    .toEqual({ attempts: 1, isUnknown: true })
})

// contract: a start kept behind one still composing never passes it: the turn's end delivers the earlier first, then the later, each once, and no Stop carries either
test('a later start never passes an earlier one still composing', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, timers, slow } = harnessWithHeldCompose(world)
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'step', lead: 'Earlier lead.' })
  slow.isArmed = true
  await runHeld(harness, timers)
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'later words' })
  await world.clock.settle()
  const block = await stop(harness)
  slow.gate.open()
  await world.clock.settle()
  await completeTurn(harness)
  await tickIdle(harness, 3)
  const order = world.prompts.flatMap(prompt => ['Earlier lead.', 'later words'].filter(text => prompt.includes(text)))
  expect({ inBlock: block.includes('words') || block.includes('lead.'), order }).toEqual({ inBlock: false, order: ['Earlier lead.', 'later words'] })
})


// contract: a coordinate or delegate start never enters an idle window another delivery claimed, even from its own command, where it would only queue behind that prompt and be lost with it: it stays kept and the next idle tick delivers it once
test('a fixed start never passes another claim, and is delivered once when idle', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers: HeldTimers = { isHeld: false, queue: [] }
  const harness = createModuleHarness(world, { defer: work => { if (timers.isHeld) timers.queue.push(work); else work() } })
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'coordinate', text: 'first words' })
  timers.queue.length = 0
  timers.isHeld = false
  scheduleStart(harness.port)
  await world.clock.settle()
  await submitStart(harness.port, { kind: 'delegate', issues: [3], instructions: 'second words' })
  await world.clock.settle()
  const early = { submits: countPrompts(world, 'second words'), kept: readKeptIds(world).length }
  await tickIdle(harness, 2)
  expect({ early, later: countPrompts(world, 'second words'), kept: readKeptIds(world).length }).toEqual({ early: { submits: 0, kept: 1 }, later: 1, kept: 0 })
})

// contract: paints only read the attempts: two overlapping paints of the unknown outcomes an earlier shape kept each show all of them, and neither removes any
test('two overlapping paints show every unknown outcome and remove none', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  const unknownStarts = Array.from({ length: 8 }, (_, index) => ({ id: `u${index}`, kind: 'step', cause: 'claimed by an earlier load, not known whether it entered', label: `start ${index}` }))
  world.processState.value = { ...world.processState.value as Record<string, unknown>, unknownStarts, unknownOverflow: 3 }
  await Promise.all([reread(harness.port, true), refreshView(harness.port, { isQuiet: true, isSynced: true })])
  await world.clock.settle()
  await reread(harness.port, true)
  const row = readHoldRows(world).find(each => each.startsWith('held')) ?? ''
  const attempts = decodeProcessState(world.processState.value)?.attempts ?? []
  expect({ items: (row.match(/\d+\) /g) ?? []).length, isCounted: row.includes('3 more start prompts'), kept: attempts.length }).toEqual({ items: 9, isCounted: true, kept: 9 })
})

// contract: a command whose keep answered with a failure says in its reply that whether its start was kept is unknown, never that it was not kept; the tick's own read settles it, and the pane then keeps the note that it was not kept, though a later start is kept, until a render of the Flow view has shown it
test('a start that could not be kept is named in the reply and survives a later keep', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: false }
  const count = (value: unknown): number => (value as { pendingStarts?: unknown[] } | undefined)?.pendingStarts?.length ?? 0
  const harness = faultyHost(world, { failWrite: (next, current) => fault.isArmed && count(next) > count(current) && !(fault.isArmed = false) })
  await newProcess(harness)
  await startTurn(harness)
  fault.isArmed = true
  const reply = await runApproveStep(harness.port, diagnosisComment.url)
  await harness.tick()
  await submitStart(harness.port, { kind: 'coordinate', text: 'next words' })
  await world.clock.settle()
  await reread(harness.port, true)
  expect({ isReplied: reply.isOk && reply.value.includes('was kept is not known') && reply.value.includes('(host busy)') && !reply.value.includes('was not kept'),
    isShown: readStartRows(world).some(row => row.includes('was not kept (its keep did not land: host busy)')) })
    .toEqual({ isReplied: true, isShown: true })
})

// contract: two wake callbacks of one approval submit the wake once, as only the claim that won the compare-and-set submits
test('two wake callbacks of one approval submit it once', async (_$, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  seedDelegation(world, 'coord', [1])
  const timers: HeldTimers = { isHeld: false, queue: [] }
  const harness = createModuleHarness(world, { defer: work => { if (timers.isHeld) timers.queue.push(work); else work() } })
  await newProcess(harness)
  await reread(harness.port, true)
  world.approveConfig(verifyFile)
  timers.isHeld = true
  await reread(harness.port, true)
  await reread(harness.port, true)
  await runHeld(harness, timers)
  expect(countPrompts(world, wake)).toBe(1)
})

// contract: a reload from a version that kept no process state, whose activity record cannot be read, never seeds an idle session: a start kept then waits
test('an unreadable legacy activity record never seeds an idle session', async (_$, on) => {
  const world = arrangeUnit(on)
  const path = `${records}/activity/${unitSession}.json`
  const fault = { isFailing: false }
  const harness = faultyHost(world, { failRead: file => fault.isFailing && file === path })
  await newProcess(harness)
  await startTurn(harness)
  world.processState.value = undefined
  // why: the record stays unreadable through the whole start, as a disk fault does, so no later read adopts the turn it holds.
  fault.isFailing = true
  await reloadModule(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'legacy words' })
  await world.clock.settle()
  expect(countPrompts(world, 'legacy words')).toBe(0)
})

// contract: a mirror publish whose revision read fails writes nothing, so an older module's snapshot never lands over a newer mirror
test('a mirror publish whose fence cannot be read never lands an older record', async (_$, on) => {
  const world = arrangeUnit(on)
  const older = { snapshot: null as Awaited<ReturnType<ModuleHarness['port']['readSessionState']>> | null }
  const fault = { isArmed: false }
  const revision = `${records}/s/${unitSession}.rev`
  const harness = faultyHost(world, { failRead: file => fault.isArmed && file === revision && !(fault.isArmed = false) },
    { readSessionState: async () => older.snapshot ?? world.directSessionState.readSessionState() })
  await newProcess(harness)
  await reloadModule(harness)
  const path = `${records}/s/${unitSession}.json`
  const before = await harness.port.readSessionState()
  await updateSession(harness.port, session => ({ ...session, isLong: true }))
  const newer = world.files.get(path)
  older.snapshot = before
  fault.isArmed = true
  await harness.asOldModule(() => mirrorSession(harness.port, false).catch(() => undefined))
  older.snapshot = null
  expect(world.files.get(path)).toBe(newer)
})

// contract: a publish whose lock holder ends after the rename was asked for, and before it ran, renames nothing, as only the holder renames
test('a publish whose lock is lost as its rename is asked renames nothing', async (_$, on) => {
  const world = arrangeUnit(on)
  const path = `${records}/activity/${unitSession}.json`
  const lock = publishLockPath(common, unitSession)
  const cut = { isArmed: false }
  const base = createModuleHarness(world).port
  const loseLock = (): void => {
    cut.isArmed = false
    world.hostLocks.kill(lock, `${unitSession}/publish`)
  }
  const harness = createModuleHarness(world, {
    processes: { ...base.processes, run: async (argv, options) => {
      if (cut.isArmed && argv[0] === 'mv' && argv.at(-1) === path) loseLock()
      return base.processes.run(argv, options)
    } },
    files: { ...world.boundaries.files, write: async (file, text) => {
      if (cut.isArmed && file.endsWith('.mv')) loseLock()
      await world.boundaries.files.write(file, text)
    } },
  })
  await newProcess(harness)
  const before = world.files.get(path)
  cut.isArmed = true
  await startTurn(harness)
  expect(world.files.get(path)).toBe(before)
})

// contract: a turn publish whose read of the activity record fails writes nothing, so a newer record a failed turn-start write left ahead is kept, and a reload adopts its turn
test('a turn publish that cannot read the activity record never writes over a newer one', async (_$, on) => {
  const world = arrangeUnit(on)
  const path = `${records}/activity/${unitSession}.json`
  const fault = { isArmed: false }
  const harness = faultyHost(world, { failRead: file => fault.isArmed && file === path && !(fault.isArmed = false) })
  await newProcess(harness)
  const state = await readProcessState(harness.port)
  const epoch = (state?.epoch ?? 0) + 1
  world.files.set(path, JSON.stringify({ v: 1, isTurn: true, at: world.clock.now(), isDialog: false, epoch }))
  fault.isArmed = true
  await recordActivity(harness.port, 'turn.complete', state)
  await reloadModule(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'fenced words' })
  await world.clock.settle()
  expect({ epoch: (JSON.parse(world.files.get(path) ?? '{}') as { epoch?: number }).epoch, submits: countPrompts(world, 'fenced words') }).toEqual({ epoch, submits: 0 })
})

// contract: the doorbell claims the idle window in the same compare-and-set a start delivery does, so a start kept right after a ring waits rather than entering behind the doorbell's prompt
test('a start kept right after a doorbell ring waits for the session to be idle', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  world.files.set(`${records}/mail/12/new/m1.1.json`, JSON.stringify({ v: 2, id: 'm1', kind: 'assign', from: 'coordinator-sid', to: '12', issue: 12, in_reply_to: '', seq: 1,
    created_at: new Date(world.clock.now() - 6 * 60000).toISOString(), expects: '', attempt: 1, body: 'work on it', refs: [], author: 'agent', options: [] }))
  await ringDoorbell(harness.port)
  await world.clock.settle()
  await submitStart(harness.port, { kind: 'coordinate', text: 'after ring words' })
  await world.clock.settle()
  expect({ rings: countPrompts(world, doorbell), start: countPrompts(world, 'after ring words') }).toEqual({ rings: 1, start: 0 })
})

// contract: a turn that worked after entering as an empty doorbell, whose write of that work failed, is still a work turn at its Stop, which asks for the message it owes
test('a work turn whose write failed is not taken for an empty doorbell at its Stop', async (_$, on) => {
  const world = createWorld(on, childCheckout(), { ...parChild(), herdrEnv: inside })
  world.files.set(scopeFile('coord'), JSON.stringify({ v: 1, sessionId: 'coord', issues: [1], coversCreated: false, host: coordinatorHost }))
  markSpawned(world, [1])
  world.files.set(`${records}/mail/1/cur/a1.1.json`, JSON.stringify({ v: 1, id: 'a1', kind: 'assign', from: 'coordinator-coord', to: '1', issue: 1, in_reply_to: '', seq: 1,
    created_at: '2026-11-03T00:00:00.000Z', expects: '', attempt: 1, body: 'merge it', refs: [], author: 'agent' }))
  const fault = { isArmed: false }
  const harness = faultyHost(world, { failWrite: next => fault.isArmed && JSON.stringify(next).includes('"isEmptyDoorbell":false') && !(fault.isArmed = false) })
  await newProcess(harness)
  await handleMailPromptSubmit(harness.port, { prompt: doorbell, permission_mode: 'default' } as never, (async () => ({})) as unknown as Next<'classic.UserPromptSubmit'>)
  await startTurn(harness)
  fault.isArmed = true
  await handleToolCall(harness.port, { tool: 'Read', input: { file_path: '/repo/README.md' }, tool_use_id: 'read-1' } as never, async () => ({ result: 'read' }) as never)
  await world.clock.settle()
  expect(await stop(harness)).toContain(noMessage)
})

// group: Fault lifecycles
// contract: (pin, not a red: the registry only moved where these faults live) a fault of the registry clears as soon as its operation succeeds again, so a paint after the recovery no longer shows it, though no paint showed it before
test('a registry fault clears on resolution, shown or not', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: false }
  const harness = faultyHost(world, { failWrite: () => fault.isArmed && !(fault.isArmed = false) })
  await newProcess(harness)
  fault.isArmed = true
  await startTurn(harness)
  await completeTurn(harness)
  await reread(harness.port, true)
  expect((world.views.at(-1)?.notes ?? []).filter(note => note.key === 'Process' && note.value.includes('host busy'))).toEqual([])
})

// contract: a keep whose answer was lost is settled against the state that stands when it is settled, never against an older read: a start kept meanwhile is never said not kept
test('an unknown keep is never settled from a read older than the keep', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: false }
  const count = (value: unknown): number => (value as { pendingStarts?: unknown[] } | undefined)?.pendingStarts?.length ?? 0
  const harness = faultyHost(world, { loseWrite: (next, current) => fault.isArmed && count(next) > count(current) && !(fault.isArmed = false) })
  await newProcess(harness)
  await startTurn(harness)
  const older = world.processState.value
  fault.isArmed = true
  await submitStart(harness.port, { kind: 'step', lead: 'Raced lead.' })
  const stale = { ...harness.port, readProcessState: async () => older }
  await recoverStarts(stale)
  await reread(harness.port, true)
  expect({ kept: count(world.processState.value), isNotKept: readStartRows(world).some(row => row.includes('was not kept')) }).toEqual({ kept: 1, isNotKept: false })
})

// contract: (pin, not a red: its first half is the keep-failure red above) a start notice of a keep the tick found not kept stays through a later successful keep until a render of the Flow view showed it, and the next successful keep after that render clears it
test('a keep failure stays until a paint showed it, then clears with the next keep', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: false }
  const count = (value: unknown): number => (value as { pendingStarts?: unknown[] } | undefined)?.pendingStarts?.length ?? 0
  const harness = faultyHost(world, { failWrite: (next, current) => fault.isArmed && count(next) > count(current) && !(fault.isArmed = false) })
  await newProcess(harness)
  await startTurn(harness)
  fault.isArmed = true
  await submitStart(harness.port, { kind: 'coordinate', text: 'lost words' })
  await harness.tick()
  await submitStart(harness.port, { kind: 'coordinate', text: 'kept words' })
  await reread(harness.port, true)
  const shown = readStartRows(world).some(row => row.includes('was not kept (its keep did not land: host busy)'))
  await renderFlow(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'later words' })
  await reread(harness.port, true)
  expect({ shown, after: readStartRows(world).some(row => row.includes('was not kept')) }).toEqual({ shown: true, after: false })
})

// group: The one gate
// contract: a session held by unresolved evidence submits nothing on any route, a kept start, a wake or a doorbell, until the evidence resolves; then the start is delivered
test('a held session submits no start, wake or doorbell until its hold resolves', async (_$, on) => {
  const world = arrangeUnit(on)
  const fault = { isHostUnreadable: false }
  const harness = faultyHost(world, { failRead: path => fault.isHostUnreadable && path === `${records}/host/${unitSession}.json` })
  await newProcess(harness)
  fault.isHostUnreadable = true
  world.processState.value = { ...world.processState.value as Record<string, unknown>, legacy: { host: 'unread', activity: 'unread' }, pendingWake: 'blob1', wokenBlobs: ['blob1'] }
  world.files.set(`${records}/mail/12/new/m1.1.json`, JSON.stringify({ v: 2, id: 'm1', kind: 'inform', from: 'coordinator-sid', to: '12', issue: 12, in_reply_to: '', seq: 1,
    created_at: new Date(world.clock.now()).toISOString(), expects: '', attempt: 1, body: 'news', refs: [], author: 'agent', options: [] }))
  await submitStart(harness.port, { kind: 'coordinate', text: 'held words' })
  await followApproval(harness.port, null, true)
  await ringDoorbell(harness.port)
  await tickIdle(harness, 3)
  const held = [...world.prompts]
  fault.isHostUnreadable = false
  await tickIdle(harness, 4)
  expect({ held, delivered: countPrompts(world, 'held words') }).toEqual({ held: [], delivered: 1 })
})

// contract: a replaced load whose submit answers after a reload only records that answer on its attempt: the kept start stays until the recorded load settles it, and is never delivered again
test('a replaced load only records its late answer, and the recorded load settles it', async (_$, on) => {
  const world = arrangeApproval(on)
  const held = { resolve: (): void => {} }
  const harness = createModuleHarness(world, {
    submitPrompt: async text => {
      world.prompts.push(text)
      await new Promise<void>(resolve => { held.resolve = resolve })
    },
  })
  await newProcess(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'late words' })
  await world.clock.settle()
  await reloadModule(harness)
  held.resolve()
  await world.clock.settle()
  const state = world.processState.value as { pendingStarts?: unknown[]; attempts?: { status: { kind: string } }[] }
  const recorded = { kept: state.pendingStarts?.length ?? 0, attempts: (state.attempts ?? []).map(attempt => attempt.status.kind) }
  await tickIdle(harness, 2)
  expect({ recorded, kept: ((world.processState.value as { pendingStarts?: unknown[] }).pendingStarts ?? []).length, submits: countPrompts(world, 'late words') })
    .toEqual({ recorded: { kept: 1, attempts: ['entered'] }, kept: 0, submits: 1 })
})
