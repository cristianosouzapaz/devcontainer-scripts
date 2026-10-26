import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { noFlow } from '../support/builders'
import { declareFlow, readPaneCurrentStep, startSkill } from '../support/helpers'
import { createWorld, root } from '../support/world'
import type { Gate, Options } from '../support/world'

const issueReads = (runs: string[]): number => runs.filter(run => run.includes('issue(number:')).length

test('a gh call that changes the issue labels reaches the pane before the next tick', async ($, on) => {
  const options: Options = { session: noFlow, issueLabels: { 1: ['needs-triage'] } }
  const { views, clock } = createWorld(on, { branch: 'fix' }, options)
  await declareFlow($, 'fix', [1])
  expect(readPaneCurrentStep(views)).toBe('Triage')
  await clock.advance(5000)
  options.issueLabels = { 1: ['ready-for-agent'] }
  await $.tool.call({ tool: 'Bash', command: 'gh issue edit 1 --remove-label needs-triage --add-label ready-for-agent' })
  await clock.settle()
  await startSkill($, 'diagnosing-bugs')
  await clock.settle()
  expect(readPaneCurrentStep(views)).toBe('Diagnose')
})

test('a Bash call that does not invoke gh reads no issue', async ($, on) => {
  const { runs, clock } = createWorld(on, { branch: 'fix' }, { session: noFlow, issueLabels: { 1: ['needs-triage'] } })
  await declareFlow($, 'fix', [1])
  await clock.advance(5000)
  const before = issueReads(runs)
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  await clock.settle()
  expect(issueReads(runs)).toBe(before)
})

test('a tick during a run reaches the pane while the live run keeps updating', async ($, on) => {
  const gate: Gate = {}
  const options: Options = { session: noFlow, issueLabels: { 1: ['needs-triage'] }, spawnGate: new Promise(resolve => { gate.open = resolve }) }
  const { views, liveRuns, clock } = createWorld(on, { branch: 'fix', isDirty: true, tree: 'red' }, options)
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await declareFlow($, 'fix', [1])
  const pending = $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./check'] })
  await clock.advance(3000)
  options.issueLabels = { 1: ['ready-for-agent'] }
  await clock.advance(60000)
  const painted = liveRuns.length
  await clock.advance(3000)
  const step = readPaneCurrentStep(views)
  const durations = liveRuns.slice(painted).map(run => run?.duration ?? -1)
  gate.open?.()
  await pending
  expect(step).toBe('Diagnose')
  expect(durations.length).toBeGreaterThan(1)
  expect(durations).toEqual([...durations].sort((a, b) => a - b))
  expect(new Set(durations).size).toBe(durations.length)
  expect(liveRuns.at(-1)).toBe(null)
})
