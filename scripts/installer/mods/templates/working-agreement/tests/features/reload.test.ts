import { expect } from 'claude-code/testing'
import type { Next } from 'claude-code'
import type { ProcessState } from '../../types'

import { followApproval } from '../../hooks/core/approval-wake'
import { DroppedPromptError } from '../../hooks/core/engine-port'
import type { EnginePort } from '../../hooks/core/engine-port'
import { createFeaturePort } from '../../hooks/core/feature-port'
import { readFault } from '../../hooks/core/fault-registry'
import { recordActivity } from '../../hooks/core/liveness'
import { openAdoption, readProcessState } from '../../hooks/core/process-state'
import { sendTyped } from '../../hooks/core/mail-send'
import { reread } from '../../hooks/core/pane-view'
import { renderFlowStatus } from '../../hooks/core/status'
import { createReadPort } from '../../hooks/core/read-port'
import { locatePosition } from '../../hooks/core/position'
import { mirrorSession, readSession, temporaryPath, updateSession } from '../../hooks/core/record-store'
import { publishLockPath } from '../../hooks/core/session-publish'
import { sessionMemory } from '../../hooks/core/session-memory'
import { registrationBoundMs, tickMs } from '../../hooks/core/timing'
import { withVerifyTurn } from '../../hooks/core/verify-queue'
import { recoverStarts, runApproveStep, scheduleStart, submitStart } from '../../hooks/core/user-steps'

import { describeStartFailure } from '../../hooks/domain/instruction'
import { createEmptySession } from '../../hooks/domain/records'
import { endHandoffTurn, recordHandoffDocument, startHandoff } from '../../hooks/features/handoff'
import { handleMailPromptSubmit } from '../../hooks/handlers/mail'
import { handleToolCall } from '../../hooks/handlers/tool-call'
import { handleTurnComplete, handleTurnStart } from '../../hooks/handlers/turn'
import { handleStop } from '../../hooks/handlers/worktree'
import { buildChanged, coordinator, diagnoseRuns, diagnosisComment, verifyFile } from '../support/builders'
import { inside } from '../support/helpers'
import { test } from '../support/kit'
import { childCheckout, parChild } from '../support/parallel-worktrees'
import { createModuleHarness, faultyHost, newProcess, nextTurnId, reloadModule } from '../support/reload'
import type { ModuleHarness } from '../support/reload'
import { common, coordinatorHost, createTestPort, createWorld, markSpawned, records, scopeFile, seedDelegation } from '../support/world'
import type { World } from '../support/world'

/** A promise the test holds a host call on, until it opens it. */
interface Gate { promise: Promise<void>; open: () => void }

/** A tool call's subagent, absent for the main loop, and what happens while its tool runs. */
interface ToolCallScene { agentId?: string; during?: () => Promise<void> }

const unitSession = 'unit-12'
const minuteMs = 60000
const doorbell = '[working-agreement] Checking this session\'s mailbox; any mail comes with this prompt.'
const wake = 'The user approved the Verify config this unit waited on, from their own terminal: call the verify tool.'
const noMessage = 'with no message to its coordinator'
const reloadFailure = 'a handoff was running and has no continuation in this process (mod reload)'
const processFailure = 'a handoff was running and has no continuation in this process (the session\'s previous process ended)'

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
 * Builds unit `a` of issue 1, at Integrate, delegated by a running coordinator `coord`.
 * @param on - The test's hook registration.
 * @returns The world.
 */
function arrangeDelegatedChild(on: Parameters<typeof createWorld>[0]): World {
  const world = createWorld(on, childCheckout(), { ...parChild(), herdrEnv: inside })
  world.files.set(scopeFile('coord'), JSON.stringify({ v: 1, sessionId: 'coord', issues: [1], coversCreated: false, host: coordinatorHost }))
  markSpawned(world, [1])
  return world
}

/**
 * Builds a Fix world whose diagnosis waits for its approval, so an approval keeps a start while a turn runs.
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
 * Leaves a message from the coordinator unread in the unit's mailbox.
 * @param world - The world.
 * @param ageMs - How long ago it was sent.
 */
function seedUnreadMail(world: World, ageMs: number): void {
  world.files.set(`${records}/mail/12/new/m1.1.json`, JSON.stringify({ v: 2, id: 'm1', kind: 'assign', from: 'coordinator-sid', to: '12', issue: 12, in_reply_to: '', seq: 1,
    created_at: new Date(world.clock.now() - ageMs).toISOString(), expects: '', attempt: 1, body: 'work on it', refs: [], author: 'agent', options: [] }))
}

/**
 * Reads whether the unit's activity record holds a running turn.
 * @param world - The world.
 * @param session - The session whose record is read.
 * @returns The record's isTurn, undefined without a record.
 */
function readIsTurn(world: World, session = unitSession): boolean | undefined {
  const text = world.files.get(`${records}/activity/${session}.json`)
  return text === undefined ? undefined : (JSON.parse(text) as { isTurn: boolean }).isTurn
}

/**
 * Moves the clock in steps, letting the work each step wakes settle before the next.
 * @param world - The world.
 * @param steps - How many steps.
 * @param stepMs - How long each is.
 * @returns Once moved.
 */
async function advanceBy(world: World, steps: number, stepMs: number): Promise<void> {
  if (steps === 0) return
  await world.clock.advance(stepMs)
  await world.clock.settle()
  await advanceBy(world, steps - 1, stepMs)
}

/**
 * Reads the sequence a temporary path ends with.
 * @param path - The path.
 * @returns The sequence.
 */
const readSequence = (path: string): number => Number(path.split('-').at(-1))

/**
 * Reads the unit's activity record.
 * @param world - The world.
 * @returns The record, or null without one.
 */
const readActivityRecord = (world: World): { isTurn: boolean; at: number; epoch?: number } | null =>
  JSON.parse(world.files.get(`${records}/activity/${unitSession}.json`) ?? 'null') as { isTurn: boolean; at: number; epoch?: number } | null

/**
 * Counts the prompts submitted with exactly the given text, or containing it.
 * @param world - The world.
 * @param text - The text.
 * @returns How many.
 */
const countPrompts = (world: World, text: string): number => world.prompts.filter(prompt => prompt === text || prompt.includes(text)).length

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
 * Runs a turn the new load hears itself, as the user's prompt after a reload starts one: its start ends the reload's hold, and the
 * starts kept wait for its end.
 * @param harness - The direct-dispatch harness.
 * @returns Once the turn ended.
 */
async function hearTurn(harness: ModuleHarness): Promise<void> {
  await startTurn(harness)
  await completeTurn(harness)
}

/**
 * Runs a Read call through the mod's tool hook, as the main loop or a subagent makes it.
 * @param harness - The direct-dispatch harness.
 * @param call - The subagent making it, absent for the main loop, and what happens while the tool runs.
 * @returns Once the call settled.
 */
async function callTool(harness: ModuleHarness, call: ToolCallScene = {}): Promise<void> {
  await handleToolCall(harness.port, { tool: 'Read', input: { file_path: '/repo/README.md' }, tool_use_id: 'read-1', ...call.agentId ? { agentId: call.agentId } : {} } as never,
    async () => {
      await call.during?.()
      return { result: 'read' } as never
    })
  await harness.world.clock.settle()
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
 * Allocates a temporary path in one module.
 * @param harness - The direct-dispatch harness.
 * @param isOld - Whether the replaced module allocates.
 * @returns The path.
 */
function allocate(harness: ModuleHarness, isOld: boolean): Promise<string> {
  const run = (): Promise<string> => temporaryPath(harness.port, '/d')
  return isOld ? harness.asOldModule(run) : run()
}

/**
 * Allocates temporary paths in one module a number of times, so the next allocation of two modules shares a sequence.
 * @param harness - The direct-dispatch harness.
 * @param isOld - Whether the replaced module allocates.
 * @param times - How many.
 * @returns Once allocated.
 */
async function allocateTimes(harness: ModuleHarness, isOld: boolean, times: number): Promise<void> {
  if (times <= 0) return
  await allocate(harness, isOld)
  await allocateTimes(harness, isOld, times - 1)
}

/**
 * Enters a prompt as the engine does once it is submitted, which delivers the unread mail with it.
 * @param harness - The direct-dispatch harness.
 * @param prompt - The prompt's text.
 * @returns The context it entered with, joined.
 */
async function enterPrompt(harness: ModuleHarness, prompt: string): Promise<string> {
  const result = await handleMailPromptSubmit(harness.port, { prompt, permission_mode: 'default' } as never,
    (async () => ({})) as unknown as Next<'classic.UserPromptSubmit'>)
  return (result as { additionalContext?: string[] }).additionalContext?.join('\n') ?? ''
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
 * Runs ticks of the session's own timer.
 * @param harness - The direct-dispatch harness.
 * @param ticks - How many.
 * @returns Once they ran.
 */
async function tickTimes(harness: ModuleHarness, ticks: number): Promise<void> {
  if (ticks === 0) return
  await harness.tick()
  await tickTimes(harness, ticks - 1)
}

/**
 * Runs ticks a full period apart, as the session's timer does, so a prompt a delivery claimed no longer holds the next.
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

// group: Rejected prompts
// contract: a prompt a later hook blocks is no evidence of a turn boundary, so a load a reload started stays held: it submits no kept start until it hears an accepted prompt or a turn start or end
test('a blocked prompt after a reload keeps the reload hold and submits no kept start', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await reloadModule(harness)
  await handleMailPromptSubmit(harness.port, { prompt: 'blocked', permission_mode: 'default' } as never, (async () => ({ block: 'a later hook blocked it' })) as unknown as Next<'classic.UserPromptSubmit'>)
  const held = world.processState.value as ProcessState
  world.processState.value = { ...held, pendingStarts: [{ id: 'kept-1', start: { kind: 'step', lead: 'Held start.' } }] }
  const before = world.prompts.length
  await tickIdle(harness, 3)
  expect({ submitted: world.prompts.length - before, kept: ((world.processState.value as ProcessState).pendingStarts ?? []).length }).toEqual({ submitted: 0, kept: 1 })
})

// contract: a prompt a later hook blocks while a reload's adoption is still reading the state is no boundary either: the adoption keeps the reload's uncertainty, so no kept start is submitted until an accepted prompt or a turn start or end
test('a blocked prompt during a slow adoption after a reload keeps the reload hold', async (_$, on) => {
  const world = arrangeUnit(on)
  const slow = { isArmed: false, gate: createGate() }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, { readProcessState: async () => {
    if (slow.isArmed) { slow.isArmed = false; await slow.gate.promise }
    return base.readProcessState()
  } })
  await newProcess(harness)
  slow.isArmed = true
  const reloading = reloadModule(harness)
  await world.clock.settle()
  await handleMailPromptSubmit(harness.port, { prompt: 'blocked', permission_mode: 'default' } as never, (async () => ({ block: 'a later hook blocked it' })) as unknown as Next<'classic.UserPromptSubmit'>)
  slow.gate.open()
  await reloading
  const held = world.processState.value as ProcessState
  world.processState.value = { ...held, pendingStarts: [{ id: 'kept-1', start: { kind: 'step', lead: 'Held start.' } }] }
  const before = world.prompts.length
  await tickIdle(harness, 3)
  expect({ submitted: world.prompts.length - before, kept: ((world.processState.value as ProcessState).pendingStarts ?? []).length }).toEqual({ submitted: 0, kept: 1 })
})

// group: Hold announcements
// contract: a hold no fault caused is announced until a notification of it went through: one that failed is tried again at the next tick
test('a hold announcement whose notification failed is announced again', async (_$, on) => {
  const world = arrangeUnit(on)
  const failures = { left: 1 }
  const harness = createModuleHarness(world, { notify: async text => { if (failures.left > 0) { failures.left -= 1; throw new Error('notify failed') } world.notifications.push(text) } })
  await newProcess(harness)
  await enterPrompt(harness, 'hello')
  const held = world.processState.value as ProcessState
  world.processState.value = { ...held, pendingStarts: [{ id: 'kept-1', start: { kind: 'step', lead: 'Held start.' } }] }
  await tickIdle(harness, 4)
  expect({ failed: failures.left, isAnnounced: world.notifications.some(text => text.includes('its turn has not started')) }).toEqual({ failed: 0, isAnnounced: true })
})

// contract: a tick announces holds from the state its own recovery left, so a start that recovery settled as entered is never announced as held
test('a start recovery settled in the same tick is not announced as held', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await reloadModule(harness)
  const held = world.processState.value as ProcessState
  const owner = held.loadId ?? ''
  world.processState.value = { ...held, pendingStarts: [{ id: 'kept-1', start: { kind: 'step', lead: 'Held start.' } }],
    attempts: [{ id: 'attempt-1', owner, route: 'start', subject: 'kept-1', kind: 'step', label: 'the start', at: world.clock.now(), epoch: held.epoch, status: { kind: 'entered' } }] }
  await tickIdle(harness, 1)
  expect({ kept: ((world.processState.value as ProcessState).pendingStarts ?? []).length, notifications: world.notifications.filter(text => text.includes('start prompt')) })
    .toEqual({ kept: 0, notifications: [] })
})

// group: A reload mid-turn
// contract: a reload in the middle of a turn keeps the turn live: the activity record still holds it and no tick rings unread mail into it; the turn's end releases it, ringing exactly once
test('a reload mid-turn keeps the turn live until its end, which rings the doorbell once', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await reloadModule(harness)
  await callTool(harness)
  seedUnreadMail(world, 6 * minuteMs)
  await tickTimes(harness, 5)
  expect({ isTurn: readIsTurn(world), prompts: world.prompts }).toEqual({ isTurn: true, prompts: [] })
  await completeTurn(harness)
  expect({ isTurn: readIsTurn(world), doorbells: countPrompts(world, doorbell) }).toEqual({ isTurn: false, doorbells: 1 })
  expect(await enterPrompt(harness, doorbell)).toContain('work on it')
  await harness.tick()
  expect(countPrompts(world, doorbell)).toBe(1)
})

for (const isSent of [true, false]) {
  // contract: a turn carried over a reload is never told it sent no message, as the load before it may have seen one sent whose write failed: its Stop asks for none, whether or not it sent one
  test(`a turn that ${isSent ? 'sent a' : 'sent no'} message before a reload is not asked for one at its Stop`, async (_$, on) => {
    const world = arrangeDelegatedChild(on)
    world.files.set(`${records}/mail/1/cur/a1.1.json`, JSON.stringify({ v: 1, id: 'a1', kind: 'assign', from: 'coordinator-coord', to: '1', issue: 1, in_reply_to: '', seq: 1,
      created_at: '2026-11-03T00:00:00.000Z', expects: '', attempt: 1, body: 'merge it', refs: [], author: 'agent' }))
    const harness = createModuleHarness(world)
    await newProcess(harness)
    await startTurn(harness)
    if (isSent) expect((await sendTyped(harness.port, { kind: 'done', body: 'merged', in_reply_to: 'a1' })).isOk).toBe(true)
    await reloadModule(harness)
    expect((await stop(harness)).includes(noMessage)).toBe(false)
  })
}

// contract: a start kept while the session was busy outlives a reload: no prompt is submitted into the turn, its Stop carries none, and the turn's end delivers it once
test('a start kept while busy outlives a reload and is delivered once the turn ends, never mid-turn', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  expect((await runApproveStep(harness.port, diagnosisComment.url)).isOk).toBe(true)
  await world.clock.settle()
  await reloadModule(harness)
  await tickTimes(harness, 2)
  expect(countPrompts(world, 'Diagnosis approved')).toBe(0)
  expect(await stop(harness)).not.toContain('Diagnosis approved')
  await completeTurn(harness)
  expect(countPrompts(world, `Diagnosis approved: ${diagnosisComment.url}`)).toBe(1)
})

// contract: an approval of the Verify config a delegated unit waited on, given before a reload the old module had not followed up, still wakes the unit once, once the new module hears a turn of its own
test('an approval given before a reload still wakes the waiting unit once', async (_$, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  seedDelegation(world, 'coord', [1])
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await reread(harness.port, true)
  world.approveConfig(verifyFile)
  await reloadModule(harness)
  await hearTurn(harness)
  await reread(harness.port, true)
  await world.clock.settle()
  await reread(harness.port, true)
  await world.clock.settle()
  expect(countPrompts(world, wake)).toBe(1)
})

// group: Registration
// contract: a registration of the mod's tools that settles after its bound, once a turn started, leaves the activity record showing the turn
test('a registration that settles late, after a turn started, leaves the turn recorded', async (_$, on) => {
  const world = arrangeUnit(on)
  const gate: { open: () => void } = { open: () => {} }
  const registered = new Promise<void>(resolve => { gate.open = resolve })
  const harness = createModuleHarness(world, { registerSurface: () => registered })
  const started = newProcess(harness)
  await world.clock.advance(registrationBoundMs)
  await started
  await startTurn(harness)
  gate.open()
  await world.clock.settle()
  expect(readIsTurn(world)).toBe(true)
})

// group: A new process
// contract: a new process holds no turn, so a turn its predecessor left recorded as running is recorded idle and unread mail rings
test('a new process records a turn its predecessor left running as idle', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await newProcess(harness)
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  expect({ isTurn: readIsTurn(world), doorbells: countPrompts(world, doorbell) }).toEqual({ isTurn: false, doorbells: 1 })
})

// contract: the one reload from a version that kept no process state carries the turn it recorded for this very process, until any turn end
test('a reload from a module that kept no process state carries its recorded turn until the turn ends', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  world.processState.value = undefined
  // why: a version that kept no process state wrote a record with no epoch and no turn id.
  world.files.set(`${records}/activity/${unitSession}.json`, JSON.stringify({ v: 1, isTurn: true, at: world.clock.now(), isDialog: false }))
  await reloadModule(harness)
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  expect({ isTurn: readIsTurn(world), doorbells: countPrompts(world, doorbell) }).toEqual({ isTurn: true, doorbells: 0 })
  await completeTurn(harness, 'unknown-to-the-new-module')
  expect({ isTurn: readIsTurn(world), doorbells: countPrompts(world, doorbell) }).toEqual({ isTurn: false, doorbells: 1 })
})

// group: What proves a turn
// contract: tool events of a subagent in an idle session prove no turn: the session stays idle and unread mail rings
test('a subagent\'s tool events in an idle session leave it idle', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await callTool(harness, { agentId: 'sub' })
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  expect({ isTurn: readIsTurn(world) ?? false, doorbells: countPrompts(world, doorbell) }).toEqual({ isTurn: false, doorbells: 1 })
})

// contract: a tool event from a hook still running after an interrupted turn ended proves no turn, so the session stays idle
test('a tool event after an interrupted turn ended leaves the session idle', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await completeTurn(harness, 't1', true)
  await callTool(harness)
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  expect({ isTurn: readIsTurn(world), doorbells: countPrompts(world, doorbell) }).toEqual({ isTurn: false, doorbells: 1 })
})

// group: Two modules at once
// contract: a turn end the replaced module hears after the new module started, between the Stop and the end, releases the turn the new module reads; the new module rings only once it hears a turn of its own, as the replaced module may have heard more it never recorded
test('a turn end only the replaced module hears releases the turn for the new module', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await reloadModule(harness)
  await harness.asOldModule(() => completeTurn(harness))
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  const held = { isTurn: readIsTurn(world), doorbells: countPrompts(world, doorbell) }
  await hearTurn(harness)
  expect({ held, doorbells: countPrompts(world, doorbell) }).toEqual({ held: { isTurn: false, doorbells: 0 }, doorbells: 1 })
})

// contract: a turn end that names another turn, as a stale one does, leaves the running turn live
test('a turn end naming another turn leaves the running turn live', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness, 't2')
  await completeTurn(harness, 't1')
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  expect({ isTurn: readIsTurn(world), doorbells: countPrompts(world, doorbell) }).toEqual({ isTurn: true, doorbells: 0 })
})

// group: Module state a reload starts over
// contract: a handoff running when the mod reloads loses its arming, so the new module marks it failed, naming the reload, and a later turn end neither clears nor continues
test('a handoff running at a reload is marked failed, and the next turn end leaves it alone', async (_$, on) => {
  const world = createWorld(on, { branch: 'feat', isDirty: true })
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startHandoff(createFeaturePort(harness.port))
  await world.clock.settle()
  await reloadModule(harness)
  expect((await readSession(harness.port)).handoff).toEqual({ state: 'failed', reason: reloadFailure })
  await startTurn(harness)
  await completeTurn(harness)
  expect(world.commands).toEqual(['handoff'])
})

// contract: a handoff running when the session's previous process ended is marked failed for that cause, never for a reload
test('a handoff running when the previous process ended is marked failed for that cause', async (_$, on) => {
  const world = createWorld(on, { branch: 'feat', isDirty: true })
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startHandoff(createFeaturePort(harness.port))
  await world.clock.settle()
  await newProcess(harness)
  expect((await readSession(harness.port)).handoff).toEqual({ state: 'failed', reason: processFailure })
})

// contract: once the new module marked a running handoff failed, the replaced module's own end of the /handoff turn carries nothing on
test('the replaced module ends no handoff the new module already marked failed', async (_$, on) => {
  const world = createWorld(on, { branch: 'feat', isDirty: true })
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startHandoff(createFeaturePort(harness.port))
  await world.clock.settle()
  await startTurn(harness)
  await recordHandoffDocument(createFeaturePort(harness.port), 'Write', '/tmp/handoff.md', false)
  await reloadModule(harness)
  await harness.asOldModule(async () => {
    endHandoffTurn('answer')
    await world.clock.settle()
  })
  await world.clock.settle()
  expect({ commands: world.commands, handoff: (await readSession(harness.port)).handoff }).toEqual({ commands: ['handoff'], handoff: { state: 'failed', reason: reloadFailure } })
})

// group: Interleavings of two dispatches
// contract: a tool call an interrupt abandoned, whose end comes after its turn's end, leaves the session recorded idle, and unread mail rings
test('a tool call whose end comes after its interrupted turn ended leaves the session recorded idle', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await callTool(harness, { during: () => completeTurn(harness, 't1', true) })
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  expect({ isTurn: readIsTurn(world), doorbells: countPrompts(world, doorbell) }).toEqual({ isTurn: false, doorbells: 1 })
})

// contract: a new module's start that read a running turn, landing after the replaced module recorded that turn's end, never records the turn again
test('a start that read a running turn lands after the replaced module recorded its end, and records no turn', async (_$, on) => {
  const world = arrangeUnit(on)
  const held = { isArmed: false, gate: createGate(), reached: createGate() }
  const harness = createModuleHarness(world, {
    readProcessState: async () => {
      // why: the dispatch reads one moment, so the value is taken before the hold, as the engine's snapshot would be.
      const value = world.processState.value
      if (held.isArmed) {
        held.isArmed = false
        held.reached.open()
        await held.gate.promise
      }
      return value
    },
  })
  await newProcess(harness)
  await startTurn(harness)
  held.isArmed = true
  const started = reloadModule(harness)
  await held.reached.promise
  await harness.asOldModule(() => completeTurn(harness))
  held.gate.open()
  await started
  expect(readIsTurn(world)).toBe(false)
})

// contract: two module loads that allocate a temporary record path in the same millisecond at the same sequence still get different paths
test('two module loads allocating a temporary path in the same millisecond get different paths', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await reloadModule(harness)
  const old = readSequence(await allocate(harness, true))
  const fresh = readSequence(await allocate(harness, false))
  await allocateTimes(harness, true, Math.max(old, fresh) - old)
  await allocateTimes(harness, false, Math.max(old, fresh) - fresh)
  const paths = [await allocate(harness, true), await allocate(harness, false)]
  expect(readSequence(paths[0]!)).toBe(readSequence(paths[1]!))
  expect(paths[0]).not.toBe(paths[1])
})

// contract: two dispatches that follow the same approval at once wake the unit once
test('two dispatches following one approval at once wake the unit once', async (_$, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  seedDelegation(world, 'coord', [1])
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await reread(harness.port, true)
  world.approveConfig(verifyFile)
  const position = await locatePosition(createReadPort(harness.port), await readSession(harness.port))
  await Promise.all([followApproval(harness.port, position, true), followApproval(harness.port, position, true)])
  await world.clock.settle()
  expect(countPrompts(world, wake)).toBe(1)
})

// contract: a wake recorded just before a reload, whose deferred submit the reload cancelled, is still submitted once by the new module
test('a wake whose deferred submit a reload cancelled is submitted once by the new module', async (_$, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  seedDelegation(world, 'coord', [1])
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const harness = createModuleHarness(world, { defer: work => { if (timers.isHeld) timers.queue.push(work); else work() } })
  await newProcess(harness)
  await reread(harness.port, true)
  world.approveConfig(verifyFile)
  timers.isHeld = true
  await reread(harness.port, true)
  timers.queue.length = 0
  timers.isHeld = false
  await reloadModule(harness)
  await hearTurn(harness)
  await reread(harness.port, true)
  await world.clock.settle()
  await reread(harness.port, true)
  await world.clock.settle()
  expect(countPrompts(world, wake)).toBe(1)
})

// group: Unknown process state
// contract: a process state of a shape this module does not know is unknown: never overwritten, never taken for idle, so no doorbell rings and the record is left as it is
test('a process state of an unknown shape is left as it is and never taken for idle', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  const foreign = { shape: 'v9', running: 't1' }
  world.processState.value = foreign
  await reloadModule(harness)
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  await completeTurn(harness)
  expect({ state: world.processState.value, isTurn: readIsTurn(world), doorbells: countPrompts(world, doorbell) }).toEqual({ state: foreign, isTurn: false, doorbells: 0 })
})

// group: What the pane shows of a fault
// contract: a process state the mod cannot use is shown on the pane, naming the cause and that the session is treated as busy, and the row clears once a read succeeds
test('a process state the mod cannot use is shown on the pane until a read succeeds', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  world.processState.value = { shape: 'v9' }
  await reread(harness.port, true)
  const row = world.views.at(-1)?.notes.find(note => note.key === 'Process')
  expect(row?.value).toContain('a value of a shape this module does not know')
  expect(row?.value).toContain('treats this session as busy')
  world.processState.value = undefined
  await reread(harness.port, true)
  expect((world.views.at(-1)?.notes ?? []).some(note => note.key === 'Process')).toBe(false)
})

// contract: a claimed wake not yet submitted is shown on the pane, saying it waits and that each refresh tries it again
test('a claimed wake not yet submitted is shown on the pane', async (_$, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  seedDelegation(world, 'coord', [1])
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const harness = createModuleHarness(world, { defer: work => { if (timers.isHeld) timers.queue.push(work); else work() } })
  await newProcess(harness)
  await reread(harness.port, true)
  world.approveConfig(verifyFile)
  timers.isHeld = true
  await reread(harness.port, true)
  await reread(harness.port, true)
  const row = world.views.at(-1)?.notes.find(note => note.key === 'Approve')
  expect(row?.value).toContain('the wake prompt is not delivered yet')
  expect(row?.value).toContain('tried again at each refresh')
})

// contract: the turn end's request for a message is made once per state, and a reload between two Stops of that state does not make it again
test('a turn end asked once for a message is not asked again after a reload', async (_$, on) => {
  const world = arrangeDelegatedChild(on)
  world.files.set(`${records}/mail/1/cur/a1.1.json`, JSON.stringify({ v: 1, id: 'a1', kind: 'assign', from: 'coordinator-coord', to: '1', issue: 1, in_reply_to: '', seq: 1,
    created_at: '2026-11-03T00:00:00.000Z', expects: '', attempt: 1, body: 'do it', refs: [], author: 'agent' }))
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  expect(await stop(harness)).toContain(noMessage)
  await reloadModule(harness)
  expect(await stop(harness)).not.toContain(noMessage)
})

// group: The fix-first review of the upgrade and the races
// contract: after the reload from a version whose activity record holds no epoch, a tool event in the carried turn still moves the record's time
test('a tool event after the upgrade reload moves the time of an activity record that held no epoch', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  world.files.set(`${records}/activity/${unitSession}.json`, JSON.stringify({ v: 1, isTurn: true, at: world.clock.now(), isDialog: false }))
  world.processState.value = undefined
  await reloadModule(harness)
  const before = readActivityRecord(world)?.at ?? 0
  await world.clock.advance(2 * minuteMs)
  await callTool(harness)
  expect(readActivityRecord(world)?.at).toBeGreaterThan(before)
})

// contract: a tool event's write, read before a turn end that lands first, never puts the ended turn back in the activity record
test('a tool event whose record read precedes the turn end never writes the ended turn back', async (_$, on) => {
  const world = arrangeUnit(on)
  const path = `${records}/activity/${unitSession}.json`
  const held = { isArmed: false, gate: createGate(), reached: createGate() }
  const harness = createModuleHarness(world, {
    files: { ...world.boundaries.files, read: async file => {
      const text = await world.boundaries.files.read(file)
      if (held.isArmed && file === path) {
        held.isArmed = false
        held.reached.open()
        await held.gate.promise
      }
      return text
    } },
  })
  await newProcess(harness)
  await startTurn(harness)
  await world.clock.advance(2 * minuteMs)
  const seen = await readProcessState(harness.port)
  held.isArmed = true
  const tool = recordActivity(harness.port, 'tool', seen)
  await held.reached.promise
  const ended = completeTurn(harness)
  await world.clock.settle()
  held.gate.open()
  await Promise.all([tool, ended])
  expect(readActivityRecord(world)?.isTurn).toBe(false)
})

// contract: the replaced module's mirror of an older snapshot never lands over the new module's newer mirror
test('the replaced module never mirrors an older session record over a newer one', async (_$, on) => {
  const world = arrangeUnit(on)
  const older = { snapshot: null as Awaited<ReturnType<EnginePort['readSessionState']>> | null }
  const harness = createModuleHarness(world, { readSessionState: async () => older.snapshot ?? world.directSessionState.readSessionState() })
  await newProcess(harness)
  await reloadModule(harness)
  const path = `${records}/s/${unitSession}.json`
  const before = await harness.port.readSessionState()
  await updateSession(harness.port, session => ({ ...session, isLong: true }))
  const newer = world.files.get(path)
  older.snapshot = before
  await harness.asOldModule(() => mirrorSession(harness.port, false))
  older.snapshot = null
  expect(world.files.get(path)).toBe(newer)
})

// contract: a mirror publish that holds no generation yet, as one before the adoption seeded the process state, never lands over a fenced mirror, and a session write then still succeeds
test('a mirror publish before the process state holds a generation never lands over a fenced mirror', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  const path = `${records}/s/${unitSession}.json`
  const before = await harness.port.readSessionState()
  await updateSession(harness.port, session => ({ ...session, isLong: true }))
  const newer = world.files.get(path)
  // why: a load still starting holds its adoption open, as the one whose session start read the state absent did.
  openAdoption()
  await mirrorSession({ ...harness.port, readProcessState: async () => undefined, readSessionState: async () => before }, false).catch(() => null)
  expect(world.files.get(path)).toBe(newer)
  const absent = { ...harness.port, readProcessState: async () => undefined }
  expect((await updateSession(absent, session => ({ ...session, isLong: false })))?.kind).toBe('written')
})

// contract: a registration whose bound wait a reload cancelled is not taken as registered: its own answer decides, a late failure included
test('a registration whose bound a reload cancelled waits for its own answer, and its late failure is shown', async (_$, on) => {
  const world = arrangeUnit(on)
  const gate: { reject: (error: Error) => void } = { reject: () => {} }
  const registered = new Promise<void>((_resolve, reject) => { gate.reject = reject })
  const base = createTestPort(world)
  const harness = createModuleHarness(world, { registerSurface: () => registered,
    clock: { sleep: (delayMs, signal) => delayMs === registrationBoundMs ? Promise.reject(new Error('the wait was cancelled: its module was replaced')) : base.clock.sleep(delayMs, signal) } })
  const started = newProcess(harness)
  await world.clock.settle()
  expect(sessionMemory.isSurfaceRegistered).toBe(false)
  gate.reject(new Error('registry closed'))
  await started
  await world.clock.settle()
  expect(readFault('tools')).toContain('registry closed')
  expect(sessionMemory.isSurfaceRegistered).toBe(false)
})

// contract: a start kept for a turn whose end's deferred submit a reload cancelled is still submitted once by the new module, once it hears a turn of its own
test('a kept start whose deferred submit a reload cancelled is submitted once by the new module', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const harness = createModuleHarness(world, { defer: work => { if (timers.isHeld) timers.queue.push(work); else work() } })
  await newProcess(harness)
  await startTurn(harness)
  expect((await runApproveStep(harness.port, diagnosisComment.url)).isOk).toBe(true)
  await world.clock.settle()
  timers.isHeld = true
  await completeTurn(harness)
  timers.queue.length = 0
  timers.isHeld = false
  await reloadModule(harness)
  await hearTurn(harness)
  await harness.tick()
  await harness.tick()
  expect(countPrompts(world, 'Diagnosis approved')).toBe(1)
})

// contract: a kept start whose submit the engine refuses stays kept, the pane names the refusal, and a later tick submits it once
test('a kept start whose submit is refused stays kept, is shown on the pane, and is submitted once later', async (_$, on) => {
  const world = arrangeApproval(on)
  const refusal = { isOn: false }
  const harness = createModuleHarness(world, { submitPrompt: async text => { if (refusal.isOn) throw new DroppedPromptError('queue full'); world.prompts.push(text) } })
  await newProcess(harness)
  await startTurn(harness)
  expect((await runApproveStep(harness.port, diagnosisComment.url)).isOk).toBe(true)
  await world.clock.settle()
  refusal.isOn = true
  await completeTurn(harness)
  await reread(harness.port, true)
  expect(world.views.at(-1)?.notes.find(note => note.key === 'Start')?.value).toContain('queue full')
  refusal.isOn = false
  await harness.tick()
  await harness.tick()
  expect(countPrompts(world, 'Diagnosis approved')).toBe(1)
})

// contract: a wake whose submit the engine refuses stays claimed and pending, even when a write fails meanwhile, and a later refresh submits it once
test('a refused wake stays pending through a failed write and is submitted once later', async (_$, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  seedDelegation(world, 'coord', [1])
  const faults = { isRefused: false, failedWrites: 0 }
  const harness = faultyHost(world, { failWrite: () => faults.failedWrites > 0 && faults.failedWrites-- > 0 }, {
    submitPrompt: async text => {
      if (faults.isRefused) { faults.failedWrites = 1; throw new DroppedPromptError('queue full') }
      world.prompts.push(text)
    },
  })
  await newProcess(harness)
  await reread(harness.port, true)
  world.approveConfig(verifyFile)
  faults.isRefused = true
  await reread(harness.port, true)
  faults.isRefused = false
  faults.failedWrites = 0
  await reread(harness.port, true)
  await world.clock.settle()
  // why: the dropped wake's claim of the idle window could not be released with its failed write, so it holds the session for one tick.
  await tickIdle(harness, 1)
  await reread(harness.port, true)
  await world.clock.settle()
  expect(countPrompts(world, wake)).toBe(1)
})

// contract: a process state of this shape name that lacks a field this module needs is unknown: never taken for idle, never overwritten
test('a process state missing a field is read as unknown and left as it is', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  const partial = { shape: 'v1', turn: { id: 't1', hasSent: false, isInformOnly: false, isEmptyDoorbell: false }, prompt: null, pendingStart: null,
    verifyAskedBlob: null, approvalWait: null, wokenBlobs: [] }
  world.processState.value = partial
  await reloadModule(harness)
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  await startTurn(harness, 't2')
  expect({ state: world.processState.value, doorbells: countPrompts(world, doorbell) }).toEqual({ state: partial, doorbells: 0 })
})

// contract: a turn start whose process state write failed keeps the session busy until a write succeeds, however a later read reads, and the pane says so
test('a failed turn start write keeps the session busy until a write succeeds', async (_$, on) => {
  const world = arrangeUnit(on)
  const faults = { failedWrites: 0 }
  const harness = faultyHost(world, { failWrite: () => faults.failedWrites > 0 && faults.failedWrites-- > 0 })
  await newProcess(harness)
  faults.failedWrites = 1
  await startTurn(harness)
  await reread(harness.port, true)
  const row = world.views.at(-1)?.notes.find(note => note.key === 'Process')?.value ?? ''
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  expect({ doorbells: countPrompts(world, doorbell), row }).toEqual({ doorbells: 0, row: expect.stringContaining('host busy') })
})

// contract: two module loads that open a Verify hold in the same millisecond at the same sequence name different holds
test('two module loads opening a Verify hold in the same millisecond name different holds', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await reloadModule(harness)
  const hold = async (): Promise<string> => {
    const held = await withVerifyTurn(harness.port, common, unitSession, async turn => turn.id,
      { call: 'verify', deadline: world.clock.now() + minuteMs, signal: new AbortController().signal, onMove: async () => {} })
    return held.kind === 'done' ? held.value : held.kind
  }
  const ids = [await harness.asOldModule(hold), await hold()]
  expect(ids[0]).not.toBe(ids[1])
})

// group: Second fix-first review: starts, faults and wording
// contract: a start a command kept is saved before its delivery is deferred, so a reload that cancels the delivery still leaves it delivered once
test('a start kept by a command whose deferred delivery a reload cancelled is delivered once', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const harness = createModuleHarness(world, { defer: work => { if (timers.isHeld) timers.queue.push(work); else work() } })
  await newProcess(harness)
  timers.isHeld = true
  expect((await runApproveStep(harness.port, diagnosisComment.url)).isOk).toBe(true)
  timers.queue.length = 0
  timers.isHeld = false
  await reloadModule(harness)
  await hearTurn(harness)
  await harness.tick()
  await harness.tick()
  expect(countPrompts(world, 'Diagnosis approved')).toBe(1)
})

// contract: a start the engine dropped whose receipt could not be written holds the session, named on the hold row as an answer recorded again, and once the tick records it the start is delivered once
test('a dropped start whose receipt write failed is delivered once after the tick records it', async (_$, on) => {
  const world = arrangeApproval(on)
  const faults = { isRefused: false, failedWrites: 0 }
  const harness = faultyHost(world, { failWrite: () => faults.failedWrites > 0 && faults.failedWrites-- > 0 }, {
    submitPrompt: async text => { if (faults.isRefused) { faults.failedWrites = 1; throw new DroppedPromptError('queue full') } world.prompts.push(text) },
  })
  await newProcess(harness)
  await startTurn(harness)
  expect((await runApproveStep(harness.port, diagnosisComment.url)).isOk).toBe(true)
  await world.clock.settle()
  faults.isRefused = true
  await completeTurn(harness)
  faults.isRefused = false
  await reread(harness.port, true)
  const isNamed = (world.views.at(-1)?.notes ?? []).some(note => note.key === 'Process' && note.value.includes('recording that answer in the process state failed'))
  await tickIdle(harness, 3)
  expect({ isNamed, delivered: countPrompts(world, 'Diagnosis approved') }).toEqual({ isNamed: true, delivered: 1 })
})

// contract: a start the engine dropped is named as not entered on its Start row, stays first in line, and is submitted again once the session is idle; the row clears once it entered
test('a dropped start is submitted again once idle, and its Start row clears once it entered', async (_$, on) => {
  const world = arrangeApproval(on)
  const refusal = { isOn: false }
  const harness = createModuleHarness(world, { submitPrompt: async text => { if (refusal.isOn) throw new DroppedPromptError('queue full'); world.prompts.push(text) } })
  await newProcess(harness)
  await startTurn(harness)
  expect((await runApproveStep(harness.port, diagnosisComment.url)).isOk).toBe(true)
  await world.clock.settle()
  refusal.isOn = true
  await completeTurn(harness)
  refusal.isOn = false
  await reread(harness.port, true)
  const before = (world.views.at(-1)?.notes ?? []).some(note => note.key === 'Start' && note.value.includes('the engine dropped it'))
  await tickIdle(harness, 2)
  await reread(harness.port, true)
  expect({ before, delivered: countPrompts(world, 'Diagnosis approved'), after: (world.views.at(-1)?.notes ?? []).some(note => note.key === 'Start') })
    .toEqual({ before: true, delivered: 1, after: false })
})

// contract: a turn start the process state could not record keeps the session busy across a reload, so no doorbell rings into that turn
test('a turn start the process state could not record keeps the session busy across a reload', async (_$, on) => {
  const world = arrangeUnit(on)
  const faults = { failedWrites: 0 }
  const harness = faultyHost(world, { failWrite: () => faults.failedWrites > 0 && faults.failedWrites-- > 0 })
  await newProcess(harness)
  faults.failedWrites = 1
  await startTurn(harness)
  await reloadModule(harness)
  seedUnreadMail(world, 6 * minuteMs)
  await harness.tick()
  await harness.tick()
  expect(countPrompts(world, doorbell)).toBe(0)
})

// contract: an entering prompt whose write failed holds the session until its turn starts, never for a set time; one whose turn never starts becomes a hold the pane names, which a prompt the user types ends
test('an entering prompt whose write failed holds the session until a turn starts, named on the pane, and a typed prompt ends the hold', async (_$, on) => {
  const world = arrangeUnit(on)
  const faults = { failedWrites: 0 }
  const harness = faultyHost(world, { failWrite: () => faults.failedWrites > 0 && faults.failedWrites-- > 0 })
  await newProcess(harness)
  faults.failedWrites = 1
  await enterPrompt(harness, 'hello')
  seedUnreadMail(world, 6 * minuteMs)
  await tickIdle(harness, 3)
  await reread(harness.port, true)
  const held = { doorbells: countPrompts(world, doorbell), isNamed: (world.views.at(-1)?.notes ?? []).some(note => note.key === 'Process' && note.value.includes('its turn has not started')) }
  await enterPrompt(harness, 'typed by the user')
  await startTurn(harness)
  await completeTurn(harness)
  expect({ held, isHeld: (world.views.at(-1)?.notes ?? []).some(note => note.value.includes('its turn has not started')) }).toEqual({ held: { doorbells: 0, isNamed: true }, isHeld: false })
})

// contract: a wake this load saw delivered whose answer could not be written is never submitted again, and once the answer is written its wait ends
test('a delivered wake whose answer write failed is submitted once and its wait ends once written', async (_$, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  seedDelegation(world, 'coord', [1])
  const faults = { failedWrites: 0, isArmed: false }
  const harness = faultyHost(world, { failWrite: () => faults.failedWrites > 0 && faults.failedWrites-- > 0 }, {
    submitPrompt: async text => { world.prompts.push(text); if (faults.isArmed && text.includes(wake)) faults.failedWrites = 1 },
  })
  await newProcess(harness)
  await reread(harness.port, true)
  world.approveConfig(verifyFile)
  faults.isArmed = true
  await reread(harness.port, true)
  await world.clock.settle()
  faults.isArmed = false
  await reread(harness.port, true)
  const during = (world.views.at(-1)?.notes ?? []).find(note => note.key === 'Approve')?.value ?? ''
  await tickIdle(harness, 2)
  await reread(harness.port, true)
  await world.clock.settle()
  expect({ wakes: countPrompts(world, wake), isUndelivered: during.includes('not delivered yet'), isWaiting: (world.views.at(-1)?.notes ?? []).some(note => note.key === 'Approve') })
    .toEqual({ wakes: 1, isUndelivered: false, isWaiting: false })
})

// contract: a process state of a shape this module does not know is shown as cleared only by a restart of the session, which discards any start prompts still waiting, never by a later read
test('a process state of an unknown shape is shown as needing a new process', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  world.processState.value = { shape: 'v9' }
  await reread(harness.port, true)
  const row = world.views.at(-1)?.notes.find(note => note.key === 'Process')?.value ?? ''
  expect({ isRestart: row.includes('restarting the session clears this and discards any start prompts still waiting; start the current step by hand afterwards (/flow status names it)'),
    isRerun: row.includes('run their commands again'), isRead: row.includes('until a read succeeds') })
    .toEqual({ isRestart: true, isRerun: false, isRead: false })
})

// group: The session's publish lock
// contract: while another hold of its publish lock outlasts the deadline, an activity publish writes nothing and the pane says it waited, naming every holder it may be, this load's own earlier publish included; once the hold ends, a tick publishes it and the row clears
test('an activity publish held past its deadline by another load writes nothing until a tick after the hold ends', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  const ticket = world.hostLocks.seed(publishLockPath(common, unitSession), `${unitSession}/publish-another-load`)
  const ended = completeTurn(harness)
  await advanceBy(world, 6, 10000)
  await ended
  await reread(harness.port, true)
  const row = world.views.at(-1)?.notes.find(note => note.key === 'Process' && note.value.includes('/activity/'))?.value ?? ''
  expect({ isTurn: readActivityRecord(world)?.isTurn, isWaited: row.includes('waited'), isHeld: row.includes('another load of this session'), isSelf: row.includes('an earlier publish of this load') })
    .toEqual({ isTurn: true, isWaited: true, isHeld: true, isSelf: true })
  world.hostLocks.end(publishLockPath(common, unitSession), ticket)
  await harness.tick()
  await reread(harness.port, true)
  expect({ isTurn: readActivityRecord(world)?.isTurn, rows: (world.views.at(-1)?.notes ?? []).filter(note => note.key === 'Process').length })
    .toEqual({ isTurn: false, rows: 0 })
})

// contract: while another load of the session holds its publish lock past the deadline, a mirror publish writes nothing and its caller is told it waited; once the hold ends, a tick publishes the newer record
test('a mirror publish held past its deadline by another load writes nothing until a tick after the hold ends', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  const path = `${records}/s/${unitSession}.json`
  const before = world.files.get(path)
  const ticket = world.hostLocks.seed(publishLockPath(common, unitSession), `${unitSession}/publish-another-load`)
  const written = updateSession(harness.port, session => ({ ...session, isLong: true })).then(result => result?.kind === 'unmirrored' ? result.error : '')
  await advanceBy(world, 6, 10000)
  expect((await written).includes('waited')).toBe(true)
  expect(world.files.get(path)).toBe(before)
  world.hostLocks.end(publishLockPath(common, unitSession), ticket)
  await harness.tick()
  expect(JSON.parse(world.files.get(path) ?? '{}')).toMatchObject({ isLong: true })
})

// contract: a publish whose hold ends before its rename, as its holder process does, renames nothing, and the pane says the hold was lost
test('a publish whose hold is lost before its rename renames nothing', async (_$, on) => {
  const world = arrangeUnit(on)
  const path = `${records}/activity/${unitSession}.json`
  const held = { isArmed: false, gate: createGate(), reached: createGate() }
  const harness = createModuleHarness(world, {
    files: { ...world.boundaries.files, read: async file => {
      const text = await world.boundaries.files.read(file)
      if (held.isArmed && file === path) {
        held.isArmed = false
        held.reached.open()
        await held.gate.promise
      }
      return text
    } },
  })
  await newProcess(harness)
  await startTurn(harness)
  held.isArmed = true
  const ended = completeTurn(harness)
  await held.reached.promise
  expect(world.hostLocks.kill(publishLockPath(common, unitSession), `${unitSession}/publish-`)).toBe(true)
  await world.clock.settle()
  held.gate.open()
  await ended
  await reread(harness.port, true)
  expect({ isTurn: readActivityRecord(world)?.isTurn, isLost: (world.views.at(-1)?.notes ?? []).some(note => note.key === 'Process' && note.value.includes('lost')) })
    .toEqual({ isTurn: true, isLost: true })
})

// contract: every session publishes under one of 16 fixed stripe locks, so the lock files stay bounded; a hold on another stripe never delays a publish, while a hold on the session's own stripe does
test('a publish waits only on its own stripe of the 16 fixed publish locks', async (_$, on) => {
  const stripes = new Set(Array.from({ length: 200 }, (_, index) => publishLockPath(common, `session-${index}`)))
  const other = Array.from({ length: 64 }, (_, index) => `other-${index}`).find(id => publishLockPath(common, id) !== publishLockPath(common, unitSession)) ?? ''
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  const foreign = world.hostLocks.seed(publishLockPath(common, other), `${other}/publish-another-session`)
  await completeTurn(harness)
  const isFreeAcross = readActivityRecord(world)?.isTurn === false
  world.hostLocks.end(publishLockPath(common, other), foreign)
  await startTurn(harness)
  const own = world.hostLocks.seed(publishLockPath(common, unitSession), `${unitSession}/publish-another-load`)
  const ended = completeTurn(harness)
  await advanceBy(world, 6, 10000)
  await ended
  const isHeldWithin = readActivityRecord(world)?.isTurn === true
  world.hostLocks.end(publishLockPath(common, unitSession), own)
  expect({ isBounded: stripes.size <= 16 && [...stripes].every(path => /\/locks\/publish-([0-9]|1[0-5])$/.test(path)), isFreeAcross, isHeldWithin })
    .toEqual({ isBounded: true, isFreeAcross: true, isHeldWithin: true })
})

// contract: a session write whose mirror publish fails under the publish lock is told to its caller as landed but unmirrored, with the write's error, and the pane shows the failed write, never a lock it could not take
test('a mirror write that fails under the publish lock is told to its caller as unmirrored, and on the pane', async (_$, on) => {
  const options: Parameters<typeof createWorld>[2] = { session: coordinator, herdrEnv: inside, herdrReply: () => '{}' }
  const world = createWorld(on, { branch: 'main' }, options)
  markSpawned(world, [12], unitSession)
  world.seedChat(unitSession, createEmptySession(unitSession))
  world.chat.id = unitSession
  const harness = createModuleHarness(world)
  await newProcess(harness)
  options.renameFails = target => target === `${records}/s/${unitSession}.json`
  const written = await updateSession(harness.port, session => ({ ...session, isLong: true }))
  await reread(harness.port, true)
  const row = world.views.at(-1)?.notes.find(note => note.key === 'Process' && note.value.includes(`/s/${unitSession}.json`))?.value ?? ''
  expect({ told: written?.kind === 'unmirrored' && written.error.includes('rename failed'), isWrite: row.includes('failed under its publish lock'), isTake: row.includes('could not take') })
    .toEqual({ told: true, isWrite: true, isTake: false })
})

// contract: a wake whose submit answered before a reload while its answer could not be written is never submitted again by the new load, and its wait ends once the answer is written
test('a submitted wake whose answer was not written before a reload is not submitted again by the new load', async (_$, on) => {
  const world = createWorld(on, buildChanged(), { verifyFile })
  seedDelegation(world, 'coord', [1])
  const faults = { failedWrites: 0, isArmed: false }
  const harness = faultyHost(world, { failWrite: () => faults.failedWrites > 0 && faults.failedWrites-- > 0 }, {
    submitPrompt: async text => { world.prompts.push(text); if (faults.isArmed && text.includes(wake)) faults.failedWrites = 1 },
  })
  await newProcess(harness)
  await reread(harness.port, true)
  world.approveConfig(verifyFile)
  faults.isArmed = true
  await reread(harness.port, true)
  await world.clock.settle()
  faults.isArmed = false
  faults.failedWrites = 99
  await reloadModule(harness)
  await reread(harness.port, true)
  await world.clock.settle()
  await reread(harness.port, true)
  const row = world.views.at(-1)?.notes.find(note => note.key === 'Approve')?.value ?? ''
  const during = { wakes: countPrompts(world, wake), isUndelivered: row.includes('not delivered yet') }
  faults.failedWrites = 0
  await tickIdle(harness, 3)
  await reread(harness.port, true)
  await world.clock.settle()
  expect({ during, wakes: countPrompts(world, wake), isWaiting: (world.views.at(-1)?.notes ?? []).some(note => note.key === 'Approve') })
    .toEqual({ during: { wakes: 1, isUndelivered: false }, wakes: 1, isWaiting: false })
})

// contract: a start a tick already took and submitted is never submitted again by the command's own deferred delivery
test('a kept start the tick delivered first is not submitted again by the command\'s deferred delivery', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const harness = createModuleHarness(world, { defer: work => { if (timers.isHeld) timers.queue.push(work); else work() } })
  await newProcess(harness)
  timers.isHeld = true
  expect((await runApproveStep(harness.port, diagnosisComment.url)).isOk).toBe(true)
  const own = timers.queue.splice(0)
  timers.isHeld = false
  await harness.tick()
  for (const work of own) work()
  await world.clock.settle()
  expect(countPrompts(world, 'Diagnosis approved')).toBe(1)
})

// contract: (pin, not a red: the behaviour was already right) a publish that renamed the revision beside the mirror but failed to rename the mirror leaves the fence ahead, and the next tick still writes the mirror
test('a mirror whose rename failed after its revision was renamed is written by the next tick', async (_$, on) => {
  const options: Parameters<typeof createWorld>[2] = { session: coordinator, herdrEnv: inside, herdrReply: () => '{}' }
  const world = createWorld(on, { branch: 'main' }, options)
  markSpawned(world, [12], unitSession)
  world.seedChat(unitSession, createEmptySession(unitSession))
  world.chat.id = unitSession
  const harness = createModuleHarness(world)
  await newProcess(harness)
  const path = `${records}/s/${unitSession}.json`
  const revision = `${records}/s/${unitSession}.rev`
  options.renameFails = target => target === path
  await updateSession(harness.port, session => ({ ...session, isLong: true })).catch(() => undefined)
  const fence = world.files.get(revision)
  const isStale = !(JSON.parse(world.files.get(path) ?? '{}') as { isLong?: boolean }).isLong
  options.renameFails = undefined
  await harness.tick()
  expect({ isFenced: !!fence && fence === world.files.get(revision), isStale, isLong: (JSON.parse(world.files.get(path) ?? '{}') as { isLong?: boolean }).isLong })
    .toEqual({ isFenced: true, isStale: true, isLong: true })
})

// contract: (pin, not a red: the behaviour was already right) a publish whose publish lock cannot be taken, as when its host lock fails, writes nothing and says it could not take the lock, never that the lock was free
test('a publish whose lock cannot be taken writes nothing and says so', async (_$, on) => {
  const fault = { isArmed: false }
  const options: Parameters<typeof createWorld>[2] = { session: coordinator, herdrEnv: inside, herdrReply: () => '{}',
    beforeRun: argv => { if (fault.isArmed && argv[0] === 'mkdir' && (argv.at(-1) ?? '').endsWith('/locks')) throw new Error('read-only file system') } }
  const world = createWorld(on, { branch: 'main' }, options)
  markSpawned(world, [12], unitSession)
  world.seedChat(unitSession, createEmptySession(unitSession))
  world.chat.id = unitSession
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  fault.isArmed = true
  await completeTurn(harness)
  await reread(harness.port, true)
  fault.isArmed = false
  const row = world.views.at(-1)?.notes.find(note => note.key === 'Process' && note.value.includes('/activity/'))?.value ?? ''
  expect({ isTurn: readActivityRecord(world)?.isTurn, isRefused: row.includes('could not take its publish lock'), cause: row.includes('read-only file system') })
    .toEqual({ isTurn: true, isRefused: true, cause: true })
})

// group: Kept starts
// contract: two starts kept while a turn runs are each delivered exactly once, in the order they were kept: the turn end the first, the tick the next
test('two starts kept while busy are each delivered once, in order', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'step', lead: 'First lead.' })
  await submitStart(harness.port, { kind: 'step', lead: 'Second lead.' })
  await world.clock.settle()
  await completeTurn(harness)
  await world.clock.settle()
  await tickIdle(harness, 3)
  const order = world.prompts.flatMap(prompt => prompt.includes('First lead.') ? ['first'] : prompt.includes('Second lead.') ? ['second'] : [])
  expect(order).toEqual(['first', 'second'])
})

// contract: a Stop never carries a kept start; the turn's end delivers the starts kept while it ran, one at a time in the order kept, each once
test('starts kept during a turn are delivered once each, in order, after it ends, never by its Stops', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'step', lead: 'First lead.' })
  await submitStart(harness.port, { kind: 'step', lead: 'Second lead.' })
  await world.clock.settle()
  const blocks = [await stop(harness), await stop(harness)]
  await completeTurn(harness)
  await tickIdle(harness, 2)
  expect({ inBlocks: blocks.some(block => block.includes('lead.')), order: readSubmitOrder(world, ['First lead.', 'Second lead.']) })
    .toEqual({ inBlocks: false, order: ['First lead.', 'Second lead.'] })
})

// contract: a start an older module kept in the single slot is adopted as the oldest kept start and delivered once, before a start kept after it
test('a start kept in the older single slot is delivered once, before a newer one', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  // why: a state written before the queue holds no pendingStarts at all.
  const legacy = Object.fromEntries(Object.entries(world.processState.value as Record<string, unknown>).filter(([key]) => key !== 'pendingStarts'))
  world.processState.value = { ...legacy, pendingStart: { kind: 'step', lead: 'Legacy lead.' } }
  await submitStart(harness.port, { kind: 'step', lead: 'Newer lead.' })
  await world.clock.settle()
  await completeTurn(harness)
  await world.clock.settle()
  await tickIdle(harness, 3)
  const order = world.prompts.flatMap(prompt => prompt.includes('Legacy lead.') ? ['legacy'] : prompt.includes('Newer lead.') ? ['newer'] : [])
  expect(order).toEqual(['legacy', 'newer'])
})

// contract: a command that would keep a start prompt while the session keeps the most it can is refused before it applies, nothing changed, naming how many wait, to run it again once they are delivered and where /flow status shows them; every start already kept is still delivered
test('a command past the start keeping limit is refused with nothing changed, and none kept is dropped', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  for (const index of Array.from({ length: 8 }, (_, at) => at)) await submitStart(harness.port, { kind: 'step', lead: `Lead ${index}.` })
  await world.clock.settle()
  const before = JSON.stringify([...world.files].filter(([path]) => !path.includes('/activity/')))
  const refused = await runApproveStep(harness.port, diagnosisComment.url)
  const after = JSON.stringify([...world.files].filter(([path]) => !path.includes('/activity/')))
  const status = await renderFlowStatus(harness.port)
  await completeTurn(harness)
  await world.clock.settle()
  await tickIdle(harness, 10)
  const message = refused.isOk ? '' : refused.error
  expect({ isRefused: message.startsWith('Refused, nothing changed: 8 start prompts already wait') && message.includes('Run the command again once they are delivered')
    && message.includes('/flow status'), isUnchanged: before === after, isShown: status.includes('8 start prompts wait'),
  delivered: Array.from({ length: 8 }, (_, index) => countPrompts(world, `Lead ${index}.`)), approvals: countPrompts(world, 'Diagnosis approved') })
    .toEqual({ isRefused: true, isUnchanged: true, isShown: true, delivered: [1, 1, 1, 1, 1, 1, 1, 1], approvals: 0 })
})

// contract: a command that applied while another filled the start keeping says it was applied and its start prompt not kept, with why, never that it was refused
test('a command applied while the keeping filled says its start was not kept, never refused', async (_$, on) => {
  const world = arrangeApproval(on)
  const fill = { isArmed: false }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    updateProcessState: async change => {
      if (fill.isArmed) {
        fill.isArmed = false
        const held = world.processState.value as Record<string, unknown>
        world.processState.value = { ...held, pendingStart: null, pendingStarts: Array.from({ length: 8 }, (_, index) => ({ id: `other-${index}`, start: { kind: 'step', lead: `Other ${index}.` } })) }
      }
      return base.updateProcessState(change)
    },
  })
  await newProcess(harness)
  await startTurn(harness)
  fill.isArmed = true
  const applied = await runApproveStep(harness.port, diagnosisComment.url)
  await world.clock.settle()
  await reread(harness.port, true)
  const row = world.views.at(-1)?.notes.find(note => note.key === 'Start')?.value ?? ''
  expect({ isApplied: applied.isOk, isTold: row.includes('the command was applied, but its start prompt') && row.includes('was not kept (8 start prompts already wait'), isRefused: row.includes('Refused') })
    .toEqual({ isApplied: true, isTold: true, isRefused: false })
})

// contract: (pin, not a red: the queue of 027adf1e already passed it) a start an older module kept in the single slot is delivered exactly once across a reload
test('a start kept in the older single slot is delivered once across a reload', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  // why: a state written before the queue holds no pendingStarts at all.
  const legacy = Object.fromEntries(Object.entries(world.processState.value as Record<string, unknown>).filter(([key]) => key !== 'pendingStarts'))
  world.processState.value = { ...legacy, pendingStart: { kind: 'step', lead: 'Legacy lead.' } }
  await reloadModule(harness)
  await hearTurn(harness)
  await tickIdle(harness, 2)
  await reloadModule(harness)
  await hearTurn(harness)
  await tickIdle(harness, 2)
  expect(countPrompts(world, 'Legacy lead.')).toBe(1)
})

// contract: kept starts the mod cannot read leave the process state as it is: nothing is kept over them and nothing is delivered; the pane says the command applied without its start kept, never that a start was lost, and why the state cannot be used
test('kept starts that cannot be read are never taken for none', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  world.processState.value = { ...world.processState.value as Record<string, unknown>, pendingStarts: [{ id: 'x' }] }
  await submitStart(harness.port, { kind: 'step', lead: 'Unread lead.' })
  await world.clock.settle()
  await reread(harness.port, true)
  const notes = world.views.at(-1)?.notes ?? []
  const start = notes.find(note => note.key === 'Start')?.value ?? ''
  const process = notes.find(note => note.key === 'Process')?.value ?? ''
  expect({ prompts: countPrompts(world, 'Unread lead.'), kept: (world.processState.value as { pendingStarts?: unknown }).pendingStarts,
    isNotKept: start.includes('was not kept ('), isLost: start.includes('lost'), isCause: process.includes('cannot use its process state') })
    .toEqual({ prompts: 0, kept: [{ id: 'x' }], isNotKept: true, isLost: false, isCause: true })
})

/**
 * Reads the ids of the starts the session keeps, oldest first.
 * @param world - The world.
 * @returns The ids.
 */
const readKeptIds = (world: World): string[] => ((world.processState.value as { pendingStarts?: { id: string }[] }).pendingStarts ?? []).map(kept => kept.id)

/**
 * Reads which of the given texts the submitted prompts carry, in submit order.
 * @param world - The world.
 * @param texts - The texts, each naming one start.
 * @returns The texts found, one per prompt that carries one.
 */
const readSubmitOrder = (world: World, texts: string[]): string[] => world.prompts.flatMap(prompt => texts.filter(text => prompt.includes(text)))

/**
 * Counts the starts a held process state keeps.
 * @param value - The held value.
 * @returns How many.
 */
const readKeptCount = (value: unknown): number => (value as { pendingStarts?: unknown[] } | undefined)?.pendingStarts?.length ?? 0

// contract: deliveries run one at a time from take to submit, so a start kept first reaches the host first even when a start kept after it composes faster
test('a start kept first is submitted first, though a later one composes faster', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
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
  await submitStart(harness.port, { kind: 'step', lead: 'Slow lead.' })
  await submitStart(harness.port, { kind: 'coordinate', text: 'fast words' })
  const deliveries = timers.queue.splice(0)
  timers.isHeld = false
  slow.isArmed = true
  for (const work of deliveries) work()
  await world.clock.settle()
  slow.gate.open()
  await world.clock.settle()
  // why: the second start waits for the idle window the first one's entry claimed, never queued behind it.
  await tickIdle(harness, 2)
  expect(readSubmitOrder(world, ['Slow lead.', 'fast words'])).toEqual(['Slow lead.', 'fast words'])
})

// contract: deliveries with no id, as the tick and the turn end make, claim the idle window inside the take, so two of them in one idle window submit one start
test('two deliveries in one idle window submit one start', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'one words' })
  await submitStart(harness.port, { kind: 'coordinate', text: 'two words' })
  await completeTurn(harness)
  scheduleStart(harness.port)
  scheduleStart(harness.port)
  await world.clock.settle()
  expect(readSubmitOrder(world, ['one words', 'two words'])).toEqual(['one words'])
})

// contract: starts a Stop took whose composition failed are kept again first, as one block in the order they were kept
test('starts a Stop could not compose are kept again in their order', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: false }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    readSessionState: async () => { if (fault.isArmed) throw new Error('host busy'); return base.readSessionState() },
  })
  await newProcess(harness)
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'step', lead: 'First lead.' })
  await submitStart(harness.port, { kind: 'step', lead: 'Second lead.' })
  const kept = readKeptIds(world)
  fault.isArmed = true
  await stop(harness)
  fault.isArmed = false
  expect({ count: kept.length, restored: readKeptIds(world) }).toEqual({ count: 2, restored: kept })
})

// contract: a start whose composition fails stays first in line and holds the starts kept after it, and only those, named on its Start row; once it composes, both are delivered once, in the order kept
test('a start whose composition fails holds the starts behind it until it composes', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const fault = { isRead: false }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    defer: work => { if (timers.isHeld) timers.queue.push(work); else work() },
    readSessionState: async () => { if (fault.isRead) throw new Error('host busy'); return base.readSessionState() },
  })
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'step', lead: 'Failed lead.' })
  await submitStart(harness.port, { kind: 'coordinate', text: 'later words' })
  timers.queue.length = 0
  timers.isHeld = false
  fault.isRead = true
  scheduleStart(harness.port)
  await world.clock.settle()
  scheduleStart(harness.port)
  await world.clock.settle()
  fault.isRead = false
  await reread(harness.port, true)
  const during = { later: countPrompts(world, 'later words'), isHeld: (world.views.at(-1)?.notes ?? []).some(note => note.key === 'Start' && note.value.includes('the starts kept after it wait for it')) }
  await tickIdle(harness, 3)
  expect({ during, order: readSubmitOrder(world, ['Failed lead.', 'later words']) }).toEqual({ during: { later: 0, isHeld: true }, order: ['Failed lead.', 'later words'] })
})

// contract: a keep whose compare-and-set retries on a state with room keeps the start and says nothing of a full keeping
test('a keep that retries onto a state with room keeps the start', async (_$, on) => {
  const world = arrangeApproval(on)
  const retry = { isArmed: false }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    updateProcessState: async change => {
      if (retry.isArmed) {
        retry.isArmed = false
        const held = world.processState.value as Record<string, unknown>
        change({ ...held, pendingStart: null, pendingStarts: Array.from({ length: 8 }, (_, index) => ({ id: `other-${index}`, start: { kind: 'step', lead: `Other ${index}.` } })) } as never)
      }
      return base.updateProcessState(change)
    },
  })
  await newProcess(harness)
  retry.isArmed = true
  await submitStart(harness.port, { kind: 'coordinate', text: 'retried words' })
  await world.clock.settle()
  await reread(harness.port, true)
  expect({ delivered: countPrompts(world, 'retried words'), rows: (world.views.at(-1)?.notes ?? []).filter(note => note.key === 'Start').length })
    .toEqual({ delivered: 1, rows: 0 })
})


// contract: (pin, not a red: the queue of 027adf1e already passed it) two kept starts whose command deliveries a reload cancelled are each delivered exactly once, in order, by the new module
test('two kept starts whose deliveries a reload cancelled are each delivered once', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const harness = createModuleHarness(world, { defer: work => { if (timers.isHeld) timers.queue.push(work); else work() } })
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'coordinate', text: 'one words' })
  await submitStart(harness.port, { kind: 'coordinate', text: 'two words' })
  timers.queue.length = 0
  timers.isHeld = false
  await reloadModule(harness)
  await hearTurn(harness)
  await tickIdle(harness, 4)
  expect(readSubmitOrder(world, ['one words', 'two words'])).toEqual(['one words', 'two words'])
})

/**
 * Stops the main turn as the engine does, with the dispatch signal given, so a test can abandon the Stop while it composes.
 * @param harness - The direct-dispatch harness.
 * @param signal - The Stop's dispatch signal.
 * @returns The block's text, empty when the stop goes through.
 */
async function stopWith(harness: ModuleHarness, signal: AbortSignal): Promise<string> {
  const next = Object.assign(async () => ({}), { signal }) as unknown as Next<'classic.Stop'>
  const result = await handleStop(harness.port, { stop_hook_active: false, background_tasks: [] } as never, next)
  return (result as { block?: string }).block ?? ''
}

// contract: a start submit the host never settles is shown unknown after one tick and never submitted again; it holds every later start, named on the hold row with how to check it; the user's typed prompt hands it over, ending it with a notice, and the later start is then delivered once
test('a start submit that never settles holds later starts as unknown until the user types a prompt', async (_$, on) => {
  const world = arrangeApproval(on)
  const hang = { isArmed: true }
  const harness = createModuleHarness(world, {
    submitPrompt: async text => {
      world.prompts.push(text)
      if (hang.isArmed) { hang.isArmed = false; await new Promise<never>(() => {}) }
    },
  })
  await newProcess(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'hung words' })
  await world.clock.settle()
  await world.clock.advance(tickMs)
  await world.clock.settle()
  await submitStart(harness.port, { kind: 'coordinate', text: 'later words' })
  await tickIdle(harness, 2)
  await reread(harness.port, true)
  const row = (world.views.at(-1)?.notes ?? []).find(note => note.key === 'Process' && note.value.includes('got no answer'))?.value ?? ''
  const during = { later: countPrompts(world, 'later words'), hung: countPrompts(world, 'hung words') }
  await enterPrompt(harness, 'typed by the user')
  await startTurn(harness)
  await completeTurn(harness)
  await reread(harness.port, true)
  const notice = (world.views.at(-1)?.notes ?? []).find(note => note.key === 'Start' && note.value.includes('the user typed a prompt'))?.value ?? ''
  await tickIdle(harness, 2)
  expect({ during, isNamed: row.includes('whether it entered is unknown') && row.includes('type any prompt'), isNoticed: notice.includes('if it did not'),
    later: countPrompts(world, 'later words'), hung: countPrompts(world, 'hung words'), kept: readKeptIds(world).length })
    .toEqual({ during: { later: 0, hung: 1 }, isNamed: true, isNoticed: true, later: 1, hung: 1, kept: 0 })
})

// contract: a Stop the host abandons while it composes delivers nothing and keeps every start it took again, first and in their order
test('an abandoned Stop keeps the starts it took again, in their order', async (_$, on) => {
  const world = arrangeApproval(on)
  const abandon = new AbortController()
  const base = createModuleHarness(world).port
  const armed = { isArmed: false }
  const harness = createModuleHarness(world, {
    readSessionState: async () => { if (armed.isArmed) abandon.abort(); return base.readSessionState() },
  })
  await newProcess(harness)
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'step', lead: 'First lead.' })
  await submitStart(harness.port, { kind: 'coordinate', text: 'second words' })
  const kept = readKeptIds(world)
  armed.isArmed = true
  const block = await stopWith(harness, abandon.signal)
  armed.isArmed = false
  expect({ block, count: kept.length, restored: readKeptIds(world) }).toEqual({ block: '', count: 2, restored: kept })
})

// contract: a step start never enters an idle window another delivery claimed, even from its own command; it waits for the next idle tick, which delivers it once
test('a step start does not enter a window another delivery claimed', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const harness = createModuleHarness(world, { defer: work => { if (timers.isHeld) timers.queue.push(work); else work() } })
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'coordinate', text: 'first words' })
  timers.queue.length = 0
  timers.isHeld = false
  scheduleStart(harness.port)
  await world.clock.settle()
  await submitStart(harness.port, { kind: 'step', lead: 'Step lead.' })
  await world.clock.settle()
  const early = countPrompts(world, 'Step lead.')
  await tickIdle(harness, 2)
  expect({ first: countPrompts(world, 'first words'), early, later: countPrompts(world, 'Step lead.') }).toEqual({ first: 1, early: 0, later: 1 })
})

// contract: a delivery a reload interrupted between its take and its submit submits nothing and keeps its start again, which the new load delivers once
test('a delivery of the replaced load submits nothing after a reload, and the new load delivers its start once', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
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
  await submitStart(harness.port, { kind: 'step', lead: 'Old lead.' })
  const delivery = timers.queue.splice(0)
  timers.isHeld = false
  slow.isArmed = true
  for (const work of delivery) work()
  await world.clock.settle()
  await reloadModule(harness)
  slow.gate.open()
  await world.clock.settle()
  const early = { prompts: countPrompts(world, 'Old lead.'), kept: readKeptIds(world).length }
  await hearTurn(harness)
  await tickIdle(harness, 2)
  expect({ early, later: countPrompts(world, 'Old lead.') }).toEqual({ early: { prompts: 0, kept: 1 }, later: 1 })
})

// contract: a take claims the idle window even over a prompt held past its tick that never started its turn, so a second delivery in that window submits nothing
test('a take claims the window over a stale held prompt', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const harness = createModuleHarness(world, { defer: work => { if (timers.isHeld) timers.queue.push(work); else work() } })
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'coordinate', text: 'one words' })
  await submitStart(harness.port, { kind: 'coordinate', text: 'two words' })
  timers.queue.length = 0
  timers.isHeld = false
  world.processState.value = { ...world.processState.value as Record<string, unknown>, prompt: { enteredAt: 0, isInformOnly: false, isEmptyDoorbell: false } }
  await world.clock.advance(2 * tickMs)
  scheduleStart(harness.port)
  await world.clock.settle()
  scheduleStart(harness.port)
  await world.clock.settle()
  expect(readSubmitOrder(world, ['one words', 'two words'])).toEqual(['one words'])
})

// contract: a start failure shown as still kept is forgotten once that start is no longer kept, as when another load delivered it
test('a start failure is forgotten once another load delivered that start', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const fault = { isArmed: false }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    defer: work => { if (timers.isHeld) timers.queue.push(work); else work() },
    readSessionState: async () => { if (fault.isArmed) throw new Error('host busy'); return base.readSessionState() },
  })
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'step', lead: 'Failing lead.' })
  timers.queue.length = 0
  timers.isHeld = false
  fault.isArmed = true
  scheduleStart(harness.port)
  await world.clock.settle()
  fault.isArmed = false
  await reread(harness.port, true)
  const isHeld = (): boolean => (world.views.at(-1)?.notes ?? []).some(note => note.key === 'Start' && note.value.includes('its composition failed'))
  const before = isHeld()
  world.processState.value = { ...world.processState.value as Record<string, unknown>, pendingStarts: [] }
  await reread(harness.port, true)
  expect({ before, after: isHeld() }).toEqual({ before: true, after: false })
})

// contract: a start that cannot be started again from its kept form names how to start it by its kind: the current step by hand for a step start, the same command again for a coordinate or delegate start
test('a start failure names how to start it by hand by its kind', () => {
  const step = describeStartFailure({ stage: 'keep', cause: 'full', kind: 'step' })
  const coordinate = describeStartFailure({ stage: 'keep', cause: 'full', kind: 'coordinate' })
  const delegate = describeStartFailure({ stage: 'keep', cause: 'x', kind: 'delegate' })
  expect({ step: step.includes('start the current step by hand'), coordinate: coordinate.includes('run the same /flow coordinate command again') && !coordinate.includes('current step'),
    delegate: delegate.includes('run the same /flow delegate command again') && !delegate.includes('current step') })
    .toEqual({ step: true, coordinate: true, delegate: true })
})


/**
 * Reads what is known of each attempt the session holds, oldest first.
 * @param world - The world.
 * @returns Each attempt's status.
 */
const readAttempts = (world: World): string[] => ((world.processState.value as { attempts?: { status: { kind: string } }[] } | undefined)?.attempts ?? []).map(attempt => attempt.status.kind)

/**
 * Builds a module whose next start submit waits until the test settles it, as an engine that holds a prompt does.
 * @param world - The world.
 * @returns The harness and the settle controls.
 */
function harnessWithHeldSubmit(world: World): { harness: ModuleHarness; held: { isArmed: boolean; resolve: () => void; reject: (error: Error) => void } } {
  const held = { isArmed: true, resolve: (): void => {}, reject: (_error: Error): void => {} }
  const harness = createModuleHarness(world, {
    submitPrompt: async text => {
      world.prompts.push(text)
      if (!held.isArmed) return
      held.isArmed = false
      await new Promise<void>((resolve, reject) => { held.resolve = resolve; held.reject = reject })
    },
  })
  return { harness, held }
}

// contract: a start whose submit has no answer within the one-tick bound is held as unknown, never submitted again, and its late success is recorded as entered, ending the hold with no row left
test('a submit that succeeds after the tick bound confirms its start once', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, held } = harnessWithHeldSubmit(world)
  await newProcess(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'late words' })
  await world.clock.advance(tickMs)
  await world.clock.settle()
  await tickIdle(harness, 2)
  const during = readAttempts(world)
  held.resolve()
  await world.clock.settle()
  await tickIdle(harness, 2)
  await reread(harness.port, true)
  expect({ during, submits: countPrompts(world, 'late words'), kept: readKeptIds(world).length, rows: (world.views.at(-1)?.notes ?? []).filter(note => note.key === 'Start' || note.value.startsWith('held')).length })
    .toEqual({ during: ['unknown'], submits: 1, kept: 0, rows: 0 })
})

// contract: a start whose submit is dropped after it was held unknown never entered, and nothing passed it while it held the session, so it stays first in line and is submitted once more
test('a submit dropped after the tick bound is submitted once more, as nothing passed it', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, held } = harnessWithHeldSubmit(world)
  await newProcess(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'dropped words' })
  await world.clock.advance(tickMs)
  await world.clock.settle()
  held.reject(new DroppedPromptError('interrupted'))
  await world.clock.settle()
  await tickIdle(harness, 2)
  expect({ submits: countPrompts(world, 'dropped words'), kept: readKeptIds(world).length, attempts: readAttempts(world) }).toEqual({ submits: 2, kept: 0, attempts: [] })
})

// contract: a delivery whose claim cannot be written submits nothing and leaves its start first in line, which a later tick delivers once
test('a claim whose write fails submits nothing and leaves the start kept', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { writes: 0 }
  const harness = faultyHost(world, { failWrite: next => JSON.stringify(next).includes('"kind":"pending"') && fault.writes > 0 && fault.writes-- > 0 })
  await newProcess(harness)
  fault.writes = 1
  await submitStart(harness.port, { kind: 'coordinate', text: 'fenced words' })
  await world.clock.settle()
  const early = { submits: countPrompts(world, 'fenced words'), attempts: readAttempts(world), kept: readKeptIds(world).length }
  await tickIdle(harness, 2)
  expect({ early, later: countPrompts(world, 'fenced words') }).toEqual({ early: { submits: 0, attempts: [], kept: 1 }, later: 1 })
})

// contract: a load record that failed to write is shown as a Process fault that says the load submits nothing while it is not recorded; the next write this load owns records it, as a kept start's does, which clears the fault, and the start is then delivered once
test('a failed load record is shown, and the next owned write records it so delivery resumes', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: true }
  const harness = faultyHost(world, { failWrite: (next, current) => fault.isArmed && current !== undefined && (next as { loadId?: string }).loadId !== (current as { loadId?: string }).loadId && !(fault.isArmed = false) })
  await newProcess(harness)
  await reread(harness.port, true)
  const row = (world.views.at(-1)?.notes ?? []).find(note => note.key === 'Process' && note.value.includes('this load is recorded'))?.value ?? ''
  await submitStart(harness.port, { kind: 'coordinate', text: 'held words' })
  await world.clock.settle()
  await tickIdle(harness, 2)
  await reread(harness.port, true)
  expect({ isShown: row.includes('submits no prompt of its own'), delivered: countPrompts(world, 'held words'), isCleared: !(world.views.at(-1)?.notes ?? []).some(note => note.value.includes('this load is recorded')) })
    .toEqual({ isShown: true, delivered: 1, isCleared: true })
})

// contract: (pin, not a red: the flag already cleared in a finally at 4abb6ff8) a tick delivery that throws never leaves later tick deliveries suppressed
test('a tick delivery that throws does not suppress the next', async (_$, on) => {
  const world = arrangeApproval(on)
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const fault = { writes: 0 }
  const harness = faultyHost(world, { failWrite: () => fault.writes > 0 && fault.writes-- > 0 }, {
    defer: work => { if (timers.isHeld) timers.queue.push(work); else work() },
  })
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'coordinate', text: 'retried words' })
  timers.queue.length = 0
  timers.isHeld = false
  fault.writes = 1
  scheduleStart(harness.port)
  await world.clock.settle()
  await tickIdle(harness, 2)
  expect(countPrompts(world, 'retried words')).toBe(1)
})

// contract: a prompt the user types while a start's submit is unsettled never settles that start, which stays pending until its own submit answers and is delivered once
test('a typed prompt in the window leaves the start pending, delivered once', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, held } = harnessWithHeldSubmit(world)
  await newProcess(harness)
  void submitStart(harness.port, { kind: 'coordinate', text: 'window words' })
  await world.clock.settle()
  await enterPrompt(harness, 'what is the status?')
  const during = readAttempts(world)
  held.resolve()
  await world.clock.settle()
  expect({ during, submits: countPrompts(world, 'window words'), kept: readKeptIds(world).length }).toEqual({ during: ['pending'], submits: 1, kept: 0 })
})

// contract: (pin, not a red: the tick's settlement retry passes it) a start known entered whose removal could not be written stays out of every delivery, and the tick removes it, so it is delivered once
test('a confirmed start whose removal failed is removed by the tick, delivered once', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: true }
  const harness = faultyHost(world, { failWrite: (next, current) => fault.isArmed && readKeptCount(next) < readKeptCount(current) && !(fault.isArmed = false) })
  await newProcess(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'removed words' })
  await world.clock.settle()
  const early = readAttempts(world)
  await tickIdle(harness, 3)
  expect({ early, submits: countPrompts(world, 'removed words'), kept: readKeptIds(world).length }).toEqual({ early: ['entered'], submits: 1, kept: 0 })
})

// contract: a start known entered whose removal failed before a reload keeps that outcome: the new load removes it, never delivers it again and never shows it unknown
test('a start known entered whose removal failed before a reload is settled by the new load, never shown unknown', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: true }
  const harness = faultyHost(world, { failWrite: (next, current) => fault.isArmed && readKeptCount(next) < readKeptCount(current) && !(fault.isArmed = false) })
  await newProcess(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'reloaded words' })
  await world.clock.settle()
  await reloadModule(harness)
  await tickIdle(harness, 3)
  await reread(harness.port, true)
  const notes = world.views.at(-1)?.notes ?? []
  expect({ submits: countPrompts(world, 'reloaded words'), kept: readKeptIds(world).length, isUnknown: notes.some(note => note.value.includes('unknown')) })
    .toEqual({ submits: 1, kept: 0, isUnknown: false })
})

// contract: a start whose submit settles successfully after a reload, recorded by the replaced load's receipt, entered once: the new load settles it and never delivers it again
test('a late submit success after a reload is recorded by the replaced load, and enters once', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, held } = harnessWithHeldSubmit(world)
  await newProcess(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'swept words' })
  await world.clock.advance(tickMs)
  await world.clock.settle()
  await reloadModule(harness)
  await tickIdle(harness, 2)
  held.resolve()
  await world.clock.settle()
  await tickIdle(harness, 2)
  expect({ submits: countPrompts(world, 'swept words'), kept: readKeptIds(world).length }).toEqual({ submits: 1, kept: 0 })
})

// contract: a start kept during a turn is never carried by its Stop, and the turn's end, an interrupt's included, delivers it once, with no unknown row
test('a start kept during an interrupted turn is delivered once at its end, never by its Stop', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'interrupted words' })
  const block = await stop(harness)
  await callTool(harness)
  await completeTurn(harness, 't1', true)
  await tickIdle(harness, 2)
  await reread(harness.port, true)
  expect({ inBlock: block.includes('interrupted words'), delivered: countPrompts(world, 'interrupted words'), kept: readKeptIds(world).length,
    rows: (world.views.at(-1)?.notes ?? []).filter(note => note.key === 'Start' || note.value.startsWith('held')).length })
    .toEqual({ inBlock: false, delivered: 1, kept: 0, rows: 0 })
})

/**
 * Builds a harness whose next process-state read waits on a gate, so a turn can start while a delivery composes.
 * @param world - The world.
 * @returns The harness and the gate's arming.
 */
function harnessWithHeldRead(world: World): { harness: ModuleHarness; slow: { isArmed: boolean; gate: Gate } } {
  const slow = { isArmed: false, gate: createGate() }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    updateProcessState: async change => {
      // why: the claim, the last write before a submit, waits, so a turn starts between the composition and that write, as one typed while the start composes would.
      if (slow.isArmed && JSON.stringify(change(world.processState.value as never)).includes('"kind":"pending"')) { slow.isArmed = false; await slow.gate.promise }
      return base.updateProcessState(change)
    },
  })
  return { harness, slow }
}

// contract: a step start whose delivery a typed prompt's turn overtook while it composed submits nothing into that turn, its Stop carries none, and the turn's end delivers it once
test('a turn that starts while a step start composes holds it until the turn ends', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, slow } = harnessWithHeldRead(world)
  await newProcess(harness)
  slow.isArmed = true
  void submitStart(harness.port, { kind: 'step', lead: 'Overtaken lead.' })
  await world.clock.settle()
  await startTurn(harness)
  slow.gate.open()
  await world.clock.settle()
  const early = countPrompts(world, 'Overtaken lead.')
  const block = await stop(harness)
  await completeTurn(harness)
  expect({ early, inBlock: block.includes('Overtaken lead.'), delivered: countPrompts(world, 'Overtaken lead.') }).toEqual({ early: 0, inBlock: false, delivered: 1 })
})

// contract: a coordinate or delegate start whose delivery a typed prompt's turn overtook while it composed submits nothing into that turn, its Stop carries none, and the turn's end delivers it once
test('a turn that starts while a fixed start composes holds it until the turn ends', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, slow } = harnessWithHeldRead(world)
  await newProcess(harness)
  slow.isArmed = true
  void submitStart(harness.port, { kind: 'coordinate', text: 'overtaken words' })
  await world.clock.settle()
  await startTurn(harness)
  slow.gate.open()
  await world.clock.settle()
  const early = countPrompts(world, 'overtaken words')
  const block = await stop(harness)
  await completeTurn(harness)
  expect({ early, inBlock: block.includes('overtaken words'), delivered: countPrompts(world, 'overtaken words') }).toEqual({ early: 0, inBlock: false, delivered: 1 })
})

/**
 * Builds a harness whose next session read, once armed, waits on a gate and then fails if asked, so a step start's composition holds
 * across a reload.
 * @param world - The world.
 * @returns The harness, the deferred work it holds, and the gate's arming.
 */
function harnessWithHeldCompose(world: World): { harness: ModuleHarness; timers: { isHeld: boolean; queue: (() => void)[] }; slow: { isArmed: boolean; isFailing: boolean; gate: Gate } } {
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const slow = { isArmed: false, isFailing: false, gate: createGate() }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    defer: work => { if (timers.isHeld) timers.queue.push(work); else work() },
    readSessionState: async () => {
      if (!slow.isArmed) return base.readSessionState()
      slow.isArmed = false
      await slow.gate.promise
      if (slow.isFailing) throw new Error('session unreadable')
      return base.readSessionState()
    },
  })
  return { harness, timers, slow }
}

// contract: a start whose composition a reload interrupted is never claimed by the replaced load: nothing is held or shown unknown, and the new load delivers it once
test('a start whose composition a reload interrupted is delivered once by the new load, never held', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, timers, slow } = harnessWithHeldCompose(world)
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'step', lead: 'Claimed lead.' })
  const delivery = timers.queue.splice(0)
  timers.isHeld = false
  slow.isArmed = true
  for (const work of delivery) work()
  await world.clock.settle()
  await reloadModule(harness)
  await hearTurn(harness)
  await tickIdle(harness, 1)
  await reread(harness.port, true)
  const isHeld = (world.views.at(-1)?.notes ?? []).some(note => note.value.startsWith('held'))
  slow.gate.open()
  await world.clock.settle()
  await tickIdle(harness, 1)
  expect({ isHeld, submits: countPrompts(world, 'Claimed lead.'), attempts: readAttempts(world) }).toEqual({ isHeld: false, submits: 1, attempts: [] })
})

// contract: a replaced load whose composition fails after the new load delivered the start changes nothing, and no row says the start is still kept or failing
test('a failed delivery of a replaced load after the new load delivered its start changes nothing', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, timers, slow } = harnessWithHeldCompose(world)
  await newProcess(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'step', lead: 'Missing lead.' })
  const delivery = timers.queue.splice(0)
  timers.isHeld = false
  slow.isArmed = true
  slow.isFailing = true
  for (const work of delivery) work()
  await world.clock.settle()
  await reloadModule(harness)
  await hearTurn(harness)
  await tickIdle(harness, 1)
  slow.gate.open()
  await world.clock.settle()
  await reread(harness.port, true)
  const notes = world.views.at(-1)?.notes ?? []
  expect({ submits: countPrompts(world, 'Missing lead.'), kept: readKeptIds(world).length, isFailing: notes.some(note => note.value.includes('could not be composed') || note.value.includes('stays first in line')) })
    .toEqual({ submits: 1, kept: 0, isFailing: false })
})

// contract: a Stop the replaced load still runs after a reload changes nothing in the keeping, so a start the new load is composing, whose composition then fails, stays first in line and is delivered once
test('an old load\'s Stop after a reload leaves the new load\'s start kept', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness, timers, slow } = harnessWithHeldCompose(world)
  await newProcess(harness)
  await reloadModule(harness)
  await hearTurn(harness)
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'step', lead: 'New lead.' })
  const delivery = timers.queue.splice(0)
  timers.isHeld = false
  slow.isArmed = true
  slow.isFailing = true
  for (const work of delivery) work()
  await world.clock.settle()
  const during = readKeptIds(world).length
  await harness.asOldModule(() => stop(harness))
  const after = { kept: readKeptIds(world).length, attempts: readAttempts(world) }
  slow.gate.open()
  await world.clock.settle()
  await tickIdle(harness, 2)
  expect({ during, after, delivered: countPrompts(world, 'New lead.'), kept: readKeptIds(world).length }).toEqual({ during: 1, after: { kept: 1, attempts: [] }, delivered: 1, kept: 0 })
})

// contract: a load whose load record failed, and whose tick resumes after a reload recorded a newer load that still ticks, stands down: it neither touches the newer load's start nor records itself, and the newer load delivers that start once
test('a load whose record failed never takes over from a newer load', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: true }
  const timers = { isHeld: false, queue: [] as (() => void)[] }
  const slow = { isArmed: false, gate: createGate() }
  const base = createModuleHarness(world).port
  const harness = faultyHost(world, { failWrite: (next, current) => fault.isArmed && current !== undefined && (next as { loadId?: string }).loadId !== (current as { loadId?: string }).loadId && !(fault.isArmed = false) }, {
    defer: work => { if (timers.isHeld) timers.queue.push(work); else work() },
    readSessionState: async () => {
      if (slow.isArmed) { slow.isArmed = false; await slow.gate.promise }
      return base.readSessionState()
    },
  })
  await newProcess(harness)
  await reloadModule(harness)
  await hearTurn(harness)
  const recorded = (world.processState.value as { loadId?: string }).loadId
  timers.isHeld = true
  await submitStart(harness.port, { kind: 'step', lead: 'Newer lead.' })
  const delivery = timers.queue.splice(0)
  timers.isHeld = false
  slow.isArmed = true
  for (const work of delivery) work()
  await world.clock.settle()
  await harness.asOldModule(() => recoverStarts(harness.port))
  const after = { attempts: readAttempts(world), kept: readKeptIds(world).length, isSame: (world.processState.value as { loadId?: string }).loadId === recorded }
  slow.gate.open()
  await world.clock.settle()
  await tickIdle(harness, 2)
  expect({ after, delivered: countPrompts(world, 'Newer lead.'), kept: readKeptIds(world).length }).toEqual({ after: { attempts: [], kept: 1, isSame: true }, delivered: 1, kept: 0 })
})

// contract: an attempt whose outcome is unknown outlives painting and a reload: the new load never submits it again, and once its tick passed ends it with a notice that its outcome is unknown, how to check it and how to start it by hand
test('an unknown attempt of a replaced load is never submitted again, and ends with a notice', async (_$, on) => {
  const world = arrangeApproval(on)
  const { harness } = harnessWithHeldSubmit(world)
  await newProcess(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'unshown words' })
  await world.clock.advance(tickMs)
  await world.clock.settle()
  await reread(harness.port, true)
  await reloadModule(harness)
  await tickIdle(harness, 1)
  await reread(harness.port, true)
  const notices = world.views.flatMap(view => view?.notes ?? []).filter(note => note.key === 'Start' && note.value.includes('/flow coordinate') && note.value.includes('whether it entered is unknown'))
  expect({ isNoticed: notices.some(note => note.value.includes('run the same /flow coordinate command again')), submits: countPrompts(world, 'unshown words'), attempts: readAttempts(world), kept: readKeptIds(world).length })
    .toEqual({ isNoticed: true, submits: 1, attempts: [], kept: 0 })
})

// contract: a step start with no current step to start leaves the keeping with a notice that says it was not started, and the start kept after it is delivered once
test('a start composed to nothing leaves the keeping, and the start behind it is delivered once', async (_$, on) => {
  const world = arrangeUnit(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'step', lead: 'Nothing lead.' })
  await submitStart(harness.port, { kind: 'coordinate', text: 'carried words' })
  await completeTurn(harness)
  await tickIdle(harness, 2)
  expect({ nothing: countPrompts(world, 'Nothing lead.'), carried: countPrompts(world, 'carried words'), kept: readKeptIds(world).length }).toEqual({ nothing: 0, carried: 1, kept: 0 })
})

// contract: no paint removes an unknown attempt, shown or skipped, so the next load still shows it
test('a skipped paint never removes an unknown attempt', async (_$, on) => {
  const world = arrangeApproval(on)
  const skip = { isArmed: false }
  const { harness } = harnessWithHeldSubmit(world)
  const base = harness.port
  harness.port = { ...base, readSessionId: async () => skip.isArmed ? 'another-session' : base.readSessionId() }
  await newProcess(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'skipped words' })
  await world.clock.advance(tickMs)
  await world.clock.settle()
  skip.isArmed = true
  await reread(harness.port, true)
  skip.isArmed = false
  await reloadModule(harness)
  await reread(harness.port, true)
  expect((world.views.at(-1)?.notes ?? []).filter(note => note.key === 'Process' && note.value.includes('got no answer')).length).toBe(1)
})

// contract: a start known entered whose settlement write fails holds the next start until the tick settles it, and then the next is delivered once
test('a failed settlement holds the next start until the tick settles it, and both are delivered once', async (_$, on) => {
  const world = arrangeApproval(on)
  const fault = { isArmed: false }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    updateProcessState: async change => {
      const current = world.processState.value
      if (fault.isArmed && readKeptCount(change(current as never)) < readKeptCount(current)) { fault.isArmed = false; throw new Error('host busy') }
      return base.updateProcessState(change)
    },
  })
  await newProcess(harness)
  await startTurn(harness)
  await submitStart(harness.port, { kind: 'coordinate', text: 'first words' })
  await submitStart(harness.port, { kind: 'coordinate', text: 'second words' })
  fault.isArmed = true
  await completeTurn(harness)
  const early = countPrompts(world, 'second words')
  await tickIdle(harness, 3)
  expect({ early, firstSubmits: countPrompts(world, 'first words'), secondSubmits: countPrompts(world, 'second words'), kept: readKeptIds(world).length })
    .toEqual({ early: 0, firstSubmits: 1, secondSubmits: 1, kept: 0 })
})

// contract: a process state of the shape before attempts keeps every outcome it held: its unknown starts, the count of more, and a start an earlier load had marked as being delivered each end, at the first tick of the load that holds the state, with a notice that its outcome is unknown, the oldest past the bound folded into one that counts them; nothing of them is submitted
test('unknown outcomes of the earlier shape each end with a notice, the oldest folded into a count', async (_$, on) => {
  const world = arrangeApproval(on)
  const harness = createModuleHarness(world)
  await newProcess(harness)
  const held = world.processState.value as ProcessState
  const stored = Array.from({ length: 8 }, (_, index) => ({ id: `u${index}`, kind: 'coordinate' as const, cause: 'claimed by an earlier load, not known whether it entered' }))
  const flight = { id: 'k9', start: { kind: 'coordinate' as const, text: 'ninth words' }, inFlight: { delivery: 'gone', loadId: 'earlier-load', at: 0 } }
  world.processState.value = { ...held, unknownStarts: stored, unknownOverflow: 3, unknownOverflowShown: 2, pendingStarts: [flight] }
  await recoverStarts(harness.port)
  await reread(harness.port, true)
  const rows = (world.views.at(-1)?.notes ?? []).filter(note => note.key === 'Start' && note.value.includes('whether it entered'))
  expect({ rows: rows.length, isCounted: rows.some(note => note.value.includes('more prompts of the mod')), submits: countPrompts(world, 'ninth words'), kept: readKeptIds(world).length })
    .toEqual({ rows: 8, isCounted: true, submits: 0, kept: 0 })
})
