import { expect } from 'claude-code/testing'
import { test } from '../support/kit'
import type { Engine } from 'claude-code/testing'
import type { FlowView } from '../../types'
import { sectionGap } from '../../hooks/ui/theme'
import { buildWriteCall, buildPullRequest, noFlow, pushedCloseOut, twoIssueCloseOut } from '../support/builders'
import { declareFlow, mountPane, endTurn, readFlowStatus, readPromptContext, runFlowCommand, textOf } from '../support/helpers'
import { createWorld } from '../support/world'

/** A node of a mounted pane's tree, as far as these tests read it. */
interface PaneNode { children?: unknown[] }
// These labels occupy different numbers of pill rows in the pane.
const oneRow = ['bug', 'ready-for-agent']
const twoRows = ['ready-for-agent', 'needs-triage']
const threeRows = ['ready-for-agent', 'needs-triage', 'needs-info']

const labelsOf = (labels: string[]) => ({ session: { info: { 1: { title: 'feat', labels } } } })
// The pane draws the view the mod stored last, without refreshing it.

const isPaneNode = (value: unknown): value is PaneNode => typeof value === 'object' && value !== null
const readText = (node: unknown): string => {
  if (typeof node === 'string') return node
  return isPaneNode(node) ? (node.children ?? []).map(readText).join('') : ''
}
const countPaneText = async ($: Engine, text: RegExp): Promise<number> => {
  const ui = await mountPane($, { columns: 40, rows: 30 })
  const found = await ui.findAll({ type: 'Text', text })
  await ui.unmount()
  return found.length
}

test('the current PR step names its open PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skips: [{ step: 'verify', reason: 'covered separately' }], skills: ['generate-commit'] }, prs: [buildPullRequest({ closingIssuesReferences: [] })] })
  expect(await readFlowStatus($)).toContain('▸ PR #5')
  expect(await readPromptContext($)).toContain('current step: PR #5')
})

test('the PR step reads PR #<n> once done, in the status and in the declaration steps', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, pushedCloseOut)
  expect(await readFlowStatus($)).toContain('✓ PR #5')
  const declared = (await declareFlow($, 'close-out', [1, 2])).result
  expect(declared).toContain('✓ PR #5 (')
})

test('the PR step reads PR with no PR on record', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, unit: { skips: [{ step: 'verify', reason: 'covered separately' }], skills: ['generate-commit'] } })
  expect(await readFlowStatus($)).toContain('▸ PR · no PR')
  expect(await readPromptContext($)).toContain('current step: PR.')
})

test('the pane shows the current Commit fact after a new edit and turn end', async ($, on) => {
  const git = { branch: 'feat', ahead: 8, isDirty: false }
  createWorld(on, git, { session: noFlow })
  await runFlowCommand($, 'trivial')
  await runFlowCommand($, 'skip verify covered separately')
  git.ahead = 9
  await $.tool.call(buildWriteCall('src/a.ts'))
  git.isDirty = true
  await endTurn($)
  expect(await readFlowStatus($)).toContain('▸ Commit · uncommitted changes')
  expect(await countPaneText($, /^uncommitted changes/)).toBeGreaterThan(0)
})

test('the pane reports stale GitHub facts while a declared issue is unverified', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { failing: 'gh', session: { flow: 'small-feature', issues: [1], info: {} } })
  await readFlowStatus($)
  expect(await countPaneText($, /^read failed \(gh could not run: /)).toBe(1)
})

test('the pane reports one failed GitHub read while GitHub is unreachable and every declared issue is verified', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...twoIssueCloseOut, failing: 'gh' })
  await readFlowStatus($)
  expect(await countPaneText($, /^read failed \(gh could not run: /)).toBe(1)
})

for (const [count, labels] of [[1, oneRow], [2, twoRows], [3, threeRows]] as const) {
  test(`/flow status keeps ${count} labels on one line before Branch`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, labelsOf([...labels]))
    const lines = ((await readFlowStatus($)) ?? '').split('\n')
    const first = lines.findIndex(line => line.startsWith('Labels'))
    const branch = lines.findIndex(line => line.startsWith('Branch'))
    expect(lines[branch - 1]).toBe('')
    expect(lines[branch - 2]).not.toBe('')
    expect(lines.slice(first, branch - 1)).toEqual(['Labels'.padEnd(10) + labels.map(label => ` ${label} `).join('  ')])
  })
}

test('with several issues the pane draws the first issue with its labels and counts the rest, which /flow status lists', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { session: { flow: 'close-out', issues: [1, 2, 3], info: { 1: { title: 'first', labels: ['bug'] }, 2: { title: 'second', labels: ['needs-info'] }, 3: { title: 'third', labels: [] } } } })
  const status = (await readFlowStatus($)) ?? ''
  const ui = await mountPane($, { columns: 40, rows: 30 })
  const text = textOf(await ui.drawn())
  expect(text).toContain('#1')
  expect(text).toContain('first')
  expect(text).not.toContain('second')
  expect(text).toContain('+2 more · /flow status')
  expect((await ui.findAll({ type: 'Button' })).filter(button => button.props['label'] === 'open')).toHaveLength(1)
  expect((await ui.findAll({ type: 'Text', text: /^ [a-z-]+ $/ })).map(pill => pill.text)).toEqual([' bug '])
  for (const line of ['#2', 'second', '#3', 'third']) expect(status).toContain(line)
  await ui.unmount()
})

test('the mounted pane draws the label rows /flow status prints', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, labelsOf(threeRows))
  const status = (await readFlowStatus($)) ?? ''
  const ui = await mountPane($, { columns: 40, rows: 30 })
  const pills = (await ui.findAll({ type: 'Text', text: /^ [a-z-]+ $/ })).map(pill => pill.text)
  expect(pills).toEqual(threeRows.map(label => ` ${label} `))
  for (const label of threeRows) expect(status).toContain(` ${label} `)
  await ui.unmount()
})

test('every keyed Flow button draws only its clean label, keeps its hotkey and fits the footer inline once the labels fit', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  const value: FlowView = {
    flow: 'Small feature', progress: '0/1', issues: [{ number: 1, title: 'First' }, { number: 2, title: 'Second' }], pending: null,
    meta: [], labels: [], steps: [], notes: [], footer: { action: 'continue', isRunning: false }, hasRunLog: true,
    violations: [{ factId: 'fact', text: 'needs attention', tone: 'warn' }],
  }
  const displayed = { value }
  on('state.get', { plugin: 'working-agreement', key: 'view' }, () => ({ value: { value: displayed.value, version: 0 } }))
  const pane = await mountPane($)
  const buttons = await pane.findAll({ type: 'Button' })
  expect(buttons.map(button => button.props['label'])).toEqual(['open', 'dismiss', 'Run log', 'Continue in new session'])
  expect(buttons.map(button => button.props['hotkey'])).toEqual(['o', 'd', 'l', 'c'])
  for (const key of ['o', 'd', 'l', 'c']) expect(await pane.findAll({ type: 'Text', text: new RegExp(`^${key}$`) })).toHaveLength(0)
  displayed.value = { ...value, footer: { action: 'start', isRunning: false } }
  await pane.redraw()
  expect((await pane.find({ key: 'n' }))?.props['label']).toBe('Start new session')
  expect((await pane.find({ key: 'n' }))?.props['hotkey']).toBe('n')
  expect(await pane.findAll({ type: 'Text', text: /^n$/ })).toHaveLength(0)
  await pane.unmount()
  // `[ Run log ]` and `[ Continue in new session ]` take 40 columns with their gap, the body's width less its padding.
  displayed.value = value
  const narrow = await mountPane($, { columns: 44 })
  expect((await narrow.findAll({ type: 'Box' })).some(box => box.props['alignItems'] === 'flex-end' && box.props['flexDirection'] === 'row')).toBe(true)
  await narrow.unmount()
})

for (const [count, labels] of [[1, oneRow], [2, twoRows], [3, threeRows]] as const) {
  test(`the mounted pane puts the Branch section right after the Labels section, one section gap apart, with ${count} label row${count === 1 ? '' : 's'}`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, labelsOf([...labels]))
    await readFlowStatus($)
    const ui = await mountPane($, { columns: 40, rows: 30 })
    const sections = (await ui.findAll({ type: 'Box' })).find(box => {
      const labelsIndex = box.children.findIndex(child => readText(child).startsWith('Labels'))
      return labelsIndex >= 0 && box.children.findIndex(child => readText(child).startsWith('Branch')) === labelsIndex + 1
    })
    expect(sections?.props['gap']).toBe(sectionGap)
    await ui.unmount()
  })
}

for (const [columns, pill] of [[31, ' ready-for-agent '], [30, ' ready-for-age… '], [29, ' ready-for-ag… ']] as const) {
  test(`the mounted pane draws the ready-for-agent pill as ${pill.trim()} on one row at ${columns} columns`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, labelsOf(['ready-for-agent']))
    await readFlowStatus($)
    const ui = await mountPane($, { columns, rows: 30 })
    const pills = await ui.findAll({ type: 'Text', text: /ready-for/ })
    expect(pills.map(readText)).toEqual([pill])
    expect(pills[0]?.props['wrap']).toBe('truncate-end')
    await ui.unmount()
  })
}

test('the mounted pane draws Diagnose as one row with its first unmet fact', async ($, on) => {
  createWorld(on, { branch: 'fix' }, { session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } } })
  expect(await readFlowStatus($)).toContain('▸ Diagnose · no red run yet')
  const ui = await mountPane($, { columns: 40, rows: 30 })
  const text = (await ui.findAll({ type: 'Text' })).map(readText).join(' ')
  expect(text).toContain('Diagnose')
  expect(text).toContain('no red run yet')
  expect(text).not.toContain('Diagnosis')
  expect(text).not.toContain('Approval')
  await ui.unmount()
})
