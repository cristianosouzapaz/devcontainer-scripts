import { expect } from 'claude-code/testing'

import type { EnginePort } from '../../hooks/core/engine-port'
import { mergeChildren } from '../../hooks/core/child-merge'
import { hostLockPath } from '../../hooks/core/host-lock'
import { readVerifyConfig } from '../../hooks/core/verify-config'
import { isStopped } from '../../hooks/domain/outcome'
import type { Result } from '../../hooks/lib/result'
import { buildChangedCheckout, coordinator } from '../support/builders'
import { seedVerifyHolder } from '../support/helpers'
import { test } from '../support/kit'
import { delegationCheckout, gatedCheckout, gateOptions, seedDelegatedChild, seedTwoChildren, tipA, tipB, twoChildren } from '../support/parallel-worktrees'
import { common, configBlob, createTestPort, createWorld, placedFile, records } from '../support/world'
import type { Options, World } from '../support/world'

/** A merge_child call made through a direct port, so the test holds its cancellation signal. */
interface Call { answer: Promise<Result<string>>; control: AbortController; text: () => Promise<string> }

const lock = hostLockPath(common, 'verify')
/** The merge commit of child `b` onto `a`, which the modelled merge names after `b`'s tip. */
const mergeB = `merge-${tipB}`
const ciError = 'gh: API rate limit exceeded (HTTP 403)'
// why: the CI lookup classifies a rate limit before it gives up, so its error carries that classification.
const ciLookupError = `rate limited, retry later: ${ciError}`

/**
 * Builds a gate config that waits for CI on the home runner.
 * @param timeoutMinutes - The Verify timeout, which bounds the CI wait too.
 * @returns The config text.
 */
const ciConfig = (timeoutMinutes = 30): string => JSON.stringify({ always: [['./check']], timeoutMinutes, waitForCiLabels: ['home'] })

/**
 * Starts merge_child through a direct port of the world's coordinator session.
 * @param world - The world.
 * @param children - The children, stacked in order, each given at its tip.
 * @param port - Overrides on the port, such as the hook budget.
 * @returns The call, its signal's controller and its text once settled.
 */
function startMerge(world: World, children: ('a' | 'b')[], port: Partial<EnginePort> = {}): Call {
  const control = new AbortController()
  const answer = mergeChildren({ ...createTestPort(world), ...port }, children.map(branch => ({ branch, tip: branch === 'a' ? tipA : tipB })), control.signal)
  return { answer, control, text: async () => { const result = await answer; return result.isOk ? result.value : result.error } }
}

/**
 * Moves the world's clock a step at a time until the call settles, so a wait bounded by the clock ends.
 * @param world - The world.
 * @param call - The call.
 * @param stepMs - The clock step.
 * @returns The call's result.
 */
async function settleByClock(world: World, call: Call, stepMs = 60000): Promise<Result<string>> {
  const state = { isSettled: false }
  void call.answer.then(() => { state.isSettled = true }, () => { state.isSettled = true })
  const advance = async (left: number): Promise<void> => {
    if (state.isSettled || !left) return
    await world.clock.advance(stepMs)
    await advance(left - 1)
  }
  await advance(200)
  return call.answer
}

/**
 * Tells a plain refusal from a stop or an unfinished call.
 * @param result - The call's result.
 * @returns Whether it is a refusal.
 */
const isRefusal = (result: Result<string>): boolean => !result.isOk && !isStopped(result) && !('isUnknown' in result)

/**
 * Asserts a stack answer that names no child as broken and says this call did not move the parent.
 * @param text - The answer's text.
 */
function expectNoCulprit(text: string): void {
  expect(text).not.toContain('Bisected')
  expect(text).not.toContain('Send this to')
  expect(text).not.toContain('stays at')
  expect(text).toContain('this call did not move par')
}

/**
 * Counts the gate commands the world spawned.
 * @param world - The world.
 * @returns How many ran.
 */
const countCommands = (world: World): number => world.runs.filter(run => run.startsWith('["./check"')).length

// contract: a stack whose top gate is cancelled in the queue names no child, runs no prefix gate and is a refusal that leaves the parent unmoved
test('a stack whose top gate is cancelled in the queue names no child and runs no prefix gate', async (_$, on) => {
  const { live, options } = twoChildren()
  const world = createWorld(on, live, options)
  await seedTwoChildren(world)
  seedVerifyHolder(world)
  const call = startMerge(world, ['a', 'b'])
  await world.clock.settle()
  call.control.abort()
  const result = await call.answer
  expect(isRefusal(result)).toBe(true)
  expectNoCulprit(await call.text())
  expect(await call.text()).toContain('cancelled')
  expect(world.runs.filter(run => run.includes('worktree add'))).toEqual([])
  expect(live.graph?.refs.par).toBe('p1')
})

for (const [name, arrange, expected] of [
  ['a lock lost before any command', (world: World, options: Options) => {
    options.actionsJobs = [{ status: 'in_progress', labels: ['home'] }]
    return async () => { await world.clock.settle(); world.hostLocks.kill(lock, 'sid/') }
  }, 'Verify lock lost before any command ran'],
  ['a queue timeout', (world: World) => { seedVerifyHolder(world); return async () => {} }, 'timed out after 30 min in the queue'],
  ['a queue that could not be joined', (_world: World, options: Options) => {
    options.failRun = argv => argv[0] === 'mkdir' && argv.at(-1)?.endsWith('/working-agreement/locks') ? { exitCode: 1, stderr: 'mkdir: cannot create directory: Read-only file system' } : undefined
    return async () => {}
  }, 'could not queue: mkdir: cannot create directory: Read-only file system'],
] as const) {
  // contract: a top gate that ends without running its commands is not red: it names no child, runs no bisection and moves nothing
  test(`a stack whose top gate meets ${name} names no child and moves nothing`, async (_$, on) => {
    const { live, options } = twoChildren()
    const config = ciConfig()
    const gated = { ...options, verifyFile: config, approvedConfig: config }
    const checkout = gatedCheckout(git => git, config)
    live.graph = checkout.graph
    const world = createWorld(on, live, gated)
    await seedTwoChildren(world)
    const act = arrange(world, gated)
    const call = startMerge(world, ['a', 'b'])
    await act()
    const result = await settleByClock(world, call)
    expect(isRefusal(result)).toBe(true)
    expect(await call.text()).toContain(expected)
    expectNoCulprit(await call.text())
    expect(countCommands(world)).toBe(0)
    expect(live.graph?.refs.par).toBe('p1')
  })
}

// contract: a gate whose lock is lost after its checkout and before its first spawn says no command ran and cites no log, never that its commands were stopped while they ran
test('a gate whose lock is lost before its first spawn says no command ran', async (_$, on) => {
  const { live, options } = twoChildren()
  const kill = { isFired: false }
  // why: the gate's checkout comes after the grant and before the spawn, so the holder dies in that window.
  const world: World = createWorld(on, live, { ...options, beforeRun: argv => {
    if (kill.isFired || !argv.includes('worktree') || !argv.includes('add')) return undefined
    kill.isFired = world.hostLocks.kill(lock, 'sid/')
    return world.clock.settle()
  } })
  await seedTwoChildren(world)
  const call = startMerge(world, ['a', 'b'])
  await settleByClock(world, call)
  const text = await call.text()
  expect(kill.isFired).toBe(true)
  expect(text).toContain('Verify lock lost before any command ran: the host process holding it ended, so nothing ran')
  expect(text).not.toContain('while the commands ran')
  expect(text).not.toContain('/working-agreement/runs/')
  expectNoCulprit(text)
  expect(countCommands(world)).toBe(0)
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a top gate stopped at the CI hook-budget floor names no child and moves nothing
test('a stack whose top gate stops at the CI budget floor names no child', async (_$, on) => {
  const config = ciConfig()
  const { live, options } = twoChildren()
  live.graph = gatedCheckout(git => git, config).graph
  const world = createWorld(on, live, { ...options, verifyFile: config, approvedConfig: config, actionsJobs: [{ status: 'in_progress', labels: ['home'] }] })
  await seedTwoChildren(world)
  const call = startMerge(world, ['a', 'b'], { budgetLeft: () => 2000 })
  const result = await call.answer
  expect(isRefusal(result)).toBe(true)
  expect(await call.text()).toContain('CI still holds the runner')
  expectNoCulprit(await call.text())
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a top tree whose Verify config is not approved is refused naming no child, never bisected onto a child
test('a stack whose top tree\'s config is not approved names no child and moves nothing', async (_$, on) => {
  const { live, options } = twoChildren()
  // why: both units are finished only while the config is approved, so the approval is withdrawn once the gate reads the top's tree.
  const world: World = createWorld(on, live, { ...options, beforeRun: argv => {
    if (argv.includes(`${mergeB}^{tree}`)) world.files.delete(`${records}/ok/${configBlob(options.approvedConfig!)}.json`)
  } })
  await seedTwoChildren(world)
  const call = startMerge(world, ['a', 'b'])
  const result = await call.answer
  expect(isRefusal(result)).toBe(true)
  expect(await call.text()).toContain('is not approved')
  expectNoCulprit(await call.text())
  expect(countCommands(world)).toBe(0)
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a red top whose bisection meets a prefix that is not verified names no culprit, keeps both answers and is a stop that moves nothing
test('a red top whose prefix gate loses its lock names no culprit and moves nothing', async (_$, on) => {
  const { live, options } = twoChildren([mergeB])
  const spawns = { count: 0 }
  const held: Options = { ...options }
  held.afterSpawn = () => {
    spawns.count += 1
    if (spawns.count === 1) held.spawnGate = new Promise<void>(() => {})
  }
  const world = createWorld(on, live, held)
  await seedTwoChildren(world)
  const call = startMerge(world, ['a', 'b'])
  await world.clock.settle()
  world.hostLocks.kill(lock, 'sid/')
  await world.clock.advance(1000)
  const result = await call.answer
  const text = await call.text()
  expect(isStopped(result)).toBe(true)
  expect(text).toContain('Verify failed on tree')
  expect(text).toContain('Verify lock lost')
  expect(text).toContain('no culprit could be named; this call did not move par')
  expect(text).not.toContain('Send this to')
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: an abort after a red top, whose prefix answers from a recorded pass, names the culprit and starts no parent move
test('an abort after a red top names the culprit and does not move the parent to the recorded green prefix', async (_$, on) => {
  const { live, options } = twoChildren([mergeB])
  const phase = { isArmed: false, spawned: false }
  const control = { value: null as AbortController | null }
  const world = createWorld(on, live, { ...options, afterSpawn: () => { phase.spawned = true }, beforeRun: argv => {
    if (phase.isArmed && phase.spawned && argv.join(' ').includes('worktree remove --force /par.verify')) control.value?.abort()
  } })
  await seedTwoChildren(world)
  expect((await startMerge(world, ['a']).answer).isOk).toBe(true)
  live.graph = { ...live.graph!, refs: { ...live.graph!.refs, par: 'p1' } }
  phase.isArmed = true
  phase.spawned = false
  const call = startMerge(world, ['a', 'b'])
  control.value = call.control
  const result = await call.answer
  const text = await call.text()
  expect(isStopped(result)).toBe(true)
  expect(text).toContain('Send this to b\'s unit')
  expect(text).toContain('cancelled before the parent move; this call did not move par')
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: an abort after a fresh green gate, before the parent move, moves nothing and says the call was cancelled before the move
test('an abort after a green gate, before the parent move, moves nothing', async (_$, on) => {
  const live = gatedCheckout()
  const phase = { spawned: false }
  const control = { value: null as AbortController | null }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: () => { phase.spawned = true }, beforeRun: argv => {
    if (phase.spawned && argv.join(' ').includes('worktree remove --force /par.verify')) control.value?.abort()
  } })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  control.value = call.control
  const result = await call.answer
  expect(isStopped(result)).toBe(true)
  expect(await call.text()).toContain('cancelled before the parent move; this call did not move par')
  expect(await call.text()).toMatch(/log: \S+\.log/)
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: an abort during the parent's placed-ref write starts no parent move, and says this call did not move the parent
test('an abort during the placed-ref write before the parent move moves nothing', async (_$, on) => {
  const live = gatedCheckout()
  const control = { value: null as AbortController | null }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, beforeRun: argv => {
    if (argv[0] === 'mv' && argv.at(-1) === placedFile('par', tipA)) control.value?.abort()
  } })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  control.value = call.control
  const result = await call.answer
  expect(isStopped(result)).toBe(true)
  expect(await call.text()).toContain('cancelled before the parent move; this call did not move par')
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a call cancelled while the gate's commands run names no child and is a stop naming the run's log
test('a cancel while the gate\'s commands run is a stop naming the log', async (_$, on) => {
  const { live, options } = twoChildren()
  const world = createWorld(on, live, { ...options, spawnGate: new Promise<void>(() => {}) })
  await seedTwoChildren(world)
  const call = startMerge(world, ['a', 'b'])
  await world.clock.settle()
  call.control.abort()
  const result = await call.answer
  const text = await call.text()
  expect(isStopped(result)).toBe(true)
  expect(text).toContain('cancelled while its commands ran')
  expect(text).toMatch(/log: \S+\.log/)
  expectNoCulprit(text)
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a gate command ended by a signal from outside is not red: it names no child, runs no bisection and moves nothing
test('a gate command ended by a signal names no child', async (_$, on) => {
  const { live, options } = twoChildren()
  const world = createWorld(on, live, { ...options, spawnCode: null, spawnSignal: 'SIGKILL' })
  await seedTwoChildren(world)
  const call = startMerge(world, ['a', 'b'])
  const result = await call.answer
  const text = await call.text()
  expect(isStopped(result)).toBe(true)
  expect(text).toContain('SIGKILL')
  expect(text).toContain('nothing counts')
  expectNoCulprit(text)
  expect(countCommands(world)).toBe(1)
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a gate that loses its lock mid-run leaves the worktree at its path to the next holder and says so
test('a gate that loses its lock mid-run does not remove the worktree a later holder uses', async (_$, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, spawnGate: new Promise<void>(() => {}) })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  await world.clock.settle()
  world.hostLocks.kill(lock, 'sid/')
  // why: the next holder removes the worktree it finds and checks out its own tree at the same path.
  live.worktrees = { ...live.worktrees, '/par.verify': { branch: 'HEAD', head: 'p1' } }
  await world.clock.advance(1000)
  const result = await call.answer
  expect(isStopped(result)).toBe(true)
  expect(await call.text()).toContain('worktree left at /par.verify')
  expect(live.worktrees?.['/par.verify']).toEqual({ branch: 'HEAD', head: 'p1' })
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a worktree an earlier gate left that cannot be removed stops the gate before any command runs, naming the worktree left and the error, never a refusal
test('a failed removal of a worktree an earlier gate left stops before any command runs, naming the worktree left', async (_$, on) => {
  const live = gatedCheckout()
  live.worktrees = { ...live.worktrees, '/par.verify': { branch: 'HEAD', head: 'p1' } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions,
    failRun: argv => argv.join(' ').includes('worktree remove --force /par.verify') ? { exitCode: 1, stderr: 'error: worktree is locked' } : undefined })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  const result = await call.answer
  const text = await call.text()
  expect(isStopped(result)).toBe(true)
  expect(text).toContain('could not be removed')
  expect(text).toContain('worktree left at /par.verify (error: worktree is locked)')
  expect(text).not.toContain('Send this to')
  expect(countCommands(world)).toBe(0)
  expect(live.worktrees?.['/par.verify']).toEqual({ branch: 'HEAD', head: 'p1' })
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a gate that removed a worktree an earlier gate left and then cannot check its tree out is a stop naming that removal, never a refusal
test('a removal of an earlier gate\'s worktree followed by a failed checkout is a stop naming the removal', async (_$, on) => {
  const live = gatedCheckout()
  live.worktrees = { ...live.worktrees, '/par.verify': { branch: 'HEAD', head: 'p1' } }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions,
    failRun: argv => argv.join(' ').includes('worktree add --detach /par.verify') ? { exitCode: 128, stderr: 'fatal: cannot add' } : undefined })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  const result = await call.answer
  const text = await call.text()
  expect(isStopped(result)).toBe(true)
  expect(text).toContain('cannot check tree')
  expect(text).toContain('this gate removed the worktree an earlier gate left at /par.verify')
  expect(countCommands(world)).toBe(0)
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a true red ran its commands, so it is a stop naming its log and the culprit and saying this call did not move the parent, never a refusal
test('a red single child is a stop naming its log and the culprit', async (_$, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, spawnCode: 1, spawnOutput: 'check: 1 failing' })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  const result = await call.answer
  const text = await call.text()
  expect(isStopped(result)).toBe(true)
  expect(text).toContain('Verify failed on tree')
  expect(text).toMatch(/see \S+\.log/)
  expect(text).toContain('Nothing was merged: this call did not move par.')
  expect(text).toContain('Send this to a\'s unit')
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a CI state the wait could not establish survives a later failure the gate catches, so the answer still leads with it
test('a gate that throws after an unknown CI state still leads with the CI line', async (_$, on) => {
  const config = ciConfig()
  const live = gatedCheckout(git => git, config)
  const world = createWorld(on, live, { session: coordinator, verifyFile: config, approvedConfig: config, actionsJobs: ciError,
    renameFails: target => target === placedFile('/par.verify', tipA) })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  await call.answer
  const text = await call.text()
  expect(text.startsWith(`CI state unknown (${ciLookupError}).\n`)).toBe(true)
  expect(text).toContain('the gate did not finish')
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a gate whose worktree removal fails names the worktree left and the error, as a stop or an unfinished call, never a refusal
test('a failed worktree removal is named with its error and is never a refusal', async (_$, on) => {
  const live = gatedCheckout()
  const phase = { spawned: false }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, spawnCode: 1, afterSpawn: () => { phase.spawned = true },
    failRun: argv => phase.spawned && argv.join(' ').includes('worktree remove --force /par.verify') ? { exitCode: 1, stderr: 'error: removal blocked' } : undefined })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  const result = await call.answer
  expect(isRefusal(result)).toBe(false)
  expect(await call.text()).toContain('worktree left at /par.verify')
  expect(await call.text()).toContain('error: removal blocked')
})

for (const [when, isAfter, wrong] of [['after', true, 'changed tree'], ['before', false, 'does not hold']] as const) {
  // contract: a tree that cannot be read around the gate's commands answers that it could not be read, never a change or a mismatch, and is never red
  test(`a tree read fault ${when} the commands answers could not be read`, async (_$, on) => {
    const live = gatedCheckout()
    const phase = { spawned: false }
    const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: () => { phase.spawned = true },
      failRun: argv => phase.spawned === isAfter && argv.includes('write-tree') && argv.includes('/par.verify') ? { exitCode: 128, stderr: 'fatal: index file corrupt' } : undefined })
    await seedDelegatedChild(world)
    const call = startMerge(world, ['a'])
    await call.answer
    const text = await call.text()
    expect(text).toContain('the tree at /par.verify could not be read (')
    expect(text).toContain('fatal: index file corrupt')
    expect(text).toContain('nothing counts')
    expect(text).not.toContain(wrong)
    expect(text).not.toContain('Send this to')
    expect(live.graph?.refs.par).toBe('p1')
  })
}

// contract: a config read that fails with the path present reads as unreadable with its error, never missing, in the gate
test('a failed config read in the gate answers unreadable, never missing', async (_$, on) => {
  const live = gatedCheckout()
  const phase = { isGate: false }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions,
    beforeRun: argv => { if (argv.includes(`${tipA}^{tree}`)) phase.isGate = true },
    failRun: argv => phase.isGate && argv.includes('cat-file') && argv.at(-1)?.endsWith(':.claude/working-agreement.json') ? { exitCode: 128, stderr: 'fatal: unable to read 0123abcd' } : undefined })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  await call.answer
  const text = await call.text()
  expect(text).toContain('unreadable (fatal: unable to read 0123abcd)')
  expect(text).not.toContain('no verify command configured')
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a failed config read in a unit's own Verify reads as unreadable with its error, never missing
test('a failed config read in the unit\'s Verify answers unreadable, never missing', async ($, on) => {
  const file = JSON.stringify({ always: [['check']] })
  createWorld(on, { ...buildChangedCheckout() }, { verifyFile: file, approvedConfig: file,
    failRun: argv => argv.includes('cat-file') && argv.at(-1)?.endsWith(':.claude/working-agreement.json') ? { exitCode: 128, stderr: 'fatal: unable to read 0123abcd' } : undefined })
  const result = String((await $.tool.call({ tool: 'mcp__working-agreement__verify' } as never)).result ?? '')
  expect(result).toContain('unreadable (fatal: unable to read 0123abcd)')
  expect(result).not.toContain('no verify command configured')
})

for (const [name, jobs, timeoutMinutes, line] of [
  ['fails', ciError, 30, `CI state unknown (${ciLookupError}), ran anyway`],
  ['runs out its wait', [{ status: 'in_progress', labels: ['home'] }], 0.01, 'CI still running when the 0.01 min wait ran out, ran anyway'],
] as const) {
  // contract: a gate whose CI lookup fails or whose CI wait runs out leads its answer with that line, ran anyway once a command started
  test(`a gate whose CI lookup ${name} leads with the CI line`, async (_$, on) => {
    const config = ciConfig(timeoutMinutes)
    const live = gatedCheckout(git => git, config)
    const world = createWorld(on, live, { session: coordinator, verifyFile: config, approvedConfig: config, actionsJobs: jobs as Options['actionsJobs'] })
    await seedDelegatedChild(world)
    const call = startMerge(world, ['a'])
    await settleByClock(world, call, 100)
    expect((await call.text()).startsWith(line)).toBe(true)
    expect(countCommands(world)).toBe(1)
  })
}

// contract: a CI line says ran anyway only when a command then started
test('a gate whose CI lookup fails and that runs no command leaves out ran anyway', async (_$, on) => {
  const config = ciConfig()
  const live = gatedCheckout(git => git, config)
  const world = createWorld(on, live, { session: coordinator, verifyFile: config, approvedConfig: config, actionsJobs: ciError,
    failRun: argv => argv.join(' ').includes('worktree add --detach /par.verify') ? { exitCode: 128, stderr: 'fatal: cannot add' } : undefined })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  await call.answer
  const text = await call.text()
  expect(text).toContain(`CI state unknown (${ciLookupError})`)
  expect(text).not.toContain('ran anyway')
  expect(countCommands(world)).toBe(0)
})

// contract: a red top whose gate saw an unknown CI state keeps that line through its bisection
test('a red top keeps its CI line through the bisection', async (_$, on) => {
  const config = ciConfig()
  const { live, options } = twoChildren([mergeB])
  live.graph = gatedCheckout(git => git, config).graph
  // why: only the top gate sees the unknown CI state, so the line the answer keeps can only be the top's.
  const held: Options = { ...options, verifyFile: config, approvedConfig: config, actionsJobs: ciError }
  held.afterSpawn = () => { held.actionsJobs = [] }
  const world = createWorld(on, live, held)
  await seedTwoChildren(world)
  const call = startMerge(world, ['a', 'b'])
  await call.answer
  const text = await call.text()
  expect(text.startsWith(`CI state unknown (${ciLookupError}), ran anyway.\n`)).toBe(true)
  expect(text.split('CI state unknown')).toHaveLength(2)
  expect(text).toContain('Bisected: Verify passed with the children before b and failed once it was added')
  expect(live.graph?.refs.par).toBe(tipA)
})

// contract: a config is missing only when a listing of the tree git completed has no config path; a failed listing reads as unreadable
test('a config is missing only from a completed tree listing without its path', async (_$, on) => {
  const listing = { fails: false }
  const world = createWorld(on, delegationCheckout(), { session: coordinator,
    failRun: argv => listing.fails && argv.includes('ls-tree') ? { exitCode: 128, stderr: 'fatal: bad object' } : undefined })
  await world.ready
  const port = createTestPort(world)
  expect(await readVerifyConfig(port, 'p1')).toEqual({ kind: 'missing', fact: 'no verify command configured' })
  listing.fails = true
  const unreadable = await readVerifyConfig(port, 'p1')
  expect(unreadable.kind).toBe('unreadable')
  expect(unreadable.kind === 'unreadable' && unreadable.fact).toContain('listing the tree failed too: fatal: bad object')
})

// contract: a gate whose evidence write fails says so with the error, so the failed write is never silent
test('a gate whose evidence write fails says so', async (_$, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, renameFails: target => target.startsWith(`${records}/v/`) })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  await call.answer
  expect(await call.text()).toContain('The gate evidence of tree ')
  expect(await call.text()).toContain('was not written (')
  expect(live.graph?.refs.par).toBe(tipA)
})

// contract: every gate of a bisection whose evidence write failed is named in the answer, the top's as well as a red prefix's
test('a bisection names the failed evidence write of the top and of the red prefix', async (_$, on) => {
  const { live, options } = twoChildren([tipA, mergeB])
  const world = createWorld(on, live, { ...options, renameFails: target => target.startsWith(`${records}/v/`) })
  await seedTwoChildren(world)
  const call = startMerge(world, ['a', 'b'])
  const result = await call.answer
  const text = await call.text()
  expect(text.split(/evidence was not written|gate evidence of tree \S+ was not written/)).toHaveLength(3)
  expect(text.split('The gate evidence of tree ')).toHaveLength(3)
  expect(isStopped(result)).toBe(true)
  expect(text).toContain('Bisected: Verify failed with only a')
  expect(live.graph?.refs.par).toBe('p1')
})

// contract: a fresh pass whose parent move fails ran its commands, so it is a stop naming the run and its log and, from the parent read back, where the parent stays
test('a fresh pass whose parent move fails is a stop naming the run and its log', async (_$, on) => {
  const live = gatedCheckout()
  const world = createWorld(on, live, { session: coordinator, ...gateOptions,
    failRun: argv => argv.includes('--ff-only') ? { exitCode: 128, stderr: 'fatal: Not possible to fast-forward, aborting.' } : undefined })
  await seedDelegatedChild(world)
  const call = startMerge(world, ['a'])
  const result = await call.answer
  const text = await call.text()
  expect(isStopped(result)).toBe(true)
  expect(text).toContain('(exit 128: fatal: Not possible to fast-forward, aborting.), so nothing was merged and par stays at p1')
  expect(text).toMatch(/Verify \S+ passed on tree \S+; log: \S+\.log/)
  expect(live.graph?.refs.par).toBe('p1')
})

for (const [name, children, redAt, notes] of [
  ['a passing top', ['a'], [], 1],
  ['a red top over an earlier passing prefix', ['a', 'b'], [mergeB], 2],
] as const) {
  // contract: a throw while the parent moves still names every failed evidence write of the call's gates, and is a call that did not finish
  test(`a throw while the parent moves after ${name} names every failed evidence write`, async (_$, on) => {
    const { live, options } = twoChildren([...redAt])
    const world = createWorld(on, live, { ...options,
      renameFails: target => target.startsWith(`${records}/v/`) || target === placedFile('par', tipA) })
    await seedTwoChildren(world)
    const call = startMerge(world, [...children])
    const result = await call.answer.catch((error: unknown) => ({ isOk: false as const, error: `threw: ${String(error)}` }))
    const text = result.isOk ? result.value : result.error
    expect(text.split('The gate evidence of tree ')).toHaveLength(notes + 1)
    expect('isUnknown' in result).toBe(true)
    expect(live.graph?.refs.par).toBe('p1')
  })
}

// contract: an answer that did not finish lists every check: a gate cleanup's that cannot tell its worktree is gone, and the parent move's that threw
test('a gate cleanup it cannot establish and a parent move that throws both name their checks', async (_$, on) => {
  const live = gatedCheckout()
  const phase = { spawned: false }
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, afterSpawn: () => { phase.spawned = true },
    renameFails: target => target === placedFile('par', tipA),
    failRun: argv => !phase.spawned ? undefined
      : argv.join(' ').includes('worktree remove --force /par.verify') ? { exitCode: 1, stderr: 'error: removal blocked' }
        : argv.join(' ').includes('worktree list --porcelain') ? { exitCode: 128, stderr: 'fatal: cannot list' } : undefined })
  await seedDelegatedChild(world)
  const result = await startMerge(world, ['a']).answer
  const check = 'check' in result && typeof result.check === 'string' ? result.check : ''
  expect(check).toContain('git worktree list')
  expect(check).toContain('git -C /par log -1')
  expect(live.graph?.refs.par).toBe('p1')
})
