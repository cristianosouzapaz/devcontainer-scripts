import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { noFlow } from '../support/builders'
import { declareFlow, endTurn, readPaneCurrentStep, runFlowCommand, startSkill } from '../support/helpers'
import { common, createWorld, root } from '../support/world'
import type { Gate, Options, World } from '../support/world'
import { parseSession } from '../../hooks/domain/records'
import type { SessionRecord } from '../../hooks/domain/records'

/**
 * Reads this chat's session record as its mirror holds it.
 * @param world - The test world.
 * @returns The mirrored record; a missing or invalid mirror fails the test.
 */
function readRecord(world: World): SessionRecord {
  const record = parseSession(JSON.parse(world.files.get(`${common}/working-agreement/s/sid.json`) ?? 'null'))
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
