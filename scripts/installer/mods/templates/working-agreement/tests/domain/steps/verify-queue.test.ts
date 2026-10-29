import { expect } from 'claude-code/testing'

import type { EnginePort } from '../../../hooks/core/engine-port'
import { breakStaleLock, leaveVerifyQueue, readVerifyQueue, waitVerifyTurn } from '../../../hooks/core/verify-queue'
import type { QueueWait } from '../../../hooks/core/verify-queue'
import { inside, readFlowStatus } from '../../support/helpers'
import { test } from '../../support/kit'
import { common, createTestPort, createWorld, records } from '../../support/world'
import type { Options, World } from '../../support/world'

const changed = { branch: 'feat', ahead: 8, isDirty: true, tree: 'one' }
const file = JSON.stringify({ always: [['check']] })
const approved: Options = { verifyFile: file, approvedConfig: file }
const dir = `${records}/verify`
const verify = { tool: 'mcp__working-agreement__verify' } as const

/**
 * Makes another session hold the lock, its ticket first in the queue.
 * @param world - The test world.
 * @param owner - Owner fields replacing a holder with no host identity.
 * @param root - The common directory whose queue it holds.
 */
function seedHolder(world: World, owner: Record<string, unknown> = {}, root = common): void {
  world.files.set(`${root}/working-agreement/verify/lock/owner.json`, JSON.stringify({ sid: 'holder', ticket: '000000000000000-holder', token: 'held',
    pidns: null, pid: null, pidStart: null, bootId: null, ...owner }))
  world.files.set(`${root}/working-agreement/verify/q/000000000000000-holder/lease`, '')
}

/**
 * Lets the seeded holder finish and release the lock.
 * @param world - The test world.
 */
function releaseHolder(world: World): void {
  for (const path of [...world.files.keys()]) if (path.startsWith(`${dir}/lock/`) || path.startsWith(`${dir}/q/000000000000000-holder/`)) world.files.delete(path)
}

/**
 * Ages a seeded lock and holder ticket past their lease.
 * @param world - The test world.
 */
function expireHolder(world: World): void {
  for (const path of [`${dir}/lock`, `${dir}/q/000000000000000-holder`]) world.modified.set(path, world.clock.now() - 31000)
}

/**
 * Builds a direct-dispatch port for another session on the same repository.
 * @param world - The test world.
 * @param sid - The session id.
 * @returns The port.
 */
const sessionPort = (world: World, sid: string): EnginePort => ({ ...createTestPort(world), readSessionId: async () => sid })

/**
 * Lists the queue's tickets.
 * @param world - The test world.
 * @returns The ticket names.
 */
const listTickets = async (world: World): Promise<string[]> => (await world.boundaries.files.list(`${dir}/q`).catch(() => [])).map(entry => entry.name)

test('a queued Verify shows its place everywhere and runs when the holder finishes', async ($, on) => {
  const world = createWorld(on, { ...changed }, { ...approved, herdrEnv: inside })
  seedHolder(world)
  const run = $.tool.call(verify)
  await world.clock.settle()
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Verify', value: 'queued, 2nd of 2', tone: 'warn' })
  expect(world.runs.some(command => command.startsWith('herdr ') && command.includes('· Verify queued, 2nd of 2'))).toBe(true)
  expect(await readFlowStatus($)).toContain('queued, 2nd of 2')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns ?? []).toEqual([])
  releaseHolder(world)
  await world.clock.advance(1000)
  expect((await run).result).toContain('Verify passed')
  expect(await listTickets(world)).toEqual([])
  expect(world.files.has(`${dir}/lock/owner.json`)).toBe(false)
  expect(world.views.at(-1)?.notes.some(note => note.key === 'Verify')).toBe(false)
})

test('waiters are served first come, first served', async (_$, on) => {
  const world = createWorld(on, { ...changed }, approved)
  seedHolder(world)
  const served: string[] = []
  const turns = new Map<string, QueueWait>()
  const waits: Promise<void>[] = []
  for (const sid of ['c', 'a', 'b']) {
    const port = sessionPort(world, sid)
    waits.push(waitVerifyTurn(port, common, sid, world.clock.now() + 600000, new AbortController().signal, async () => {}).then(wait => {
      served.push(sid)
      turns.set(sid, wait)
    }))
    await world.clock.advance(1)
  }
  expect(await readVerifyQueue(sessionPort(world, 'b'))).toBe('queued, 4th of 4')
  releaseHolder(world)
  for (const [index, sid] of ['c', 'a', 'b'].entries()) {
    await world.clock.advance(1000)
    expect(served).toEqual(['c', 'a', 'b'].slice(0, index + 1))
    if (sid === 'c') expect(await readVerifyQueue(sessionPort(world, 'b'))).toBe('queued, 3rd of 3')
    const wait = turns.get(sid)
    if (wait?.kind === 'acquired') await leaveVerifyQueue(sessionPort(world, sid), wait.turn)
  }
  await Promise.all(waits)
  expect(await listTickets(world)).toEqual([])
})

test('a killed holder and a dead waiter stop blocking the queue once their leases expire', async ($, on) => {
  const world = createWorld(on, { ...changed }, approved)
  seedHolder(world)
  world.files.set(`${dir}/q/000000000000001-dead/lease`, '')
  world.modified.set(`${dir}/q/000000000000001-dead`, world.clock.now() - 31000)
  const run = $.tool.call(verify)
  await world.clock.settle()
  expect(await readFlowStatus($)).toContain('queued, 2nd of 2')
  expireHolder(world)
  await world.clock.settle()
  await world.clock.advance(1000)
  expect((await run).result).toContain('Verify passed')
  expect(await listTickets(world)).toEqual([])
})

for (const [label, pidns, isBroken] of [['the same', 'pid:[1]', true], ['another', 'pid:[2]', false]] as const) {
  test(`a dead holder pid on ${label} pid namespace ${isBroken ? 'is broken before its lease expires' : 'waits for its lease'}`, async ($, on) => {
    const world = createWorld(on, { ...changed }, { ...approved, verifyFile: JSON.stringify({ always: [['check']], timeoutMinutes: 0.05 }),
      approvedConfig: JSON.stringify({ always: [['check']], timeoutMinutes: 0.05 }), pidNamespace: 'pid:[1]' })
    world.files.set('/proc/self/stat', `100 (claude code) S ${Array.from({ length: 19 }, (_, index) => index + 4).join(' ')} 5000 0`)
    world.files.set('/proc/sys/kernel/random/boot_id', 'boot\n')
    seedHolder(world, { pidns, bootId: 'boot', pid: 4242, pidStart: '77' })
    const run = $.tool.call(verify)
    await world.clock.settle()
    await world.clock.advance(isBroken ? 0 : 4000)
    expect((await run).result).toContain(isBroken ? 'Verify passed' : 'Verify queued, timed out')
  })
}

test('a stale lock broken by two waiters at once has a single winner', async (_$, on) => {
  const world = createWorld(on, { ...changed }, approved)
  seedHolder(world)
  expireHolder(world)
  const broken = await Promise.all(['a', 'b'].map(sid => breakStaleLock(sessionPort(world, sid), dir, sid)))
  expect(broken.filter(Boolean)).toHaveLength(1)
  expect([...world.files.keys()].some(path => path.startsWith(`${dir}/lock`))).toBe(false)
  seedHolder(world)
  expireHolder(world)
  const served: string[] = []
  const control = new AbortController()
  const waits: Promise<unknown>[] = []
  for (const sid of ['a', 'b']) {
    waits.push(waitVerifyTurn(sessionPort(world, sid), common, sid, world.clock.now() + 600000, control.signal, async () => {})
      .then(wait => { if (wait.kind === 'acquired') served.push(sid) }))
    await world.clock.advance(1)
  }
  await world.clock.advance(1000)
  await world.clock.advance(1000)
  expect(served).toEqual(['a'])
  expect(await readVerifyQueue(sessionPort(world, 'b'))).toBe('queued, 2nd of 2')
  control.abort()
  await world.clock.advance(1000)
  await Promise.all(waits)
})

test('a lock lost while running records no Verify result', async ($, on) => {
  const gate: { open?: () => void } = {}
  const world = createWorld(on, { ...changed }, { ...approved, spawnGate: new Promise(resolve => { gate.open = resolve }) })
  const run = $.tool.call(verify)
  await world.clock.settle()
  const thief = JSON.stringify({ sid: 'thief', ticket: '000000000000009-thief', token: 'stolen' })
  world.files.set(`${dir}/lock/owner.json`, thief)
  gate.open?.()
  expect((await run).result).toContain('Verify lock lost')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns).toEqual([])
  expect(world.files.get(`${dir}/lock/owner.json`)).toBe(thief)
  expect(await listTickets(world)).toEqual([])
})

test('a queued Verify times out without a record or a ticket', async ($, on) => {
  const config = JSON.stringify({ always: [['check']], timeoutMinutes: 0.01 })
  const world = createWorld(on, { ...changed }, { verifyFile: config, approvedConfig: config })
  seedHolder(world)
  const run = $.tool.call(verify)
  await world.clock.advance(1000)
  expect((await run).result).toContain('Verify queued, timed out after 0.01 min')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns ?? []).toEqual([])
  expect(await listTickets(world)).toEqual(['000000000000000-holder'])
})

test('sessions on different repositories do not wait for each other', async ($, on) => {
  const world = createWorld(on, { ...changed }, approved)
  seedHolder(world, {}, '/other.git')
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

test('a Verify waits for a CI job on its runner and runs in queue order when it ends', async ($, on) => {
  const options = { ...waitingForCi([{ status: 'in_progress', labels: ['self-hosted', 'home'] }]), herdrEnv: inside }
  const world = createWorld(on, { ...changed }, options)
  const run = $.tool.call(verify)
  await world.clock.settle()
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Verify', value: 'queued: CI running', tone: 'warn' })
  expect(world.runs.some(command => command.startsWith('herdr ') && command.includes('· Verify queued: CI running'))).toBe(true)
  expect(await readFlowStatus($)).toContain('queued: CI running')
  await world.clock.advance(1)
  const next = waitVerifyTurn(sessionPort(world, 'next'), common, 'next', world.clock.now() + 600000, new AbortController().signal, async () => {})
  await world.clock.advance(1)
  expect(await readVerifyQueue(sessionPort(world, 'next'))).toBe('queued, 2nd of 2')
  options.actionsJobs = [{ status: 'completed', labels: ['home'] }]
  await world.clock.advance(30000)
  expect((await run).result).toMatch(/^Verify passed/)
  await world.clock.advance(1000)
  expect((await next).kind).toBe('acquired')
  expect(world.views.at(-1)?.notes.some(note => note.key === 'Verify')).toBe(false)
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
  expect(result).toContain('CI state unknown')
  expect(result).toContain('Verify passed')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns).toHaveLength(1)
})

test('a CI wait past the timeout runs Verify anyway', async ($, on) => {
  const world = createWorld(on, { ...changed }, waitingForCi([{ status: 'in_progress', labels: ['home'] }], 0.01))
  const run = $.tool.call(verify)
  await world.clock.settle()
  await world.clock.advance(600)
  const result = (await run).result
  expect(result).toContain('CI still running after 0.01 min, ran anyway')
  expect(result).toContain('Verify passed')
})
