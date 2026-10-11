import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ToolRun } from '../../hooks/core/command-observation'
import { sectionGap } from '../../hooks/ui/theme'
import { buildBashCall, buildWriteCall, noFlow, twoIssueCloseOut, verifyFile } from '../support/builders'
import { readFlowStatus, readPromptContext, runFlowCommand } from '../support/helpers'
import { createWorld } from '../support/world'

/** A node of a mounted pane's tree, as far as these tests read it. */
interface PaneNode { children?: unknown[] }

// A changed tree, so Verify is the step a verify run moves.
const changed = { branch: 'feat', ahead: 8, isDirty: true }
const green: ToolRun = { result: { stdout: '' } }
// Issue #1 carries these labels; the status layout fits 26 columns of pills, so one, two and three labels wrap into that many rows.
const oneRow = ['bug', 'ready-for-agent']
const twoRows = ['ready-for-agent', 'needs-triage']
const threeRows = ['ready-for-agent', 'needs-triage', 'needs-info']

const labelsOf = (labels: string[]) => ({ session: { info: { 1: { title: 'feat', labels } } } })
// The pane draws the view the mod stored last, without refreshing it.
const mountPane = ($: Engine) => $.ui.mount({
  plugin: 'working-agreement', surface: 'terminal', component: 'Pane', requestId: 'working-agreement',
  props: { title: 'Flow', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  viewport: { columns: 40, rows: 30 },
})
const isPaneNode = (value: unknown): value is PaneNode => typeof value === 'object' && value !== null
const readText = (node: unknown): string => {
  if (typeof node === 'string') return node
  return isPaneNode(node) ? (node.children ?? []).map(readText).join('') : ''
}
const countPaneText = async ($: Engine, text: RegExp): Promise<number> => {
  const ui = await mountPane($)
  const found = await ui.findAll({ type: 'Text', text })
  await ui.unmount()
  return found.length
}

test('a direct verify run refreshes the pane before the command executes', async ($, on) => {
  const seen = { running: 0 }
  createWorld(on, changed, { verifyFile, toolRun: async () => { seen.running = await countPaneText($, /Verify — running/); return green } })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(seen.running).toBeGreaterThan(0)
})

test('the PR step reads Update PR #<n> with an open PR on record, and PR without one', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'], pr: { number: 5, state: 'OPEN' } } })
  expect(await readFlowStatus($)).toContain('Update PR #5')
  expect(await readPromptContext($)).toContain('current step: Update PR #5')
})

test('the PR step reads PR with no PR on record', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skills: ['generate-commit'] } })
  expect(await readFlowStatus($)).not.toContain('Update PR')
  expect(await readPromptContext($)).toContain('current step: PR.')
})

test('the pane marks a lapsed step stale as /flow status does', async ($, on) => {
  const git = { branch: 'feat', ahead: 8, isDirty: false }
  createWorld(on, git, { session: noFlow })
  await runFlowCommand($, 'trivial')
  git.ahead = 9
  await $.tool.call(buildBashCall('true'))
  expect(await countPaneText($, /stale/)).toBe(0)
  await $.tool.call(buildWriteCall('src/a.ts'))
  git.isDirty = true
  await $.tool.call(buildBashCall('true'))
  expect(await readFlowStatus($)).toMatch(/Commit {2}stale/)
  expect(await countPaneText($, /stale/)).toBeGreaterThan(0)
})

test('the pane says writes ask while GitHub is unreachable and a declared issue is unverified', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { failing: 'gh', session: { flow: 'small-feature', issues: [1], info: {} } })
  expect(await readFlowStatus($)).toContain('unreachable — writes ask until the declared issue is verified')
})

test('the pane says labels and PR state are not refreshed while GitHub is unreachable and every declared issue is verified', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, failing: 'gh' })
  expect(await readFlowStatus($)).toContain('unreachable — issue labels and PR state are not refreshed')
})

for (const [count, labels] of [[1, oneRow], [2, twoRows], [3, threeRows]] as const) {
  test(`/flow status keeps one blank line before Branch with ${count} label row${count === 1 ? '' : 's'}, and between pill rows`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, labelsOf([...labels]))
    const lines = ((await readFlowStatus($)) ?? '').split('\n')
    const first = lines.findIndex(line => line.startsWith('Labels'))
    const branch = lines.findIndex(line => line.startsWith('Branch'))
    expect(lines[branch - 1]).toBe('')
    expect(lines[branch - 2]).not.toBe('')
    expect(lines.slice(first, branch - 1).filter(line => line !== '')).toHaveLength(count)
    expect(lines.slice(first, branch - 1).filter(line => line === '')).toHaveLength(count - 1)
  })
}

test('the mounted pane draws the label rows /flow status prints', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, labelsOf(threeRows))
  const status = (await readFlowStatus($)) ?? ''
  const ui = await mountPane($)
  const pills = (await ui.findAll({ type: 'Text', text: /^ [a-z-]+ $/ })).map(pill => pill.text)
  expect(pills).toEqual(threeRows.map(label => ` ${label} `))
  for (const label of threeRows) expect(status).toContain(` ${label} `)
  await ui.unmount()
})

for (const [count, labels] of [[1, oneRow], [2, twoRows], [3, threeRows]] as const) {
  test(`the mounted pane puts the Branch section right after the Labels section, one section gap apart, with ${count} label row${count === 1 ? '' : 's'}`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, labelsOf([...labels]))
    await readFlowStatus($)
    const ui = await mountPane($)
    const sections = (await ui.findAll({ type: 'Box' })).find(box => {
      const labelsIndex = box.children.findIndex(child => readText(child).startsWith('Labels'))
      return labelsIndex >= 0 && box.children.findIndex(child => readText(child).startsWith('Branch')) === labelsIndex + 1
    })
    expect(sections?.props['gap']).toBe(sectionGap)
    await ui.unmount()
  })
}
