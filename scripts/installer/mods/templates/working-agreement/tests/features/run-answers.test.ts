import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EnginePort } from '../../hooks/core/engine-port'
import type { CallRef } from '../../hooks/core/command-calls'
import { answerCommandHook, answerFailedCommandCall, countLedgerEntries, stopDroppedCall, withdrawBoundMs } from '../../hooks/core/command-calls'
import { hostLockPath } from '../../hooks/core/host-lock'
import { withStoppableDispatch } from '../../hooks/core/tool-run'
import { handleRun } from '../../hooks/handlers/run'
import { handleVerify } from '../../hooks/handlers/verify'
import { test } from '../support/kit'
import { createModuleHarness, reloadModule } from '../support/reload'
import { releaseVerifyHolder, seedVerifyHolder } from '../support/helpers'
import { common, createWorld } from '../support/world'
import type { Checkout, Options, World } from '../support/world'

/** A held answer to a process call, released by the test. */
interface Gate { promise: Promise<void>; release: () => void }

const argv = ['./check']
const verifyFile = '{"always":[["./check"]]}'
const dropCause = "the engine dropped this call after the mod's hooks ran past their time budget"
const logPattern = /\/repo\.git\/working-agreement\/runs\/sid-\S+\.log/
const verifyLock = hostLockPath(common, 'verify')

/**
 * Builds a gate a fake waits on until the test releases it.
 * @returns The gate.
 */
function createGate(): Gate {
  const gate: Gate = { promise: Promise.resolve(), release: () => {} }
  gate.promise = new Promise<void>(resolve => { gate.release = resolve })
  return gate
}

/**
 * Fails the closing of every command log, as a full disk does once the command has run.
 * @param args - The process call.
 * @returns The failure, or undefined for any other call.
 */
const failLogClose = (args: string[]): { exitCode: number; stderr: string } | undefined => args[3] === 'verify-log' ? { exitCode: 1, stderr: 'disk full' } : undefined

/**
 * Fails the worktree listing, as a git whose index is locked does.
 * @param args - The process call.
 * @returns The failure, or undefined for any other call.
 */
const failWorktreeList = (args: string[]): { exitCode: number; stderr: string } | undefined => args.includes('worktree') && args.includes('list') ? { exitCode: 128, stderr: 'index locked' } : undefined

/**
 * Names a direct call by its own tool use id.
 * @param key - The id.
 * @returns The call.
 */
const ownCall = (key: string): CallRef => ({ key, isOwnerKnown: true })

/**
 * Starts a run dispatch the way the run hook does, stoppable under its call key, without the engine's budget.
 * @param port - The dispatch's port.
 * @param call - The call.
 * @returns Its answer.
 */
async function dispatchRun(port: EnginePort, call: CallRef): Promise<string> {
  return (await withStoppableDispatch(call.key, new AbortController().signal, signal => handleRun(port, { argv }, signal, call))).result
}

/**
 * Starts a Verify dispatch the way the verify hook does, stoppable under its call key, without the engine's budget.
 * @param port - The dispatch's port.
 * @param call - The call.
 * @returns Its answer.
 */
async function dispatchVerify(port: EnginePort, call: CallRef): Promise<string> {
  return (await withStoppableDispatch(call.key, new AbortController().signal, signal => handleVerify(port, signal, call))).result
}

/**
 * Calls a command tool through the engine.
 * @param $ - The test's engine.
 * @param tool - The tool.
 * @returns Its answer's text.
 */
async function callTool($: Engine, tool: 'run' | 'verify'): Promise<string> {
  return String((await $.tool.call({ tool: `mcp__working-agreement__${tool}`, ...(tool === 'run' ? { argv } : {}) })).result)
}

/**
 * Builds the options of a fix unit whose Verify config is approved.
 * @param extra - Further options.
 * @returns The options.
 */
const fixOptions = (extra: Options = {}): Options => ({ session: { flow: 'fix' }, verifyFile, approvedConfig: verifyFile, ...extra })

/**
 * Builds a dirty checkout of the fix branch.
 * @param tree - Its content tree.
 * @returns The checkout.
 */
const dirtyFix = (tree = 'changed'): Checkout => ({ branch: 'fix', isDirty: true, tree })

/**
 * Counts the commands the world spawned, which it logs among its process calls by their argv.
 * @param world - The test world.
 * @returns How many times the run's argv was spawned.
 */
const countSpawns = (world: World): number => world.runs.filter(run => run === JSON.stringify(argv)).length

/**
 * Waits for a direct dispatch, moving the clock as the engine would, since a direct port's waits end only when the clock moves.
 * @param world - The test world.
 * @param call - The dispatch.
 * @returns Its answer.
 */
async function finish<T>(world: World, call: Promise<T>): Promise<T> {
  const state = { isSettled: false }
  void call.then(() => { state.isSettled = true }, () => { state.isSettled = true })
  await advanceUntil(world, () => state.isSettled, 100, 600)
  return call
}

/**
 * Moves the clock a step at a time until the condition holds, or the steps run out.
 * @param world - The test world.
 * @param isDone - The condition.
 * @param stepMs - How far each step moves the clock.
 * @param left - The steps left.
 */
async function advanceUntil(world: World, isDone: () => boolean, stepMs: number, left = 50): Promise<void> {
  if (isDone() || left <= 0) return
  await world.clock.advance(stepMs)
  await advanceUntil(world, isDone, stepMs, left - 1)
}

for (const tool of ['run', 'verify'] as const) {
  const label = tool === 'run' ? 'Run' : 'Verify'
  // contract: a command that ran but whose log could not be closed is answered as stopped after it started, with its log and no record, never that it could not run
  test(`${tool} whose log cannot be closed after its command ran says it stopped, with its log`, async ($, on) => {
    createWorld(on, dirtyFix(), fixOptions({ spawnCode: 7, failRun: failLogClose }))
    const answer = await callTool($, tool)
    expect(answer).not.toContain('could not run')
    expect(answer).toContain(`${label} stopped: its dispatch failed, after the command${tool === 'run' ? '' : 's'} started; no record written. did not finish: disk full. Log: `)
    expect(answer).toMatch(logPattern)
  })

  // contract: a worktree listing that fails is a refusal naming the failed read, never that the unit's branch is checked out nowhere
  test(`${tool} with an unreadable worktree list says the read failed, never checked out nowhere`, async ($, on) => {
    createWorld(on, dirtyFix(), fixOptions({ failRun: failWorktreeList }))
    const answer = await callTool($, tool)
    expect(answer).not.toContain('checked out nowhere')
    expect(answer).toContain(`${label} refused: the worktree list could not be read (index locked), so whether the unit's branch is checked out is unknown; no record written.`)
  })

  // contract: a worktree that cannot be read after the command ran is a stop naming what ran, that nothing was recorded and that whether the tree changed is unknown, never that it changed
  test(`${tool} whose worktree cannot be read after its command ran says whether it changed the tree is unknown`, async ($, on) => {
    const after = { isArmed: false }
    createWorld(on, dirtyFix(), fixOptions({ spawnCode: 7, afterSpawn: () => { after.isArmed = true },
      failRun: args => after.isArmed && args.includes('write-tree') ? { exitCode: 128, stderr: 'index unreadable' } : undefined }))
    const answer = await callTool($, tool)
    expect(answer).not.toContain('change the tree')
    expect(answer).not.toContain('changes the tree')
    expect(answer).toContain(`${label} stopped: ${tool === 'run' ? 'the command' : 'the commands'} ran (`)
    expect(answer).toContain('so whether it changed the tree is unknown; no record written. Log: ')
  })
}

// contract: a second command-tool call while one is in flight is refused naming the live call's tool, start time, stage and log, never a bare "already in flight"; the wrapper's start token that marked the command running reaches neither an answer nor the run view
test('a second call while a run is in flight names the live call', async ($, on) => {
  const world = createWorld(on, dirtyFix(), fixOptions({ verifyFile: '{"always":[["./check"]],"timeoutMinutes":0.01}', approvedConfig: '{"always":[["./check"]],"timeoutMinutes":0.01}', spawnGate: new Promise(() => {}) }))
  const pending = callTool($, 'run')
  await world.clock.settle()
  const answer = await callTool($, 'verify')
  expect(answer).not.toBe('a run is already in flight')
  expect(answer).toMatch(/^verify refused: this session's run call started at \S+ is still in flight \(running its command \(log: \/repo\.git\/working-agreement\/runs\/sid-\S+\.log\)\); its result goes to that call\. Wait for it to answer, then call verify again; \/flow status shows it\.$/)
  await world.clock.advance(600)
  const settled = await pending
  expect(settled).toContain('timed out after 0.01 min')
  expect(JSON.stringify([answer, settled, [...world.files.values()], world.liveRuns])).not.toContain('wa-started')
})

// contract: a record written before the dispatch failed is answered as recorded, never as could not run nor as no record written
test('a run whose session read fails after its record was written says it stopped and was recorded', async (_$, on) => {
  const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7 }))
  const base = createModuleHarness(world).port
  // why: the engine skips a hook that throws, so the session store's failed read is modelled on the port.
  const harness = createModuleHarness(world, { readSessionState: async () => {
    const read = await base.readSessionState()
    if ((read.value as { units?: { runs?: unknown[] }[] } | undefined)?.units?.some(unit => unit.runs?.length)) throw new Error('session store unreadable')
    return read
  } })
  const answer = await finish(world, dispatchRun(harness.port, ownCall('read-after-record')))
  expect(answer).not.toContain('could not run')
  expect(answer).not.toContain('no record written')
  expect(answer).toContain('Run stopped: its dispatch failed, after the command started; recorded')
  expect(answer).toContain('did not finish: session store unreadable. Log: ')
  expect(world.sessions.get('sid')?.units[0]?.runs).toHaveLength(1)
})

// contract: a changed tree whose changed-paths diff fails is answered as stopped after the command started, with its log
test('a run whose tree changed and whose diff then fails says it stopped, with its log', async ($, on) => {
  const checkout = dirtyFix('before')
  createWorld(on, checkout, fixOptions({ afterSpawn: () => { checkout.tree = 'after' }, failRun: args => args.includes('--name-only') ? { exitCode: 128, stderr: 'bad object' } : undefined }))
  const answer = await callTool($, 'run')
  expect(answer).not.toContain('could not run')
  expect(answer).toContain('Run stopped: its dispatch failed, after the command started; no record written. did not finish: bad object. Log: ')
})

// contract: a command whose fork fails before its wrapper's start token is answered as not run, with no log cited, never as started
test('a run whose fork fails before any stream event says nothing of it ran and cites no log', async (_$, on) => {
  const world = createWorld(on, dirtyFix(), fixOptions({ spawnStart: 'fork-fails' }))
  // why: the engine skips a spawn hook that throws, so the failed fork is modelled on the port's stream.
  const answer = await finish(world, dispatchRun(createModuleHarness(world).port, ownCall('fork')))
  expect(answer).not.toContain('started')
  expect(answer).not.toContain('Log:')
  expect(answer).toBe('Run could not run: fork failed: resource temporarily unavailable; nothing of it ran; it left the Verify queue; no record written.')
  expect(world.sessions.get('sid')?.units[0]?.runs).toEqual([])
})

// contract: a first output that is not the wrapper's start token makes the outcome unknown, never started nor not started
test('a command whose first output is not the start token has an unknown outcome', async ($, on) => {
  createWorld(on, dirtyFix(), fixOptions({ spawnStart: 'garbage\n' }))
  const answer = await callTool($, 'run')
  expect(answer).toContain("Run: the outcome of this call is unknown: the command's start could not be confirmed (")
  expect(answer).toContain('check /flow status (Run log) before you call run again.')
  expect(answer).not.toContain('nothing of it ran')
  expect(answer).not.toContain('after the command started')
})

// contract: a Verify that selects no command, records, and then fails is answered as recorded, never that nothing of it ran and nothing was recorded
test('a Verify with no selected command that recorded and then failed says recorded', async (_$, on) => {
  const world = createWorld(on, dirtyFix(), fixOptions({ verifyFile: '{"always":[]}', approvedConfig: '{"always":[]}' }))
  const fault = { isFired: false }
  // why: the first clock read after the record and the shared evidence are written is the run view's finish, which fails once.
  const harness = createModuleHarness(world, {
    now: async () => {
      const isWritten = Boolean(world.sessions.get('sid')?.units[0]?.verifyRuns.length) && [...world.files.keys()].some(path => path.includes('/working-agreement/v/'))
      if (isWritten && !fault.isFired) {
        fault.isFired = true
        throw new Error('clock unreadable')
      }
      return world.clock.now()
    },
  })
  const answer = (await finish(world, handleVerify(harness.port, new AbortController().signal, ownCall('zero')))).result
  expect(answer).not.toContain('nothing of it ran')
  expect(answer).toContain('Verify stopped: its dispatch failed, after it ran no command; recorded. did not finish: clock unreadable.')
  expect(answer).not.toContain('Log:')
})

// contract: a record write still pending when the call is dropped is answered as unknown, never as recorded nor as not recorded
test('a record write pending across a drop says whether it was written is unknown', async (_$, on) => {
  const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7 }))
  const gate = createGate()
  const writing = { isHeld: false }
  const base = createModuleHarness(world).port
  const harness = createModuleHarness(world, {
    writeSessionState: async (value, version) => {
      if ((value as { units?: { runs?: unknown[] }[] })?.units?.some(unit => unit.runs?.length)) { writing.isHeld = true; await gate.promise }
      return base.writeSessionState(value, version)
    },
  })
  const pending = dispatchRun(harness.port, ownCall('pending-write'))
  await advanceUntil(world, () => writing.isHeld, 100)
  expect(writing.isHeld).toBe(true)
  const answer = stopDroppedCall('run', 'sid', ownCall('pending-write'))
  expect(answer).toContain(`Run stopped: ${dropCause}, while recording its result; stop requested, still withdrawing; whether its record was written is unknown; call run again once it has withdrawn.`)
  expect(answer).not.toContain('recorded;')
  expect(answer).not.toContain('no record written')
  gate.release()
  await finish(world, pending)
  expect(countLedgerEntries()).toBe(0)
})

// contract: a stop that lands while the call waits in the queue, racing the lock grant, starts no command, is answered as withdrawing from the queue, and a retry once it withdrew runs once
test('a queued run stopped as the lock is granted spawns nothing, and a retry runs once', async (_$, on) => {
  const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7 }))
  const harness = createModuleHarness(world)
  seedVerifyHolder(world)
  const pending = dispatchRun(harness.port, ownCall('queued'))
  await world.clock.settle()
  releaseVerifyHolder(world)
  const answer = answerFailedCommandCall('run', 'sid', ownCall('queued'), { kind: 'timeout', cause: 'its hook ran past its time budget' })
  expect(answer).toBe('Run stopped: its hook ran past its time budget, while waiting in the Verify queue or for CI; stop requested, still withdrawing; call run again once it has withdrawn.')
  expect(answer).not.toContain('nothing')
  await finish(world, pending)
  expect(countSpawns(world)).toBe(0)
  expect(await finish(world, dispatchRun(harness.port, ownCall('retry')))).toContain('red recorded')
  expect(countSpawns(world)).toBe(1)
})

// contract: a dropped call whose dispatch had already settled, with its hook's budget left, gets that answer once, prefixed with the drop; with no entry it is told the outcome is unknown, never that nothing of it still runs
test('a dropped call whose dispatch already answered gets that answer, once', async (_$, on) => {
  const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7 }))
  const harness = createModuleHarness(world)
  await finish(world, dispatchRun(harness.port, ownCall('late')))
  const answer = stopDroppedCall('run', 'sid', ownCall('late'))
  expect(answer).toContain(`Run: ${dropCause}; its dispatch had already finished, and answered:\nRun fail: exit 7.`)
  expect(answer).toContain('red recorded')
  const again = stopDroppedCall('run', 'sid', ownCall('late'))
  expect(again).toBe('Run: the outcome of this call is unknown: the mod holds no record of it; check /flow status (Run log) before you call run again.')
  expect(again).not.toContain('nothing of it is still running')
  expect(countLedgerEntries()).toBe(0)
})

// contract: a dropped call whose key fell back to the tool name is told its outcome is unknown, and the call in flight it cannot be matched to is not stopped
test('a dropped call with no tool use id gets the owner-unknown answer and stops no other call', async (_$, on) => {
  const gate = createGate()
  const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7, spawnGate: gate.promise }))
  const harness = createModuleHarness(world)
  const pending = dispatchRun(harness.port, ownCall('owned'))
  await world.clock.settle()
  const answer = stopDroppedCall('run', 'sid', { key: 'mcp__working-agreement__run', isOwnerKnown: false })
  expect(answer).toBe('Run: the outcome of this call is unknown: the run in flight could not be matched to this call; check /flow status (Run log) before you call run again.')
  gate.release()
  expect(await finish(world, pending)).toContain('red recorded')
})

// contract: the run and verify hooks' failure answer reads this call's ledger entry: a timeout of a running command is a stop naming its log, any other failure failed before its dispatch started
test('the hook failure answer names a running command on a timeout and a failure before the dispatch otherwise', async (_$, on) => {
  const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7, spawnGate: new Promise(() => {}) }))
  const harness = createModuleHarness(world)
  const pending = dispatchRun(harness.port, ownCall('hooked'))
  await world.clock.settle()
  const thrown = await answerCommandHook('run', async () => 'sid', ownCall('hooked'), { kind: 'throw', message: 'boom', budget: 10_000 })
  expect(thrown).toEqual({ result: '[working-agreement] Run could not run: boom; it failed before its dispatch started, so nothing of it ran.', isError: true })
  const timedOut = await answerCommandHook('run', async () => 'sid', ownCall('hooked'), { kind: 'timeout', budget: 10_000 })
  expect(timedOut.result).toMatch(/^\[working-agreement\] Run stopped: its hook ran past its time budget, while running its command \(log: \/repo\.git\/working-agreement\/runs\/sid-\S+\.log\); stop requested, still withdrawing; call run again once it has withdrawn\.$/)
  expect(await finish(world, pending)).toBe('Run cancelled; no record written.')
  expect(countLedgerEntries()).toBe(0)
})

for (const fault of ['exits non-zero', 'throws'] as const) {
  // contract: a group kill that exits non-zero, or throws, makes the answer say whether the command still runs is unknown, not the debug log alone
  test(`a group kill that ${fault} says whether the command still runs is unknown`, async (_$, on) => {
    const file = '{"always":[["./check"]],"timeoutMinutes":0.01}'
    const world = createWorld(on, dirtyFix('red'), fixOptions({ verifyFile: file, approvedConfig: file, spawnGate: new Promise(() => {}),
      failRun: args => fault === 'exits non-zero' && args[3] === 'verify-kill' ? { exitCode: 1, stderr: 'kill: operation not permitted' } : undefined }))
    const base = createModuleHarness(world).port
    const harness = createModuleHarness(world, fault === 'throws' ? { processes: { ...base.processes, run: async (args, init) => {
      if (args[3] === 'verify-kill') throw new Error('process table full')
      return base.processes.run(args, init)
    } } } : {})
    const answer = await finish(world, dispatchRun(harness.port, ownCall(`kill-${fault}`)))
    expect(answer).toContain('timed out after 0.01 min')
    expect(answer).toContain(`whether its command still runs is unknown: ${fault === 'throws' ? 'process table full' : 'kill: operation not permitted'}; check its process group and its log `)
  })
}

for (const clock of ['read', 'never read'] as const) {
  // contract: a stopped call still withdrawing past the bound is answered that whether any of it still runs is unknown, with how to check, never "call it again in a few seconds"; a stop whose time was never read is measured from the first retry that saw it
  test(`a call withdrawing past the bound, its stop time ${clock}, is answered unknown`, async (_$, on) => {
    const kill = createGate()
    const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7, spawnGate: new Promise(() => {}), beforeRun: args => args[3] === 'verify-kill' ? kill.promise : undefined }))
    const stopped = { isArmed: false }
    const harness = createModuleHarness(world, clock === 'never read' ? { now: async () => {
      if (stopped.isArmed) throw new Error('clock unreadable')
      return world.clock.now()
    } } : {})
    const retry = createModuleHarness(world).port
    const pending = dispatchRun(harness.port, ownCall('withdrawing'))
    await world.clock.settle()
    stopped.isArmed = true
    expect(stopDroppedCall('run', 'sid', ownCall('withdrawing'))).toContain('stop requested, still withdrawing')
    await world.clock.settle()
    const atLeast = clock === 'read' ? '' : 'at least '
    expect(await finish(world, dispatchRun(retry, ownCall('soon')))).toBe(`the previous run call was stopped ${atLeast}0 s ago and is still withdrawing; call it again in a few seconds`)
    await world.clock.advance(withdrawBoundMs + 1000)
    const late = await finish(world, dispatchRun(retry, ownCall('late')))
    expect(late).not.toContain('call it again in a few seconds')
    expect(late).toMatch(new RegExp(`^the previous run call was stopped ${atLeast}31 s ago and has not finished withdrawing, so whether any of it still runs is unknown; check its run in /flow status \\(Run log\\), its log /repo\\.git/working-agreement/runs/sid-\\S+\\.log, before you call run again\\.$`))
    stopped.isArmed = false
    kill.release()
    await finish(world, pending.catch(() => ''))
    expect(countLedgerEntries()).toBe(0)
  })
}

// contract: a failed write of the shared Verify evidence is named in Verify's answer, never left to the debug log
test("a failed shared evidence write is named in Verify's answer", async ($, on) => {
  createWorld(on, dirtyFix(), fixOptions({ renameFails: target => target.includes('/working-agreement/v/') }))
  const answer = await callTool($, 'verify')
  expect(answer).toContain('Verify passed')
  expect(answer).toContain('recorded for this unit; the shared evidence other sessions on this tree reuse was not written (')
  expect(answer).toContain('so they will not see this pass')
})

// contract: a settled call keeps its one ledger entry and never blocks: a recorded run, a Verify, a failure and a refusal each run, and each leaves one entry
test('a settled call keeps one ledger entry and never blocks the next call', async (_$, on) => {
  const options = fixOptions({ spawnCode: 7 })
  const world = createWorld(on, dirtyFix('red'), options)
  const harness = createModuleHarness(world)
  expect(await finish(world, dispatchRun(harness.port, ownCall('recorded')))).toContain('red recorded')
  expect(countLedgerEntries()).toBe(1)
  expect(await finish(world, dispatchVerify(harness.port, ownCall('verify')))).toContain('Verify failed')
  expect(countLedgerEntries()).toBe(1)
  options.failRun = failLogClose
  expect(await finish(world, dispatchRun(harness.port, ownCall('failed')))).toContain('Run stopped:')
  expect(countLedgerEntries()).toBe(1)
  options.failRun = failWorktreeList
  expect(await finish(world, dispatchRun(harness.port, ownCall('refused')))).toContain('Run refused:')
  expect(countLedgerEntries()).toBe(1)
})

// contract: the session's next command-tool call prunes a settled call's entry, so a drop of it afterwards is answered unknown, while a drop of the call that pruned it gets that call's answer
test("the session's next call prunes a settled entry", async (_$, on) => {
  const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7 }))
  const harness = createModuleHarness(world)
  expect(await finish(world, dispatchRun(harness.port, ownCall('first')))).toContain('red recorded')
  expect(await finish(world, dispatchRun(harness.port, ownCall('second')))).toContain('red recorded')
  expect(countLedgerEntries()).toBe(1)
  expect(stopDroppedCall('run', 'sid', ownCall('first'))).toBe('Run: the outcome of this call is unknown: the mod holds no record of it; check /flow status (Run log) before you call run again.')
  expect(stopDroppedCall('run', 'sid', ownCall('second'))).toContain(`Run: ${dropCause}; its dispatch had already finished, and answered:\nRun fail: exit 7.`)
  expect(countLedgerEntries()).toBe(0)
})

// contract: the ledger keeps at most one settled call per session, whatever the number of calls
test('the ledger keeps at most one settled call per session', async (_$, on) => {
  const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7 }))
  const own = createModuleHarness(world).port
  const other = createModuleHarness(world, { readSessionId: async () => 'other' }).port
  for (const [index, port] of [own, other, own, other, own].entries()) await finish(world, dispatchRun(port, ownCall(`call-${index}`)))
  expect(countLedgerEntries()).toBe(2)
  expect(stopDroppedCall('run', 'other', ownCall('call-3'))).toContain('its dispatch had already finished')
  expect(stopDroppedCall('run', 'sid', ownCall('call-4'))).toContain('its dispatch had already finished')
  expect(countLedgerEntries()).toBe(0)
})

for (const tool of ['run', 'verify'] as const) {
  // contract: a Verify lock lost after the grant and before the first spawn is answered that nothing ran and nothing was recorded, citing no log, never that the command was stopped while it ran
  test(`a ${tool} whose lock is lost before its spawn says nothing ran and cites no log`, async (_$, on) => {
    const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7 }))
    const base = createModuleHarness(world).port
    const kill = { isFired: false }
    // why: the run view's first write comes after the grant and before the spawn, so the holder dies in that window.
    const harness = createModuleHarness(world, { writeLiveRun: async run => {
      if (run && !kill.isFired) {
        kill.isFired = true
        world.hostLocks.kill(verifyLock, 'sid/')
        await world.clock.settle()
      }
      return base.writeLiveRun(run)
    } })
    const answer = await finish(world, tool === 'run' ? dispatchRun(harness.port, ownCall('lost')) : dispatchVerify(harness.port, ownCall('lost')))
    expect(kill.isFired).toBe(true)
    expect(answer).not.toContain('Log:')
    expect(answer).not.toContain('ran anyway')
    expect(answer).toBe(`Verify lock lost before ${tool === 'run' ? 'the command' : 'any command'} ran: the host process holding it ended; nothing ran and no record was written.`)
    expect(countSpawns(world)).toBe(0)
  })
}

// contract: a call dropped once its record was written, while it finishes, is answered with that record, never as waiting in the queue; a second call meanwhile is refused naming the same stage
test('a Verify dropped while finishing after its record names the record, never the queue', async (_$, on) => {
  const gate = createGate()
  const rename = { isHeld: false }
  const world = createWorld(on, dirtyFix(), fixOptions({ verifyFile: '{"always":[]}', approvedConfig: '{"always":[]}',
    beforeRun: args => {
      if (args[0] !== 'mv' || !args.some(arg => arg.includes('/working-agreement/v/'))) return undefined
      rename.isHeld = true
      return gate.promise
    } }))
  const harness = createModuleHarness(world)
  const pending = dispatchVerify(harness.port, ownCall('finishing'))
  await advanceUntil(world, () => rename.isHeld, 100)
  expect(rename.isHeld).toBe(true)
  const busy = await finish(world, dispatchRun(harness.port, ownCall('parallel')))
  expect(busy).not.toContain('Verify queue')
  expect(busy).toContain('is still in flight (finishing, recorded)')
  const answer = stopDroppedCall('verify', 'sid', ownCall('finishing'))
  expect(answer).not.toContain('Verify queue')
  expect(answer).toBe(`Verify stopped: ${dropCause}, while finishing, recorded; stop requested, still withdrawing; call verify again once it has withdrawn.`)
  gate.release()
  expect(await finish(world, pending)).toContain('Verify passed on tree changed: no command run.')
  expect(countLedgerEntries()).toBe(0)
})

// contract: a call that crosses a reload is answered unknown from the new module's empty ledger, never that nothing of it is still running
test('a dropped call that crossed a reload is answered unknown', async (_$, on) => {
  const gate = createGate()
  const world = createWorld(on, dirtyFix('red'), fixOptions({ spawnCode: 7, spawnGate: gate.promise }))
  const harness = createModuleHarness(world)
  const pending = dispatchRun(harness.port, ownCall('crossing'))
  await world.clock.settle()
  await reloadModule(harness)
  const answer = stopDroppedCall('run', 'sid', ownCall('crossing'))
  expect(answer).toBe('Run: the outcome of this call is unknown: the mod holds no record of it; check /flow status (Run log) before you call run again.')
  expect(answer).not.toContain('nothing of it is still running')
  gate.release()
  await harness.asOldModule(() => finish(world, pending))
})
