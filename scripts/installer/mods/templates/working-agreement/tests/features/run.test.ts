import { expect, test } from 'claude-code/testing'
import { noFlow, diagnosed, diagnosisComment } from '../support/builders'
import { declareFlow, readFlowStatus, readStepStates } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Options } from '../support/world'

const argv = ['./check']

for (const [session, reason] of [[noFlow, 'No unit declared'], [{ flow: 'close-out' }, 'no Diagnose step']] as const) {
  test(`run refuses outside Diagnose: ${reason}`, async ($, on) => {
    const { sessions } = createWorld(on, { branch: 'fix' }, { session })
    const result = await $.tool.call({ tool: 'mcp__working-agreement__run', argv })
    expect(result.result).toContain(reason)
    expect(result.isError).not.toBe(true)
    expect(sessions.get('sid')?.units.flatMap(unit => unit.runs)).toEqual([])
  })
}

for (const input of [undefined, [], [''], [1], 'check']) {
  test(`run refuses invalid argv ${JSON.stringify(input)}`, async ($, on) => {
    const { sessions } = createWorld(on, { branch: 'fix' }, { session: { flow: 'fix' } })
    expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv: input })).result).toContain('non-empty array of non-empty strings')
    expect(sessions.get('sid')?.units[0]?.runs).toEqual([])
  })
}

test('red and green record the same argv on different worktree content; changing argv bounds history', async ($, on) => {
  const checkout: Checkout = { branch: 'fix', tree: 'red', isDirty: true }
  const options: Options = { session: { flow: 'fix' }, spawnCode: 7, spawnOutput: 'tail' }
  const { sessions, clock } = createWorld(on, checkout, options)
  const red = await $.tool.call({ tool: 'mcp__working-agreement__run', argv })
  expect(red.result).toContain('red recorded on tree red; Diagnose')
  expect(red.result).toContain('tail')
  expect(red.result).toContain('/repo.git/working-agreement/runs/sid-')
  expect(red.result).toContain('tail\nthe first error may be earlier — see /repo.git/working-agreement/runs/sid-')
  expect(typeof red.result === 'string' ? red.result.match(/\/repo\.git\/working-agreement\/runs\/sid-[^\s]+\.log/g) : []).toHaveLength(1)
  options.spawnCode = 0
  await clock.advance(1)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv })).result).toContain('this pass does not count: Diagnose')
  checkout.tree = 'green'
  await clock.advance(1)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv })).result).toContain('this pass does not count: Diagnose')
  expect(sessions.get('sid')?.units[0]?.runs.map(run => run.outcome.kind)).toEqual(['pass', 'pass', 'fail'])
  await clock.advance(1)
  await $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['other'] })
  expect(sessions.get('sid')?.units[0]?.runs.map(run => run.argv)).toEqual([['other']])
})

test('run uses the declared branch worktree while the chat checkout is elsewhere', async ($, on) => {
  const checkout: Checkout = { branch: 'fix', isDirty: true, worktrees: { '/fix': { branch: 'fix', isDirty: true, tree: 'fix-tree' } } }
  const { sessions } = createWorld(on, checkout, { session: { flow: 'fix' } })
  checkout.branch = 'other'
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv })).result).toContain('this pass does not count: Diagnose')
  expect(sessions.get('sid')?.units[0]?.runs[0]?.tree).toBe('fix-tree')
})

test('progress describes a red, an unpaired pass and the fix green once Diagnose is approved', async ($, on) => {
  const checkout = { branch: 'fix', isDirty: true, tree: 'red' }
  const options: Options = {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'], comments: [diagnosisComment] } } },
    unit: diagnosed, spawnCode: 7,
  }
  const { clock } = createWorld(on, checkout, options)
  await clock.advance(10)
  const red = await $.tool.call({ tool: 'mcp__working-agreement__run', argv })
  expect(red.result).toContain('red recorded on tree red; a green needs the same argv on a different tree')
  expect(red.result).not.toContain('green after red:')
  options.spawnCode = 0
  await clock.advance(1)
  const unpaired = await $.tool.call({ tool: 'mcp__working-agreement__run', argv })
  expect(unpaired.result).toContain('this pass pairs with no earlier red of the same argv on a different tree')
  expect(unpaired.result).not.toContain('green after red:')
  checkout.tree = 'green'
  await clock.advance(1)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv })).result)
    .toContain('green after red: the approved fix passes; call the verify tool')
})

test('a pass before the approved comment is not the fix green, and one after it is', async ($, on) => {
  const checkout = { branch: 'fix', isDirty: true, tree: 'green' }
  const { clock } = createWorld(on, checkout, {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'], comments: [
      { ...diagnosisComment, createdAt: new Date(100).toISOString() },
    ] } } }, unit: diagnosed,
  })
  await clock.advance(10)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv })).result)
    .toContain('this pass pairs with no earlier red of the same argv on a different tree')
  await clock.advance(200)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv })).result)
    .toContain('green after red: the approved fix passes; call the verify tool')
})

test('a red recorded while Diagnose is open names the next Diagnose need', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'fix', isDirty: true, tree: 'red' }, {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'], comments: [] } } }, spawnCode: 7,
  })
  await clock.advance(10)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv })).result)
    .toContain("red recorded on tree red; Diagnose next needs a diagnosis comment on #1 after the red run, then the user's /flow approve <comment URL>")
})

test('run refuses an unchecked-out branch and a platform without process groups', async ($, on) => {
  const checkout: Checkout = { branch: 'fix', worktrees: {} }
  const { sessions } = createWorld(on, checkout, { session: { flow: 'fix' }, platform: 'Windows' })
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv })).result).toContain('checked out nowhere')
  checkout.worktrees = { '/repo': { branch: 'fix' } }
  expect((await $.tool.call({ tool: 'mcp__working-agreement__run', argv })).result).toContain('Linux or macOS')
  expect(sessions.get('sid')?.units[0]?.runs).toEqual([])
})

test('run discards evidence when the command changes worktree content and names changed paths', async ($, on) => {
  const checkout = { branch: 'fix', tree: 'before', isDirty: true }
  const { sessions } = createWorld(on, checkout, { session: { flow: 'fix' }, afterSpawn: () => { checkout.tree = 'after' } })
  const result = await $.tool.call({ tool: 'mcp__working-agreement__run', argv })
  expect(result.result).toContain('no record written. Changed paths: "src/a.ts"')
  expect(sessions.get('sid')?.units[0]?.runs).toEqual([])
})

for (const first of ['run', 'verify']) {
  test(`run and verify share an in-flight guard when ${first} starts first`, async ($, on) => {
    const options: Options = { session: { flow: 'fix' }, verifyFile: '{"verify":["./check"],"timeoutMinutes":0.01}', spawnGate: new Promise(() => {}) }
    options.approvedConfig = options.verifyFile!
    const { clock, sessions } = createWorld(on, { branch: 'fix', isDirty: true, tree: 'changed' }, options)
    const pending = $.tool.call({ tool: `mcp__working-agreement__${first}`, ...(first === 'run' ? { argv } : {}) })
    await clock.settle()
    for (const tool of ['run', 'verify']) expect((await $.tool.call({ tool: `mcp__working-agreement__${tool}`, ...(tool === 'run' ? { argv } : {}) })).result).toBe('a run is already in flight')
    await clock.advance(600)
    expect((await pending).result).toContain('timed out after 0.01 min')
    const unit = sessions.get('sid')?.units[0]
    expect((first === 'run' ? unit?.runs : unit?.verifyRuns)?.[0]?.outcome).toEqual({ kind: 'timeout', minutes: 0.01 })
  })
}

for (const tool of ['run', 'verify']) {
  test(`${tool} preserves the lifetime when a carried chat contributes its first run`, async ($, on) => {
    const options: Options = { session: noFlow, verifyFile: '{"verify":["./check"]}', issueLabels: { 1: ['ready-for-agent'] }, spawnCode: tool === 'run' ? 7 : 0 }
    options.approvedConfig = options.verifyFile!
    const world = createWorld(on, { branch: 'fix', isDirty: true, tree: 'changed' }, options)
    const { chat, sessions } = world
    expect((await declareFlow($, 'fix', [1])).deny).toBeUndefined()
    const previous = sessions.get('sid')!
    chat.id = 'carried'
    sessions.set(chat.id, { ...previous, sessionId: chat.id, units: [] })
    const result = await $.tool.call({ tool: `mcp__working-agreement__${tool}`, ...(tool === 'run' ? { argv } : {}) })
    expect(result.result).toContain(tool === 'run' ? 'red recorded' : 'Verify passed')
    expect(sessions.get(chat.id)?.units[0]?.generation).toBe(previous.units[0]?.generation)
    expect(sessions.get(chat.id)?.units[0]?.base).toBe(previous.units[0]?.base)
    if (tool === 'run') expect(await readFlowStatus($)).toContain('no comment after the red')
    else expect((await readStepStates(world)).Verify).toBe('done')
  })
}
