import { expect } from 'claude-code/testing'
import { test } from '../support/kit'
import type { Next, On, PaneCloseInput } from 'claude-code'
import type { Mounted } from 'claude-code/testing'
import type { FlowView, RunCommandView, RunView, VerifyRecord } from '../../types'
import type { EnginePort } from '../../hooks/core/engine-port'
import { readSession, readUnit } from '../../hooks/core/record-store'
import { withRunView } from '../../hooks/core/run-view'
import { sessionMemory } from '../../hooks/core/session-memory'
import { handlePaneClose, handlePaneRender } from '../../hooks/handlers/pane-render'
import type { PaneElements } from '../../hooks/ui/pane-sections'
import { diagnosed, diagnosisComment } from '../support/builders'
import { checkTheme, mountPane, readFlowStatus, readPromptContext, textOf } from '../support/helpers'
import type { DrawnNode } from '../support/helpers'
import { common, configBlob, createTestPort, createWorld } from '../support/world'
import type { World, Gate, Options } from '../support/world'

interface RenderTable { elements?: PaneElements }

const config = JSON.stringify({ verify: ['./check'], always: [['./lint']] })

function findInnermostBox(node: unknown, text: string): DrawnNode | undefined {
  if (typeof node !== 'object' || node === null) return undefined
  const tree = node as DrawnNode
  return (tree.children ?? []).map(child => findInnermostBox(child, text)).find(child => child !== undefined)
    ?? (tree.type === 'Box' && textOf(tree) === text ? tree : undefined)
}

function hasColumnBox(node: unknown): boolean {
  if (typeof node !== 'object' || node === null) return false
  const tree = node as DrawnNode
  return (tree.type === 'Box' && tree.props?.['flexDirection'] === 'column') || (tree.children ?? []).some(hasColumnBox)
}

async function expectTheme(pane: Mounted<'terminal', 'Pane'>): Promise<void> {
  checkTheme(await pane.drawn(), ['text', 'inactive', 'suggestion', 'success', 'warning', 'error', 'merged', 'subtle'])
  expect((await pane.find({ type: 'Box' }))?.props['backgroundColor']).toBeUndefined()
}


async function expectText(pane: Mounted<'terminal', 'Pane'>, text: string, props: Record<string, unknown>): Promise<void> {
  const found = (await pane.findAll({ type: 'Text' })).find(node => node.text === text && Object.entries(props).every(([key, value]) => node.props[key] === value))
  expect(found).toBeDefined()
}

async function mountRunLog($: Parameters<typeof readFlowStatus>[0], columns = 80): Promise<Mounted<'terminal', 'Pane'>> {
  await readFlowStatus($)
  const pane = await mountPane($, { columns })
  await pane.press({ key: 'l' })
  return pane
}

function command(status: RunCommandView['status'], outcome: string, output = '', seconds = 0): RunCommandView {
  return { argv: [`./${status}`], status, outcome, output, duration: seconds }
}

function savedRun(overrides: Partial<RunView> = {}): RunView {
  const defaults: RunView = { runId: 'saved', kind: 'Verify', status: 'failed', selection: 'rules: hooks/**', tree: '3f9e0c1abcdef', cwd: '/workspace/a-long-worktree',
    log: '/repo.git/working-agreement/runs/saved.log', at: 1000, duration: 106,
    commands: [command('passed', 'exit 0', 'first\n\nlast', 4), command('failed', 'exit 1', 'failure', 102), command('waiting', '', 'must not appear')] }
  return { ...defaults, ...overrides }
}

function seedRun(on: On, run: RunView, options: Options = {}): World {
  const outcome: VerifyRecord['outcome'] = run.status === 'passed' ? { kind: 'pass' } : run.status === 'timed out' ? { kind: 'timeout', minutes: 30 } : { kind: 'fail', code: 1, signal: null }
  const record = { tree: run.tree, runId: run.runId, at: run.at, outcome }
  const unit = run.kind === 'Verify'
    ? { verifyRuns: [{ ...record, base: 'c0', configBlob: configBlob(config), commands: run.commands.map(entry => entry.argv) }] }
    : { runs: [{ ...record, argv: run.commands[0]!.argv }] }
  const world = createWorld(on, { branch: 'feat', isDirty: true, tree: run.tree }, { ...options, approvedConfig: config, unit, verifyFile: config })
  world.files.set(`${common}/working-agreement/runs/${run.runId}.json`, JSON.stringify(run))
  return world
}

for (const columns of [30, 60]) {
  test(`a Verify re-run on a verified tree keeps Commit current on one row at ${columns} columns`, async ($, on) => {
    const gate: Gate = {}
    const run = savedRun({ status: 'passed', commands: [
      { ...command('passed', 'exit 0'), argv: ['./lint'] },
      { ...command('passed', 'exit 0'), argv: ['./check'] },
    ] })
    const { clock } = seedRun(on, run, { session: { flow: 'trivial' }, spawnCode: 1, spawnGate: new Promise<void>(resolve => { gate.open = resolve }) })
    await readFlowStatus($)
    const before = await mountPane($, { columns })
    expect(textOf(await before.drawn())).toContain('✓ Verify')
    expect(textOf(await before.drawn())).toContain('▸ Commit · no commit in the slice')
    const beforeRow = findInnermostBox(await before.drawn(), '▸ Commit · no commit in the slice')
    expect(beforeRow).toBeDefined()
    expect(beforeRow?.props?.['flexDirection']).not.toBe('column')
    expect((beforeRow?.children ?? []).some(hasColumnBox)).toBe(false)
    await before.unmount()

    const pending = $.tool.call({ tool: 'mcp__working-agreement__verify' })
    await clock.settle()
    const pane = await mountPane($, { columns })
    const liveRow = findInnermostBox(await pane.drawn(), '▸ Commit · no commit in the slice')
    expect(liveRow).toBeDefined()
    expect(liveRow?.props?.['flexDirection']).not.toBe('column')
    expect((liveRow?.children ?? []).some(hasColumnBox)).toBe(false)
    const liveText = textOf(await pane.drawn())
    expect(liveText).toContain('✓ Verify')
    expect(liveText).not.toContain('▸ Verify')
    await expectText(pane, 'Commit', { color: 'text' })

    gate.open?.()
    await clock.settle()
    await pending
    const ended = textOf(await pane.drawn())
    expect(ended).toContain('✗ Verify · failed, exit 1')
    expect(ended).toContain('○ Commit')
    expect(ended).not.toContain('no commit in the slice')
    const failedRow = findInnermostBox(await pane.drawn(), '✗ Verify · failed, exit 1')
    expect(failedRow).toBeDefined()
    expect(failedRow?.props?.['flexDirection']).not.toBe('column')
    expect((failedRow?.children ?? []).some(hasColumnBox)).toBe(false)
    await pane.unmount()
  })
}

for (const tool of ['verify', 'run']) {
  test(`${tool} shows live commands and a throttled four-line tail, then only its step fact`, async ($, on) => {
    const gate: Gate = {}
    const options: Options = { verifyFile: config, session: { flow: tool === 'run' ? 'fix' : 'small-feature' },
      spawnGate: new Promise<void>(resolve => { gate.open = resolve }), spawnOutput: 'one\ntwo\nthree\nfour\nfive\n', spawnCode: 1 }
    options.approvedConfig = config
    const { clock } = createWorld(on, { branch: 'feat', isDirty: true, tree: 'changed' }, options)
    const pending = $.tool.call({ tool: `mcp__working-agreement__${tool}`, ...(tool === 'run' ? { argv: ['./reproduce'] } : {}) })
    await clock.settle()
    const pane = await mountPane($)
    const live = textOf(await pane.drawn())
    if (tool === 'run') expect(live).toContain('▸ Diagnose')
    expect(live).toContain(tool === 'run' ? './reproduce' : '▸ ./lint0:00')
    await expectText(pane, tool === 'run' ? 'run' : 'Verify', { color: 'text', weight: 'semibold' })
    await expectText(pane, tool === 'run' ? 'Diagnose' : 'Code', { color: 'text', weight: undefined })
    await expectText(pane, '▸ ', { color: 'suggestion' })
    await expectText(pane, '0:00', { color: 'inactive' })
    if (tool === 'verify') {
      expect(live).toContain('○ ./check')
      await expectText(pane, '0:00', { color: 'text' })
      expect(live).toContain('full (no rules)')
      await expectText(pane, '  full (no rules)', { color: 'inactive', wrap: 'truncate-end' })
      await expectText(pane, './lint', { color: 'text', wrap: 'truncate-end' })
      await expectText(pane, './check', { color: 'inactive', wrap: 'truncate-end' })
      await expectText(pane, '○ ', { color: 'inactive' })
    } else {
      expect(live).not.toContain('▸ ./reproduce')
      await expectText(pane, './reproduce', { color: 'text', wrap: 'truncate-end' })
    }
    await clock.advance(1000)
    const firstTail = textOf(await pane.drawn())
    expect(firstTail).toContain('│ two│ three│ four│ five')
    expect(firstTail).not.toContain('│ one')
    await expectText(pane, '0:01', { color: 'inactive' })
    await expectText(pane, '│ ', { color: 'subtle' })
    await expectText(pane, 'two', { color: 'text', wrap: 'truncate-end' })
    options.spawnOutput = 'new tail\n'
    await clock.advance(999)
    await readFlowStatus($)
    expect(textOf(await pane.drawn())).toBe(firstTail)
    await clock.advance(1)
    expect(textOf(await pane.drawn())).toContain('│ new tail')
    gate.open?.()
    await clock.settle()
    await pending
    const ended = textOf(await pane.drawn())
    expect(ended).not.toContain('│ new tail')
    expect(ended).not.toContain('○ ./check')
    expect(ended).toContain(tool === 'verify' ? '✗ Verify · failed, exit 1' : 'Diagnose · no comment after the red')
    if (tool === 'verify') {
      await expectText(pane, '✗ ', { color: 'error' })
      await expectText(pane, 'failed, exit 1', { color: 'error', wrap: 'wrap' })
    }
    expect((await pane.find({ key: 'l' }))?.props['hotkey']).toBe('l')
    expect(await pane.find({ key: 'c' })).toBeUndefined()
    await expectTheme(pane)
    await pane.unmount()
  })
}

test('completed commands stay above the running command, and each log block keeps its own output', async ($, on) => {
  const gate: Gate = {}
  const second = new Promise<void>(resolve => { gate.open = resolve })
  const count = { value: 0 }
  const options: Options = { verifyFile: config }
  options.afterSpawn = () => {
    count.value += 1
    options.spawnOutput = count.value === 1 ? 'argv: ordinary first output' : 'second output'
    options.spawnGate = second
  }
  options.approvedConfig = config
  const { clock } = createWorld(on, { branch: 'feat', isDirty: true, tree: 'changed' }, options)
  const pending = $.tool.call({ tool: 'mcp__working-agreement__verify' })
  await clock.settle()
  options.spawnOutput = 'second live output'
  await clock.advance(1000)
  const flow = await mountPane($)
  expect(textOf(await flow.drawn())).toContain('✓ ./lint0s▸ ./check0:01│ second live output')
  await expectText(flow, '✓ ', { color: 'success' })
  await expectText(flow, '0s', { color: 'inactive' })
  gate.open?.()
  await clock.settle()
  await pending
  const ended = textOf(await flow.drawn())
  expect(ended).toContain('✓ Verify')
  expect(ended).not.toContain('Verify · passed')
  await expectText(flow, 'Verify', { color: 'text', weight: undefined })
  await flow.press({ key: 'l' })
  const log = flow
  const text = textOf(await log.drawn())
  expect(text).toContain('✓ ./lintexit 0 · 0s│ argv: ordinary first output')
  expect(text).toContain('✓ ./checkexit 0 · 1s│ second output')
  expect(text.indexOf('argv: ordinary first output')).toBeLessThan(text.indexOf('✓ ./check'))
  await expectTheme(log)
  await flow.unmount()
})

test('timeout clears the live section and leaves the short Verify fact', async ($, on) => {
  const file = JSON.stringify({ verify: ['./silent'], timeoutMinutes: 0.01 })
  const { clock } = createWorld(on, { branch: 'feat', isDirty: true, tree: 'changed' }, { approvedConfig: file, verifyFile: file, spawnGate: new Promise(() => {}) })
  const pending = $.tool.call({ tool: 'mcp__working-agreement__verify' })
  await clock.settle()
  const flow = await mountPane($)
  expect(textOf(await flow.drawn())).toContain('▸ Code')
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('already in flight')
  expect(textOf(await flow.drawn())).toContain('○ Verify')
  await clock.advance(600)
  await pending
  const ended = textOf(await flow.drawn())
  expect(ended).toContain('✗ Verify · timed out, 0.01 min')
  expect(ended).not.toContain('./silent')
  await expectText(flow, 'timed out, 0.01 min', { color: 'error', wrap: 'wrap' })
  await flow.press({ key: 'l' })
  const log = flow
  await expectText(log, 'timed out', { color: 'error' })
  await expectText(log, 'timed out · 0.01 min', { color: 'error' })
  expect(textOf(await log.drawn())).not.toContain('timed out after')
  await expectTheme(log)
  await flow.unmount()
})

test('l switches the Flow pane to Run log; Flow or Esc returns and digit selectors keep outcomes before output', async ($, on) => {
  const options: Options = {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'], comments: [] } } },
    comments: { 1: [] }, issueLabels: { 1: ['ready-for-agent'] },
    verifyFile: config, spawnCode: 1, spawnOutput: 'red output',
  }
  const checkout = { branch: 'fix', isDirty: true, tree: 'red-tree' }
  options.approvedConfig = config
  const { clock, opened } = createWorld(on, checkout, options)
  await $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./reproduce'] })
  await clock.advance(1000)
  checkout.tree = 'green-tree'
  options.spawnCode = 0
  options.spawnOutput = 'old green output'
  await $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./reproduce'] })
  await clock.advance(1000)
  options.spawnOutput = 'green output'
  await $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./reproduce'] })
  expect(await readFlowStatus($)).toContain('Diagnose · no comment after the red')
  const context = await readPromptContext($)
  expect(context).toContain("current step: Diagnose. Diagnose next needs a diagnosis comment on #1 after the red run, then the user's /flow approve <comment URL>.")
  expect(context).not.toContain('Diagnose. no comment after the red.')
  const diagnosePane = await mountPane($)
  expect(textOf(await diagnosePane.drawn())).toContain('▸ Diagnose · no comment after the red')
  await diagnosePane.unmount()
  await clock.advance(1000)
  options.spawnOutput = 'Verify output'
  options.spawnCode = 1
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  const flow = await mountPane($)
  await flow.press({ key: 'l' })
  expect(opened).toContainEqual({ id: 'working-agreement', title: 'Flow', closeOnEscape: true })
  const log = flow
  const buttons = (await log.findAll({ type: 'Button' })).filter(button => button.props['hotkey'])
  expect(buttons.map(button => button.props['hotkey'])).toEqual(['1', '2', '3'])
  expect(buttons.map(button => button.text)).toEqual(['Verify · failed', 'green · exit 0', 'red · exit 1'])
  expect(buttons.every(button => button.props['plain'] === true)).toBe(true)
  await expectText(log, '❯ ', { color: 'suggestion' })
  await expectText(log, '  ', { color: 'suggestion' })
  await expectText(log, 'Verify', { color: 'text', weight: 'semibold' })
  await expectText(log, 'green', { color: 'text', weight: undefined })
  await expectText(log, ' · failed', { color: 'inactive', wrap: 'truncate-end' })
  await expectText(log, 'green-t', { color: 'inactive' })
  expect((await log.findAll({ type: 'Box' })).some(box => box.props['marginY'] === 1 && /^─+$/.test(textOf(box)))).toBe(true)
  const verify = textOf(await log.drawn())
  expect(verify).toContain('Selectionfull (no rules)')
  expect(verify).toContain('Cwd/repo')
  expect(verify).toContain('File/repo.git/working-agreement/runs/')
  expect(verify).toContain('✗ ./lintexit 1 · 0s│ Verify output')
  expect(verify).toContain('○ ./checknot run')
  await log.press({ key: '2' })
  const green = textOf(await log.drawn())
  expect(green).toContain('✓ ./reproduceexit 0 · 0s│ green output')
  expect(green).not.toContain('old green output')
  expect(green).not.toContain('Verify output')
  expect(green).toContain('run · green recorded')
  expect(green).not.toContain('Selection')
  await expectText(log, 'green recorded', { color: 'text' })
  await log.press({ key: '3' })
  expect(textOf(await log.drawn())).toContain('✗ ./reproduceexit 1 · 0s│ red output')
  await expectText(log, '❯ ', { color: 'suggestion' })
  await expectText(log, 'exit 1 · 0s', { color: 'error' })
  await expectText(log, 'red recorded', { color: 'text' })
  await log.press({ key: '1' })
  expect(textOf(await log.drawn())).toContain('Verify output')
  const back = await log.find({ key: 'flow' })
  expect(back?.props['label']).toBe('Flow')
  expect(back?.props['hotkey']).toBeUndefined()
  expect(await log.findAll({ type: 'Text', text: /^Esc$/ })).toHaveLength(0)
  await expectText(log, 'Home/End · PgUp/PgDn', { color: 'inactive', wrap: 'truncate-end' })
  await log.press({ key: 'flow' })
  expect(opened).toContainEqual({ id: 'working-agreement', title: 'Flow', closeOnEscape: undefined })
  expect(textOf(await log.drawn())).toContain('▸ Diagnose · no comment after the red')
  await expectTheme(log)
  await flow.unmount()
})

test('a person close returns Run log to Flow but passes through from Flow', async (_$, on) => {
  const world = createWorld(on, { branch: 'feat' })
  const port = createTestPort(world)
  const passed: PaneCloseInput[] = []
  const next = (async (event: PaneCloseInput) => { passed.push(event); return { value: undefined } }) as unknown as Next<'ui.close'>
  world.paneViews.push('run-log')
  await handlePaneClose(port, { id: 'working-agreement', origin: { kind: 'person' } }, next)
  expect(world.paneViews.at(-1)).toBe('flow')
  expect(world.opened.at(-1)).toEqual({ id: 'working-agreement', title: 'Flow', closeOnEscape: undefined })
  expect(passed).toEqual([])
  await handlePaneClose(port, { id: 'working-agreement', origin: { kind: 'person' } }, next)
  expect(passed).toEqual([{ id: 'working-agreement', origin: { kind: 'person' } }])
})

for (const sidecar of ['missing', 'invalid']) {
  test(`a ${sidecar} sidecar leaves the recorded run summary readable`, async ($, on) => {
    const { files, chat, sessions, seedChat } = createWorld(on, { branch: 'feat', isDirty: true, tree: 'changed' }, { approvedConfig: config, verifyFile: config, spawnOutput: 'output' })
    await $.tool.call({ tool: 'mcp__working-agreement__verify' })
    for (const path of files.keys()) {
      if (path.includes('/runs/') && path.endsWith('.json')) {
        if (sidecar === 'missing') files.delete(path)
        else files.set(path, '{"commands":[null]}')
      }
    }
    const previous = sessions.get('sid')!
    chat.id = 'reader'
    seedChat(chat.id, { ...previous, sessionId: chat.id, units: [] })
    await readFlowStatus($)
    const log = await mountRunLog($)
    expect(textOf(await log.drawn())).toContain('Verify · passed')
    await expectTheme(log)
    await log.unmount()
  })
}

test('an unrecorded tree-changing Verify remains in Run log until the next run', async ($, on) => {
  const checkout = { branch: 'feat', isDirty: true, tree: 'before' }
  const options: Options = { verifyFile: config, spawnOutput: 'changed output', afterSpawn: () => { checkout.tree = 'after' } }
  options.approvedConfig = config
  const { sessions, clock } = createWorld(on, checkout, options)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(sessions.get('sid')?.units[0]?.verifyRuns).toEqual([])
  const pane = await mountPane($)
  expect(textOf(await pane.drawn())).toContain('▸ Code · tree changed during run')
  await expectText(pane, 'tree changed during run', { color: 'text', wrap: 'wrap' })
  await pane.press({ key: 'l' })
  expect(textOf(await pane.drawn())).toContain('Verify · not recorded')
  expect(textOf(await pane.drawn())).toContain('Changedsrc/a.ts')
  await expectText(pane, 'not recorded', { color: 'warning' })
  await expectText(pane, 'src/a.ts', { color: 'warning', wrap: 'wrap' })
  options.afterSpawn = () => {}
  options.spawnOutput = 'next output'
  await clock.advance(1000)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  const next = textOf(await pane.drawn())
  expect(next).toContain('Verify · passed')
  expect(next).not.toContain('tree changed')
  expect(next).not.toContain('changed output')
  expect((await pane.find({ key: 'flow' }))?.props['label']).toBe('Flow')
  await pane.press({ key: 'flow' })
  expect(textOf(await pane.drawn())).toContain('✓ Verify')
  await expectTheme(pane)
  await pane.unmount()
})

test('an unrecorded tree-changing Verify on a tree another run covers shows on the current Verify', async ($, on) => {
  const checkout = { branch: 'feat', ahead: 8, isDirty: true, tree: 'before' }
  const covering = { tree: 'after', base: 'c0', configBlob: configBlob(config), commands: [['./lint'], ['./check']],
    outcome: { kind: 'fail', code: 1, signal: null }, runId: 'covering', at: 1 }
  createWorld(on, checkout, { verifyFile: config, approvedConfig: config, unit: { verifyRuns: [covering] }, afterSpawn: () => { checkout.tree = 'after' } })
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  const pane = await mountPane($)
  const drawn = textOf(await pane.drawn())
  expect(drawn).toContain('✓ Code')
  expect(drawn).toContain('▸ Verify · tree changed during run')
  await pane.unmount()
})

test('an unrecorded tree-changing Verify leaves any other Code blocker shown, as in the status', async ($, on) => {
  const checkout = { branch: 'feat', isDirty: true, tree: 'before' }
  createWorld(on, checkout, {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'], comments: [diagnosisComment] } } },
    unit: diagnosed, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
    verifyFile: config, approvedConfig: config, afterSpawn: () => { checkout.tree = 'after' },
  })
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  const pane = await mountPane($)
  const drawn = textOf(await pane.drawn())
  expect(drawn).toContain('▸ Code · no green after the approval')
  expect(drawn).not.toContain('tree changed during run')
  expect(await readFlowStatus($)).toContain('▸ Code · no green after the approval')
  await pane.unmount()
})

test('resize stacks whole footer buttons above the primary, while identifiers yield around fixed parts', async ($, on) => {
  const gate: Gate = {}
  const argv = ['./very-long-command-name-with-a-distinct-end']
  const options: Options = { session: { flow: 'fix', isLong: true }, spawnGate: new Promise<void>(resolve => { gate.open = resolve }) }
  const { clock } = createWorld(on, { branch: 'very-long-branch-name-with-a-distinct-end', isDirty: true }, options)
  const pending = $.tool.call({ tool: 'mcp__working-agreement__run', argv })
  await clock.settle()
  const pane = await mountPane($, { columns: 48 })
  const wideBoxes = await pane.findAll({ type: 'Box' })
  expect(wideBoxes.some(box => box.props['flexDirection'] === 'row' && box.props['justifyContent'] === 'flex-end' && box.props['gap'] === 2)).toBe(true)
  await pane.redraw({ title: 'Flow', isFocused: true, bodyColumns: 43, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} })
  const buttons = await pane.findAll({ type: 'Button' })
  expect(buttons.slice(-2).map(button => button.props['label'])).toEqual(['Run log', 'Continue in new session'])
  const boxes = await pane.findAll({ type: 'Box' })
  expect(boxes.some(box => box.props['flexDirection'] === 'column' && box.props['alignItems'] === 'flex-end' && box.props['gap'] === 1)).toBe(true)
  const texts = await pane.findAll({ type: 'Text' })
  expect(texts.find(text => text.text === argv[0])?.props['wrap']).toBe('truncate-end')
  expect(texts.find(text => text.text === 'very-long-branch-name-with-a-distinct-end')?.props['wrap']).toBe('truncate-middle')
  expect(boxes.some(box => box.props['flexShrink'] === 0 && /^\d+:\d\d$/.test(textOf(box)))).toBe(true)
  expect(boxes.some(box => box.props['width'] === 2 && box.props['flexShrink'] === 0 && textOf(box) === '▸ ')).toBe(true)
  expect(textOf(await pane.drawn())).not.toContain('Unit finished.')
  expect((await pane.find({ key: 'l' }))?.props['hotkey']).toBe('l')
  expect((await pane.find({ key: 'c' }))?.props['hotkey']).toBe('c')
  await pane.redraw({ title: 'Flow', isFocused: true, bodyColumns: 44, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} })
  expect((await pane.findAll({ type: 'Box' })).some(box => box.props['flexDirection'] === 'row' && box.props['justifyContent'] === 'flex-end' && box.props['gap'] === 2)).toBe(true)
  gate.open?.()
  await clock.settle()
  await pending
  await pane.unmount()
})

test('single-command Verify has a plain live argv and appears before recorded history in Run log', async ($, on) => {
  const gate: Gate = {}
  const file = '{"verify":["./only"]}'
  const options: Options = { verifyFile: file, spawnOutput: 'one\ntwo\n\nfour\nfive\n', spawnGate: new Promise<void>(resolve => { gate.open = resolve }),
    unit: { runs: [{ argv: ['./before'], tree: 'abcdef123456', runId: 'older', at: 0, outcome: { kind: 'fail', code: 7, signal: null } }] } }
  options.approvedConfig = file
  const { clock } = createWorld(on, { branch: 'feat', isDirty: true, tree: '3f9e0c1abcdef' }, options)
  await clock.advance(1000)
  const pending = $.tool.call({ tool: 'mcp__working-agreement__verify' })
  await clock.settle()
  await clock.advance(14000)
  const flow = await mountPane($)
  await expectText(flow, './only', { color: 'text', wrap: 'truncate-end' })
  await expectText(flow, '0:14', { color: 'inactive' })
  await expectText(flow, ' ', { color: 'text', wrap: 'truncate-end' })
  expect(textOf(await flow.drawn())).not.toContain('▸ ./only')
  await flow.press({ key: 'l' })
  const log = flow
  const picks = (await log.findAll({ type: 'Button' })).filter(button => button.props['hotkey'])
  expect(picks.map(button => button.text)).toEqual(['running · 0:14', 'red · exit 7'])
  expect(picks.map(button => button.props['hotkey'])).toEqual(['1', '2'])
  await expectText(log, 'running', { color: 'text', weight: 'semibold' })
  await expectText(log, 'running', { color: 'text' })
  await expectText(log, '0:14', { color: 'inactive' })
  await expectText(log, '0:14', { color: 'text' })
  await expectText(log, './only', { color: 'text', weight: 'semibold', wrap: 'wrap' })
  await expectText(log, '3f9e0c1', { color: 'text' })
  expect(textOf(await log.drawn())).toContain('│ two│  │ four│ five')
  expect(textOf(await log.drawn())).not.toContain('│ one')
  await log.press({ key: '2' })
  expect(textOf(await log.drawn())).toContain('run · red recorded')
  await log.press({ key: '1' })
  gate.open?.()
  await clock.settle()
  await pending
  expect(textOf(await log.drawn())).toContain('Verify · passed')
  await expectTheme(log)
  await flow.unmount()
})

test('Run log summary, keyed rows and command blocks match variant D spacing, colours and wrapping', async ($, on) => {
  const run = savedRun()
  seedRun(on, run)
  const log = await mountRunLog($, 47)
  const text = textOf(await log.drawn())
  expect(text).toContain('Verify · failed1m46s')
  await expectText(log, 'Verify', { color: 'text', weight: 'semibold' })
  await expectText(log, ' · ', { color: 'inactive' })
  await expectText(log, 'failed', { color: 'error', weight: undefined })
  await expectText(log, '1m46s', { color: 'inactive' })
  await expectText(log, 'rules: hooks/**', { color: 'text', wrap: 'truncate-end' })
  await expectText(log, '3f9e0c1', { color: 'text', wrap: 'wrap' })
  await expectText(log, run.cwd, { color: 'text', wrap: 'truncate-middle' })
  await expectText(log, run.log, { color: 'inactive', wrap: 'wrap' })
  for (const key of ['Selection', 'Tree', 'Cwd', 'File']) {
    await expectText(log, key, { color: 'inactive' })
    expect((await log.findAll({ type: 'Box' })).some(box => box.props['width'] === 10 && box.props['flexShrink'] === 0 && textOf(box) === key)).toBe(true)
  }
  await expectText(log, '✓ ', { color: 'success' })
  await expectText(log, '✗ ', { color: 'error' })
  await expectText(log, '○ ', { color: 'inactive' })
  await expectText(log, './passed', { color: 'text', weight: 'semibold', wrap: 'wrap' })
  await expectText(log, './failed', { color: 'text', weight: 'semibold', wrap: 'wrap' })
  await expectText(log, './waiting', { color: 'inactive', weight: undefined, wrap: 'wrap' })
  await expectText(log, 'exit 0 · 4s', { color: 'inactive' })
  await expectText(log, 'exit 1 · 1m42s', { color: 'error' })
  await expectText(log, 'not run', { color: 'inactive' })
  await expectText(log, '│ ', { color: 'subtle' })
  await expectText(log, ' ', { color: 'inactive', wrap: 'wrap' })
  await expectText(log, 'failure', { color: 'text', wrap: 'wrap' })
  expect(text).not.toContain('must not appear')
  const boxes = await log.findAll({ type: 'Box' })
  expect(boxes.some(box => box.props['paddingLeft'] === 2 && textOf(box) === 'exit 1 · 1m42s')).toBe(true)
  expect(boxes.filter(box => box.props['marginTop'] === 1 && textOf(box).startsWith('─'))).toHaveLength(4)
  expect(text.indexOf('exit 1 · 1m42s')).toBeLessThan(text.indexOf('│ failure'))
  expect(text.indexOf('Home/End · PgUp/PgDn')).toBeGreaterThan(text.indexOf('not run'))
  expect((await log.find({ key: 'flow' }))?.props['label']).toBe('Flow')
  await expectTheme(log)
  await log.unmount()
})

test('a finished red run draws its failed command as a failure, like a failed Verify command', async ($, on) => {
  seedRun(on, savedRun({ kind: 'red', status: 'failed', commands: [command('failed', 'exit 1', 'boom', 8)] }))
  const log = await mountRunLog($, 47)
  const text = textOf(await log.drawn())
  expect(text).toContain('✗ ./failed')
  expect(text).not.toContain('▸ ./failed')
  await expectText(log, '✗ ', { color: 'error' })
  await expectText(log, 'exit 1 · 8s', { color: 'error' })
  await log.unmount()
})

for (const [status, label, color] of [['passed', 'passed', 'text'], ['timed out', 'timed out', 'error'], ['tree changed', 'not recorded', 'warning'], ['cancelled', 'cancelled', 'inactive']] as const) {
  test(`Run log renders ${status} with its own outcome and command contract`, async ($, on) => {
    const commands = status === 'timed out' ? [command('timeout', 'timed out after 30 min', '', 1800)]
      : status === 'cancelled' ? [command('passed', 'exit 0', '', 65), command('cancelled', 'cancelled'), command('waiting', '', 'hidden')]
      : [command('passed', 'exit 0', '', 65)]
    const run = savedRun({ status, commands, duration: status === 'timed out' ? 1800 : 65, ...(status === 'tree changed' ? { changed: ['src/a.ts'] } : {}) })
    seedRun(on, run)
    await readFlowStatus($)
    const flow = await mountPane($)
    const previousFact = textOf(await flow.drawn())
    await flow.press({ key: 'l' })
    const log = flow
    await expectText(log, label, { color })
    await expectText(log, status === 'timed out' ? '30m00s' : '1m05s', { color: 'inactive' })
    await expectText(log, '(no output)', { color: 'inactive', wrap: 'wrap' })
    if (status === 'timed out') {
      await expectText(log, 'timed out · 30 min', { color: 'error' })
      expect(textOf(await log.drawn())).not.toContain('timed out after')
    }
    if (status === 'tree changed') await expectText(log, 'src/a.ts', { color: 'warning', wrap: 'wrap' })
    if (status === 'cancelled') {
      await expectText(log, 'killed', { color: 'inactive' })
      await expectText(log, './cancelled', { color: 'inactive', weight: undefined })
      await expectText(log, './waiting', { color: 'inactive', weight: undefined })
      expect(textOf(await log.drawn())).toContain('↷ ./cancelled')
      expect(textOf(await log.drawn())).toContain('○ ./waiting')
      expect(textOf(await log.drawn())).not.toContain('hidden')
    }
    await log.press({ key: 'flow' })
    expect(textOf(await flow.drawn())).toBe(previousFact)
    await expectTheme(log)
    await flow.unmount()
  })
}

test('step rows keep fixed names and symbols, wrap current facts, and truncate skipped reasons', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  const value: FlowView = { flow: 'Small feature', progress: '3/7', issues: [{ number: 1, title: 'A long issue title' }], pending: null, meta: [], labels: [], notes: [], footer: { action: 'continue', isRunning: false },
    steps: [
      { isError: false, isMerged: false, isRewritten: false, id: 'verify', symbol: '✓', label: 'Verify', state: 'done' },
      { isError: false, isMerged: false, isRewritten: false, id: 'commit', symbol: '▸', label: 'Commit', state: 'current', detail: 'a fact to act on that wraps' },
      { isError: false, isMerged: false, isRewritten: false, id: 'pr', symbol: '○', label: 'PR', state: 'pending' },
      { isError: false, isMerged: false, isRewritten: false, id: 'tickets', symbol: '↷', label: 'Tickets', state: 'skipped', detail: 'optional for this unit' },
    ] }
  const displayed = { value, run: null as RunView | null }
  on('state.get', { plugin: 'working-agreement', key: 'view' }, () => ({ value: { value: displayed.value, version: 0 } }))
  on('state.get', { plugin: 'working-agreement', key: 'liveRun' }, () => ({ value: { value: displayed.run, version: 0 } }))
  const flow = await mountPane($, { columns: 47 })
  await expectText(flow, '✓ ', { color: 'success' })
  await expectText(flow, 'Verify', { color: 'text', weight: undefined })
  await expectText(flow, '▸ ', { color: 'suggestion' })
  await expectText(flow, 'Commit', { color: 'text', weight: undefined })
  await expectText(flow, 'a fact to act on that wraps', { color: 'text', wrap: 'wrap' })
  await expectText(flow, '○ ', { color: 'inactive' })
  await expectText(flow, 'PR', { color: 'inactive' })
  await expectText(flow, '↷ ', { color: 'inactive' })
  await expectText(flow, 'Tickets', { color: 'inactive' })
  await expectText(flow, 'optional for this unit', { color: 'inactive', wrap: 'truncate-end' })
  await expectText(flow, 'Small feature', { color: 'text', weight: 'semibold', wrap: 'truncate-end' })
  await expectText(flow, 'A long issue title', { color: 'inactive', wrap: 'truncate-end' })
  expect(textOf(await flow.drawn())).not.toContain('Unit finished.')
  const run = savedRun({ status: 'running', duration: 65, commands: [command('passed', 'exit 0', '', 65), command('failed', 'exit 7'), command('timeout', 'timed out after 30 min'), command('running', '', 'tail\n\nlast'), command('waiting', '')] })
  displayed.value = { ...value, hasRunLog: true }
  displayed.run = run
  await flow.redraw()
  await expectText(flow, 'Verify', { color: 'text', weight: 'semibold' })
  await expectText(flow, '  rules: hooks/**', { color: 'inactive', wrap: 'truncate-end' })
  await expectText(flow, '1:05', { color: 'inactive' })
  await expectText(flow, '1m05s', { color: 'inactive' })
  await expectText(flow, 'exit 7', { color: 'error' })
  await expectText(flow, 'timed out', { color: 'error' })
  await expectText(flow, '✗ ', { color: 'error' })
  await expectText(flow, '0:00', { color: 'text' })
  await expectText(flow, './waiting', { color: 'inactive', wrap: 'truncate-end' })
  await expectText(flow, ' ', { color: 'text', wrap: 'truncate-end' })
  await expectText(flow, '│ ', { color: 'subtle' })
  await expectTheme(flow)
  await flow.unmount()
})

test('a live red or green run leaves every row as judged, the current step with its fact', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  const value: FlowView = { flow: 'Fix', progress: '1/6', issues: [], pending: null, meta: [], labels: [], notes: [], footer: null,
    steps: [
      { isError: false, isMerged: false, isRewritten: false, id: 'diagnose', symbol: '✓', label: 'Diagnose', state: 'done' },
      { isError: false, isMerged: false, isRewritten: false, id: 'code', symbol: '▸', label: 'Code', state: 'current', detail: 'no green run on this tree' },
      { isError: false, isMerged: false, isRewritten: false, id: 'verify', symbol: '○', label: 'Verify', state: 'pending' },
    ] }
  const displayed = { value, run: null as RunView | null }
  on('state.get', { plugin: 'working-agreement', key: 'view' }, () => ({ value: { value: displayed.value, version: 0 } }))
  on('state.get', { plugin: 'working-agreement', key: 'liveRun' }, () => ({ value: { value: displayed.run, version: 0 } }))
  const flow = await mountPane($, { columns: 47 })
  for (const kind of ['green', 'red'] as const) {
    displayed.value = { ...value, hasRunLog: true }
    displayed.run = savedRun({ kind, status: 'running', commands: [command('running', '')] })
    await flow.redraw()
    const drawn = textOf(await flow.drawn())
    expect(drawn).toContain('✓ Diagnose')
    expect(drawn).toContain('▸ Code · no green run on this tree')
    expect(drawn).toContain('○ Verify')
  }
  await flow.unmount()
})

test('an unrecorded attempt leaves a done Verify row without status when an earlier pass still applies', async ($, on) => {
  const checkout = { branch: 'feat', tree: 'before', isDirty: true }
  createWorld(on, checkout, { approvedConfig: config, verifyFile: config, afterSpawn: () => { checkout.tree = 'after' },
    unit: { verifyRuns: [{ runId: 'previous', at: 0, tree: 'after', base: 'c0', configBlob: configBlob(config), commands: [['./lint'], ['./check']], outcome: { kind: 'pass' } }] } })
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(await readFlowStatus($)).toContain('✓ Verify\n')
  const flow = await mountPane($)
  expect(textOf(await flow.drawn())).not.toContain('tree changed during run')
  await expectText(flow, '✓ ', { color: 'success' })
  await flow.unmount()
  const log = await mountRunLog($)
  await expectText(log, 'not recorded', { color: 'warning' })
  await log.unmount()
})

test('an unrecorded attempt appears before the retained newest Verify record', async ($, on) => {
  const checkout = { branch: 'feat', tree: '3f9e0c1abcdef', isDirty: true }
  const options: Options = { verifyFile: config, afterSpawn: () => { checkout.tree = 'changed' },
    unit: { verifyRuns: [{ runId: 'previous', at: 0, tree: '1234567abcdef', base: 'c0', configBlob: configBlob(config), commands: [['./previous']], outcome: { kind: 'pass' } }] } }
  options.approvedConfig = config
  createWorld(on, checkout, options)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  const log = await mountRunLog($)
  const picks = (await log.findAll({ type: 'Button' })).filter(button => button.props['hotkey'])
  expect(picks.map(button => button.text)).toEqual(['not recorded · not recorded', 'Verify · passed'])
  await expectText(log, 'not recorded', { color: 'text', weight: 'semibold' })
  await expectText(log, '3f9e0c1', { color: 'inactive' })
  await log.press({ key: '2' })
  expect(textOf(await log.drawn())).toContain('Verify · passed')
  await expectText(log, '1234567', { color: 'text' })
  await expectTheme(log)
  await log.unmount()
})

test('a cancelled run holds no record error for its cut sidecar save, while a failed save on a live call still does', async (_$, on) => {
  const world = createWorld(on, { branch: 'feat', isDirty: true, tree: 'changed' }, { session: { flow: 'fix' } })
  const base = createTestPort(world)
  const call = { control: new AbortController(), isFailing: false }
  // The engine cuts a cancelled call's `$` calls; a live call's write can still fail on its own.
  const port: EnginePort = { ...base, processes: { ...base.processes, run: (argv, init) => call.control.signal.aborted || (call.isFailing && argv[0] === 'mv')
    ? Promise.reject(new Error(`$.process.run(${argv[0]}) aborted`)) : base.processes.run(argv, init) } }
  const { unit } = await readSession(port)
  const generation = (await readUnit(port, unit!)).generation
  const initial: RunView = { runId: '1-1-sid', kind: 'Verify', status: 'running', selection: '', tree: 'changed', cwd: '/repo', log: '/log', duration: 0, at: 0,
    commands: [{ argv: ['./check'], status: 'running', duration: 0, outcome: '', output: '' }] }
  const runView = (signal: AbortSignal, work: () => void): Promise<string> => withRunView(port, 'sid', unit!, generation, initial, signal, async () => { work(); return 'cancelled' })
  const cancelled = runView(call.control.signal, () => call.control.abort())
  // The test port's sleep ignores its signal, so the paint loop's wait ends only when the clock passes it.
  await world.clock.advance(1000)
  await cancelled
  expect(sessionMemory.recordError).toBe(null)
  call.control = new AbortController()
  const failed = runView(call.control.signal, () => { call.isFailing = true })
  await world.clock.advance(1000)
  await failed
  expect(sessionMemory.recordError?.error).toContain('runs/1-1-sid.json: $.process.run(mv) aborted')
})

test('a Run log render the host abandons ends quietly, while an unabandoned failure still throws', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', isDirty: true, tree: 'changed' }, { session: { flow: 'fix' } })
  const base = createTestPort(world)
  // The host cuts an abandoned render's `$` calls.
  const port: EnginePort = { ...base, processes: { ...base.processes, run: () => Promise.reject(new Error('$.process.run(git) aborted')) } }
  world.paneViews.push('run-log')
  const table: RenderTable = {}
  const render = new AbortController()
  render.abort()
  on('ui.render', { component: 'Pane', requestId: 'probe' }, (engine, e) => {
    table.elements = engine.ui.resolve(e)
    return handlePaneRender(port, table.elements, e.props, render.signal)
  })
  const pane = await mountPane($, { requestId: 'probe' })
  expect(textOf(await pane.drawn())).toBe('')
  await pane.unmount()
  await expect(handlePaneRender(port, table.elements!, { bodyColumns: 80, scroll: { offset: 0, bodyRows: 50 } }, new AbortController().signal)).rejects.toThrow('aborted')
})
