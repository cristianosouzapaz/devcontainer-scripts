import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { recordObservedEnd } from '../../hooks/core/child-end'
import type { EnginePort } from '../../hooks/core/engine-port'
import { readGit } from '../../hooks/core/repository'
import { readUnitSlice } from '../../hooks/core/unit-slice'
import type { UnitSlice } from '../../hooks/domain/step-states'
import { noFlow } from '../support/builders'
import { declareFlow, endTurn, readPaneCurrentStep, runFlowCommand, startSkill } from '../support/helpers'
import { buildChildEntry, observedEndFile, parentCheckout, readObservedEndFile, seedChildren, seedObservedEnd, withCommit } from '../support/parallel-worktrees'
import { createTestPort, createWorld, records, root } from '../support/world'
import type { Checkout, Gate, Options, World } from '../support/world'
import { parseSession } from '../../hooks/domain/records'
import type { SessionRecord, UnitEntry } from '../../hooks/domain/records'

/**
 * Reads this chat's session record as its mirror holds it.
 * @param world - The test world.
 * @returns The mirrored record; a missing or invalid mirror fails the test.
 */
function readRecord(world: World): SessionRecord {
  const record = parseSession(JSON.parse(world.files.get(`${records}/s/sid.json`) ?? 'null'))
  if (!record) throw new Error('the session mirror holds no valid record')
  return record
}

/**
 * Reads the skills this chat's record credits to its units.
 * @param world - The test world.
 * @returns The started skills.
 */
const readUnitSkills = (world: World): string[] => readRecord(world).units.flatMap(unit => unit.skills)

/**
 * Reads the labels this chat's record holds for issue 1.
 * @param world - The test world.
 * @returns The labels, or none when the issue info is an error.
 */
function readLabels(world: World): string[] {
  const info = readRecord(world).info[1]
  return info && 'labels' in info ? info.labels : []
}

test('a fact written during a run survives in the record and on the pane after the run ends', async ($, on) => {
  const gate: Gate = {}
  const options: Options = { session: noFlow, issueLabels: { 1: ['needs-triage'] }, spawnGate: new Promise(resolve => { gate.open = resolve }) }
  const world = createWorld(on, { branch: 'fix', isDirty: true, tree: 'red' }, options)
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await declareFlow($, 'fix', [1])
  const pending = $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./check'] })
  await world.clock.advance(3000)
  options.issueLabels = { 1: ['ready-for-agent'] }
  // The live run's last paint precedes the fact, so the run's moment has not seen it.
  await $.tool.call({ tool: 'Bash', command: 'gh issue edit 1 --remove-label needs-triage --add-label ready-for-agent' })
  await world.clock.settle()
  expect(readLabels(world)).toEqual(['ready-for-agent'])
  gate.open?.()
  await pending
  await world.clock.settle()
  expect(readLabels(world)).toContain('ready-for-agent')
  expect(readPaneCurrentStep(world.views)).toBe('Diagnose')
})

test('two overlapping writers both keep their facts in the record', async ($, on) => {
  const gate: Gate = {}
  const options: Options = { session: noFlow, issueLabels: { 1: ['needs-triage'] } }
  const world = createWorld(on, { branch: 'fix' }, options)
  await declareFlow($, 'fix', [1])
  await world.clock.advance(60000)
  options.issueLabels = { 1: ['ready-for-agent'] }
  options.issueGate = new Promise(resolve => { gate.open = resolve })
  // The turn's full refresh reads the session, then waits on the issue read before it writes.
  const turn = endTurn($)
  await world.clock.settle()
  await startSkill($, 'diagnosing-bugs')
  expect(readUnitSkills(world)).toEqual(['diagnosing-bugs'])
  gate.open?.()
  await turn
  expect(readLabels(world)).toContain('ready-for-agent')
  expect(readUnitSkills(world)).toContain('diagnosing-bugs')
})

test('a /flow command shows its new state over a refresh that read the session before it', async ($, on) => {
  const gate: Gate = {}
  const options: Options = { session: noFlow, issueLabels: { 1: ['needs-triage'] } }
  const world = createWorld(on, { branch: 'fix' }, options)
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await declareFlow($, 'fix', [1])
  expect(readPaneCurrentStep(world.views)).toBe('Triage')
  options.issueGate = new Promise(resolve => { gate.open = resolve })
  await world.clock.advance(60000)
  await runFlowCommand($, 'skip triage labelled elsewhere')
  expect(readPaneCurrentStep(world.views)).toBe('Diagnose')
  gate.open?.()
  await world.clock.settle()
  expect(readPaneCurrentStep(world.views)).toBe('Diagnose')
})

/** Child `b` (#3) of `par`, as a sibling's session records it. */
const childB = buildChildEntry('b', 3)

/**
 * Reads child `b`'s slice as a session's judgement does, then waits for the end it caches in that session's own file.
 * @param world - The test world.
 * @param sessionId - The observing session.
 * @param entry - The child's evidence.
 * @returns The slice.
 */
async function observeChild(world: World, sessionId = 'sid', entry: UnitEntry = childB): Promise<UnitSlice> {
  const port = { ...createTestPort(world), readSessionId: async () => sessionId }
  const git = (await readGit(port))!
  const slice = await readUnitSlice(port, entry.identity, entry, git)
  if (!slice) throw new Error('the child slice is unreadable')
  // why: The read never waits for its write; the same observation queued behind it settles once that write has.
  await recordObservedEnd(port, entry.identity, entry, git, slice, false)
  return slice
}

/**
 * Holds a port's first matching call until the test opens the gate.
 * @param world - The test world.
 * @param isHeld - Whether a process call is the one to hold.
 * @returns The port, the gate, and a promise settled once the held call is reached.
 */
function holdProcess(world: World, isHeld: (argv: string[]) => boolean): [EnginePort, Gate, Promise<void>] {
  const base = createTestPort(world)
  const gate: Gate = {}
  const held = new Promise<void>(resolve => { gate.open = resolve })
  const arrival: Gate = {}
  const reached = new Promise<void>(resolve => { arrival.open = resolve })
  const state = { isHeld: false }
  const run: EnginePort['processes']['run'] = async (argv, options) => {
    if (!state.isHeld && isHeld(argv)) { state.isHeld = true; arrival.open?.(); await held }
    return base.processes.run(argv, options)
  }
  return [{ ...base, processes: { ...base.processes, run } }, gate, reached]
}

/**
 * Creates the reference workflow from `par`'s worktree with child `b` at the given commit and in the records.
 * @param on - The engine hooks.
 * @param tip - Child `b`'s tip.
 * @returns The world and its checkout.
 */
async function createChildRecords(on: On, tip: string): Promise<[World, Checkout]> {
  const checkout = parentCheckout({ b: tip })
  const world = createWorld(on, checkout, { session: noFlow })
  await world.ready
  await seedChildren(world, [childB])
  return [world, checkout]
}

test("each session caches a child's slice end in its own file and never writes another session's", async (_$, on) => {
  const [world] = await createChildRecords(on, 'b1')
  const other = await seedObservedEnd(world, childB.identity, 'other', 'p1', childB.generation!)
  await observeChild(world)
  expect(await readObservedEndFile(world, childB.identity, 'sid')).toBe('b1')
  expect(world.files.get(other)).toBe(JSON.stringify({ v: 1, identity: childB.identity, generation: childB.generation, end: 'p1' }))
})

test('a unit that is no child, or a child slice with no commit, caches no end', async (_$, on) => {
  const [world] = await createChildRecords(on, 'p1')
  await observeChild(world)
  await observeChild(world, 'sid', { ...childB, baseBranch: 'main' })
  expect(await readObservedEndFile(world, childB.identity, 'sid')).toBeUndefined()
})

test('a slower observation never moves the cached end backward, judged against the live tip', async (_$, on) => {
  const [world, checkout] = await createChildRecords(on, 'b1')
  // why: The slower judgement has read the tip, then waits on its worktree listing while the user commits and a newer judgement caches its end.
  const [port, gate, reached] = holdProcess(world, argv => argv.includes('worktree'))
  const git = (await readGit(port))!
  const slow = readUnitSlice(port, childB.identity, childB, git)
  await reached
  checkout.graph = withCommit(checkout.graph!, 'b3', ['b1'], 'b')
  await observeChild(world)
  gate.open?.()
  const stale = (await slow)!
  expect(stale.end).toBe('b1')
  await recordObservedEnd(port, childB.identity, childB, git, stale, false)
  expect(await readObservedEndFile(world, childB.identity, 'sid')).toBe('b3')
})

test('a judgement never waits for the end it caches', async (_$, on) => {
  const [world] = await createChildRecords(on, 'b1')
  const [port, gate] = holdProcess(world, argv => argv[0] === 'mv')
  const git = (await readGit(port))!
  expect((await readUnitSlice(port, childB.identity, childB, git))?.end).toBe('b1')
  expect(await readObservedEndFile(world, childB.identity, 'sid')).toBeUndefined()
  gate.open?.()
  await observeChild(world)
  expect(await readObservedEndFile(world, childB.identity, 'sid')).toBe('b1')
})

test("a session's own stored end that is not JSON is replaced by its next observation", async (_$, on) => {
  const [world] = await createChildRecords(on, 'b1')
  world.files.set(await observedEndFile(childB.identity, 'sid'), '{')
  await observeChild(world)
  expect(await readObservedEndFile(world, childB.identity, 'sid')).toBe('b1')
})

test('an end the rewritten branch no longer reaches is replaced by the new one, even an older one', async (_$, on) => {
  const [world, checkout] = await createChildRecords(on, 'b1')
  checkout.graph = withCommit(checkout.graph!, 'b3', ['b1'], 'b')
  await observeChild(world)
  checkout.graph = { ...checkout.graph, refs: { ...checkout.graph.refs, b: 'b1' } }
  await observeChild(world)
  expect(await readObservedEndFile(world, childB.identity, 'sid')).toBe('b1')
})

test("a new lifetime of the unit replaces the cached end, even with an older one", async (_$, on) => {
  const [world, checkout] = await createChildRecords(on, 'b1')
  const slow = await observeChild(world, 'x')
  checkout.graph = withCommit(checkout.graph!, 'b3', ['b1'], 'b')
  await observeChild(world)
  const port = createTestPort(world)
  const renewed = { ...childB, generation: 'sid:2:1' }
  await recordObservedEnd(port, childB.identity, renewed, (await readGit(port))!, slow, false)
  expect(world.files.get(await observedEndFile(childB.identity, 'sid'))).toBe(JSON.stringify({ v: 1, identity: childB.identity, generation: 'sid:2:1', end: 'b1' }))
})

test('two sessions caching the same child at the same time both keep their observation', async (_$, on) => {
  const [world, checkout] = await createChildRecords(on, 'b1')
  const first = observeChild(world, 'x')
  checkout.graph = withCommit(checkout.graph!, 'b3', ['b1'], 'b')
  await Promise.all([first, observeChild(world, 'y')])
  expect(await readObservedEndFile(world, childB.identity, 'x')).toBeDefined()
  expect(await readObservedEndFile(world, childB.identity, 'y')).toBe('b3')
})

test("one session's overlapping observations of a child leave the newest end, whichever read its file first", async (_$, on) => {
  const [world, checkout] = await createChildRecords(on, 'b1')
  const slow = await observeChild(world, 'x')
  checkout.graph = withCommit(checkout.graph!, 'b3', ['b1'], 'b')
  const gate: Gate = {}
  const held = new Promise<void>(resolve => { gate.open = resolve })
  const path = await observedEndFile(childB.identity, 'sid')
  const reads = { held: false }
  const base = createTestPort(world)
  // why: The slow observation reads this session's file, then waits, so the newer one would otherwise write in between.
  const port = { ...base, files: { ...base.files, read: async (file: string) => {
    const text = await base.files.read(file).catch(() => null)
    if (file === path && !reads.held) { reads.held = true; await held }
    if (text === null) throw new Error(`no such file: ${file}`)
    return text
  } } }
  const git = (await readGit(port))!
  const older = recordObservedEnd(port, childB.identity, childB, git, slow, false)
  const newer = recordObservedEnd(port, childB.identity, childB, git, { ...slow, end: 'b3' }, false)
  await Promise.race([newer, world.clock.settle()])
  gate.open?.()
  await Promise.all([older, newer])
  expect(await readObservedEndFile(world, childB.identity, 'sid')).toBe('b3')
})
