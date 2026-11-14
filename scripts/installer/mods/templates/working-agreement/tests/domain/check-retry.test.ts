import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { EventResult, On } from 'claude-code'

import { describeGuardChecks, guardCatch } from '../../hooks/core/check-retry'
import { stopDroppedCall } from '../../hooks/core/command-calls'
import type { CaughtNext } from '../../hooks/core/check-retry'
import { test } from '../support/kit'
import { readFlowStatus, slowClockReads, waitReal as waitFor } from '../support/helpers'
import { common, createWorld } from '../support/world'

// why: the engine types leave out the timer globals, yet only a real-time wait outlasts a hook's budget and its catch grace.
declare function setTimeout(handler: () => void, delayMs: number): unknown
declare function clearTimeout(timer: unknown): void

/** What the fake check saw and what reached the tool. */
interface Probe { checks: number; ran: number }

/** What the probe tool answers, or the guard's deny. */
type ToolAnswer = EventResult<'tool.call'>

// why: the first run outlasts the engine's ten-second hook budget, so each test takes that long.
const slowTestMs = 30_000
const pastBudgetMs = 10_500
const tool = 'mcp__probe__write'

/**
 * Waits in real time.
 * @param delayMs - How long.
 * @param signal - Ends the wait early, rejecting, once it aborts.
 * @returns Once the time passed.
 */
function waitReal(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs)
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
  })
}

/**
 * Registers a guard on the probe tool whose check outlasts the hook budget on its first run, then takes retryMs on its retry;
 * the guard's .catch is the mod's own guardCatch.
 * @param on - The test's hook registration.
 * @param retryMs - How long the retry takes before it passes the call on.
 * @returns The probe the test reads.
 */
function registerSlowGuard(on: On, retryMs: number): Probe {
  const probe: Probe = { checks: 0, ran: 0 }
  const check = guardCatchCheck(probe, retryMs)
  // why: the test's hooks are one link of the chain: once its guard times out, nothing of the test's lies beneath the catch's next, so the guard's chain is the probe tool itself, carried by a stand-in for next with the real failure and grace.
  const runTool = (): Promise<ToolAnswer> => { probe.ran += 1; return Promise.resolve({ result: 'ran' }) }
  on('tool.call', { tool }, (_$, e, next) => check(e, runTool, next.signal))
    .catch((_$, e, next) => guardCatch<typeof e, ToolAnswer>({ guard: 'probe', label: 'pre-probe', check: proceed => check(e, proceed),
      deny: reason => ({ deny: reason }), sleep: waitReal })(e, standInFor(next, runTool)))
  // why: the mod's own hooks run on every call too, so they get the world they read.
  createWorld(on, { branch: 'feature' })
  return probe
}

/**
 * Stands in for a catch's next: the probe tool as the chain beneath, with the real failure, call state and grace read live.
 * @param next - The catch's next.
 * @param runTool - The probe tool.
 * @returns The stand-in.
 */
function standInFor<E>(next: Pick<CaughtNext<E, ToolAnswer>, 'error' | 'called' | 'budget'>, runTool: () => Promise<ToolAnswer>): CaughtNext<E, ToolAnswer> {
  const budget = { get ms(): number { return next.budget.ms }, get remainingMs(): number { return next.budget.remainingMs } }
  return Object.assign((): Promise<ToolAnswer> => runTool(), { error: next.error, called: next.called, budget })
}

/**
 * Builds the fake check: slow past the budget on its first run, which the engine's abort at the budget ends without
 * passing the call on, then retryMs on any later run, then passing.
 * @param probe - Where the runs are counted.
 * @param retryMs - How long a later run takes.
 * @returns The check.
 */
function guardCatchCheck(probe: Probe, retryMs: number) {
  return async <E, R>(event: E, proceed: (event: E) => Promise<R>, signal?: AbortSignal): Promise<R> => {
    probe.checks += 1
    await waitReal(probe.checks === 1 ? pastBudgetMs * 2 : retryMs, probe.checks === 1 ? signal : undefined)
    return proceed(event)
  }
}

/**
 * Calls the probe tool.
 * @param $ - The test engine.
 * @returns The call's answer.
 */
function callProbe($: Engine): ReturnType<Engine['tool']['call']> {
  return $.tool.call({ tool } as never)
}

test('a guard check that times out once and then passes allows the call, and the status counts the recovered timeout', { timeoutMs: slowTestMs }, async ($, on) => {
  const probe = registerSlowGuard(on, 0)
  const answer = await callProbe($)
  expect(answer.deny).toBeUndefined()
  expect(probe.ran).toBe(1)
  expect(describeGuardChecks()).toContain('probe 0 run, max 0 ms of the budget, 1 timed out (1 recovered by the retry)')
  // why: the status row the mod draws reads its own guards' measurements, so the probe's guard shows there.
  expect(await readFlowStatus($)).toMatch(/Checks\s+tool\.call \d+ run, max \d+ ms of the budget/)
})

// contract: a guard check that times out on both tries denies naming the guard and the timeout, never a bare failed check
test('a guard check that times out twice denies the call naming the guard and the timeout', { timeoutMs: slowTestMs }, async ($, on) => {
  const probe = registerSlowGuard(on, pastBudgetMs)
  const answer = await callProbe($)
  expect(answer.deny).toContain("The mod's pre-probe check timed out")
  expect(answer.deny).not.toContain('The check failed')
  expect(probe.ran).toBe(0)
})

test('a retry that finishes inside the margin before the grace ends is still denied', { timeoutMs: slowTestMs }, async ($, on) => {
  const probe = registerSlowGuard(on, 700)
  const answer = await callProbe($)
  await waitReal(1_000)
  expect(answer.deny).toContain('timed out')
  expect(probe.ran).toBe(0)
})

test('a retry that passes long after the deadline denied the call never runs the tool', { timeoutMs: slowTestMs }, async ($, on) => {
  const probe = registerSlowGuard(on, 3_000)
  const answer = await callProbe($)
  await waitReal(3_500)
  expect(answer.deny).toContain('timed out')
  expect(probe.ran).toBe(0)
})

// contract: a guard check that fails for another reason than a timeout denies at once, naming its error
test('a guard check that throws denies the call at once, naming its error', async ($, on) => {
  const probe: Probe = { checks: 0, ran: 0 }
  const runTool = (): Promise<ToolAnswer> => { probe.ran += 1; return Promise.resolve({ result: 'ran' }) }
  const check = (): Promise<ToolAnswer> => { probe.checks += 1; return Promise.reject(new Error('index unreadable')) }
  on('tool.call', { tool }, () => check())
    .catch((_$, e, next) => guardCatch<typeof e, ToolAnswer>({ guard: 'probe', check, deny: reason => ({ deny: reason }), sleep: waitReal })(e, standInFor(next, runTool)))
  createWorld(on, { branch: 'feature' })
  const answer = await callProbe($)
  expect(answer.deny).toContain('The check failed')
  expect(answer.deny).toContain('index unreadable')
  expect(probe).toEqual({ checks: 1, ran: 0 })
})

// contract: a mod tool's call the engine drops after the guard passed it on is answered with the state the mod observed, never core's missing-hook text nor the pre-call deny, and each claim holds
test('a run dropped past its hook budget after the guard passed it on is told what is left of it', { timeoutMs: 90_000 }, async ($, on) => {
  const delay = { ms: 0, isSlowed: false }
  const run = { tool: 'mcp__working-agreement__run', argv: ['./check'] } as never
  // why: the first run's first process call comes after the guard passed the call on, so from there each clock read charges three seconds to both hooks; the retries run unslowed.
  const world = createWorld(slowClockReads(on, () => delay.ms), { branch: 'fix', isDirty: true, tree: 'red' },
    { session: { flow: 'fix' }, spawnCode: 7, beforeRun: argv => { if (argv[0] === 'uname' && !delay.isSlowed) Object.assign(delay, { ms: 3_000, isSlowed: true }) } })
  const answer = JSON.stringify(await $.tool.call(run))
  delay.ms = 0
  expect(answer).toContain("Run stopped: the engine dropped this call after the mod's hooks ran past their time budget, while ")
  expect(answer).toContain('stop requested, still withdrawing')
  expect(answer).not.toContain('nothing of it')
  expect(answer).not.toContain('no tool.call hook answered')
  expect(answer).not.toContain('pre-call check timed out')
  expect((await $.tool.call(run)).result).toMatch(/^the previous run call was stopped (at least )?\d+ s ago and is still withdrawing; call it again in a few seconds$/)
  const retry = async (left: number): Promise<string> => {
    await waitFor(500)
    const result = String((await $.tool.call(run)).result)
    return result.includes('still withdrawing') && left > 0 ? retry(left - 1) : result
  }
  expect(await retry(40)).toContain('red recorded')
  expect(world.sessions.get('sid')?.units[0]?.runs).toHaveLength(1)
  expect(world.hostLocks.queues.get(`${common}/working-agreement/locks/verify`) ?? []).toEqual([])
})

// contract: a dropped command-tool call the ledger holds no entry for is told its outcome is unknown and how to check, never that nothing of it still runs
test('a dropped run with no ledger entry is told its outcome is unknown', () => {
  const answer = stopDroppedCall('run', 'idle-session', { key: 'no-such-call', isOwnerKnown: true })
  expect(answer).toBe('Run: the outcome of this call is unknown: the mod holds no record of it; check /flow status (Run log) before you call run again.')
  expect(answer).not.toContain('nothing of it is still running')
})

// contract: a dropped call of a mod tool the guard cannot stop is told it may still complete and to check before retrying, never that it stopped
test('a dropped call the mod cannot stop is told it may still be running', () => {
  const answer = stopDroppedCall('issue_create', 'sid', { key: 'mcp__working-agreement__issue_create', isOwnerKnown: false })
  expect(answer).toBe("issue_create may still be running: the engine dropped this call after the mod's hooks ran past their time budget, and the mod cannot stop it; wait, check its effect, and only then call it again.")
  expect(answer).not.toContain('issue_create stopped')
})
