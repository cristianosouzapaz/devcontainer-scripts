import { expect } from 'claude-code/testing'
import { test } from '../support/kit'
import { buildParentGraph, diagnoseRuns, diagnosisComment, noFlow, verifyFile } from '../support/builders'
import { endTurn, inside, mountPane, readFlowStatus, runFlowCommand, textOf } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Gate, Options } from '../support/world'

const changed: Checkout = { branch: 'feat', changed: ['src/a.ts'], isDirty: true, tree: 'one' }

const waiting: [string, Checkout, Options][] = [
  ['Diagnose', { branch: 'fix' }, { session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
    unit: { runs: diagnoseRuns }, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] } }],
  ['Verify', changed, { verifyFile }],
]

test('a live Verify run leaves every step drawn in its real state', async ($, on) => {
  const gate: Gate = {}
  const { clock } = createWorld(on, { ...changed },
    { verifyFile, approvedConfig: verifyFile, spawnGate: new Promise<void>(resolve => { gate.open = resolve }) })
  const pending = $.tool.call({ tool: 'mcp__working-agreement__verify' })
  await clock.settle()
  const pane = await mountPane($)
  const live = textOf(await pane.drawn())
  expect(live).toContain('▸ Code · no Verify run yet')
  expect(live).toContain('○ Verify')
  expect(live).not.toContain('▸ Verify')
  gate.open?.()
  await clock.settle()
  await pending
  await pane.unmount()
})

for (const [step, checkout, options] of waiting) {
  test(`${step} waiting on a user approval reads ● on the pane, in the status and on the sidebar`, async ($, on) => {
    const world = createWorld(on, { ...checkout }, { ...options, herdrEnv: inside })
    expect(await readFlowStatus($)).toContain(`● ${step}`)
    await endTurn($)
    expect(world.runs.at(-1)).toContain(`--token flow_step=● ${step} --token`)
    const pane = await mountPane($)
    expect(textOf(await pane.drawn())).toContain(`● ${step}`)
    await pane.unmount()
  })
}

test('a Verify config edited during its run reads ● with the approval fact, not the unrecorded run', async ($, on) => {
  const checkout: Checkout = { ...changed }
  const options: Options = { verifyFile, approvedConfig: verifyFile }
  options.afterSpawn = () => { checkout.tree = 'two'; options.verifyFile = JSON.stringify({ verify: ['./edited.sh'] }) }
  createWorld(on, checkout, options)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  const pane = await mountPane($)
  const drawn = textOf(await pane.drawn())
  expect(drawn).toContain('● Verify · config not approved')
  expect(drawn).not.toContain('tree changed during run')
  await pane.unmount()
})

test('the declaration reply marks a step waiting on a user approval ●', async ($, on) => {
  createWorld(on, { ...changed }, { verifyFile, session: noFlow })
  expect((await runFlowCommand($, 'trivial')).text).toContain('● Verify')
})

test('an integrated child awaiting its parent reads ✓ Integrate on the pane, in the status and on the sidebar', async ($, on) => {
  const graph = buildParentGraph()
  const world = createWorld(on, { branch: 'a', graph: { ...graph, refs: { ...graph.refs, par: 'ma' } }, worktrees: { '/repo': { branch: 'a' }, '/par': { branch: 'par' } } },
    { unit: { base: 'p1', baseBranch: 'par', skips: [{ step: 'code', reason: 'covered' }, { step: 'verify', reason: 'covered' }] }, herdrEnv: inside })
  expect(await readFlowStatus($)).toContain("✓ Integrate · awaiting par's PR")
  await endTurn($)
  expect(world.runs.at(-1)).toContain('--token flow_step=✓ Integrate --token')
  const pane = await mountPane($)
  expect(textOf(await pane.drawn())).toContain('✓ Integrate')
  await pane.unmount()
})
