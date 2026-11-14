import { expect } from 'claude-code/testing'
import type { Next } from 'claude-code'

import { sendTyped } from '../../hooks/core/mail-send'
import { reread } from '../../hooks/core/pane-view'
import { tickMs } from '../../hooks/core/timing'
import { submitStart } from '../../hooks/core/user-steps'
import { createEmptySession } from '../../hooks/domain/records'
import { handleClassicSessionStart } from '../../hooks/handlers/session'
import { handleTurnComplete, handleTurnStart } from '../../hooks/handlers/turn'
import { handleStop } from '../../hooks/handlers/worktree'
import { buildChanged, coordinator, diagnoseRuns, diagnosisComment, verifyFile } from '../support/builders'
import { inside } from '../support/helpers'
import { test } from '../support/kit'
import { childCheckout, parChild } from '../support/parallel-worktrees'
import { createModuleHarness, faultyHost, newProcess, nextTurnId, reloadModule } from '../support/reload'
import type { ModuleHarness } from '../support/reload'
import { coordinatorHost, createWorld, markSpawned, records, scopeFile, seedDelegation } from '../support/world'
import type { World } from '../support/world'

/** A promise the test holds a host call on, until it opens it. */
interface Gate { promise: Promise<void>; open: () => void }

/** Deferred work the test holds, to run it when the scene needs it. */
interface HeldTimers { isHeld: boolean; queue: (() => void)[] }

const unitSession = 'unit-12'
const noMessage = 'with no message to its coordinator'
const wake = 'The user approved the Verify config this unit waited on, from their own terminal: call the verify tool.'

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
 * @param options - World options besides the unit's, which a test may change later.
 * @returns The world, in the unit's session.
 */
function arrangeUnit(on: Parameters<typeof createWorld>[0], options: Parameters<typeof createWorld>[2] = {}): World {
  // why: the world reads the options the caller holds, so one it changes later, as a fault it arms, reaches the world.
  const world = createWorld(on, { branch: 'main' }, Object.assign(options, { session: coordinator, herdrEnv: inside, herdrReply: () => '{}' }))
  markSpawned(world, [12], unitSession)
  world.seedChat(unitSession, createEmptySession(unitSession))
  world.chat.id = unitSession
  return world
}

/**
 * Builds unit `a` of issue 1, at Integrate, delegated by a running coordinator `coord`, holding an assign it can reply done to.
 * @param on - The test's hook registration.
 * @returns The world.
 */
function arrangeDelegatedChild(on: Parameters<typeof createWorld>[0]): World {
  const world = createWorld(on, childCheckout(), { ...parChild(), herdrEnv: inside })
  world.files.set(scopeFile('coord'), JSON.stringify({ v: 1, sessionId: 'coord', issues: [1], coversCreated: false, host: coordinatorHost }))
  markSpawned(world, [1])
  world.files.set(`${records}/mail/1/cur/a1.1.json`, JSON.stringify({ v: 1, id: 'a1', kind: 'assign', from: 'coordinator-coord', to: '1', issue: 1, in_reply_to: '', seq: 1,
    created_at: '2026-11-03T00:00:00.000Z', expects: '', attempt: 1, body: 'merge it', refs: [], author: 'agent' }))
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
 * Counts the prompts that carry a text.
 * @param world - The world.
 * @param text - The text.
 * @returns How many.
 */
const countPrompts = (world: World, text: string): number => world.prompts.filter(prompt => prompt.includes(text)).length


/**
 * Counts the starts a held process state keeps.
 * @param value - The held value.
 * @returns How many.
 */
const countKept = (value: unknown): number => (value as { pendingStarts?: unknown[] } | undefined)?.pendingStarts?.length ?? 0

/**
 * Reads the pane's Start and Process rows as last painted.
 * @param world - The world.
 * @param key - The row key.
 * @returns The rows.
 */
const readRows = (world: World, key: string): string[] => (world.views.at(-1)?.notes ?? []).filter(note => note.key === key).map(note => note.value)

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
 * @param gate - Holds the chain beneath the hook, as a slow hook below the mod's does, until it opens.
 * @returns Once the turn's end settled.
 */
async function completeTurn(harness: ModuleHarness, turnId = harness.turns.last, isAborted = false, gate?: Gate): Promise<void> {
  await handleTurnComplete(harness.port, { reason: isAborted ? 'aborted' : 'answer', answer: '', durationMs: 0, isAborted, turnId } as never,
    (async () => { await gate?.promise; return { text: '' } }) as unknown as Next<'turn.complete'>)
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

// group: One owner of the turn evidence and the queue
// contract: a replaced load whose delivery resumes after a reload claims nothing, as its claim names its own load, so it changes no start and submits nothing, and the recorded load delivers the start once, once it hears a turn of its own
test('a replaced load resuming its delivery after a reload claims nothing, and the new load delivers once', async (_$, on) => {
  const world = arrangeApproval(on)
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
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'step', lead: 'Handed lead.' })
  const delivery = timers.queue.splice(0)
  timers.isHeld = false
  slow.isArmed = true
  for (const work of delivery) work()
  await world.clock.settle()
  await reloadModule(harness)
  slow.gate.open()
  await world.clock.settle()
  const after = { kept: countKept(world.processState.value), attempts: (world.processState.value as { attempts?: unknown[] }).attempts ?? [], submits: countPrompts(world, 'Handed lead.') }
  // why: the new load holds its own prompts until it hears a turn of its own, as the replaced load may have heard one it never recorded.
  await startTurn(harness)
  await completeTurn(harness)
  await tickIdle(harness, 2)
  expect({ after, delivered: countPrompts(world, 'Handed lead.') }).toEqual({ after: { kept: 1, attempts: [], submits: 0 }, delivered: 1 })
})

// contract: an end of an earlier turn that lands late never clears a newer turn start whose write failed, so no start enters that newer turn
test('a late end of an earlier turn keeps a newer failed turn start busy', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: false }
  const harness = faultyHost(world, { failWrite: next => fault.isArmed && (next as { turn?: { id?: string } | null }).turn?.id === 't2' && !(fault.isArmed = false) })
  await newProcess(harness)
  await startTurn(harness, 't1')
  const gate = createGate()
  const ending = completeTurn(harness, 't1', false, gate)
  fault.isArmed = true
  await startTurn(harness, 't2')
  gate.open()
  await ending
  await submitStart(harness.port, { kind: 'coordinate', text: 'busy words' })
  await world.clock.settle()
  expect(countPrompts(world, 'busy words')).toBe(0)
})

// contract: a turn start whose write failed is shown as work in progress on the pane, never as a step waiting on the user, as the delivery guard already holds it
test('a failed turn start is shown working, not waiting on the user', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: false }
  const harness = faultyHost(world, { failWrite: next => fault.isArmed && !!(next as { turn?: unknown }).turn && !(fault.isArmed = false) })
  await newProcess(harness)
  fault.isArmed = true
  await startTurn(harness)
  await reread(harness.port, true)
  expect((world.views.at(-1)?.steps ?? []).some(step => step.symbol === '●')).toBe(false)
})

// contract: a message sent whose turn read after the send fails still counts for its turn, so its Stop asks for none
test('a sent message whose later state read fails is not asked for again', async (_$, on) => {
  const world = arrangeDelegatedChild(on)
  const window = { isOpen: false, isArmed: false }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    files: { ...world.boundaries.files, write: async (file, text) => {
      await world.boundaries.files.write(file, text)
      if (window.isOpen && file.includes('/mail/coordinator-coord/')) window.isArmed = true
    } },
    readProcessState: async () => {
      if (window.isArmed) { window.isArmed = false; throw new Error('host busy') }
      return base.readProcessState()
    },
  })
  await newProcess(harness)
  await startTurn(harness)
  window.isOpen = true
  expect((await sendTyped(harness.port, { kind: 'done', body: 'merged', in_reply_to: 'a1' })).isOk).toBe(true)
  window.isOpen = false
  window.isArmed = false
  expect(await stop(harness)).not.toContain(noMessage)
})

// contract: a message sent whose write to its turn failed, followed by a reload, is never asserted unsent: the new load's Stop asks for no message
test('a sent message whose write failed before a reload is not asked for again', async (_$, on) => {
  const world = arrangeDelegatedChild(on)
  const fault = { isArmed: false }
  const harness = faultyHost(world, { failWrite: next => fault.isArmed && JSON.stringify(next).includes('"hasSent":true') && !(fault.isArmed = false) })
  await newProcess(harness)
  await startTurn(harness)
  fault.isArmed = true
  expect((await sendTyped(harness.port, { kind: 'done', body: 'merged', in_reply_to: 'a1' })).isOk).toBe(true)
  await reloadModule(harness)
  expect(await stop(harness)).not.toContain(noMessage)
})

// contract: an earlier version's activity record unreadable through a reload, while the session is idle, is read again at the tick, so the session is not held busy for good, and a start kept then is delivered once
test('an idle legacy record unreadable through a reload is read again, never a phantom turn', async (_$, on) => {
  const world = arrangeUnit(on)
  const path = `${records}/activity/${unitSession}.json`
  const fault = { isFailing: false }
  const harness = faultyHost(world, { failRead: file => fault.isFailing && file === path })
  await newProcess(harness)
  // why: a version before the process state wrote no epoch in its record.
  world.files.set(path, JSON.stringify({ v: 1, isTurn: false, at: world.clock.now(), isDialog: false }))
  world.processState.value = undefined
  fault.isFailing = true
  await reloadModule(harness)
  fault.isFailing = false
  await tickIdle(harness, 2)
  await submitStart(harness.port, { kind: 'coordinate', text: 'idle words' })
  await world.clock.settle()
  await tickIdle(harness, 2)
  expect(countPrompts(world, 'idle words')).toBe(1)
})

// group: Established evidence stands
// contract: a submit that answers after its tick bound, while the unknown settlement it was left with has not been written, is settled by that answer: a start that entered leaves no unknown note
test('a late submit success before its unknown settlement lands leaves no unknown note', async (_$, on) => {
  const world = arrangeApproval(on)
  const held = { resolve: (): void => {}, isArmed: true }
  const fault = { isArmed: false }
  const count = (value: unknown): number => (value as { unknownStarts?: unknown[] } | undefined)?.unknownStarts?.length ?? 0
  const harness = faultyHost(world, { failWrite: (next, current) => fault.isArmed && count(next) > count(current) && !(fault.isArmed = false) }, {
    submitPrompt: async text => {
      world.prompts.push(text)
      if (!held.isArmed) return
      held.isArmed = false
      await new Promise<void>(resolve => { held.resolve = resolve })
    },
  })
  await newProcess(harness)
  fault.isArmed = true
  await submitStart(harness.port, { kind: 'coordinate', text: 'late words' })
  await world.clock.advance(tickMs)
  await world.clock.settle()
  held.resolve()
  await world.clock.settle()
  await tickIdle(harness, 2)
  await reread(harness.port, true)
  expect({ isUnknown: readRows(world, 'Start').some(row => row.includes('got no answer')), kept: countKept(world.processState.value) }).toEqual({ isUnknown: false, kept: 0 })
})

// contract: a wake whose submit never settles is held as unknown after a tick, named on the hold row with how to check it, and never submitted again
test('a wake submit that never settles is held unknown and never submitted again', async (_$, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  seedDelegation(world, 'coord', [1])
  const harness = createModuleHarness(world, {
    submitPrompt: async text => {
      world.prompts.push(text)
      if (text.includes(wake)) await new Promise<never>(() => {})
    },
  })
  await newProcess(harness)
  await reread(harness.port, true)
  world.approveConfig(verifyFile)
  await reread(harness.port, true)
  await world.clock.settle()
  await world.clock.advance(tickMs)
  await world.clock.settle()
  await tickIdle(harness, 2)
  await reread(harness.port, true)
  await world.clock.settle()
  expect({ wakes: countPrompts(world, wake), isUnknown: readRows(world, 'Process').some(row => row.includes('Verify approval wake') && row.includes('got no answer') && row.includes('type any prompt')) })
    .toEqual({ wakes: 1, isUnknown: true })
})

// contract: a publish whose lock holder renamed the record and ended before answering is shown with the record's state unknown, naming it, never as nothing written
test('a rename whose answer was lost is shown unknown, not as nothing written', async (_$, on) => {
  const options: Parameters<typeof createWorld>[2] = {}
  const world = arrangeUnit(on, options)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  const path = `${records}/activity/${unitSession}.json`
  const cut = { isArmed: true }
  // why: the holder ends right after this rename, before it answers; every lock this session waits on is cut, as the hold names its own.
  options.renameFails = target => {
    if (cut.isArmed && target === path) {
      cut.isArmed = false
      for (const lock of world.hostLocks.queues.keys()) world.hostLocks.kill(lock, unitSession)
    }
    return false
  }
  await startTurn(harness)
  await reread(harness.port, true)
  expect(readRows(world, 'Process').filter(each => each.includes(path))).toEqual([expect.stringContaining('was written is unknown: inspect it')])
})

// contract: a compaction during a turn changes no kept start: no Stop carries it, and the turn's end delivers it once
test('a compaction during a turn leaves a kept start for the turn end, delivered once', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'compacted words' })
  await world.clock.settle()
  const block = await stop(harness)
  await handleClassicSessionStart(harness.port, { source: 'compact' } as never, (async () => ({})) as unknown as Next<'classic.SessionStart'>)
  await completeTurn(harness)
  expect({ inBlock: block.includes('compacted words'), delivered: countPrompts(world, 'compacted words'), kept: countKept(world.processState.value) }).toEqual({ inBlock: false, delivered: 1, kept: 0 })
})


// contract: a wake this load saw enter, whose wait could not be ended, is shown as entered, never as unknown or undelivered, and is not submitted again
test('a delivered wake whose wait cannot be ended is shown entered', async (_$, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  seedDelegation(world, 'coord', [1])
  const fault = { isArmed: false }
  const harness = faultyHost(world, { failWrite: (next, current) => fault.isArmed && (current as { pendingWake?: string | null }).pendingWake !== null
    && (next as { pendingWake?: string | null }).pendingWake === null && !(fault.isArmed = false) })
  await newProcess(harness)
  await reread(harness.port, true)
  world.approveConfig(verifyFile)
  fault.isArmed = true
  await reread(harness.port, true)
  await world.clock.settle()
  const notes = await (async (): Promise<string[]> => { await reread(harness.port, true); return readRows(world, 'Approve') })()
  expect({ wakes: countPrompts(world, wake), isEntered: notes.some(row => row.includes('entered')), isUnknown: notes.some(row => row.includes('unknown') || row.includes('not delivered')) })
    .toEqual({ wakes: 1, isEntered: true, isUnknown: false })
})
