import { expect, test } from 'claude-code/testing'
import { noFlow, verifyFile } from '../../support/builders'
import { readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand } from '../../support/helpers'
import { configBlob, createWorld } from '../../support/world'
import type { Checkout, Options } from '../../support/world'

const changed = { branch: 'feat', ahead: 8, isDirty: true, tree: 'one' }
const config = { verify: ['full'], always: [['lint'], ['docs']], full: ['package.json', 'ci/**'],
  rules: [{ paths: ['docs/**'], run: ['docs'] }, { paths: ['docs/**', 'src/**'], run: ['second'] }] }

test('Verify stays present without config and proposes an argv config for approval', async ($, on) => {
  createWorld(on, { ...changed }, {})
  expect(await readCurrentStep($)).toBe('Verify')
  expect(await readFlowStatus($)).toContain('no verify command configured')
  const instruction = await readPromptContext($)
  expect(instruction).toContain("verify alone, as an argv taken from the project's docs, scripts or CI")
  expect(instruction).toContain('rules only when the full command is slow')
  expect(instruction).toContain('strict keys (verify, always, full, rules, timeoutMinutes, $schema)')
  expect(instruction).toContain('/flow approve verify')
})

for (const [file, path] of [
  ['{', '$'], ['[]', '$'], ['{}', 'verify'], ['{"verify":"sh"}', 'verify'], ['{"verify":[]}', 'verify'],
  ['{"verify":[""]}', 'verify[0]'], ['{"verify":["x"],"oops":1}', 'oops'],
  ['{"verify":["x"],"always":[[]]}', 'always[0]'], ['{"verify":["x"],"rules":{}}', 'rules'],
  ['{"verify":["x"],"rules":[{"paths":["docs/**",":x"],"run":["x"]}]}', 'rules[0].paths[1]'],
  ['{"verify":["x"],"rules":[{"paths":[],"run":[""]}]}', 'rules[0].run[0]'],
  ['{"verify":["x"],"rules":[{"paths":[],"run":["x"],"extra":1}]}', 'rules[0].extra'],
  ['{"verify":["x"],"full":["/root"]}', 'full[0]'], ['{"verify":["x"],"full":["a..b"]}', 'full[0]'],
  ['{"verify":["x"],"full":["a\\\\b"]}', 'full[0]'],
  ['{"verify":["x"],"timeoutMinutes":0}', 'timeoutMinutes'], ['{"verify":["x"],"timeoutMinutes":1e999}', 'timeoutMinutes'],
  ['{"verify":["x"],"timeoutMinutes":null}', 'timeoutMinutes'], ['{"verify":["x"],"full":null}', 'full'],
]) {
  test(`invalid config names its JSON path: ${file}`, async ($, on) => {
    const world = createWorld(on, { ...changed }, { approvedConfig: file!, verifyFile: file })
    const result = await $.tool.call({ tool: 'mcp__working-agreement__verify' })
    expect(result.result).toContain(`${path}:`)
    expect(result.isError).not.toBe(true)
    expect(world.sessions.get('sid')?.units[0]?.verifyRuns).toEqual([])
    expect(await readCurrentStep($)).toBe('Verify')
  })
}

test('approval previews all argv and globs, requires the current prefix, and is composer-only', async ($, on) => {
  const file = JSON.stringify(config)
  createWorld(on, { ...changed }, { verifyFile: file })
  const refused = await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(refused.result).toContain('Stop and ask the user to run /flow approve verify')
  expect((await runFlowCommand($, 'approve verify')).text).toContain('Run /flow approve verify')
  expect((await runFlowCommand($, 'approve verify')).text).toContain('ci/**')
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Stop and ask the user to run /flow approve verify')
  expect((await runFlowCommand($, 'approve verify deadbee')).text).toContain('Current config:')
  const id = configBlob(file).slice(0, 12)
  expect((await runFlowCommand($, `approve verify ${id}`, { kind: 'plugin', name: 'working-agreement' })).text).toContain("user's to run")
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Stop and ask the user to run /flow approve verify')
  expect((await runFlowCommand($, `approve verify ${id}`)).text).toContain('approved')
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Verify passed')
})

for (const [paths, full, commands] of [
  [['docs/a.md'], false, [['lint'], ['docs'], ['second']]],
  [['unmatched'], true, [['lint'], ['docs'], ['full']]],
  [['package.json'], true, [['lint'], ['docs'], ['full']]],
  [['ci/build'], true, [['lint'], ['docs'], ['full']]],
] as [string[], boolean, string[][]][]) {
  test(`selection for ${paths.join(', ')} is ordered, deduplicated, and complete`, async ($, on) => {
    const file = JSON.stringify(config)
    const world = createWorld(on, { ...changed, changed: paths }, { verifyFile: file })
    await runFlowCommand($, `approve verify ${configBlob(file).slice(0, 12)}`)
    const result = await $.tool.call({ tool: 'mcp__working-agreement__verify' })
    expect(result.result).toContain(full ? 'Selection: full' : 'Selection: rules docs/**')
    expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.commands).toEqual(commands)
    expect(await readCurrentStep($)).toBe('Commit')
    expect(await readFlowStatus($)).toContain('✓ Verify')
  })
}

test('no rules always selects full and accepts schema metadata and fractional timeouts', async ($, on) => {
  const file = JSON.stringify({ $schema: 'schema.json', verify: ['full'], always: [['full']], timeoutMinutes: 0.5 })
  const world = createWorld(on, { ...changed }, { verifyFile: file })
  await runFlowCommand($, `approve verify ${configBlob(file).slice(0, 12)}`)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('full (no rules)')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.commands).toEqual([['full']])
})

test('a unit with no common base runs full verification', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', graph: {
    commits: { m: { parents: [], files: {} }, f: { parents: [], files: { code: 'changed' } } },
    refs: { main: 'm', 'origin/main': 'm', feat: 'f' },
  } }, { verifyFile })
  await runFlowCommand($, `approve verify ${configBlob(verifyFile).slice(0, 12)}`)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('full (no base)')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.base).toBeNull()
})

test('commands changing the unit tree produce changed paths and no record', async ($, on) => {
  const checkout = { ...changed }
  const world = createWorld(on, checkout, { verifyFile, afterSpawn: () => { checkout.tree = 'mutated' } })
  await runFlowCommand($, `approve verify ${configBlob(verifyFile).slice(0, 12)}`)
  const result = await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(result.result).toContain('commands change the tree; no record written')
  expect(result.result).toContain('src/a.ts')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns).toEqual([])
})

test('an empty Code change or a branch checked out nowhere refuses without recording', async ($, on) => {
  const checkout: Checkout = { branch: 'feat' }
  const world = createWorld(on, checkout, { verifyFile })
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Code is not done')
  checkout.worktrees = {}
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('checked out nowhere')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns).toEqual([])
})

test('passes are bound to tree, base, config and recomputed command set; records stay bounded', async ($, on) => {
  const checkout: Checkout = { ...changed }
  const options: Options = { verifyFile }
  const world = createWorld(on, checkout, options)
  await runFlowCommand($, `approve verify ${configBlob(verifyFile).slice(0, 12)}`)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns).toHaveLength(1)
  checkout.tree = 'two'
  expect(await readCurrentStep($)).toBe('Verify')
  expect(await readFlowStatus($)).toContain('not run on this tree')
  checkout.tree = 'one'
  const record = world.sessions.get('sid')!
  world.sessions.set('sid', { ...record, units: record.units.map(unit => ({ ...unit, verifyRuns: unit.verifyRuns.map(run => ({ ...run, commands: [['partial']] })) })) })
  expect(await readCurrentStep($)).toBe('Verify')
  world.sessions.set('sid', { ...record, units: record.units.map(unit => ({ ...unit, base: 'c1' })) })
  expect(await readCurrentStep($)).toBe('Verify')
  options.verifyFile = JSON.stringify({ verify: ['different'] })
  expect(await readFlowStatus($)).toContain('config not approved')
})

test('a Verify on a new tree replaces the previous tree record in the session', async ($, on) => {
  const checkout = { ...changed }
  const world = createWorld(on, checkout, { verifyFile })
  await runFlowCommand($, `approve verify ${configBlob(verifyFile).slice(0, 12)}`)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  checkout.tree = 'two'
  await world.clock.advance(1)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns.map(run => run.tree)).toEqual(['two'])
  expect(await readCurrentStep($)).toBe('Commit')
  checkout.tree = 'one'
  expect(await readCurrentStep($)).toBe('Verify')
})

for (const [code, signal, fact] of [[7, null, 'failed, exit 7'], [null, 'SIGTERM', 'failed, signal SIGTERM']] as const) {
  test(`failed runs expose ${fact} and fail fast`, async ($, on) => {
    const file = JSON.stringify(config)
    const world = createWorld(on, { ...changed }, { verifyFile: file, spawnCode: code, spawnSignal: signal, spawnOutput: 'bad\routput\u001b[31m' })
    await runFlowCommand($, `approve verify ${configBlob(file).slice(0, 12)}`)
    const result = await $.tool.call({ tool: 'mcp__working-agreement__verify' })
    expect(result.result).toContain('the first error may be earlier — see')
    expect(result.result).toContain('Not run: ["docs"], ["second"]')
    expect(result.result).not.toContain('\u001b')
    expect(await readFlowStatus($)).toContain(fact)
    expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.outcome.kind).toBe('fail')
  })
}

test('timeout is a recorded failure and concurrent runs are refused', async ($, on) => {
  const options: Options = { verifyFile: JSON.stringify({ verify: ['slow'], timeoutMinutes: 0.01 }), spawnGate: new Promise(() => {}) }
  const world = createWorld(on, { ...changed }, options)
  await runFlowCommand($, `approve verify ${configBlob(options.verifyFile!).slice(0, 12)}`)
  const run = $.tool.call({ tool: 'mcp__working-agreement__verify' })
  await world.clock.settle()
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('already in flight')
  await world.clock.advance(600)
  expect((await run).result).toContain('timed out after 0.01 min')
  expect(await readFlowStatus($)).toContain('timed out, 0.01 min')
})

test('no unit refuses normally without an ignored config prompt notice', async ($, on) => {
  createWorld(on, { ...changed }, { session: noFlow, verifyFile: '{' })
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('No unit declared')
  expect(await readPromptContext($)).not.toContain('ignored')
})
