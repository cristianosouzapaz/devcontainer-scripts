import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { noFlow, verifyFile } from '../support/builders'
import { declareFlow, endTurn, readFlowStatus, runFlowCommand, startSkill } from '../support/helpers'
import { common, configBlob, createWorld } from '../support/world'
import type { Checkout, Gate, Graph, Options } from '../support/world'

interface LogLine { at: number; session: string; generation?: string; branch: string; issues: number[]; event: string; [field: string]: unknown }

const logs = `${common}/working-agreement/log/`

/**
 * Reads every logged line, grouped by log file.
 * @param files - The world's files.
 * @returns Each log file's parsed lines.
 */
function readLogs(files: Map<string, string>): LogLine[][] {
  return [...files.entries()].filter(([path]) => path.startsWith(logs))
    .map(([, text]) => text.trimEnd().split('\n').map(line => JSON.parse(line) as LogLine))
}

/**
 * Reads the single log file's lines.
 * @param files - The world's files.
 * @returns Its parsed lines, or none when no log exists.
 */
function readLog(files: Map<string, string>): LogLine[] {
  const all = readLogs(files)
  expect(all.length).toBeLessThanOrEqual(1)
  return all[0] ?? []
}

test('a declaration logs who declared it, then a snapshot, then only the steps that changed with their cause', async ($, on) => {
  const options: Options = { session: noFlow, issueLabels: { 1: ['needs-triage'] } }
  const { files, clock } = createWorld(on, { branch: 'feat' }, options)
  await declareFlow($, 'small-feature', [1])
  await clock.settle()
  const [declare, snapshot] = readLog(files)
  expect(declare).toMatchObject({ session: 'sid', branch: 'feat', issues: [1], event: 'declare', flow: 'small-feature', declaredBy: 'agent' })
  expect(declare?.generation).toBeTruthy()
  expect(snapshot).toMatchObject({ event: 'snapshot', generation: declare?.generation, steps: { grill: 'current', spec: 'pending' } })
  await endTurn($)
  await clock.settle()
  expect(readLog(files)).toHaveLength(2)
  options.issueLabels = { 1: ['ready-for-agent'] }
  await startSkill($, 'grilling')
  await startSkill($, 'to-spec')
  await clock.advance(61000)
  await endTurn($)
  await clock.settle()
  const steps = readLog(files).filter(line => line.event === 'step')
  expect(steps).toContainEqual(expect.objectContaining({ step: 'grill', from: 'current', to: 'done', cause: ['turn end'] }))
  expect(steps).toContainEqual(expect.objectContaining({ step: 'code', from: 'pending', to: 'current' }))
  expect(steps.some(line => line.step === 'verify')).toBe(false)
})

test('a re-declaration on another identity names the identity it replaces, in a new log', async ($, on) => {
  const checkout: Checkout = { branch: 'feat', ahead: 0 }
  const { files, clock } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  checkout.ahead = 1
  await declareFlow($, 'small-feature', [2])
  await clock.settle()
  const declares = readLogs(files).flat().filter(line => line.event === 'declare')
  expect(declares).toHaveLength(2)
  expect(declares.find(line => line.issues[0] === 2)?.replaces).toEqual({ branch: 'feat', issues: [1] })
  expect(readLogs(files)).toHaveLength(2)
})

test('a deny and a skip are logged with their reason', async ($, on) => {
  const { files, clock } = createWorld(on, { branch: 'feature' })
  await endTurn($)
  const denied = await $.tool.call({ tool: 'Write', file_path: 'src/a.ts', content: '' })
  await runFlowCommand($, 'skip verify covered separately')
  await clock.settle()
  const lines = readLog(files)
  expect(lines).toContainEqual(expect.objectContaining({ event: 'deny', tool: 'Write', reason: denied.deny }))
  expect(lines).toContainEqual(expect.objectContaining({ event: 'skip', step: 'verify', reason: 'covered separately' }))
})

test('two chats on one unit append to the same log, each line naming its chat', async ($, on) => {
  const { files, clock, chat } = createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  await declareFlow($, 'small-feature', [1])
  await clock.settle()
  const lines = readLog(files)
  expect(new Set(lines.map(line => line.session))).toEqual(new Set(['sid', 'second']))
  expect(lines.filter(line => line.event === 'declare')).toHaveLength(2)
})

test('a failing append never fails the call and shows in /flow status until an append succeeds', async ($, on) => {
  const options: Options = { session: noFlow, issueLabels: { 1: ['needs-triage'] }, appendExitCode: 1 }
  const { files, clock } = createWorld(on, { branch: 'feat' }, options)
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  await clock.settle()
  expect(readLogs(files)).toEqual([])
  const status = await readFlowStatus($)
  expect(status).toContain('Log')
  expect(status).toContain('log append')
  expect(status).toContain('append failed')
  options.appendExitCode = undefined
  await runFlowCommand($, 'skip tickets not needed')
  await clock.settle()
  expect(await readFlowStatus($)).not.toContain('log append')
})

test('/flow status names the unit log', async ($, on) => {
  const { files, clock } = createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['needs-triage'] } })
  await declareFlow($, 'small-feature', [1])
  await clock.settle()
  const path = [...files.keys()].find(file => file.startsWith(logs))
  expect(await readFlowStatus($)).toContain(`Log       ${path}`)
})

test('the declaration sweep removes a log whose declaration is gone', async ($, on) => {
  const { files, clock } = createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  const orphan = `${logs}0123abcd.jsonl`
  files.set(orphan, '{}\n')
  await declareFlow($, 'small-feature', [1])
  await clock.settle()
  expect(files.has(orphan)).toBe(false)
  expect(readLogs(files)).toHaveLength(1)
})

test('an issue attached to an issue-less unit carries its log under the new identity', async ($, on) => {
  const { files, clock } = createWorld(on, { branch: 'feat' }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature')
  await clock.settle()
  await declareFlow($, 'small-feature', [1])
  await clock.settle()
  const declares = readLog(files).filter(line => line.event === 'declare')
  expect(declares.map(line => line.issues)).toEqual([[], [1]])
  expect(declares[1]?.replaces).toEqual({ branch: 'feat', issues: [] })
})

test('an approved verify config, a started handoff and a recorded violation are logged', async ($, on) => {
  const graph: Graph = { commits: { a: { parents: [], files: {} } }, refs: { main: 'a', feature: 'a', 'origin/main': 'a' } }
  const checkout: Checkout = { branch: 'feature', graph }
  on('tool.call', { tool: 'Bash' }, () => {
    checkout.graph = { ...graph, commits: { ...graph.commits, b: { parents: ['a'], files: { file: 'changed' } } }, refs: { ...graph.refs, feature: 'b' } }
    return { result: 'written' }
  })
  const { files, clock } = createWorld(on, checkout, { verifyFile })
  const blob = configBlob(verifyFile)
  await runFlowCommand($, `approve verify ${blob.slice(0, 12)}`)
  await $.tool.call({ tool: 'Bash', command: 'opaque' })
  await runFlowCommand($, 'handoff')
  await clock.settle()
  const lines = readLog(files)
  expect(lines).toContainEqual(expect.objectContaining({ event: 'approve', config: blob }))
  expect(lines).toContainEqual(expect.objectContaining({ event: 'violation', action: 'recorded', kind: 'commit' }))
  expect(lines).toContainEqual(expect.objectContaining({ event: 'handoff', state: 'started' }))
})

test('a deny whose record write loses every compare-and-set logs no line', async ($, on) => {
  const { files, clock } = createWorld(on, { branch: 'feature' }, { casMisses: 5 })
  const lost = await $.tool.call({ tool: 'Write', file_path: 'src/a.ts', content: '' })
  await clock.settle()
  expect(lost.deny).toBeTruthy()
  expect(readLogs(files).flat().filter(line => line.event === 'deny')).toEqual([])
  await $.tool.call({ tool: 'Write', file_path: 'src/b.ts', content: '' })
  await clock.settle()
  expect(readLog(files).filter(line => line.event === 'deny')).toHaveLength(1)
})

test('an older observation overtaken by a newer painted one logs no step', async ($, on) => {
  const gate: Gate = {}
  const options: Options = { session: noFlow, issueLabels: { 1: ['needs-triage'] } }
  const { files, clock } = createWorld(on, { branch: 'feat' }, options)
  await declareFlow($, 'small-feature', [1])
  await clock.settle()
  options.statusGate = new Promise<void>(resolve => { gate.open = resolve })
  // The turn-end read takes the session before the skip, then waits on git status while the skip paints.
  const older = endTurn($)
  await clock.settle()
  await runFlowCommand($, 'skip verify covered separately')
  await clock.settle()
  gate.open?.()
  await older
  await clock.settle()
  const verify = readLog(files).filter(line => line.event === 'step' && line.step === 'verify')
  expect(verify).toEqual([expect.objectContaining({ from: 'pending', to: 'skipped' })])
})

test('a line past the write cap keeps its event and drops its detail', async ($, on) => {
  const branch = `feat-${'x'.repeat(5000)}`
  const { files, clock } = createWorld(on, { branch }, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  await clock.settle()
  const declare = readLog(files).find(line => line.event === 'declare')
  expect(declare).toMatchObject({ session: 'sid', isTruncated: true })
  expect(declare?.branch).toBeUndefined()
  expect(declare?.flow).toBeUndefined()
})
