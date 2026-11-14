import type { SessionContextBreakdown, SessionContextUsage } from 'claude-code'
import { isLongSession } from '../../hooks/features/handoff'
import { diagnosed, diagnosisComment, pushedCloseOut } from '../support/builders'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { test } from '../support/kit'
import { endTurn, enterOwnPrompt, readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand, startSession } from '../support/helpers'
import { findDelegation } from '../../hooks/core/delegation'
import { sendMail } from '../../hooks/core/mailbox'
import { doorbellText } from '../../hooks/domain/mail'
import { holdSpawnLock, releaseSpawnLock } from '../support/helpers'
import { createModuleHarness, reloadModule } from '../support/reload'
import { buildScope, createTestPort, createWorld, markSpawned, records, root, scopeFile, seedDelegation } from '../support/world'
import type { Gate, Options, World } from '../support/world'


/** The spawn lock's file. */
const spawnLock = `${records}/locks/spawn`


test('a handoff whose /handoff turn leaves one document clears and continues from it in a new session', async ($, on) => {
  const { commands, prompts, clock } = createWorld(on, { branch: 'feat', isDirty: true })
  await runFlowCommand($, 'handoff')
  await clock.settle()
  await $.turn.start({ text: '/handoff', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  await endTurn($)
  await clock.settle()
  expect(commands).toEqual(['handoff', 'clear'])
  expect(prompts.join('\n')).toContain('Continue from the handoff document at /tmp/handoff.md')
})

test('a handoff cancelled with /flow handoff cancel runs no /clear', async ($, on) => {
  const { commands, clock } = createWorld(on, { branch: 'feat' }, {})
  await runFlowCommand($, 'handoff')
  await clock.settle()
  expect((await runFlowCommand($, 'handoff cancel')).text).toContain('Handoff reset')
  await $.turn.start({ text: '/handoff', turnId: 't' })
  await endTurn($)
  await clock.settle()
  expect(commands).toEqual(['handoff'])
})

// contract: a handoff started while a turn runs waits for its own /handoff turn: the live turn's end and its writes are not the handoff's
test('a handoff started mid-turn is armed only by the next turn, so the live turn\'s end neither fails nor takes it', async ($, on) => {
  const { commands, prompts, clock, sessions } = createWorld(on, { branch: 'feat', isDirty: true })
  await $.turn.start({ text: 'work', turnId: 'w' })
  await runFlowCommand($, 'handoff')
  await clock.settle()
  await $.tool.call({ tool: 'Write', file_path: '/tmp/notes.md', content: 'Not the handoff.' })
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 'w' })
  await clock.settle()
  expect(sessions.get('sid')?.handoff?.state).toBe('running')
  expect(commands).toEqual(['handoff'])
  await $.turn.start({ text: '/handoff', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  await endTurn($)
  await clock.settle()
  expect(commands).toEqual(['handoff', 'clear'])
  expect(prompts.join('\n')).toContain('Continue from the handoff document at /tmp/handoff.md')
})

// contract: a /handoff run the engine rejects fails the handoff, so a later turn end neither clears nor continues
test('a handoff whose /handoff run fails is failed and leaves the next turn end alone', async ($, on) => {
  const { commands, prompts, clock, sessions } = createWorld(on, { branch: 'feat', isDirty: true }, { failedCommand: 'handoff' })
  await runFlowCommand($, 'handoff')
  await clock.settle()
  await $.turn.start({ text: '/handoff', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  await endTurn($)
  await clock.settle()
  expect(commands).toEqual([])
  expect(prompts.some(text => text.startsWith('Continue from the handoff'))).toBe(false)
  expect(sessions.get('sid')?.handoff?.state).toBe('failed')
})

// why: the handoff reads the checkout before it records itself; an issue sync landing meanwhile must survive that write.
test('labels an issue sync stores while a handoff starts survive the handoff\'s own write', async ($, on) => {
  const options: Options = { issueLabels: { 1: ['ready-for-agent'] } }
  const { clock } = createWorld(on, { branch: 'feat', isDirty: true }, options)
  const release: Gate = {}
  options.statusGate = new Promise<void>(resolve => { release.open = resolve })
  const starting = runFlowCommand($, 'handoff')
  await clock.settle()
  options.issueLabels = { 1: ['ready-for-agent', 'bug'] }
  await clock.advance(61000)
  await readPromptContext($)
  release.open?.()
  await starting
  expect(await readFlowStatus($)).toContain('bug')
})

test('handoff continues the previous identity and its mirror evidence in the new chat without copying it', async ($, on) => {
  // why: this probe precedes the world, whose command handler ends the chain.
  on('command.run', { command: 'clear' }, (_$, event, next) => { chat.id = 'next'; return next(event) })
  const { chat, clock, sessions, prompts } = createWorld(on, { branch: 'feature' }, {
    session: { flow: 'fix' }, unit: { skills: ['diagnosing-bugs'], ...diagnosed }, issueLabels: { 1: ['ready-for-agent'] }, comments: { 1: [diagnosisComment] },
  })
  await runFlowCommand($, 'handoff')
  await clock.settle()
  await $.turn.start({ text: '/handoff', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  await endTurn($)
  await clock.settle()
  expect(sessions.get('next')?.unit).toEqual({ branch: 'feature', issues: [1] })
  expect(sessions.get('next')?.sessionId).toBe('next')
  expect(sessions.get('next')?.units).toEqual([])
  expect(await readFlowStatus($)).toContain('Fix')
  expect(await readCurrentStep($)).toBe('Code')
  const resume = prompts.find(text => text.startsWith('Continue from the handoff document'))!
  expect(await enterOwnPrompt($, resume)).toContain('current step: Code')
})

/** The spawn record of an issue. */
const spawnFile = (issue: number): string => `${records}/spawn/${issue}.json`

/**
 * Reads the session an issue's spawn record names.
 * @param world - The world.
 * @param issue - The issue.
 * @returns The recorded session id, or undefined.
 */
const readRecordedSession = (world: World, issue: number): unknown => (JSON.parse(world.files.get(spawnFile(issue)) ?? '{}') as Record<string, unknown>).sessionId

/**
 * Builds a unit at Code of a Fix whose handoff clears into the chat ids given, one per `/clear`.
 * @param on - The test's hook registration.
 * @param ids - The chat id each `/clear` moves to.
 * @param options - World options added to the unit's.
 * @returns The world, in the unit's first chat, `sid`.
 */
function arrangeHandoff(on: Parameters<typeof createWorld>[0], ids: string[] = ['next'], options: Options = {}): World {
  const queue = [...ids]
  // why: this probe precedes the world, whose command handler ends the chain.
  on('command.run', { command: 'clear' }, (_$, event, next) => { world.chat.id = queue.shift() ?? world.chat.id; return next(event) })
  // why: the world keeps the options object itself, so a fault a test sets on it later reaches the world.
  const world = createWorld(on, { branch: 'feature' }, Object.assign(options, {
    session: { flow: 'fix' }, unit: { skills: ['diagnosing-bugs'], ...diagnosed }, issueLabels: { 1: ['ready-for-agent'] }, comments: { 1: [diagnosisComment] }, ...options,
  }))
  return world
}

/**
 * Runs `/flow handoff` through its /handoff turn, its `/clear` and the carry-over.
 * @param $ - The engine.
 * @param world - The world.
 */
async function handOff($: Engine, world: World): Promise<void> {
  await runFlowCommand($, 'handoff')
  await world.clock.settle()
  await $.turn.start({ text: '/handoff', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  await endTurn($)
  await world.clock.settle()
}

/**
 * Reads the states the handoff's transition log lines record, once the log's appends ran.
 * @param world - The world.
 * @returns The states, in order.
 */
async function readHandoffLog(world: World): Promise<unknown[]> {
  await world.clock.advance(1)
  return [...world.files].filter(([path]) => path.startsWith(`${records}/log/`))
    .flatMap(([, text]) => text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>))
    .filter(line => line.event === 'handoff').map(line => line.state)
}

/**
 * Reads the reason the Handoff row shows after `not completed · `.
 * @param world - The world.
 * @param id - The chat.
 * @returns The reason, or undefined when the handoff is not failed.
 */
const readHandoffReason = (world: World, id = 'next'): string | undefined => {
  const handoff = world.sessions.get(id)?.handoff
  return handoff?.state === 'failed' ? handoff.reason : undefined
}

// contract: a delegated unit's handoff rebinds its spawn record to the new session, every other field kept, so the new session is the delegated unit, and a second handoff rebinds again
test('a delegated unit\'s handoff leaves its spawn record naming the new session, which delegation then finds, and a second handoff rebinds again', async ($, on) => {
  const world = arrangeHandoff(on, ['next', 'third'])
  world.files.set(scopeFile('coord'), buildScope('coord', [1]))
  const record = { isStarted: true, isPrompted: true, mode: 'default', sessionId: 'sid', assignId: 'a1', startedAt: '2026-01-01T00:00:00.000Z', base: 'main', future: { kept: true } }
  world.files.set(spawnFile(1), JSON.stringify(record))
  await handOff($, world)
  expect(world.sessions.get('next')?.unit).toEqual({ branch: 'feature', issues: [1] })
  expect(readHandoffReason(world)).toBeUndefined()
  expect(JSON.parse(world.files.get(spawnFile(1)) ?? '{}')).toEqual({ ...record, sessionId: 'next', predecessors: ['sid'] })
  expect((await findDelegation(createTestPort(world), [1], true))?.sessionId).toBe('coord')
  expect(await readHandoffLog(world)).toEqual(['started', 'completed'])
  await handOff($, world)
  expect(JSON.parse(world.files.get(spawnFile(1)) ?? '{}')).toEqual({ ...record, sessionId: 'third', predecessors: ['sid', 'next'] })
  expect((await findDelegation(createTestPort(world), [1], true))?.sessionId).toBe('coord')
})

// contract: mail waiting for a delegated unit is delivered at its handoff's continuation prompt, and mail that arrives later reaches the idle continued session by the next tick
test('after a delegated unit\'s handoff, waiting mail enters with the continuation prompt and later mail rings by the next tick', async ($, on) => {
  const world = arrangeHandoff(on)
  seedDelegation(world, 'coord', [1])
  await handOff($, world)
  // why: a /clear starts the cleared chat's session, which registers its tick.
  await startSession($)
  const port = createTestPort(world)
  const coordinatorMail = (body: string): Promise<unknown> => sendMail(port, { kind: 'inform', to: '1', issue: 1, body, from: 'coordinator-coord' })
  await coordinatorMail('Waiting since the handoff.')
  const resume = world.prompts.find(text => text.startsWith('Continue from the handoff document'))!
  expect(await enterOwnPrompt($, resume)).toContain('Waiting since the handoff.')
  await $.turn.start({ text: resume, turnId: 'r' })
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 'r' })
  await world.clock.settle()
  await coordinatorMail('Arrived while idle.')
  await world.clock.advance(61000)
  await world.clock.settle()
  const doorbell = world.prompts.filter(text => text === doorbellText)
  expect(doorbell).toHaveLength(1)
  expect(await enterOwnPrompt($, doorbellText)).toContain('Arrived while idle.')
})

// contract: a handoff of a unit no scope covers moves only its own spawn record to the new session; no delegation, no other session's mailbox and no other record changes, and the handoff completes
test('an undelegated unit\'s handoff moves only its own spawn record, gains no delegation and completes', async ($, on) => {
  const world = arrangeHandoff(on)
  markSpawned(world, [1])
  world.files.set(spawnFile(2), JSON.stringify({ isStarted: true, isPrompted: true, mode: 'default', sessionId: 'other' }))
  const other = world.files.get(spawnFile(2))
  await handOff($, world)
  expect(JSON.parse(world.files.get(spawnFile(1)) ?? '{}')).toEqual({ isStarted: true, isPrompted: true, mode: 'default', sessionId: 'next', predecessors: ['sid'] })
  expect(world.files.get(spawnFile(2))).toBe(other)
  expect([...world.files.keys()].filter(path => path.startsWith(`${records}/delegation/`))).toEqual([])
  expect(await findDelegation(createTestPort(world), [1], true)).toBeNull()
  expect(readHandoffReason(world)).toBeUndefined()
  expect(await readHandoffLog(world)).toEqual(['started', 'completed'])
})

for (const [name, record, reason] of [['missing', undefined, 'the file does not exist'], ['naming a third session', 'third', 'it names session third']] as const) {
  // contract: a delegated handoff whose spawn record is missing or names a third session leaves it untouched, says this session is not the unit with the file to check, and is not completed
  test(`a delegated handoff whose spawn record is ${name} is confirmed unchanged and not completed`, async ($, on) => {
    const world = arrangeHandoff(on)
    world.files.set(scopeFile('coord'), buildScope('coord', [1]))
    if (record) markSpawned(world, [1], record)
    const before = world.files.get(spawnFile(1))
    await handOff($, world)
    expect(world.files.get(spawnFile(1))).toBe(before)
    expect(readHandoffReason(world)).toBe(`cleared and carried #1; its spawn record ${spawnFile(1)} was not changed (${reason}), so this session is not #1's delegated unit; check that file`)
    expect(await readHandoffLog(world)).toEqual(['started', 'failed'])
  })
}

// contract: a spawn record the rebind cannot read leaves whether it names the new session unknown, with the file and the error, and the handoff is not completed
test('a spawn record the rebind cannot read shows the unknown Handoff row and no completed handoff', async ($, on) => {
  const options: Options = {}
  const world = arrangeHandoff(on, ['next'], options)
  seedDelegation(world, 'coord', [1])
  await runFlowCommand($, 'handoff')
  await world.clock.settle()
  await $.turn.start({ text: '/handoff', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  options.failRead = path => path === spawnFile(1)
  await endTurn($)
  await world.clock.settle()
  expect(readHandoffReason(world)).toBe(`cleared and carried #1; whether its spawn record ${spawnFile(1)} names this session is unknown (no implementation for fs.read); `
    + 'check its sessionId against this session\'s id next')
  expect(await readHandoffLog(world)).toEqual(['started', 'failed'])
})

// contract: a two-issue unit whose one record is rebound and whose other write fails names both records, and the handoff is not completed
test('a rebind whose second record\'s write fails shows the partial Handoff row naming both records', async ($, on) => {
  const world = arrangeHandoff(on, ['next'], { session: { flow: 'fix', issues: [1, 2] }, renameFails: target => target === spawnFile(2) })
  seedDelegation(world, 'coord', [1, 2])
  await handOff($, world)
  expect(readRecordedSession(world, 1)).toBe('next')
  expect(readRecordedSession(world, 2)).toBe('sid')
  expect(readHandoffReason(world)).toBe(`cleared and carried #1, #2; #1's spawn record ${spawnFile(1)} now names this session; #2's spawn record ${spawnFile(2)} was not changed `
    + '(its write failed: rename failed), so this session is not #2\'s delegated unit; check that file')
  expect(await readHandoffLog(world)).toEqual(['started', 'failed'])
})

// contract: a rebind write whose outcome cannot be read back leaves the record unknown, never rebound or unchanged
test('a rebind write that fails and cannot be read back shows the unknown Handoff row', async ($, on) => {
  const options: Options = {}
  options.renameFails = target => {
    if (target !== spawnFile(1)) return false
    options.failRead = path => path === spawnFile(1)
    return true
  }
  const world = arrangeHandoff(on, ['next'], options)
  seedDelegation(world, 'coord', [1])
  await handOff($, world)
  expect(readHandoffReason(world)).toBe(`cleared and carried #1; whether its spawn record ${spawnFile(1)} names this session is unknown (its write failed (rename failed), `
    + `and reading it back failed: no implementation for fs.read); check its sessionId against this session's id next`)
  expect(await readHandoffLog(world)).toEqual(['started', 'failed'])
})

// contract: a spawn lock this process loses during the rebind leaves the record unknown or unchanged as established, never a completed handoff
test('a spawn lock lost during the rebind shows no completed handoff', async ($, on) => {
  const options: Options = {}
  const world = arrangeHandoff(on, ['next'], options)
  seedDelegation(world, 'coord', [1])
  // why: the lock is lost as the rebind reads the record, before its write.
  options.failRead = path => {
    if (path === spawnFile(1) && world.chat.id === 'next') world.hostLocks.kill(spawnLock, 'next')
    return false
  }
  await handOff($, world)
  const record = readRecordedSession(world, 1)
  expect([record, readHandoffReason(world)]).toEqual(record === 'sid'
    ? ['sid', `cleared and carried #1; its spawn record ${spawnFile(1)} was not changed (this process lost the spawn lock before the write), so this session is not #1's delegated unit; check that file`]
    : [record, `cleared and carried #1; whether its spawn record ${spawnFile(1)} names this session is unknown (this process lost the spawn lock during the rebind); `
      + 'check its sessionId against this session\'s id next'])
  expect(await readHandoffLog(world)).toEqual(['started', 'failed'])
})

// contract: a rebind whose spawn lock is lost between staging its write and the rename never renames over the record a competing writer wrote meanwhile, and is not completed
test('a rebind that loses the spawn lock between staging and rename leaves a competing writer\'s record in place', async ($, on) => {
  const competitor = JSON.stringify({ isStarted: true, isPrompted: true, mode: 'default', sessionId: 'sid', effort: 'high', reason: 'escalated: competitor' })
  // why: it acts at the rebind's staging write, before the rename.
  const world = arrangeHandoff(on, ['next'], { afterWrite: path => {
    if (world.chat.id === 'next' && path.startsWith(`${records}/spawn/.tmp-`) && world.hostLocks.kill(spawnLock, 'next')) world.files.set(spawnFile(1), competitor)
  } })
  seedDelegation(world, 'coord', [1])
  await handOff($, world)
  expect(world.files.get(spawnFile(1))).toBe(competitor)
  expect(readHandoffReason(world)).toMatch(new RegExp(`^cleared and carried #1; (its spawn record ${spawnFile(1)} was not changed \\(this process lost the spawn lock before the write\\)`
    + `|whether its spawn record ${spawnFile(1)} names this session is unknown \\(the lock holder ended before it answered the rename)`))
  expect(await readHandoffLog(world)).toEqual(['started', 'failed'])
})

// contract: the rebind decides from the local spawn records alone, so a scope whose native parent GitHub cannot answer never stops a record that names the cleared session from being rebound
test('a handoff rebinds a record naming the cleared session even while GitHub cannot answer the scope\'s native parent', async ($, on) => {
  const world = arrangeHandoff(on, ['next'], { session: { flow: 'fix', issues: [31] }, comments: { 31: [diagnosisComment] },
    gh: args => args.some(arg => arg.includes('{parent{number}}')) ? { exitCode: 1, stderr: 'HTTP 502' } : undefined })
  world.files.set(scopeFile('coord'), buildScope('coord', [3]))
  markSpawned(world, [31])
  await handOff($, world)
  expect(readRecordedSession(world, 31)).toBe('next')
  expect(readHandoffReason(world)).toBeUndefined()
  expect(await readHandoffLog(world)).toEqual(['started', 'completed'])
})

// contract: when no record named the cleared session and the scope read fails, the Handoff row says the record was not changed and that whether a scope covers the unit is unknown, never that it is undelegated, and the handoff is not completed
test('a handoff whose record names another session while GitHub cannot answer the scope says whether a scope covers the unit is unknown', async ($, on) => {
  // why: gh retries a 502 after host sleeps, which run on the test clock otherwise.
  const world = arrangeHandoff(on, ['next'], { session: { flow: 'fix', issues: [31] }, comments: { 31: [diagnosisComment] }, isSleepInstant: true,
    gh: args => args.some(arg => arg.includes('{parent{number}}')) ? { exitCode: 1, stderr: 'HTTP 502' } : undefined })
  world.files.set(scopeFile('coord'), buildScope('coord', [3]))
  markSpawned(world, [31], 'third')
  await handOff($, world)
  expect(readRecordedSession(world, 31)).toBe('third')
  expect(readHandoffReason(world)).toMatch(new RegExp(`^cleared and carried #31; its spawn record ${spawnFile(31)} was not changed \\(it names session third\\), so this session `
    + 'is not #31\'s delegated unit; check that file; whether a coordinator\'s scope covers #31 is unknown \\(.+\\); check delegation/ under working-agreement in git rev-parse --git-common-dir$'))
  expect(await readHandoffLog(world)).toEqual(['started', 'failed'])
})

// contract: a handoff whose rebind waits on the spawn lock when the mod reloads leaves the carried session's unknown note and no completed handoff
test('a reload between the carry-over and the rebind leaves the unknown Handoff row and no completed handoff', async ($, on) => {
  const world = arrangeHandoff(on)
  seedDelegation(world, 'coord', [1])
  holdSpawnLock(world)
  await handOff($, world)
  await reloadModule(createModuleHarness(world))
  expect(readHandoffReason(world)).toBe('cleared and carried #1; the rebind of its spawn record to this session has not finished yet; if this row stays after the '
    + 'continuation prompt, it did not finish in the load that cleared the session; check the sessionId of spawn/<issue>.json under working-agreement in '
    + 'git rev-parse --git-common-dir against this session\'s id next')
  expect(readRecordedSession(world, 1)).toBe('sid')
  expect(await readHandoffLog(world)).toEqual(['started'])
  // why: the replaced load's rebind still waits on the lock, so it is let finish within the test.
  releaseSpawnLock(world)
  await world.clock.settle()
})

for (const failure of ['carry-over', 'prompt'] as const) {
  test(`handoff ${failure} failure after clear is visible in the new session pane and status`, async ($, on) => {
    on('command.run', { command: 'clear' }, (_$, event, next) => {
      chat.id = 'next'
      return next(event)
    })
    // why: the carry-over's own write is the one that fails: a one-shot fault on a shared read could be taken by the turn-end audit, which runs beside the handoff.
    const { chat, clock, sessions, views, commands, prompts } = createWorld(on, { branch: 'feature' }, {
      missSessionWrite: value => failure === 'carry-over' && value.sessionId === 'next' && value.unit !== null,
      beforePromptSubmit: text => {
        if (failure === 'prompt' && text.startsWith('Continue from the handoff')) throw new Error('prompt failed')
      },
    })
    await runFlowCommand($, 'handoff')
    await clock.settle()
    await $.turn.start({ text: '/handoff', turnId: 't' })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
    await endTurn($)
    await clock.settle()
    expect(commands).toEqual(['handoff', 'clear'])
    expect(prompts.some(text => text.startsWith('Continue from the handoff'))).toBe(false)
    const handoff = sessions.get('next')?.handoff
    expect(handoff?.state).toBe('failed')
    const reason = handoff?.state === 'failed' ? handoff.reason : ''
    expect(reason.length).toBeGreaterThan(0)
    expect(views.at(-1)?.notes.find(note => note.key === 'Handoff')?.value).toBe(`not completed · ${reason}`)
    // why: one wording, shown once: the pane's note and the status row are the same fact.
    expect(((await readFlowStatus($)) ?? '').split('\n').filter(line => line.startsWith('Handoff'))).toEqual([`Handoff     not completed · ${reason}`])
  })
}

function context(window: number, tokens: number | undefined, totalTokens: number, free: number, threshold?: number): SessionContextUsage {
  const breakdown: SessionContextBreakdown = {
    categories: [{ kind: 'free', name: 'arbitrary label', tokens: free, color: 'inactive', isDeferred: false }],
    totalTokens, maxTokens: window, rawMaxTokens: window, autocompactSource: 'auto', percentage: 0,
    gridRows: [], model: 'test', memoryFiles: [], mcpTools: [], agents: [],
    autoCompactThreshold: threshold, isAutoCompactEnabled: threshold !== undefined, apiUsage: null,
  }
  return { window, tokens, breakdown }
}

for (const [name, usage, expected] of [
  ['200k room boundary without buffer', context(200000, 100000, 142000, 58000, 167000), true],
  ['200k one token above room boundary', context(200000, 100000, 141999, 58001, 167000), false],
  ['200k absent API tokens still uses room', context(200000, undefined, 142000, 58000, 167000), true],
  ['200k past compaction threshold', context(200000, 100000, 168000, 32000, 167000), true],
  ['1M used token boundary', context(1000000, 150000, 150000, 817000, 967000), true],
  ['1M below used token boundary', context(1000000, 149999, 149999, 817001, 967000), false],
  ['auto-compact off free boundary', context(200000, 100000, 100000, 25000), true],
  ['auto-compact off above free boundary', context(200000, 100000, 100000, 25001), false],
  ['no breakdown used boundary', { window: 200000, tokens: 150000 }, true],
  ['no breakdown below used boundary', { window: 200000, tokens: 149999 }, false],
  ['no breakdown absent tokens', { window: 200000 }, false],
] as [string, SessionContextUsage, boolean][]) {
  test(`session length: ${name}`, () => { expect(isLongSession(usage, 150000)).toBe(expected) })
}

test('the configured used-token threshold remains effective', () => {
  expect(isLongSession({ window: 1000000, tokens: 49999 }, 50000)).toBe(false)
  expect(isLongSession({ window: 1000000, tokens: 50000 }, 50000)).toBe(true)
})

test('session start applies a lowered handoff threshold before any turn completes', { options: { handoffTokens: 50000 } }, async ($, on) => {
  createWorld(on, { branch: 'feature' }, { contextUsage: () => ({ window: 200000, tokens: 50001 }) })

  await $.session.start({ cwd: root, surface: null, isInteractive: false })

  expect(await readFlowStatus($)).toContain('Continue in new session: /flow handoff')
})

test('summary context room marks the session long and offers continuation', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feature' }, {
    contextUsage: args => {
      expect(args.breakdown).toBe('summary')
      return context(200000, 100000, 142000, 58000, 167000)
    },
  })
  await endTurn($)
  await clock.settle()
  expect(await readFlowStatus($)).toContain('Continue in new session: /flow handoff')
})

for (const issues of [[], [1], [1, 2]]) {
  test(`handoff brief continues ${issues.length ? 'the finished unit' : 'work without a flow'} (${issues.length} issues)`, async ($, on) => {
    const briefs: string[] = []
    on('command.run', { command: 'handoff' }, (_$, event, next) => { briefs.push(event.args); return next(event) })
    const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: { ...pushedCloseOut.session, flow: issues.length ? 'close-out' : null, issues } })
    await runFlowCommand($, 'handoff')
    await clock.settle()
    expect(briefs.join('\n')).toContain(issues.length ? 'The next session continues this unit.' : 'The next session continues this work.')
    expect(briefs.join('\n')).not.toContain('follow-up on')
  })
}
