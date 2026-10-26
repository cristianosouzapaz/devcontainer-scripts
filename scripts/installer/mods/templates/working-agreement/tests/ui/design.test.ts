import { expect } from 'claude-code/testing'
import { test } from '../support/kit'
import type { Mounted } from 'claude-code/testing'
import type { ThemeKey } from 'claude-code'
import type { FlowView, IssueComment, ReadFailure } from '../../types'
import { flowDefinitions } from '../../hooks/domain/flow-definitions'
import { createEmptySession, createEmptyUnit } from '../../hooks/domain/records'
import type { Session, Unit } from '../../hooks/domain/records'
import { withStates } from '../../hooks/domain/step-states'
import type { Position } from '../../hooks/domain/step-states'
import { buildView } from '../../hooks/ui/view-model'
import { renderStatusText } from '../../hooks/ui/status-text'
import { pushedCloseOut, diagnoseRuns, diagnosisComment } from '../support/builders'
import { mountPane, readFlowStatus, readPromptContext } from '../support/helpers'
import { createWorld } from '../support/world'

interface DiagnoseComments { comments: IssueComment[] | ReadFailure }
interface Node { props?: Record<string, unknown>; children?: unknown[] }
interface Displayed { value: FlowView }

const themeKeys: ThemeKey[] = ['text', 'inverseText', 'inactive', 'subtle', 'suggestion', 'remember', 'success', 'error', 'warning', 'merged', 'claude', 'permission', 'planMode', 'autoAccept', 'promptBorder', 'bashBorder', 'ide', 'diffAdded', 'diffRemoved', 'diffAddedDimmed', 'diffRemovedDimmed', 'diffAddedWord', 'diffRemovedWord']
const declared: Session = { ...createEmptySession('sid'), flow: 'fix', unit: { branch: 'feature/a-long-branch-name', issues: [1] }, issues: [1], info: { 1: { title: 'A long issue title', labels: ['ready-for-agent', 'needs-triage', 'needs-info'] } } }

function position(current = 'diagnose', overrides: Partial<Position> = {}): Position {
  const flow = flowDefinitions.flows['fix']!
  const index = flow.steps.findIndex(step => step.id === current)
  const states = flow.steps.map((step, i) => ({ step, isError: false, isWaitingApproval: false, state: i < index ? 'done' as const : i === index ? 'current' as const : 'pending' as const, fact: 'a fact to act on' }))
  return { flow, unit: createEmptyUnit(), git: null, slice: null, states, current: states[index] ?? null, verify: { fact: 'no pass', isVerified: false }, checks: 'off', isConcluded: false, ...overrides }
}



function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (typeof node !== 'object' || node === null) return ''
  const tree = node as Node
  return (tree.children ?? []).map(textOf).join('') || String(tree.props?.['label'] ?? '')
}

function checkTheme(node: unknown): void {
  if (typeof node !== 'object' || node === null) return
  const { props, children } = node as Node
  for (const key of ['color', 'backgroundColor']) {
    if (props?.[key] !== undefined) expect(themeKeys).toContain(props[key])
  }
  for (const child of children ?? []) checkTheme(child)
}

async function expectText(ui: Mounted<'terminal', 'Pane'>, text: string, props: Record<string, unknown>): Promise<void> {
  const nodes = await ui.findAll({ type: 'Text' })
  expect(nodes.find(node => node.text === text && Object.entries(props).every(([key, value]) => node.props[key] === value))).toBeDefined()
}

for (const columns of [30, 60]) {
  test(`Flow redraw at ${columns} columns preserves fixed parts and yields context`, async ($, on) => {
    createWorld(on, { branch: 'feat' })
    const slice = { base: 'a', end: 'b', tree: 'tree', baseTree: 'base', commits: 1, isClean: true, isFrozen: true, isRewritten: false, isShared: false }
    const session: Session = { ...declared, blocked: { edits: 2 }, handoff: { state: 'failed', reason: 'unavailable' } }
    const base = buildView(session, withStates(position('diagnose', { slice }), session), 'unreachable')
    const displayed: Displayed = { value: { ...base, hasRunLog: true, footer: { action: 'continue', isRunning: false },
      notes: [...base.notes, { key: 'Checkout', value: "other, not this unit's branch", tone: 'warn' }],
      violations: [{ factId: 'v', text: 'a commit appeared', tone: 'error' }, { factId: 'u', text: 'could not check', tone: 'warn' }],
      steps: [...base.steps, { isError: false, isMerged: false, id: 'tickets', symbol: '↷', label: 'Tickets', state: 'skipped', detail: 'optional for this unit' }] } }
    on('state.get', { plugin: 'working-agreement', key: 'view' }, () => ({ value: { value: displayed.value, version: 0 } }))
    const ui = await mountPane($, { columns: 60 })
    await ui.redraw({ title: 'Flow', isFocused: true, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} })
    checkTheme(await ui.drawn())
    expect((await ui.find({ type: 'Box' }))?.props['backgroundColor']).toBeUndefined()
    await expectText(ui, '✓ ', { color: 'success' })
    await expectText(ui, '▸ ', { color: 'suggestion' })
    await expectText(ui, '○ ', { color: 'inactive' })
    await expectText(ui, '↷ ', { color: 'inactive' })
    await expectText(ui, 'no red run yet', { color: 'text', wrap: 'wrap' })
    await expectText(ui, 'optional for this unit', { color: 'inactive', wrap: 'truncate-end' })
    await expectText(ui, 'feature/a-long-branch-name', { color: 'text', wrap: 'truncate-middle' })
    await expectText(ui, 'frozen', { color: 'inactive' })
    await expectText(ui, 'unreachable · not refreshed', { color: 'warning', wrap: 'wrap' })
    await expectText(ui, columns === 30 ? ' ready-for-age… ' : ' ready-for-agent ', { color: 'text', backgroundColor: 'subtle', wrap: 'truncate-end' })
    for (const [key, color] of [['Checkout', 'warning'], ['Violation', 'error'], ['Unchecked', 'warning'], ['Blocked', 'error'], ['Handoff', 'error']]) await expectText(ui, key!, { color, weight: 'semibold' })
    await expectText(ui, 'a commit appeared', { color: 'text', wrap: 'wrap' })
    const boxes = await ui.findAll({ type: 'Box' })
    for (const text of ['✓ ', 'Diagnose', ' · ', 'Branch', base.progress, ' · frozen']) {
      expect(boxes.find(box => box.props['flexShrink'] === 0 && textOf(box) === text)).toBeDefined()
    }
    const pillRows = boxes.filter(box => box.props['gap'] === 2 && box.children.some(child => (child as Node).props?.['backgroundColor'] === 'subtle'))
    expect(pillRows).toHaveLength(columns === 30 ? 3 : 2)
    expect(renderStatusText(displayed.value)).toContain('↷ Tickets · optional for this unit')
    expect(boxes.find(box => textOf(box).includes('dismiss') && box.props['marginTop'] === 1 && box.props['paddingLeft'] === 10)).toBeDefined()
    expect(boxes.find(box => textOf(box).includes('Run log') && box.props['alignItems'] === 'flex-end')?.props['flexDirection']).toBe(columns < 44 ? 'column' : 'row')
    expect(textOf(await ui.drawn())).not.toContain('History')
    expect(textOf(await ui.drawn())).not.toContain('run /')
    displayed.value = buildView(declared, withStates(position('diagnose', { slice: { ...slice, isRewritten: true } }), declared), 'unauth')
    await ui.redraw()
    await expectText(ui, 'rewritten', { color: 'error' })
    await expectText(ui, '? ', { color: 'inactive' })
    expect(textOf(await ui.drawn())).not.toContain('History')
    expect(renderStatusText(displayed.value)).not.toContain('History')
    await expectText(ui, 'not authenticated — run gh auth login', { color: 'warning', wrap: 'wrap' })
    checkTheme(await ui.drawn())
    await ui.unmount()
  })
}

test('merged PR and failing CI draw their own symbols, facts and theme keys', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  const concluded = position('pr', { isConcluded: true, pullRequest: { number: 318, state: 'MERGED' } })
  const displayed = { value: buildView(declared, concluded, 'connected') }
  on('state.get', { plugin: 'working-agreement', key: 'view' }, () => ({ value: { value: displayed.value, version: 0 } }))
  const ui = await mountPane($, { columns: 60 })
  expect(textOf(await ui.drawn())).toContain('✓ PR #318 · merged')
  expect(renderStatusText(displayed.value)).toContain('✓ PR #318 · merged')
  await expectText(ui, '✓ ', { color: 'merged' })
  await expectText(ui, 'PR #318', { color: 'text' })
  await expectText(ui, 'merged', { color: 'merged' })
  expect((await ui.findAll({ type: 'Box' })).find(box => textOf(box) === 'merged')?.props['flexShrink']).toBe(0)
  checkTheme(await ui.drawn())
  const failing = position('pr')
  displayed.value = buildView(declared, { ...failing, states: failing.states.map(entry => ({ ...entry, isError: true, fact: 'CI failing: mods' })) }, 'connected')
  await ui.redraw()
  await expectText(ui, '✗ ', { color: 'error' })
  await expectText(ui, 'CI failing: mods', { color: 'error', wrap: 'wrap' })
  expect(textOf(await ui.drawn())).not.toContain('waiting for CI')
  expect(renderStatusText(displayed.value)).toContain('✗ PR · CI failing: mods')
  checkTheme(await ui.drawn())
  await ui.unmount()
})

for (const [name, unit, info, fact] of [
  ['red', { runs: [] }, { comments: [] }, 'no red run yet'],
  ['comment', { runs: diagnoseRuns }, { comments: [] }, 'no comment after the red'],
  ['approval', { runs: diagnoseRuns }, { comments: [diagnosisComment] }, 'needs /flow approve'],
  ['deleted approval', { runs: diagnoseRuns, approval: diagnosisComment.url }, { comments: [] }, 'approved comment deleted'],
  ['issue', { runs: diagnoseRuns }, { comments: [] }, 'issue not yet created'],
  ['comments unavailable', { runs: diagnoseRuns }, { comments: { error: 'comments unreadable' } }, 'comments unreadable'],
] as [string, Partial<Unit>, DiagnoseComments, string][]) {
  test(`Diagnose pane and status wording: ${name}`, async ($, on) => {
    createWorld(on, { branch: 'feat' })
    const session: Session = { ...declared, issues: name === 'issue' ? [] : [1], info: { 1: { title: 'bug', labels: [], ...info } } }
    const located = position('diagnose', { unit: { ...createEmptyUnit(), skips: [{ step: 'triage', reason: 'the fixture starts at Diagnose' }], ...unit } })
    const view = buildView(session, withStates(located, session), 'connected')
    on('state.get', { plugin: 'working-agreement', key: 'view' }, () => ({ value: { value: view, version: 0 } }))
    const ui = await mountPane($, { columns: 60 })
    await expectText(ui, fact, { color: 'text', wrap: 'wrap' })
    expect(renderStatusText(view)).toContain(`▸ Diagnose · ${fact}`)
    await ui.unmount()
  })
}

test('dismiss hotkey clears the displayed violation and its button', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { violations: [{ factId: 'v', kind: 'commit', fact: { shas: ['c1'] }, sessionId: 'sid', toolUseIds: ['call'], agentIds: [], start: 1, end: 2 }] } })
  await readFlowStatus($)
  const ui = await mountPane($, { columns: 60 })
  expect(await ui.findAll({ type: 'Text', text: 'Violation' })).toHaveLength(1)
  expect((await ui.find({ type: 'Button', text: 'dismiss' }))?.props['hotkey']).toBe('d')
  await ui.press({ key: 'dismiss' })
  await ui.redraw()
  expect(await ui.findAll({ type: 'Text', text: 'Violation' })).toHaveLength(0)
  expect(await ui.findAll({ type: 'Button', text: 'dismiss' })).toHaveLength(0)
  await ui.unmount()
})

test('removing pane hints leaves the human step instruction intact', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { flow: 'large-feature', issues: [], info: {} } })
  const status = await readFlowStatus($)
  expect(status).not.toContain('run /wayfinder')
  expect(await readPromptContext($)).toContain('/wayfinder')
})

for (const current of ['triage', 'diagnose']) {
  test(`${current} keeps its current symbol even with an error judgement`, async ($, on) => {
    createWorld(on, { branch: 'feat' })
    const state = position(current)
    const view = buildView(declared, { ...state, states: state.states.map(entry => ({ ...entry, isError: true })) }, 'connected')
    on('state.get', { plugin: 'working-agreement', key: 'view' }, () => ({ value: { value: view, version: 0 } }))
    const ui = await mountPane($, { columns: 60 })
    await expectText(ui, '▸ ', { color: 'suggestion' })
    expect(await ui.findAll({ type: 'Text', text: '✗ ' })).toHaveLength(0)
    await ui.unmount()
  })
}

for (const action of ['start', 'continue'] as const) {
  test(`the ${action} footer button dispatches its session action`, async ($, on) => {
    on('command.run', { command: 'clear' }, (_$, event, next) => { chat.id = 'next'; return next(event) })
    const { chat, commands, prompts, sessions, views, clock } = createWorld(on, { branch: 'feat', ahead: 1 }, action === 'start'
      ? { ...pushedCloseOut, session: { ...pushedCloseOut.session, isLong: true } }
      : { session: { isLong: true } })
    await readFlowStatus($)
    const ui = await mountPane($, { columns: 60 })
    const key = action === 'start' ? 'n' : 'c'
    const label = action === 'start' ? 'Start new session' : 'Continue in new session'
    const button = await ui.find({ key })
    expect(button?.props['label']).toBe(label)
    expect(button?.props['hotkey']).toBe(key)
    expect(button?.props['dimColor']).toBe(false)
    expect((await ui.findAll({ type: 'Box' })).some(box => box.props['flexShrink'] === 0 && textOf(box) === label)).toBe(true)
    checkTheme(await ui.drawn())
    await ui.press({ key })
    await clock.settle()
    expect(commands).toEqual(action === 'start' ? ['clear'] : ['handoff'])
    if (action === 'start') {
      expect(sessions.get('next')?.unit ?? null).toBeNull()
      expect(prompts).toEqual([])
      expect(views.at(-1)).toBeNull()
      expect((await readFlowStatus($))).toContain('No flow declared')
    }
    await ui.unmount()
  })
}

test('a running handoff keeps Continue dimmed even for a finished unit and ignores presses', async ($, on) => {
  const { commands, clock } = createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: { ...pushedCloseOut.session, handoff: { state: 'running' } } })
  await readFlowStatus($)
  const ui = await mountPane($, { columns: 60 })
  const button = await ui.find({ key: 'c' })
  expect(button?.props['label']).toBe('Continue in new session')
  expect(button?.props['hotkey']).toBe('c')
  expect(button?.props['dimColor']).toBe(true)
  expect(await ui.find({ key: 'n' })).toBeUndefined()
  await ui.press({ key: 'c' })
  await clock.settle()
  expect(commands).toEqual([])
  await ui.unmount()
})
