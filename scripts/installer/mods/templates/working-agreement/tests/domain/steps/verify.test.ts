import { expect } from 'claude-code/testing'
import { test } from '../../support/kit'
import { noFlow, verifyFile } from '../../support/builders'
import { readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand } from '../../support/helpers'
import { configBlob, createWorld } from '../../support/world'
import type { Checkout, Options } from '../../support/world'
import { facts } from '../../../hooks/domain/facts'

const changed = { branch: 'feat', ahead: 8, isDirty: true, tree: 'one' }
const config = { always: [['lint'], ['docs']],
  rules: [{ paths: ['docs/**'], run: ['docs'] }, { paths: ['docs/**', 'src/**'], run: ['second'] }] }

test('Verify stays present without config and proposes an argv config for approval', async ($, on) => {
  createWorld(on, { ...changed }, {})
  expect(await readCurrentStep($)).toBe('Verify')
  expect(await readFlowStatus($)).toContain('no verify command configured')
  const instruction = await readPromptContext($)
  expect(instruction).toContain('rules mapping path globs to the targeted check each change needs')
  expect(instruction).toContain('never the full suite, which CI runs')
  expect(instruction).toContain('strict keys (always, rules, timeoutMinutes, waitForCiLabels, issues, $schema)')
  expect(instruction).toContain('/flow approve verify')
})

for (const [file, path] of [
  ['{', '$'], ['[]', '$'], ['{"verify":["x"]}', 'verify'], ['{"full":["ci/**"]}', 'full'], ['{"oops":1}', 'oops'],
  ['{"always":[[""]]}', 'always[0][0]'], ['{"always":[[]]}', 'always[0]'], ['{"always":{}}', 'always'], ['{"rules":{}}', 'rules'],
  ['{"rules":[{"paths":["docs/**",":x"],"run":["x"]}]}', 'rules[0].paths[1]'],
  ['{"rules":[{"paths":["/root"],"run":["x"]}]}', 'rules[0].paths[0]'], ['{"rules":[{"paths":["a..b"],"run":["x"]}]}', 'rules[0].paths[0]'],
  ['{"rules":[{"paths":["a\\\\b"],"run":["x"]}]}', 'rules[0].paths[0]'],
  ['{"rules":[{"paths":[],"run":[""]}]}', 'rules[0].run[0]'],
  ['{"rules":[{"paths":[],"run":["x"],"extra":1}]}', 'rules[0].extra'],
  ['{"timeoutMinutes":0}', 'timeoutMinutes'], ['{"timeoutMinutes":1e999}', 'timeoutMinutes'], ['{"timeoutMinutes":null}', 'timeoutMinutes'],
  ['{"waitForCiLabels":"home"}', 'waitForCiLabels'], ['{"waitForCiLabels":[""]}', 'waitForCiLabels'],
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

test('a retired field names the config file and the remedy', async ($, on) => {
  const file = '{"full":["ci/**"]}'
  createWorld(on, { ...changed }, { approvedConfig: file, verifyFile: file })
  const result = await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(result.result).toContain('full: retired field in .claude/working-agreement.json')
  expect(result.result).toContain('regenerate the config, or move per-change checks into rules')
})

test('approval previews all argv and globs, requires the current prefix, and is composer-only', async ($, on) => {
  const file = JSON.stringify(config)
  createWorld(on, { ...changed }, { verifyFile: file })
  const refused = await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(refused.result).toContain('Stop and ask the user to run /flow approve verify')
  expect((await runFlowCommand($, 'approve verify')).text).toContain('Run /flow approve verify')
  expect((await runFlowCommand($, 'approve verify')).text).toContain('src/**')
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Stop and ask the user to run /flow approve verify')
  expect((await runFlowCommand($, 'approve verify deadbee')).text).toContain('Current config:')
  const id = configBlob(file).slice(0, 12)
  expect((await runFlowCommand($, `approve verify ${id}`, { kind: 'plugin', name: 'working-agreement' })).text).toContain("user's to run")
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Stop and ask the user to run /flow approve verify')
  expect((await runFlowCommand($, `approve verify ${id}`)).text).toContain('approved')
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Verify passed')
})

test('a rule selection is ordered, deduplicated, and runs only the matching rules', async ($, on) => {
  const file = JSON.stringify(config)
  const world = createWorld(on, { ...changed, changed: ['docs/a.md'] }, { verifyFile: file })
  await runFlowCommand($, `approve verify ${configBlob(file).slice(0, 12)}`)
  const result = await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(result.result).toContain('Selection: rules docs/**')
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.commands).toEqual([['lint'], ['docs'], ['second']])
  expect(await readCurrentStep($)).toBe('Commit')
  expect(await readFlowStatus($)).toContain('✓ Verify')
})

test('rules sharing a runner run it once with every path', async ($, on) => {
  const rules = [{ paths: ['docs/**'], run: ['t/bats.sh', 'mods'] }, { paths: ['docs/**'], run: ['sh', '-c', 'a'] },
    { paths: ['docs/**'], run: ['t/bats.sh', 'conventions'] }, { paths: ['docs/**'], run: ['t/bats.sh', 'mods/one.bats', 'mods'] },
    { paths: ['docs/**'], run: ['sh', '-c', 'b'] }, { paths: ['docs/**'], run: ['t/bats.sh', '--keep'] }]
  const merged = JSON.stringify({ rules })
  const world = createWorld(on, { ...changed, changed: ['docs/a.md'] }, { verifyFile: merged })
  await runFlowCommand($, `approve verify ${configBlob(merged).slice(0, 12)}`)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.commands)
    .toEqual([['t/bats.sh', 'mods', 'conventions'], ['sh', '-c', 'a'], ['sh', '-c', 'b'], ['t/bats.sh', '--keep']])
})

test('a bare runner absorbs the same runner with paths', async ($, on) => {
  const bare = JSON.stringify({ always: [['t/bats.sh', 'mods']], rules: [{ paths: ['docs/**'], run: ['t/bats.sh'] }] })
  const world = createWorld(on, { ...changed, changed: ['docs/a.md'] }, { verifyFile: bare })
  await runFlowCommand($, `approve verify ${configBlob(bare).slice(0, 12)}`)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.commands).toEqual([['t/bats.sh']])
})

test('a rule-selected pass stays done after the session moves into a subdirectory', async ($, on) => {
  const file = JSON.stringify(config)
  const options: Options = { verifyFile: file }
  createWorld(on, { ...changed, changed: ['docs/a.md'] }, options)
  await runFlowCommand($, `approve verify ${configBlob(file).slice(0, 12)}`)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  options.cwd = '/repo/docs'
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Verify')
  expect(status).not.toContain('not run on this tree')
})

test('a change no rule selects passes with nothing run, left to CI, and accepts schema metadata and fractional timeouts', async ($, on) => {
  const file = JSON.stringify({ $schema: 'schema.json', rules: [{ paths: ['nothing/**'], run: ['never'] }], timeoutMinutes: 0.5 })
  const world = createWorld(on, { ...changed }, { verifyFile: file })
  await runFlowCommand($, `approve verify ${configBlob(file).slice(0, 12)}`)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain(`Verify passed on tree one: no command run. Selection: ${facts.leftToCi}.`)
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.commands).toEqual([])
  expect(await readCurrentStep($)).toBe('Commit')
  expect(await readFlowStatus($)).toContain(facts.leftToCi)
})

test('a unit with no common base selects no rule and is left to CI', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', graph: {
    commits: { m: { parents: [], files: {} }, f: { parents: [], files: { code: 'changed' } } },
    refs: { main: 'm', 'origin/main': 'm', feat: 'f' },
  } }, { verifyFile })
  await runFlowCommand($, `approve verify ${configBlob(verifyFile).slice(0, 12)}`)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain(`Selection: ${facts.leftToCi}`)
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
  expect(await readCurrentStep($)).toBe('Code')
  expect(await readFlowStatus($)).toContain('▸ Code · tree changed')
  checkout.tree = 'one'
  options.verifyFile = JSON.stringify({ always: [['different']] })
  expect(await readFlowStatus($)).toContain('/flow approve verify')
})

for (const [scenario, run, unit, step] of [
  ['the recomputed command set on its base', {}, {}, 'Commit'],
  ['another command set', { commands: [['partial']] }, {}, 'Verify'],
  ['another config', { configBlob: 'other' }, {}, 'Verify'],
  ['another unit base', {}, { base: 'c1' }, 'Code'],
] as const) {
  test(`a recorded pass counts only for ${scenario}`, async ($, on) => {
    const pass = { tree: 'one', base: 'c0', configBlob: configBlob(verifyFile), commands: [['./test/run.sh']], outcome: { kind: 'pass' }, runId: 'r', at: 1, ...run }
    createWorld(on, { ...changed }, { approvedConfig: verifyFile, verifyFile, unit: { verifyRuns: [pass], ...unit } })
    expect(await readCurrentStep($)).toBe(step)
  })
}

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
  expect(await readCurrentStep($)).toBe('Code')
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
  const options: Options = { verifyFile: JSON.stringify({ always: [['slow']], timeoutMinutes: 0.01 }), spawnGate: new Promise(() => {}) }
  const world = createWorld(on, { ...changed }, options)
  await runFlowCommand($, `approve verify ${configBlob(options.verifyFile!).slice(0, 12)}`)
  const run = $.tool.call({ tool: 'mcp__working-agreement__verify' })
  await world.clock.settle()
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('already in flight')
  await world.clock.advance(600)
  expect((await run).result).toContain('timed out after 0.01 min')
  expect(await readFlowStatus($)).toContain('timed out after 0.01 min')
})

test('no unit refuses normally without an ignored config prompt notice', async ($, on) => {
  createWorld(on, { ...changed }, { session: noFlow, verifyFile: '{' })
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('No unit declared')
  expect(await readPromptContext($)).not.toContain('ignored')
})
