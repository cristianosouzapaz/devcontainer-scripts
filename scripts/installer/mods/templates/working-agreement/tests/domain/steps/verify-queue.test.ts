import { expect } from 'claude-code/testing'
import { buildChangedCheckout } from '../../support/builders'

import type { EnginePort } from '../../../hooks/core/engine-port'
import { hostLockPath } from '../../../hooks/core/host-lock'
import type { HostLockOutcome } from '../../../hooks/core/host-lock'
import { readVerifyQueue, waitCiIdle, withVerifyTurn } from '../../../hooks/core/verify-queue'
import type { VerifyWait } from '../../../hooks/core/verify-queue'
import { createModuleHarness, reloadModule } from '../../support/reload'
import { inside, mountPane, outlastBudget, readFlowStatus, releaseVerifyHolder, seedVerifyHolder, slowClockReads, textOf } from '../../support/helpers'
import { test } from '../../support/kit'
import { common, createTestPort, createWorld } from '../../support/world'
import type { Gate, Options, World } from '../../support/world'

const changed = buildChangedCheckout()
const file = JSON.stringify({ always: [['check']] })
const approved: Options = { verifyFile: file, approvedConfig: file }
const lock = hostLockPath(common, 'verify')
const verify = { tool: 'mcp__working-agreement__verify' } as const

/**
 * Builds a direct-dispatch port for another session on the same repository.
 * @param world - The test world.
 * @param sid - The session id.
 * @returns The port.
 */
const sessionPort = (world: World, sid: string): EnginePort => ({ ...createTestPort(world), readSessionId: async () => sid })

/**
 * Lists the ids queued for the Verify lock, the holder's first.
 * @param world - The test world.
 * @returns The ids.
 */
const listQueue = (world: World): string[] => (world.hostLocks.queues.get(lock) ?? []).map(ticket => ticket.id)

/**
 * Queues another session for the Verify lock, holding it for no work once its turn comes.
 * @param world - The test world.
 * @param sid - The session id.
 * @param signal - Ends the wait.
 * @param call - What it queues for.
 * @returns How the hold ended.
 */
const queue = (world: World, sid: string, signal = new AbortController().signal, call: VerifyWait['call'] = 'verify'): Promise<HostLockOutcome<void>> =>
  withVerifyTurn(sessionPort(world, sid), common, sid, async () => {}, { call, deadline: world.clock.now() + 600000, signal, onMove: async () => {} })

// contract: a queued Verify shows its place in the view, the pane title and the status, and runs once the holder ends, leaving no ticket
test('a queued Verify shows its place everywhere and runs when the holder finishes', async ($, on) => {
  const world = createWorld(on, { ...changed }, { ...approved, herdrEnv: inside })
  seedVerifyHolder(world)
  const run = $.tool.call(verify)
  await world.clock.settle()
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Queue', value: 'Verify waiting: 1 ahead (holder: unknown)', tone: 'text' })
  expect(world.runs.some(command => command.startsWith('herdr ') && command.includes('· Verify waiting (1 ahead)'))).toBe(true)
  // why: the wait is another session's run, so nobody has to act: the note keeps the plain tone, and status shows it once.
  expect(((await readFlowStatus($)) ?? '').split('\n').filter(line => line.includes('1 ahead'))).toEqual(['Queue       Verify waiting: 1 ahead (holder: unknown)'])
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns ?? []).toEqual([])
  releaseVerifyHolder(world)
  await world.clock.advance(1000)
  expect((await run).result).toContain('Verify passed')
  expect(listQueue(world)).toEqual([])
  expect(world.views.at(-1)?.notes.some(note => note.key === 'Queue')).toBe(false)
})

// contract: waiters for the Verify lock are served in arrival order
test('waiters are served first come, first served', async (_$, on) => {
  const world = createWorld(on, { ...changed }, approved)
  seedVerifyHolder(world)
  const served: string[] = []
  const waits: Promise<void>[] = []
  for (const sid of ['c', 'a', 'b']) {
    waits.push(queue(world, sid).then(hold => { if (hold.kind === 'done') served.push(sid) }))
    await world.clock.settle()
  }
  expect((await readVerifyQueue(sessionPort(world, 'b')))?.pane).toBe('Verify waiting: 3 ahead (holder: unknown)')
  releaseVerifyHolder(world)
  await Promise.all(waits)
  expect(served).toEqual(['c', 'a', 'b'])
  expect(listQueue(world)).toEqual([])
})

// contract: a waiter whose wait is abandoned leaves the queue at once, and the waiter behind it moves up
test('an abandoned wait withdraws its ticket at once', async (_$, on) => {
  const world = createWorld(on, { ...changed }, approved)
  seedVerifyHolder(world)
  const control = new AbortController()
  const first = queue(world, 'first', control.signal)
  await world.clock.settle()
  const second = queue(world, 'second')
  await world.clock.settle()
  expect((await readVerifyQueue(sessionPort(world, 'second')))?.pane).toBe('Verify waiting: 2 ahead (holder: unknown)')
  control.abort()
  expect((await first).kind).toBe('cancelled')
  await world.clock.settle()
  expect((await readVerifyQueue(sessionPort(world, 'second')))?.pane).toBe('Verify waiting: 1 ahead (holder: unknown)')
  releaseVerifyHolder(world)
  expect((await second).kind).toBe('done')
})

// contract: a holder process that ends while the commands run stops them, records nothing and frees the lock
test('a lock lost while running records no Verify result', async ($, on) => {
  const gate: Gate = {}
  const world = createWorld(on, { ...changed }, { ...approved, spawnGate: new Promise(resolve => { gate.open = resolve }) })
  const run = $.tool.call(verify)
  await world.clock.settle()
  expect(world.hostLocks.kill(lock, 'sid/')).toBe(true)
  const result = (await run).result
  expect(result).toContain('Verify lock lost: the host process holding it ended')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns).toEqual([])
  expect(listQueue(world)).toEqual([])
})

for (const tool of ['verify', 'run'] as const) {
  // contract: Run log shows a Verify or run stopped by a lost lock with that reason, never as cancelled
  test(`a lock lost while ${tool} runs shows in Run log as lock lost, not cancelled`, async ($, on) => {
    const gate: Gate = {}
    const world = createWorld(on, { ...changed }, { ...approved, ...tool === 'run' ? { session: { flow: 'fix' } } : {},
      spawnGate: new Promise(resolve => { gate.open = resolve }) })
    const run = $.tool.call(tool === 'run' ? { tool: 'mcp__working-agreement__run', argv: ['check'] } : verify)
    await world.clock.settle()
    world.hostLocks.kill(lock, 'sid/')
    expect((await run).result).toContain('Verify lock lost: the host process holding it ended')
    await readFlowStatus($)
    const pane = await mountPane($)
    await pane.press({ key: 'l' })
    const text = textOf(await pane.drawn())
    expect(text).toContain(`${tool === 'run' ? 'run' : 'Verify'} · not recorded · lock lost`)
    expect(text).not.toContain('cancelled')
    await pane.unmount()
  })
}

// contract: a Verify that times out in the queue writes no record, withdraws its ticket and drops its queued row
test('a queued Verify times out without a record, a ticket or a queued row', async ($, on) => {
  const config = JSON.stringify({ always: [['check']], timeoutMinutes: 0.01 })
  const world = createWorld(on, { ...changed }, { verifyFile: config, approvedConfig: config })
  seedVerifyHolder(world)
  const run = $.tool.call(verify)
  await world.clock.advance(1000)
  expect((await run).result).toContain('Verify queued, timed out after 0.01 min')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns ?? []).toEqual([])
  expect(listQueue(world)).toEqual(['holder/0'])
  expect(world.views.at(-1)?.notes.some(note => note.key === 'Verify')).toBe(false)
})

test('sessions on different repositories do not wait for each other', async ($, on) => {
  const world = createWorld(on, { ...changed }, approved)
  seedVerifyHolder(world, '/other.git')
  expect((await $.tool.call(verify)).result).toContain('Verify passed')
})

/**
 * Builds options whose Verify config waits for CI jobs on the home runner.
 * @param jobs - The repository's Actions jobs, or a failure for every read.
 * @param timeoutMinutes - The Verify timeout, which also bounds the CI wait.
 * @returns The options.
 */
function waitingForCi(jobs: Options['actionsJobs'], timeoutMinutes = 30): Options {
  const config = JSON.stringify({ always: [['check']], timeoutMinutes, waitForCiLabels: ['home'] })
  return { verifyFile: config, approvedConfig: config, actionsJobs: jobs }
}

// contract: a holder waiting for CI on its runner shows CI running to every reader and keeps the queue's order until the job ends
test('a Verify waits for a CI job on its runner and runs in queue order when it ends', async ($, on) => {
  const options = { ...waitingForCi([{ status: 'in_progress', labels: ['self-hosted', 'home'] }]), herdrEnv: inside }
  const world = createWorld(on, { ...changed }, options)
  const run = $.tool.call(verify)
  await world.clock.settle()
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Queue', value: 'Verify holds the queue, waiting for CI', tone: 'text' })
  expect(world.runs.some(command => command.startsWith('herdr ') && command.includes('· Verify waiting for CI'))).toBe(true)
  expect(await readFlowStatus($)).toContain('Verify holds the queue, waiting for CI')
  await world.clock.advance(1)
  const next = queue(world, 'next')
  await world.clock.advance(1)
  expect((await readVerifyQueue(sessionPort(world, 'next')))?.pane).toBe('Verify waiting: 1 ahead (holder: #1 verify)')
  options.actionsJobs = [{ status: 'completed', labels: ['home'] }]
  await world.clock.advance(30000)
  expect((await run).result).toMatch(/^Verify passed/)
  await world.clock.advance(1000)
  expect((await next).kind).toBe('done')
  expect(world.views.at(-1)?.notes.some(note => note.key === 'Queue')).toBe(false)
})

for (const [label, options] of [
  ['no opt-in', { ...approved, actionsJobs: [{ status: 'in_progress', labels: ['home'] }] }],
  ['a job for another runner', waitingForCi([{ status: 'queued', labels: ['ubuntu-latest'] }])],
] satisfies [string, Options][]) {
  test(`${label} runs Verify without a CI wait`, async ($, on) => {
    createWorld(on, { ...changed }, options)
    expect((await $.tool.call(verify)).result).toMatch(/^Verify passed/)
  })
}

test('an unreadable CI state runs Verify and says so', async ($, on) => {
  const world = createWorld(on, { ...changed }, waitingForCi('gh: API rate limit exceeded (HTTP 403)'))
  const result = (await $.tool.call(verify)).result
  expect(result).toContain('CI state unknown (rate limited, retry later: gh: API rate limit exceeded (HTTP 403)), ran anyway')
  expect(result).toContain('Verify passed')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns).toHaveLength(1)
})

test('a CI wait past the timeout runs Verify anyway', async ($, on) => {
  const world = createWorld(on, { ...changed }, waitingForCi([{ status: 'in_progress', labels: ['home'] }], 0.01))
  const run = $.tool.call(verify)
  await world.clock.settle()
  await world.clock.advance(600)
  const result = (await run).result
  expect(result).toContain('CI still running when the 0.01 min wait ran out, ran anyway')
  expect(result).toContain('Verify passed')
})

// contract: a lock lost during the CI wait, before any command ran, says nothing ran and records nothing
test('a lock lost during the CI wait says no command ran', async ($, on) => {
  const world = createWorld(on, { ...changed }, waitingForCi([{ status: 'in_progress', labels: ['home'] }]))
  const run = $.tool.call(verify)
  await world.clock.settle()
  world.hostLocks.kill(lock, 'sid/')
  await world.clock.advance(1000)
  expect((await run).result).toBe('Verify lock lost before any command ran: the host process holding it ended; nothing ran and no record was written.')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns ?? []).toEqual([])
})

// contract: a CI wait whose hook budget falls below the floor ends with the budget outcome, before the engine drops the call
test('a CI wait stops at the budget floor', async (_$, on) => {
  const world = createWorld(on, { ...changed }, waitingForCi([{ status: 'in_progress', labels: ['home'] }]))
  const port: EnginePort = { ...sessionPort(world, 'ci'), budgetLeft: () => 2000 }
  const hold = await withVerifyTurn(port, common, 'ci', turn => waitCiIdle(port, turn, ['home'], { deadline: world.clock.now() + 600000, signal: new AbortController().signal, onMove: async () => {} }),
    { call: 'verify', deadline: world.clock.now() + 600000, signal: new AbortController().signal, onMove: async () => {} })
  expect(hold).toEqual({ kind: 'done', value: { kind: 'budget' } })
})

// contract: a Verify queued behind another session for longer than the hook budget returns its own result, never core's missing-hook text nor the guard's pre-call deny
test('a Verify queued past the hook budget behind another session gets its own result', { timeoutMs: 90_000 }, async ($, on) => {
  const world = createWorld(slowClockReads(on), { ...changed }, approved)
  seedVerifyHolder(world)
  const answer = JSON.stringify(await outlastBudget(world, $.tool.call(verify)))
  expect(answer).not.toContain('no tool.call hook answered')
  expect(answer).not.toContain('pre-call check timed out')
  expect(answer).toContain('Verify passed')
})

// contract: a Diagnose run waiting in the queue names itself, how many are ahead and the holder, never a Verify it did not call
test('a run waiting in the queue shows Run waiting with the holder, in the pane and the sidebar', async ($, on) => {
  const world = createWorld(on, { branch: 'fix', isDirty: true, tree: 'red' }, { session: { flow: 'fix' }, spawnCode: 7, herdrEnv: inside })
  seedVerifyHolder(world)
  const run = $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./check'] })
  await world.clock.settle()
  // why: the seeded holder's ticket names no kind, as a session older than the kinds writes it, so its kind is unknown.
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Queue', value: 'Run waiting: 1 ahead (holder: unknown)', tone: 'text' })
  expect(world.views.at(-1)?.notes.some(note => note.key === 'Verify')).toBe(false)
  expect(world.runs.some(command => command.startsWith('herdr ') && command.includes('· Run waiting (1 ahead)'))).toBe(true)
  releaseVerifyHolder(world)
  await world.clock.advance(1000)
  expect((await run).result).toContain('red recorded')
})

// contract: a holder waiting for CI shows the CI state, and keeps it after another ticket is ordered before its own
test('a Verify holding the queue for CI shows the CI wait, even behind a re-ordered ticket', async ($, on) => {
  const world = createWorld(on, { ...changed }, { ...waitingForCi([{ status: 'in_progress', labels: ['self-hosted', 'home'] }]), herdrEnv: inside })
  const run = $.tool.call(verify)
  await world.clock.settle()
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Queue', value: 'Verify holds the queue, waiting for CI', tone: 'text' })
  expect(world.runs.some(command => command.startsWith('herdr ') && command.includes('· Verify waiting for CI'))).toBe(true)
  // why: a ticket that sorts before the holder's, as one re-created under a lower arrival number does, makes the list name it first.
  world.hostLocks.seed(lock, 'other/0', false)
  await world.clock.advance(1000)
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Queue', value: 'Verify holds the queue, waiting for CI', tone: 'text' })
  expect(world.views.at(-1)?.notes.some(note => /waiting: \d+ ahead/.test(note.value))).toBe(false)
  world.hostLocks.kill(lock, 'sid/')
  await world.clock.advance(1000)
  await run
})

// contract: a waiter names the holder by its call and its session's issues, and each waiter names its own call
test('a waiter names the holder by call and issues, and a merge gate waits by name', async (_$, on) => {
  const world = createWorld(on, { ...changed }, { ...approved, session: { flow: 'fix', issues: [731] } })
  const release: { open?: () => void } = {}
  const holding = withVerifyTurn(createTestPort(world), common, 'sid', () => new Promise<void>(resolve => { release.open = resolve }),
    { call: 'verify', deadline: world.clock.now() + 600000, signal: new AbortController().signal, onMove: async () => {} })
  await world.clock.settle()
  const run = queue(world, 'run', undefined, 'run')
  await world.clock.advance(1)
  const gate = queue(world, 'gate', undefined, 'merge gate')
  await world.clock.advance(1)
  expect(await readVerifyQueue(sessionPort(world, 'run'))).toEqual({ pane: 'Run waiting: 1 ahead (holder: #731 verify)', sidebar: 'Run waiting (1 ahead)' })
  expect(await readVerifyQueue(sessionPort(world, 'gate'))).toEqual({ pane: 'Merge gate waiting: 2 ahead (holder: #731 verify)', sidebar: 'Merge gate waiting (2 ahead)' })
  release.open?.()
  await world.clock.advance(1000)
  expect((await holding).kind).toBe('done')
  expect((await run).kind).toBe('done')
  expect((await gate).kind).toBe('done')
})

// contract: a holder waiting for CI still shows as holding after the mod reloads during the hold
test('a reload during a CI hold still shows the holder as holding', async (_$, on) => {
  const world = createWorld(on, { ...changed }, waitingForCi([{ status: 'in_progress', labels: ['home'] }]))
  const harness = createModuleHarness(world)
  const stop = new AbortController()
  const hold = withVerifyTurn(harness.port, common, 'sid', turn => waitCiIdle(harness.port, turn, ['home'], { deadline: world.clock.now() + 600000, signal: stop.signal, onMove: async () => {} }),
    { call: 'verify', deadline: world.clock.now() + 600000, signal: stop.signal, onMove: async () => {} })
  await world.clock.settle()
  world.hostLocks.seed(lock, 'other/0', false)
  const holding = { pane: 'Verify holds the queue, waiting for CI', sidebar: 'Verify waiting for CI' }
  expect(await readVerifyQueue(harness.port)).toEqual(holding)
  await reloadModule(harness)
  expect(await readVerifyQueue(harness.port)).toEqual(holding)
  stop.abort()
  await world.clock.advance(1000)
  expect((await hold).kind).toBe('done')
})

// contract: a ticket whose own call cannot be read, as an older load of the session writes it, starts its row with the wait alone, never a guessed call
test('a waiter or holder of unknown call names no call', async (_$, on) => {
  const world = createWorld(on, { ...changed }, approved)
  world.hostLocks.seed(lock, 'waiter/1', false)
  world.hostLocks.seed(lock, 'holder/1')
  expect(await readVerifyQueue(sessionPort(world, 'waiter'))).toEqual({ pane: 'Waiting: 1 ahead (holder: unknown)', sidebar: 'Waiting (1 ahead)' })
  world.files.set(hostLockPath(common, 'verify.ci'), 'holder/1')
  expect(await readVerifyQueue(sessionPort(world, 'holder'))).toEqual({ pane: 'Holds the queue, waiting for CI', sidebar: 'Waiting for CI' })
})
