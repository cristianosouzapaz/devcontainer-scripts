import { expect } from 'claude-code/testing'
import { test } from '../../support/kit'
import { buildChangedCheckout, buildVerifyRun, noFlow, verifyFile, verifyId } from '../../support/builders'
import { approveVerify, readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand } from '../../support/helpers'
import { configBlob, createTestPort, createWorld, records } from '../../support/world'
import type { Checkout, Options } from '../../support/world'
import type { VerifyRecord } from '../../../types'
import { readGit } from '../../../hooks/core/repository'
import { readUnitSlice } from '../../../hooks/core/unit-slice'
import { readVerifyState, writeVerifyEvidence } from '../../../hooks/core/verify'
import { facts } from '../../../hooks/domain/facts'

const changed = buildChangedCheckout()
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
  const id = verifyId(file)
  expect((await runFlowCommand($, `approve verify ${id}`, { kind: 'plugin', name: 'working-agreement' })).text).toContain("user's to run")
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Stop and ask the user to run /flow approve verify')
  expect((await runFlowCommand($, `approve verify ${id}`)).text).toContain('approved')
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Verify passed')
})

test('a rule selection is ordered, deduplicated, and runs only the matching rules', async ($, on) => {
  const file = JSON.stringify(config)
  const world = createWorld(on, { ...changed, changed: ['docs/a.md'] }, { verifyFile: file })
  await approveVerify($, file)
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
  await approveVerify($, merged)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.commands)
    .toEqual([['t/bats.sh', 'mods', 'conventions'], ['sh', '-c', 'a'], ['sh', '-c', 'b'], ['t/bats.sh', '--keep']])
})

test('a bare runner absorbs the same runner with paths', async ($, on) => {
  const bare = JSON.stringify({ always: [['t/bats.sh', 'mods']], rules: [{ paths: ['docs/**'], run: ['t/bats.sh'] }] })
  const world = createWorld(on, { ...changed, changed: ['docs/a.md'] }, { verifyFile: bare })
  await approveVerify($, bare)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.commands).toEqual([['t/bats.sh']])
})

test('a rule-selected pass stays done after the session moves into a subdirectory', async ($, on) => {
  const file = JSON.stringify(config)
  const options: Options = { verifyFile: file }
  createWorld(on, { ...changed, changed: ['docs/a.md'] }, options)
  await approveVerify($, file)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  options.cwd = '/repo/docs'
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Verify')
  expect(status).not.toContain('not run on this tree')
})

test('a change no rule selects passes with nothing run, left to CI, and accepts schema metadata and fractional timeouts', async ($, on) => {
  const file = JSON.stringify({ $schema: 'schema.json', rules: [{ paths: ['nothing/**'], run: ['never'] }], timeoutMinutes: 0.5 })
  const world = createWorld(on, { ...changed }, { verifyFile: file })
  await approveVerify($, file)
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
  await approveVerify($)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain(`Selection: ${facts.leftToCi}`)
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.base).toBeNull()
})

test('commands changing the unit tree produce changed paths and no record', async ($, on) => {
  const checkout = { ...changed }
  const world = createWorld(on, checkout, { verifyFile, afterSpawn: () => { checkout.tree = 'mutated' } })
  await approveVerify($)
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
  await approveVerify($)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns).toHaveLength(1)
  checkout.tree = 'two'
  expect(await readCurrentStep($)).toBe('Code')
  expect(await readFlowStatus($)).toContain('▸ Code · changed after Verify')
  checkout.tree = 'one'
  options.verifyFile = JSON.stringify({ always: [['different']] })
  expect(await readFlowStatus($)).toContain('/flow approve verify')
})

for (const [scenario, run, unit, step] of [
  ['the recomputed command set on its base', {}, {}, 'Commit'],
  ['another command set', { commands: [['partial']] }, {}, 'Verify'],
  ['another config', { configBlob: 'other' }, {}, 'Verify'],
  ['another unit base unless it covers the selection', { commands: [['partial']] }, { base: 'c1' }, 'Code'],
  ['the selection it covers on another unit base', {}, { base: 'c1' }, 'Commit'],
] as const) {
  test(`a recorded pass counts only for ${scenario}`, async ($, on) => {
    const pass = { ...buildVerifyRun(), ...run }
    createWorld(on, { ...changed }, { approvedConfig: verifyFile, verifyFile, unit: { verifyRuns: [pass], ...unit } })
    expect(await readCurrentStep($)).toBe(step)
  })
}

test('the latest matching run decides: a failure after a pass on the same keys is not verified', async ($, on) => {
  const pass = buildVerifyRun({ runId: 'r1' })
  const failed = { ...pass, outcome: { kind: 'fail', code: 1, signal: null }, runId: 'r2', at: 2 }
  createWorld(on, { ...changed }, { approvedConfig: verifyFile, verifyFile, unit: { verifyRuns: [pass, failed] } })
  expect(await readCurrentStep($)).toBe('Verify')
})

test('the Verify check lets the latest of several matching runs decide', async (_$, on) => {
  const pass = { tree: 'one', base: 'c0', configBlob: configBlob(verifyFile), commands: [['./test/run.sh']], outcome: { kind: 'pass' as const }, runId: 'r1', at: 1 }
  const failed = { ...pass, outcome: { kind: 'fail' as const, code: 1, signal: null }, runId: 'r2', at: 2 }
  const world = createWorld(on, { ...changed }, { approvedConfig: verifyFile, verifyFile, unit: { verifyRuns: [pass] } })
  const port = createTestPort(world)
  const unit = world.sessions.get('sid')!.units[0]!
  const slice = await readUnitSlice(port, unit.identity, unit, (await readGit(port))!)
  expect((await readVerifyState(port, slice, { ...unit, verifyRuns: [failed, pass] })).isVerified).toBe(false)
})

for (const [scenario, run, step] of [
  ['the same tree, config and selection', {}, 'Commit'],
  ['another config', { configBlob: 'other' }, 'Code'],
  ['another command set', { commands: [['partial']] }, 'Code'],
] as const satisfies [string, Partial<VerifyRecord>, string][]) {
  test(`a pass in another unit counts only for ${scenario}`, async ($, on) => {
    const world = createWorld(on, { ...changed }, { approvedConfig: verifyFile, verifyFile })
    const pass = { tree: 'one', base: 'c9', configBlob: configBlob(verifyFile), commands: [['./test/run.sh']], outcome: { kind: 'pass' as const }, runId: 'r460', at: 1, ...run }
    await writeVerifyEvidence(createTestPort(world), pass, { branch: 'other', issues: [460] })
    expect(await readCurrentStep($)).toBe(step)
  })
}

test('the step fact and /flow status name the unit a borrowed pass ran in', async ($, on) => {
  const file = JSON.stringify(config)
  const world = createWorld(on, { ...changed, changed: ['docs/a.md'] }, { approvedConfig: file, verifyFile: file })
  const pass = { tree: 'one', base: 'c9', configBlob: configBlob(file), commands: [['lint'], ['docs'], ['second']], outcome: { kind: 'pass' as const }, runId: 'r460', at: 1 }
  const port = createTestPort(world)
  await writeVerifyEvidence(port, pass, { branch: 'other', issues: [460] })
  const unit = world.sessions.get('sid')!.units[0]!
  const slice = await readUnitSlice(port, unit.identity, unit, (await readGit(port))!)
  expect((await readVerifyState(port, slice, unit)).fact).toBe('passed (run in #460)')
  expect(await readFlowStatus($)).toContain('Run        r460 in #460')
})

test('the latest matching run decides across units: a later failure elsewhere undoes an own pass', async ($, on) => {
  const pass = { tree: 'one', base: 'c0', configBlob: configBlob(verifyFile), commands: [['./test/run.sh']], outcome: { kind: 'pass' as const }, runId: 'r1', at: 1 }
  const world = createWorld(on, { ...changed }, { approvedConfig: verifyFile, verifyFile, unit: { verifyRuns: [pass] } })
  await writeVerifyEvidence(createTestPort(world), { ...pass, outcome: { kind: 'fail', code: 1, signal: null }, runId: 'r2', at: 2 }, { branch: 'other', issues: [460] })
  expect(await readCurrentStep($)).toBe('Verify')
})

test('a Verify run records its evidence repository-wide with the unit it ran in', async ($, on) => {
  const world = createWorld(on, { ...changed }, { verifyFile })
  await approveVerify($)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  const stored = [...world.files].filter(([path]) => path.startsWith(`${records}/v/`)).map(([, text]) => JSON.parse(text))
  expect(stored).toHaveLength(1)
  expect(stored[0].origin).toEqual(world.sessions.get('sid')?.units[0]?.identity)
  expect(stored[0].run.runId).toBe(world.sessions.get('sid')?.units[0]?.verifyRuns[0]?.runId)
  expect(await readFlowStatus($)).toContain('in this unit')
})

test('a Verify on a new tree replaces the previous tree record in the session', async ($, on) => {
  const checkout = { ...changed }
  const world = createWorld(on, checkout, { verifyFile })
  await approveVerify($)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  checkout.tree = 'two'
  await world.clock.advance(1)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(world.sessions.get('sid')?.units[0]?.verifyRuns.map(run => run.tree)).toEqual(['two'])
  expect(await readCurrentStep($)).toBe('Commit')
  // The session keeps only the new tree's record; the repository-wide evidence still verifies the earlier tree.
  checkout.tree = 'one'
  expect(await readCurrentStep($)).toBe('Commit')
})

for (const [code, signal, fact] of [[7, null, 'failed, exit 7'], [null, 'SIGTERM', 'failed, signal SIGTERM']] as const) {
  test(`failed runs expose ${fact} and fail fast`, async ($, on) => {
    const file = JSON.stringify(config)
    const world = createWorld(on, { ...changed }, { verifyFile: file, spawnCode: code, spawnSignal: signal, spawnOutput: 'bad\routput\u001b[31m' })
    await approveVerify($, file)
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
  await approveVerify($, options.verifyFile!)
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

test('a stop on a passing Verify the tree has moved past is blocked once, and the unit stays off Integrate', async ($, on) => {
  const checkout: Checkout = { ...changed }
  createWorld(on, checkout, { verifyFile })
  await approveVerify($)
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect((await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)).block).toBeUndefined()
  checkout.tree = 'two'
  expect(await readCurrentStep($)).toBe('Code')
  expect((await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)).block).toContain('Verify is stale: the tree changed after it')
  expect((await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as never)).block).toBeUndefined()
})

test('a stop with no passing Verify is never blocked', async ($, on) => {
  createWorld(on, { ...changed }, { verifyFile })
  expect((await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)).block).toBeUndefined()
})
