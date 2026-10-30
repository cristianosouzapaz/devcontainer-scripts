import type { PromptOrigin } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { test } from '../support/kit'
import { buildPullRequest, noFlow, pushedCloseOut, verifyFile } from '../support/builders'
import { endTurn, readFlowStatus, readStatusRow, runFlowCommand } from '../support/helpers'
import { childUnit, parallelCheckout, withCommit } from '../support/parallel-worktrees'
import { configBlob, createWorld, records, root } from '../support/world'
import type { Gate, Options } from '../support/world'

const timestamp = /\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}/

/**
 * Reads the status rows that report a violation.
 * @param $ - The engine.
 * @returns The Violation rows.
 */
const readViolationRows = async ($: Engine): Promise<string[]> => ((await readFlowStatus($)) ?? '').split('\n').filter(row => row.startsWith('Violation'))

test('status prints every group with the declared unit facts and reads status endpoints once', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', ahead: 1 }, { approvedConfig: verifyFile,
    unit: { base: 'c0' }, verifyFile, prs: [buildPullRequest({ closingIssuesReferences: [{ number: 1 }] })],
    checkRuns: { c1: [{ name: 'mods', status: 'in_progress', conclusion: null }, { name: 'docs', status: 'completed', conclusion: 'success' }] },
    rules: [{ ruleset_id: 42, type: 'pull_request' }], rulesets: [{ id: 42, current_user_can_bypass: 'always' }],
  })
  const result = await runFlowCommand($, 'status')
  const text = result.text ?? ''
  for (const fact of ['Issue      #1 open', 'Slice      c0..c1', `Worktree   ${root}`, 'PR         https://github.test/pull/5',
    'CI         c1 · mods: pending · docs: passing', `.claude/working-agreement.json @ blob ${configBlob(verifyFile).slice(0, 7)} · approved`,
    'Selection  ./test/run.sh · no local check selected — left to CI', 'GitHub     last ok ', 'Rulesets   main · pull_request · you can bypass: always',
    'Classic    main · protection off', 'Mod        1.2.3']) expect(text, fact).toContain(fact)
  expect(text.split('\n').filter(row => row.startsWith('GitHub'))).toHaveLength(1)
  expect('context' in result).toBe(false)
  for (const endpoint of ['rules/branches/main', 'rulesets/42', 'branches/main']) {
    expect(world.runs.filter(run => run === `gh api --include repos/{owner}/{repo}/${endpoint}`), endpoint).toHaveLength(1)
  }
})

test('status reads the rules and protection of the unit PR\'s base, not of the default branch', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ baseRefName: 'next' })] })
  const text = (await readFlowStatus($)) ?? ''
  for (const fact of ['Rulesets   next · no active rules', 'Classic    next · protection off']) expect(text, fact).toContain(fact)
  expect(world.runs).not.toContain('gh api --include repos/{owner}/{repo}/branches/main')
})

test('status prints a rulesets 403 as the HTTP status and GitHub message without a plan interpretation', async ($, on) => {
  const message = 'Upgrade to GitHub Pro or make this repository public to enable this feature.\nrequest denied'
  createWorld(on, { branch: 'feat' }, { rulesError: 403, rulesMessage: message })
  const text = (await readFlowStatus($)) ?? ''
  expect(text).toContain(`Rulesets   not read: HTTP 403 · ${message}`)
  expect(text.toLowerCase()).not.toContain('plan')
  expect(text).toContain('Classic    main · protection off')
})

test('status joins active rules by ruleset and prints each ruleset\'s own bypass permission, unknown only when GitHub gives none', async ($, on) => {
  createWorld(on, { branch: 'feat' }, {
    rules: [{ ruleset_id: 1, type: 'pull_request' }, { ruleset_id: 1, type: 'non_fast_forward' }, { ruleset_id: 2, type: 'deletion' }, { ruleset_id: 3, type: 'creation' }],
    rulesets: [{ id: 1, current_user_can_bypass: 'never' }, { id: 2, current_user_can_bypass: 'always' }, { id: 3, current_user_can_bypass: null }],
  })
  const text = (await readFlowStatus($)) ?? ''
  expect(text).toContain('Rulesets   main · pull_request, non_fast_forward · you can bypass: never')
  expect(text).toContain('Rulesets   main · deletion · you can bypass: always')
  expect(text).toContain('Rulesets   main · creation · you can bypass: unknown')
})

test('status reports classic protection off on a branch that only a ruleset protects', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { rules: [{ ruleset_id: 1, type: 'pull_request' }], rulesets: [{ id: 1, current_user_can_bypass: 'never' }] })
  expect(await readFlowStatus($)).toContain('Classic    main · protection off')
})

test('status explicitly reports no active rules', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  expect(await readFlowStatus($)).toContain('Rulesets   main · no active rules')
})

test('status reports classic protection on and off and its read error by HTTP status or gh failure', async ($, on) => {
  const options: Options = { isProtected: true }
  createWorld(on, { branch: 'feat' }, options)
  expect(await readFlowStatus($)).toContain('Classic    main · protection on')
  options.isProtected = false
  expect(await readFlowStatus($)).toContain('Classic    main · protection off')
  options.protectionError = { status: 500, message: 'full\nbranch error' }
  expect(await readFlowStatus($)).toContain('Classic    not read: HTTP 500 · full\nbranch error')
  options.protectionError = { message: 'error connecting to api.github.com\ncheck your internet connection' }
  expect(await readFlowStatus($)).toContain('Classic    not read: error connecting to api.github.com\ncheck your internet connection')
})

test('status includes full violation attribution and dismissed and unchecked records with open first', async ($, on) => {
  const attribution = { sessionId: 'sid', toolUseIds: ['tool-use-full-one', 'tool-use-full-two'], agentIds: ['agent-full-one', 'agent-full-two'], start: 1 }
  const world = createWorld(on, { branch: 'feat' }, { session: { violations: [
    { ...attribution, factId: 'unchecked', kind: 'unchecked', fact: { toolUseId: 'tool-use-full-one' }, end: 4000 },
    { ...attribution, factId: 'dismissed', kind: 'commit', fact: { shas: ['dismissed-sha'] }, end: 3000 },
    { ...attribution, toolUseIds: [...attribution.toolUseIds, 'older-call'], factId: 'older', kind: 'commit', fact: { shas: ['older-sha'] }, end: 1000 },
    { ...attribution, toolUseIds: [...attribution.toolUseIds, 'newer-call'], factId: 'newer', kind: 'commit', fact: { shas: ['newer-sha'] }, end: 2000 },
  ] } })
  world.files.set(`${records}/d/dismissed.json`, '{"v":1,"factId":"dismissed"}')
  const rows = await readViolationRows($)
  expect(rows).toHaveLength(4)
  expect(rows[0]).toContain('newer-call')
  expect(rows[0]).toContain('✗ A commit appeared during an agent call (it may be yours) · ')
  expect(rows[1]).toContain('older-call')
  expect(rows[0]).toContain(' · open')
  expect(rows[2]).toContain(' · unchecked')
  expect(rows[3]).toContain(' · dismissed')
  for (const row of rows) {
    expect(timestamp.test(row)).toBe(true)
    for (const id of [...attribution.toolUseIds, ...attribution.agentIds]) expect(row).toContain(id)
  }
})

test('status shows herdr last and first failure times and count and clears on success', async ($, on) => {
  const options = { session: noFlow, herdrEnv: { HERDR_ENV: '1', HERDR_PANE_ID: 'pane' }, herdrResult: { exitCode: 9, stderr: 'unavailable' } }
  const world = createWorld(on, { branch: 'feat' }, options)
  const initial = (await readFlowStatus($)) ?? ''
  const firstTime = initial.split('\n').find(row => row.startsWith('herdr'))?.match(timestamp)?.[0]
  expect(firstTime).toBeDefined()
  await world.clock.advance(60000)
  const text = (await readFlowStatus($)) ?? ''
  const row = text.split('\n').find(row => row.startsWith('herdr')) ?? ''
  expect(row).toContain('herdr      report-metadata · ')
  expect(row).toContain(' · since ')
  expect(row).toContain(` · since ${firstTime} · `)
  expect(row.match(timestamp)?.[0] === firstTime).toBe(false)
  expect(row).toContain(' · ×2 · exit 9: unavailable')
  expect(row.match(new RegExp(timestamp.source, 'g'))).toHaveLength(2)
  options.herdrResult = { exitCode: 0, stderr: '' }
  expect(await readFlowStatus($)).not.toContain('herdr      ')
})

test('status shows record write failure times count and full path and clears on a successful write', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow, renameFailures: 2 })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await world.clock.advance(60000)
  const path = `${records}/s/sid.json`
  const row = readStatusRow(await readFlowStatus($), 'Records')
  expect(row).toContain('Records    record write · ')
  expect(row).toContain(' · since ')
  expect(row).toContain(` · ×1 · ${path}: rename failed`)
  expect(row.match(new RegExp(timestamp.source, 'g'))).toHaveLength(2)
  await world.clock.advance(60000)
  expect(await readFlowStatus($)).not.toContain('Records    ')
})

test('status keeps the last successful GitHub read time and prints the error while GitHub fails', async ($, on) => {
  const options: Options = {}
  const world = createWorld(on, { branch: 'feat' }, options)
  const connected = readStatusRow(await readFlowStatus($), 'GitHub')
  const lastOk = connected.match(timestamp)?.[0]
  expect(connected).toBe(`GitHub     last ok ${lastOk}`)
  options.failing = 'gh api user'
  await world.clock.advance(120000)
  expect(readStatusRow(await readFlowStatus($), 'GitHub').startsWith(`GitHub     last ok ${lastOk} · read failed (gh could not run: `)).toBe(true)
})

test('status times include the local UTC offset', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  expect(timestamp.test((await readFlowStatus($)) ?? '')).toBe(true)
})

test('no flow status starts with talk and prints GitHub and mod facts without slice facts', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  const text = (await readFlowStatus($)) ?? ''
  expect(text.startsWith('No flow declared (talk).')).toBe(true)
  for (const key of ['GitHub', 'Rulesets', 'Classic', 'Mod']) expect(text).toContain(`\n${key.padEnd(11)}`)
  expect(text).not.toContain('Slice      ')
})

test('status and pane accept external origins while changing commands remain composer only', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  const origins: PromptOrigin[] = [{ kind: 'plugin', name: 'working-agreement' }, { kind: 'bridge' }, { kind: 'slack-ping' }]
  for (const origin of origins) {
    expect((await runFlowCommand($, 'status', origin)).text).toContain('Slice      ')
    expect((await runFlowCommand($, '', origin)).text).toBe('Flow pane opened.')
    for (const command of ['skip code reason', 'approve verify', 'trivial', 'follow-up #1', 'handoff']) {
      expect((await runFlowCommand($, command, origin)).text, `${origin.kind}: ${command}`).toContain("is the user's to run from the prompt")
    }
  }
})

test('status forces fresh issue PR and CI reads within the cache interval', async ($, on) => {
  const options: Options = { prs: [buildPullRequest({ closingIssuesReferences: [{ number: 1 }] })],
    issues: { 1: 'OPEN' }, statuses: { c1: [{ context: 'mods', state: 'pending' }] } }
  createWorld(on, { branch: 'feat', ahead: 1 }, options)
  expect(await readFlowStatus($)).toContain('mods: pending')
  options.issues = { 1: 'CLOSED' }
  options.statuses = { c1: [{ context: 'mods', state: 'success' }] }
  options.prs = [buildPullRequest({ number: 6, url: 'https://github.test/pull/6', closingIssuesReferences: [{ number: 1 }] })]
  const text = (await readFlowStatus($)) ?? ''
  expect(text).toContain('Issue      #1 closed')
  expect(text).toContain('PR         https://github.test/pull/6')
  expect(text).toContain('mods: passing')
})

test('turn end retains the GitHub caches populated by status', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', ahead: 1 }, {
    prs: [buildPullRequest({ closingIssuesReferences: [{ number: 1 }] })],
    statuses: { c1: [{ context: 'mods', state: 'success' }] },
  })
  await runFlowCommand($, 'status')
  const deliveryReads = () => world.runs.filter(run => run.includes('pullRequests(headRefName:')
    || run.includes('/check-runs') || run.includes('/commits/c1/status') || run.includes('/rules/branches/')
    || run.includes('/rulesets/') || run.startsWith('gh api --include repos/{owner}/{repo}/branches/'))
  const before = deliveryReads()
  expect(before.length > 0).toBe(true)
  await endTurn($)
  expect(deliveryReads()).toEqual(before)
})

test('status joins an in-flight reread without queuing another refresh', async ($, on) => {
  const gate: Gate = {}
  const statusGate = new Promise<void>(resolve => { gate.open = resolve })
  const world = createWorld(on, { branch: 'feat', ahead: 1 }, { statusGate, herdrEnv: { HERDR_ENV: '1', HERDR_PANE_ID: 'pane' } })
  const active = endTurn($)
  await world.clock.settle()
  const pending = runFlowCommand($, 'status')
  await world.clock.settle()
  expect(world.herdrCalls).toHaveLength(0)
  gate.open!()
  await active
  expect((await pending).text).toContain('Slice      c0..c1')
  expect(world.herdrCalls).toHaveLength(1)
})

for (const [always, changed, selection] of [
  [[], [], 'Selection  none: no change from the base'],
  [[['lint']], [], 'Selection  lint · no change from the base'],
  [[], ['src/a.ts'], 'Selection  none: no local check selected — left to CI'],
  [[['lint']], ['docs/a.md'], 'Selection  lint · docs · md · rules `docs/**`, `**/*.md`'],
] as [string[][], string[], string][]) {
  test(`status separates the Verify commands from the selection: ${selection}`, async ($, on) => {
    const file = JSON.stringify({ always, rules: [{ paths: ['docs/**'], run: ['docs'] }, { paths: ['docs/**', '**/*.md'], run: ['md'] }] })
    createWorld(on, { branch: 'feat', isDirty: true, tree: 'one', changed }, { unit: { base: 'c0' }, verifyFile: file })
    const text = (await readFlowStatus($)) ?? ''
    expect(text.split('\n').find(row => row.startsWith('Selection'))).toBe(selection)
  })
}

test('status explains missing invalid and unapproved Verify configs', async ($, on) => {
  const options: Options = {}
  createWorld(on, { branch: 'feat', ahead: 1 }, options)
  const missing = (await readFlowStatus($)) ?? ''
  expect(missing).toContain('Config     .claude/working-agreement.json · not found in the unit tree')
  expect(missing).toContain('Selection  none: verify refuses until a config exists')
  options.verifyFile = '{"verify":[]}'
  const invalid = (await readFlowStatus($)) ?? ''
  expect(invalid).toContain('Config     .claude/working-agreement.json · invalid: verify: retired field in .claude/working-agreement.json, local Verify runs only rule-selected checks and leaves full suites to CI; regenerate the config, or move per-change checks into rules')
  expect(invalid).toContain('Selection  none: verify refuses until a config exists')
  options.verifyFile = verifyFile
  expect(await readFlowStatus($)).toContain(' · needs /flow approve verify')
})

test('status prints GitHub timeout rows at 30 seconds and keeps the freshly read git slice', async ($, on) => {
  const gate: Gate = {}
  const rulesGate = new Promise<void>(resolve => { gate.open = resolve })
  const world = createWorld(on, { branch: 'feat', ahead: 1 }, { unit: { base: 'c0' }, rulesGate })
  const pending = runFlowCommand($, 'status')
  await world.clock.settle()
  await world.clock.advance(30001)
  const text = (await pending).text ?? ''
  expect(text).toContain('Slice      c0..c1')
  for (const key of ['GitHub', 'Rulesets', 'Classic']) {
    const row = text.split('\n').find(row => row.startsWith(key)) ?? ''
    expect(row, key).toContain('timed out after 30 s')
  }
  gate.open!()
  await world.clock.settle()
})

for (const finished of [true, false]) {
  test(`status offers ${finished ? 'Start' : 'Continue'} for a ${finished ? 'finished' : 'long'} session`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, finished ? pushedCloseOut : { session: { isLong: true } })
    const text = (await readFlowStatus($)) ?? ''
    expect(text).toContain(finished ? 'Start new session: /clear' : 'Continue in new session: /flow handoff')
    expect(text).not.toContain(finished ? 'Continue in new session:' : 'Start new session:')
  })
}

test("an out-of-territory commit adds no pane note or status row", async ($, on) => {
  const checkout = parallelCheckout()
  const { views } = createWorld(on, checkout, { ...childUnit, afterTool: () => checkout.graph = withCommit(checkout.graph!, 's1', ['p0'], 'sibling') })
  await $.tool.call({ tool: 'Bash', command: 'sibling commit' })
  expect(views.at(-1)?.violations ?? []).toEqual([])
  expect(await readViolationRows($)).toEqual([])
})

test('a commit only an unreadable slice could place shows the unchecked note with its count and an unchecked status row', async ($, on) => {
  const checkout = parallelCheckout()
  checkout.graph!.commits.m0x = { parents: [], files: {} }
  // The rewritten base leaves the slice unreadable, and only the slice could place a merge into the held parent.
  const { views } = createWorld(on, checkout, { unit: { base: 'm0x', baseBranch: 'parent' }, afterTool: () => checkout.graph = withCommit(checkout.graph!, 'pm', ['p0', 'c1'], 'parent') })
  for (const command of ['first merge', 'second merge']) {
    expect((await $.tool.call({ tool: 'Bash', command })).context ?? []).toEqual([])
    checkout.graph!.refs.parent = 'p0'
  }
  expect(views.at(-1)?.violations?.map(({ tone, text }) => ({ tone, text: text.replace(/latest .*/, 'latest') }))).toEqual([
    { tone: 'warn', text: 'unchecked: guarantee snapshots unavailable for 2 calls, latest' },
  ])
  const rows = await readViolationRows($)
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatch(/ · unchecked$/)
})
