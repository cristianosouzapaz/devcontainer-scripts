import { expect, test } from 'claude-code/testing'
import { reportHerdr } from '../../hooks/core/herdr'
import { reread, refreshView } from '../../hooks/core/pane-view'
import { readVerifyState } from '../../hooks/core/verify'
import { sessionMemory } from '../../hooks/core/session-memory'
import { flowDefinitions } from '../../hooks/domain/flow-definitions'
import { createEmptySession, createEmptyUnit } from '../../hooks/domain/records'
import { resolveStepStates } from '../../hooks/domain/step-states'
import type { Evidence, Position } from '../../hooks/domain/step-states'
import { diagnoseRuns, diagnosisComment, noFlow, verifyFile } from '../support/builders'
import { endTurn, readFlowStatus } from '../support/helpers'
import { common, configBlob, createTestPort, createWorld, root } from '../support/world'
import type { Gate } from '../support/world'

const inside = { HERDR_ENV: '1', HERDR_PANE_ID: 'pane id' }

for (const env of [{}, { HERDR_ENV: '0', HERDR_PANE_ID: 'p' }, { HERDR_ENV: '1' }, { HERDR_ENV: '1', HERDR_PANE_ID: '' }] as Record<string, string>[]) {
  test(`no sidebar command outside herdr: ${JSON.stringify(env)}`, async ($, on) => {
    const world = createWorld(on, { branch: 'feat' }, { herdrEnv: env })
    await readFlowStatus($)
    await endTurn($)
    expect(world.runs.filter(run => run.startsWith('herdr '))).toHaveLength(0)
  })
}

test('every reread reports all three tokens, even an unchanged view; no flow clears unit and step', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { herdrEnv: inside })
  const calls = world.herdrCalls
  await readFlowStatus($)
  await endTurn($)
  expect(calls.length >= 2).toBe(true)
  const current = world.views.at(-1)?.steps.find(step => step.state === 'current')
  expect(current).toBeDefined()
  expect(calls.at(-1)).toEqual({ argv: ['herdr', 'pane', 'report-metadata', 'pane id', '--source', 'working-agreement', '--ttl-ms', '150000',
    '--token', 'flow_unit=Small feature #1', '--token', `flow_step=${current!.label}`, '--token', 'flow_alert='], timeoutMs: 5000 })
  const saved = world.sessions.get('sid')!
  world.sessions.set('sid', { ...saved, ...noFlow, unit: null })
  await endTurn($)
  expect(calls.at(-1)?.argv).toContain('flow_unit=')
  expect(calls.at(-1)?.argv).toContain('flow_step=')
  expect(calls.at(-1)?.argv).toContain('flow_alert=')
})

for (const scenario of ['plain', 'verify-approval', 'verify-fail', 'verify-timeout', 'ci-fail', 'issue-error', 'approval', 'rewritten', 'concluded'] as const) {
  test(`sidebar uses structured step state: ${scenario}`, async (_$, on) => {
    const world = createWorld(on, { branch: 'feat', ahead: 1 }, { herdrEnv: inside, verifyFile })
    const port = createTestPort(world)
    const flowId = scenario === 'approval' ? 'fix' : scenario === 'issue-error' ? 'large-feature' : 'close-out'
    const flow = flowDefinitions.flows[flowId]!
    const session = { ...createEmptySession('sid'), flow: flowId, issues: [307, 312], info: {}, unit: { branch: 'feat', issues: [307, 312] } }
    const unit = { ...createEmptyUnit(), ...(scenario === 'approval' ? { runs: diagnoseRuns } : {}) }
    const evidence: Evidence = {
      git: null, slice: { base: 'c0', end: 'c1', tree: 'tree', baseTree: 'base-tree', commits: 1,
        isClean: true, isFrozen: false, isRewritten: scenario === 'rewritten', isShared: false },
      verify: { fact: 'arbitrary fact', isVerified: scenario === 'ci-fail', isError: scenario === 'verify-fail' || scenario === 'verify-timeout' },
      checks: scenario === 'ci-fail' ? 'failing' : 'off', isConcluded: scenario === 'concluded',
      pullRequest: { number: 318, state: scenario === 'concluded' ? 'MERGED' : 'OPEN' },
    }
    if (scenario === 'verify-approval') evidence.verify = { ...await readVerifyState(port, evidence.slice, unit), fact: 'arbitrary fact' }
    if (scenario === 'verify-fail' || scenario === 'verify-timeout') {
      const blob = configBlob(verifyFile)
      world.approveConfig(verifyFile)
      const recorded = { ...unit, verifyRuns: [{ tree: 'tree', base: 'c0', configBlob: blob,
        commands: [['./test/run.sh']],
        outcome: scenario === 'verify-fail' ? { kind: 'fail' as const, code: 1, signal: null } : { kind: 'timeout' as const, minutes: 1 }, runId: 'run', at: 1 }] }
      evidence.verify = await readVerifyState(port, evidence.slice, recorded)
    }
    const declared = scenario === 'approval' ? { ...session, issues: [307], info: { 307: { title: 'bug', labels: ['ready-for-agent'], comments: [diagnosisComment] } } } : session
    const states = resolveStepStates(flow, declared, unit, evidence)
    const position: Position = { ...evidence, flow, unit, states, current: states.find(state => state.state === 'current') ?? null }
    await reportHerdr(port, declared, position, new Set())
    const expected = scenario === 'concluded' ? '✓ PR #318' : scenario === 'rewritten' ? '? Verify'
      : scenario === 'approval' ? '● Diagnose' : scenario === 'verify-approval' ? '● Verify' : scenario === 'issue-error' ? '✗ Map'
      : scenario === 'ci-fail' ? '✗ Update PR #318' : scenario.startsWith('verify-') ? '✗ Verify' : 'Verify'
    expect(world.runs.at(-1)).toContain(`--token flow_step=${expected} --token`)
    expect(world.runs.at(-1)).toContain(`flow_unit=${flow.label} #307${scenario === 'approval' ? '' : ' +1'}`)
    expect(world.runs.at(-1)).not.toContain('arbitrary fact')
  })
}

test('alerts ignore unchecked and dismissed records, choose newest, count others, and clear without a flow', async (_$, on) => {
  const world = createWorld(on, { branch: 'feat' }, { herdrEnv: inside })
  const port = createTestPort(world)
  const attribution = { sessionId: 'sid', toolUseIds: ['call'], start: 1 }
  const session = { ...createEmptySession('sid'), violations: [
    { ...attribution, kind: 'commit' as const, fact: { shas: ['a'] }, factId: 'commit', end: 1 },
    { ...attribution, kind: 'default-tree' as const, fact: { root: '/repo', before: 'a', after: 'b' }, factId: 'tree', end: 2 },
    { ...attribution, kind: 'push' as const, fact: { ref: 'feat', before: 'a', after: 'b' }, factId: 'push', end: 3 },
    { ...attribution, kind: 'unchecked' as const, fact: { toolUseId: 'call' }, factId: 'unchecked', end: 4 },
  ] }
  await reportHerdr(port, session, null, new Set(['push']))
  expect(world.runs.at(-1)).toContain('flow_unit= --token flow_step= --token flow_alert=✗ default-tree by agent +1')
  await reportHerdr(port, session, null, new Set(['push', 'tree', 'commit']))
  expect(world.runs.at(-1)?.endsWith('--token flow_alert=')).toBe(true)
})

for (const failure of ['exit', 'throw']) {
  test(`sidebar ${failure} is retried, leaves view and records unchanged, and success clears status`, async (_$, on) => {
    const options = { herdrEnv: inside, herdrResult: { exitCode: 0, stderr: '' }, failing: undefined as string | undefined }
    const world = createWorld(on, { branch: 'feat' }, options)
    const port = createTestPort(world)
    await refreshView(port)
    const before = JSON.stringify({ sessions: [...world.sessions], files: [...world.files], view: world.views.at(-1) })
    options.herdrResult = { exitCode: failure === 'exit' ? 7 : 0, stderr: 'first line\nsecond line' }
    options.failing = failure === 'throw' ? 'herdr' : undefined
    await world.clock.advance(1234)
    await reread(port, false)
    expect(JSON.stringify({ sessions: [...world.sessions], files: [...world.files], view: world.views.at(-1) })).toBe(before)
    const held = sessionMemory.herdrError!
    expect(held.failures).toBe(1)
    expect(held.firstSeen).toBe(world.clock.now())
    expect(sessionMemory.herdrError?.error).toContain(failure === 'exit' ? 'exit 7: first line' : 'could not run:')
    expect(sessionMemory.herdrError?.error).not.toContain('second line')
    await world.clock.advance(100)
    await reread(port, false)
    expect(sessionMemory.herdrError?.failures).toBe(2)
    expect(sessionMemory.herdrError?.firstSeen).toBe(held.firstSeen)
    options.herdrResult = { exitCode: 0, stderr: '' }
    options.failing = undefined
    await reread(port, false)
    expect(sessionMemory.herdrError).toBe(null)
    expect(JSON.stringify({ sessions: [...world.sessions], files: [...world.files], view: world.views.at(-1) })).toBe(before)
  })
}

test('/flow status shows the current sidebar error and removes its row after recovery', async ($, on) => {
  const options = { herdrEnv: inside, herdrResult: { exitCode: 9, stderr: 'unavailable\nmore detail' } }
  createWorld(on, { branch: 'feat' }, options)
  const status = await readFlowStatus($)
  expect(status).toContain('herdr     report-metadata · ')
  expect(status).toContain(' · ×1 · exit 9: unavailable')
  options.herdrResult = { exitCode: 0, stderr: '' }
  expect(await readFlowStatus($)).not.toContain('herdr')
})

test('reports from direct refresh and queued reread never overlap', async (_$, on) => {
  const gate: Gate = {}
  const startedGate: Gate = {}
  const started = new Promise<void>(resolve => { startedGate.open = resolve })
  const blocked = new Promise<void>(resolve => { gate.open = resolve })
  const world = createWorld(on, { branch: 'feat' }, { herdrEnv: inside, herdrGate: blocked, beforeHerdr: () => {
    if (world.herdrActivity.calls === 1) {
      expect(world.views.at(-1)?.flow).toBe('Small feature')
      startedGate.open?.()
    }
  } })
  const state = world.herdrActivity
  const port = createTestPort(world)
  const first = refreshView(port, true)
  await started
  const second = reread(port, false)
  gate.open?.()
  await Promise.all([first, second])
  expect(state.calls).toBe(2)
  expect(state.maximum).toBe(1)
})

test('a unit without issues uses its declared branch and all values are capped at 80 characters', async (_$, on) => {
  const world = createWorld(on, { branch: 'checkout' }, { herdrEnv: inside })
  const port = createTestPort(world)
  const session = { ...createEmptySession('sid'), flow: 'trivial', unit: { branch: 'unit-branch', issues: [] } }
  const flow = flowDefinitions.flows['trivial']!
  const unit = createEmptyUnit()
  const evidence: Evidence = { git: null, slice: null, verify: { fact: '', isVerified: false }, checks: 'off', isConcluded: false }
  const states = resolveStepStates(flow, session, unit, evidence)
  const position: Position = { ...evidence, flow, unit, states, current: states.find(state => state.state === 'current') ?? null }
  await reportHerdr(port, session, position, new Set())
  expect(world.runs.at(-1)).toContain('flow_unit=Trivial change · unit-branch')
  const long = 'x'.repeat(100)
  await reportHerdr(port, session, { ...position, flow: { ...flow, label: long }, current: { ...states[0]!, step: { ...states[0]!.step, label: long } } }, new Set())
  expect(world.runs.at(-1)).toContain(`flow_unit=${'x'.repeat(80)} --token flow_step=${'x'.repeat(80)} --token`)
})

test('watched refs and the 60 second tick each report a fresh snapshot', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { herdrEnv: inside })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  const reports = () => world.runs.filter(run => run.startsWith('herdr pane report-metadata ')).length
  const initial = reports()
  await $.classic.FileChanged({ file_path: `${common}/HEAD`, event: 'change' })
  await world.clock.settle()
  expect(reports()).toBe(initial + 1)
  await world.clock.advance(60000)
  await world.clock.settle()
  expect(reports()).toBe(initial + 2)
})

test('clearing a flow updates the pane before reporting, including an unchanged empty view', async (_$, on) => {
  const check: { run?: () => void } = {}
  const world = createWorld(on, { branch: 'feat' }, { herdrEnv: inside, beforeHerdr: () => check.run?.() })
  const port = createTestPort(world)
  await refreshView(port, true)
  world.sessions.set('sid', { ...world.sessions.get('sid')!, ...noFlow, unit: null })
  check.run = () => { expect(world.views.at(-1)).toBe(null) }
  const initial = world.herdrCalls.length
  await refreshView(port, true)
  await refreshView(port, true)
  expect(world.herdrCalls.length).toBe(initial + 2)
})

test('a failure while recording a herdr error cannot reject refresh or latch the next report', async (_$, on) => {
  const options = { herdrEnv: inside, herdrResult: { exitCode: 7, stderr: 'unavailable' }, session: noFlow }
  const world = createWorld(on, { branch: 'feat' }, options)
  const original = createTestPort(world)
  const clock = { failures: 0 }
  const port = { ...original, now: async () => {
    clock.failures += 1
    throw new Error('clock unavailable')
  } }
  await refreshView(port, true)
  expect(clock.failures > 0).toBe(true)
  expect(world.herdrCalls).toHaveLength(1)
  options.herdrResult = { exitCode: 0, stderr: '' }
  await reread(port, false)
  expect(world.herdrCalls).toHaveLength(2)
  expect(sessionMemory.herdrError).toBe(null)
})
