import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { createEmptySession, createEmptyUnit, parseObservedEnd, parseSession, parseUnitRecord, retainRuns } from '../../hooks/domain/records'
import { conformanceGraph } from '../support/graph-fixture'
import { buildParentGraph, noFlow, verifyFile, diagnoseRuns, diagnosed, diagnosisComment } from '../support/builders'
import { declareFlow, endTurn, readCurrentStep, readFlowStatus, readStepStates } from '../support/helpers'
import { common, configBlob, createWorld, root } from '../support/world'
import type { Options } from '../support/world'

interface Gate { release?: () => void }

const records = `${common}/working-agreement`

function recordPaths(files: Map<string, string>, kind: string): string[] {
  return [...files.keys()].filter(path => path.startsWith(`${records}/${kind}/`) && path.endsWith('.json'))
}

test('declaration writes canonical identities and complete records in the common dir without temporary files', async ($, on) => {
  const { files, sessions } = createWorld(on, { branch: 'feature' }, { session: noFlow })
  expect((await declareFlow($, 'small-feature', [3, 1, 3])).deny).toBeUndefined()
  const identity = { branch: 'feature', issues: [1, 3] }
  const paths = recordPaths(files, 'u')
  expect(paths).toHaveLength(1)
  expect(JSON.parse(files.get(paths[0]!)!)).toEqual({ v: 1, identity, flow: 'small-feature', generation: sessions.get('sid')?.units[0]?.generation })
  expect(JSON.parse(files.get(`${records}/s/sid.json`)!)).toEqual(sessions.get('sid'))
  expect(sessions.get('sid')?.unit).toEqual(identity)
  expect([...files.keys()].some(path => path.includes('/.tmp-'))).toBe(false)
})

test('the exact identity continues across chats, inherits evidence, and a different issue set creates another unit', async ($, on) => {
  const checkout = { branch: 'feature', isDirty: true, tree: 'tree', ahead: 0 }
  const { chat, files, sessions } = createWorld(on, checkout, { approvedConfig: verifyFile, verifyFile, unit: { skills: ['grilling', 'to-spec'], verifyRuns: [{ tree: 'tree', base: 'c0', configBlob: configBlob(verifyFile), commands: [['./test/run.sh']], outcome: { kind: 'pass' }, runId: 'r', at: 1 }], approval: 'd' } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  await declareFlow($, 'close-out', [1])
  expect(recordPaths(files, 'u')).toHaveLength(1)
  expect(recordPaths(files, 's')).toHaveLength(2)
  expect(await readCurrentStep($)).toBe('Commit')
  const continued = sessions.get('second')?.units[0]
  expect(continued?.skills).toEqual(['grilling', 'to-spec'])
  expect(continued?.approval).toBe('d')
  checkout.ahead = 1
  await declareFlow($, 'small-feature', [2])
  expect(recordPaths(files, 'u')).toHaveLength(2)
  expect(sessions.get('second')?.units).toHaveLength(2)
  expect(sessions.get('second')?.unit?.issues).toEqual([2])
  expect(await readFlowStatus($)).toContain('Small feature')
})

for (const malformed of ['{"v":2}', '{"v":1,"identity":{"branch":"feature","issues":[]},"flow":7}']) {
  test(`a shared declaration that is JSON but no valid record is absent: ${JSON.stringify(malformed)}`, async ($, on) => {
    const { files } = createWorld(on, { branch: 'feature' }, { session: noFlow })
    await declareFlow($, 'small-feature')
    files.set(recordPaths(files, 'u')[0]!, malformed)
    expect(await readFlowStatus($)).toContain('No flow declared')
    expect(files.get(recordPaths(files, 'u')[0]!)).toBe(malformed)
  })
}

test('torn session mirrors are skipped when continuing another chat', async ($, on) => {
  const { chat, files, sessions } = createWorld(on, { branch: 'feature' }, { session: noFlow })
  await declareFlow($, 'small-feature', [1])
  files.set(`${records}/s/sid.json`, '{')
  chat.id = 'second'
  await declareFlow($, 'small-feature', [1])
  expect(sessions.get('second')?.units[0]?.skills).toEqual([])
  expect(files.get(`${records}/s/sid.json`)).toBe('{')
})

test('strict parsers reject a malformed field anywhere without filling defaults', () => {
  const { flow: _flow, issues: _issues, ...session } = createEmptySession('sid')
  expect(parseSession(session)).toEqual(session)
  for (const broken of [{ v: 2 }, { isLong: undefined }, { gh: 'bad' }, { info: { 1: { title: 'x', labels: [2] } } },
    { unit: { branch: 'feat', issues: [2, 1] } }, { units: [{ identity: { branch: 'feat', issues: [] }, skills: [], verify: 3 }] },
    { handoff: { state: 'failed' } }, { blocked: { edits: '1' } }]) expect(parseSession({ ...session, ...broken })).toBeNull()
  expect(parseUnitRecord({ v: 1, identity: { branch: 'feat', issues: [1, 1] }, flow: 'fix' })).toBeNull()
  for (const flow of ['follow-up-open', 'follow-up-merged']) expect(parseUnitRecord({ v: 1, identity: { branch: 'feat', issues: [1] }, flow })).toBeNull()
})

test('an observed end record parses only with exactly its keys', () => {
  const record = { v: 1, identity: { branch: 'a', issues: [2] }, generation: 'sid:1:1', end: 'a2' }
  expect(parseObservedEnd(record)).toEqual(record)
  for (const broken of [{ v: 2 }, { at: 1 }, { generation: undefined }, { end: '' }, { identity: { branch: 'a', issues: [2, 2] } }]) {
    expect(parseObservedEnd({ ...record, ...broken })).toBeNull()
  }
})

test('strict unit entries validate bases and whole-step skips without changing the record version', () => {
  const { flow: _flow, issues: _issues, ...session } = createEmptySession('sid')
  const entry = { identity: { branch: 'feat', issues: [1] }, skills: [], verifyRuns: [], runs: [], base: 'f1', skips: [{ step: 'code', reason: 'reviewed' }] }
  expect(parseSession({ ...session, units: [entry] })?.units[0]).toEqual(entry)
  for (const broken of [{ base: 1 }, { base: '' }, { skips: 'code' }, { skips: [{ step: 'code' }] },
    { skips: [{ step: 'code', reason: ' ' }] }, { skips: [{ step: '', reason: 'reviewed' }] },
    { skips: [{ step: 'code', reason: 'reviewed', extra: true }] }]) {
    expect(parseSession({ ...session, units: [{ ...entry, ...broken }] })).toBeNull()
  }
})

test('a skip on a step id of the other delivery step parses, so a unit that becomes or stops being a child needs no migration', () => {
  const { flow: _flow, issues: _issues, ...session } = createEmptySession('sid')
  const entry = { identity: { branch: 'a', issues: [1] }, skills: [], verifyRuns: [], runs: [], base: 'p1', baseBranch: 'main',
    skips: [{ step: 'integrate', reason: 'was a child' }, { step: 'pr', reason: 'not a child yet' }] }
  expect(parseSession({ ...session, units: [entry] })?.units[0]).toEqual(entry)
})

test('detached HEAD refuses a declaration', async ($, on) => {
  createWorld(on, { branch: 'HEAD' }, { session: noFlow })
  expect((await declareFlow($, 'small-feature')).deny).toContain('check out a branch first')
})

test('unreadable GitHub refuses non-default declarations even without issues', async ($, on) => {
  createWorld(on, { branch: 'feature' }, { session: noFlow, failing: 'gh' })
  expect((await declareFlow($, 'small-feature', [1])).deny).toContain('GitHub unreachable — retry')
  expect((await declareFlow($, 'small-feature')).deny).toContain('GitHub unreachable — retry')
})

test('startup repairs a deleted mirror on the 60 second tick', async ($, on) => {
  const { files, clock, sessions } = createWorld(on, { branch: 'feature' }, { session: noFlow })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await declareFlow($, 'small-feature')
  files.delete(`${records}/s/sid.json`)
  await clock.advance(59999)
  expect(files.has(`${records}/s/sid.json`)).toBe(false)
  await clock.advance(1)
  const mirror = files.get(`${records}/s/sid.json`)
  expect(mirror).toBeDefined()
  expect(JSON.parse(mirror!)).toEqual(sessions.get('sid'))
})

test('startup seeds an undefined state only from a valid same-session mirror', async ($, on) => {
  const { files, sessions } = createWorld(on, { branch: 'feature' }, { session: noFlow, isStateAbsent: true })
  const { flow: _flow, issues: _issues, ...saved } = createEmptySession('sid')
  files.set(`${records}/s/sid.json`, JSON.stringify({ ...saved, blocked: { edits: 4 } }))
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect(sessions.get('sid')?.blocked.edits).toBe(4)
})

test('HEAD file changes refresh the declared branch and GitHub, while index changes do nothing', async ($, on) => {
  const checkout = { branch: 'feature', ahead: 0 }
  const world = createWorld(on, checkout, { session: noFlow })
  const { clock, runs } = world
  await declareFlow($, 'small-feature')
  const before = runs.length
  checkout.ahead = 1
  await $.classic.FileChanged({ file_path: `${common}/index`, event: 'change' })
  await clock.settle()
  expect(runs.slice(before).filter(command => command.includes('status --porcelain=v2'))).toHaveLength(0)
  await $.classic.FileChanged({ file_path: `${common}/HEAD`, event: 'change' })
  await clock.settle()
  expect((await readStepStates(world)).Code).toBe('done')
  expect(runs.slice(before).some(command => command.startsWith('gh '))).toBe(true)
})

test('overlapping signals coalesce into one queued read and a full signal upgrades a local one', async ($, on) => {
  const gate: Gate = {}
  const options: Options = { session: noFlow }
  const checkout = { branch: 'feature', ahead: 0 }
  const world = createWorld(on, checkout, options)
  const { clock, runs } = world
  await declareFlow($, 'small-feature')
  await clock.advance(61000)
  options.statusGate = new Promise<void>(resolve => { gate.release = resolve })
  const before = runs.length
  checkout.ahead = 1
  const first = $.classic.FileChanged({ file_path: `${common}/HEAD`, event: 'change' })
  await clock.settle()
  const second = $.classic.FileChanged({ file_path: `${common}/refs/heads/feature`, event: 'change' })
  const third = endTurn($)
  await clock.settle()
  expect(runs.slice(before).some(command => command.includes('status --porcelain=v2'))).toBe(true)
  gate.release?.()
  await Promise.all([first, second, third])
  expect((await readStepStates(world)).Commit).toBe('done')
  expect(runs.slice(before).some(command => command.startsWith('gh '))).toBe(true)
})

test('the pane retains the chat unit and names its branch while another branch is checked out', async ($, on) => {
  const checkout = { branch: 'feat', graph: conformanceGraph }
  const { clock, views } = createWorld(on, checkout, { session: noFlow })
  await declareFlow($, 'small-feature', [1])
  checkout.branch = 'other'
  await $.classic.FileChanged({ file_path: `${common}/worktrees/another/HEAD`, event: 'change' })
  await clock.settle()
  const view = views.at(-1)
  expect(view?.flow).toBe('Small feature')
  expect(view?.issues.map(issue => issue.number)).toEqual([1])
  expect(view?.meta.find(row => row.key === 'Branch')?.value).toBe('feat')
})

test('evidence prefers this chat then other session filenames, with a union of skills', async ($, on) => {
  const { files, sessions } = createWorld(on, { branch: 'feature' }, { session: noFlow,
    unit: { skills: ['own'] } })
  const base = sessions.get('sid')!
  const identity = { branch: 'feature', issues: [1] }
  for (const name of ['b', 'a']) files.set(`${records}/s/${name}.json`, JSON.stringify({ ...base, sessionId: name,
    unit: identity, units: [{ identity, skills: [name], verifyRuns: [], runs: [], approval: name }],
  }))
  files.set(`${records}/s/0.json`, '{')
  await declareFlow($, 'small-feature', [1])
  const entry = sessions.get('sid')?.units[0]
  expect(entry?.skills).toEqual(['own', 'a', 'b'])
  expect(entry?.verifyRuns).toEqual([])
  expect(entry?.approval).toBe('a')
})

test('declaring outside a repository refuses the declaration', async ($, on) => {
  createWorld(on, { branch: 'feature' }, { session: noFlow, isOutsideRepo: true })
  expect((await declareFlow($, 'small-feature')).deny).toContain('check out a branch first')
})

test('startup treats a session mirror that is JSON but no valid record as absent', async ($, on) => {
  const { files, sessions } = createWorld(on, { branch: 'feature' }, { session: noFlow, isStateAbsent: true })
  files.set(`${records}/s/sid.json`, '{"v":2}')
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect(sessions.get('sid')?.unit).toBeNull()
  expect(files.get(`${records}/s/sid.json`)).toBe('{"v":2}')
})

test('declaration retries a missed state compare and one failed rename without temporary leftovers', async ($, on) => {
  const { files, sessions } = createWorld(on, { branch: 'feature' }, { session: noFlow, casMisses: 1, renameFailures: 1 })
  expect((await declareFlow($, 'small-feature')).deny).toBeUndefined()
  expect(sessions.get('sid')?.unit).toEqual({ branch: 'feature', issues: [] })
  expect([...files.keys()].some(path => path.includes('/.tmp-'))).toBe(false)
})

test('a second failed rename refuses declaration with its error', async ($, on) => {
  createWorld(on, { branch: 'feature' }, { session: noFlow, renameFailures: 2 })
  expect((await declareFlow($, 'small-feature')).deny).toContain('rename failed')
})

test('classic startup merges the four git watch paths with the existing chain result', async ($, on) => {
  createWorld(on, { branch: 'feature' }, { watchPaths: ['/other'] })
  const result = await $.classic.SessionStart({ source: 'startup' })
  expect(result.watchPaths).toEqual(['/other', `${common}/HEAD`, `${common}/packed-refs`, `${common}/refs`, `${common}/worktrees`])
})

test('strict run and comment records reject malformed boundary facts and retired diagnosis state', () => {
  const { flow: _flow, issues: _issues, ...session } = createEmptySession('sid')
  const entry = { ...createEmptyUnit(), identity: { branch: 'fix', issues: [1] }, ...diagnosed }
  expect(parseSession({ ...session, units: [entry] })?.units[0]).toEqual(entry)
  for (const broken of [
    { runs: undefined }, { runs: [{ ...diagnoseRuns[0], argv: [] }] }, { runs: [{ ...diagnoseRuns[0], argv: [''] }] },
    { runs: [{ ...diagnoseRuns[0], argv: [7] }] }, { runs: [{ ...diagnoseRuns[0], tree: '' }] },
    { runs: [{ ...diagnoseRuns[0], runId: '../unsafe' }] }, { runs: [{ ...diagnoseRuns[0], at: Infinity }] },
    { runs: [{ ...diagnoseRuns[0], outcome: { kind: 'pass', extra: true } }] },
    { runs: [{ ...diagnoseRuns[0], outcome: { kind: 'fail', code: '1', signal: null } }] },
    { runs: [{ ...diagnoseRuns[0], outcome: { kind: 'timeout', minutes: 0 } }] },
    { runs: [{ ...diagnoseRuns[0], extra: true }] }, { diagnosis: 'retired' },
    { approval: 1 }, { approval: { url: 'url', runId: 'green' } },
  ]) expect(parseSession({ ...session, units: [{ ...entry, ...broken }] })).toBeNull()
  const issue = { title: 'bug', labels: [], comments: [diagnosisComment] }
  expect(parseSession({ ...session, info: { 1: issue } })?.info[1]).toEqual(issue)
  expect(parseSession({ ...session, info: { 1: { ...issue, comments: { error: 'unreadable' } } } })?.info[1]).toEqual({ ...issue, comments: { error: 'unreadable' } })
  for (const comment of [{ url: 'url' }, { ...diagnosisComment, createdAt: 'invalid' }, { ...diagnosisComment, extra: true }]) {
    expect(parseSession({ ...session, info: { 1: { ...issue, comments: [comment] } } })).toBeNull()
  }
})

test('run history keeps every argv, newest first and deduplicated, whatever the contribution order', () => {
  const [red, green] = diagnoseRuns
  const other = { ...red!, argv: ['other'], runId: 'other', at: 1.5 }
  expect(retainRuns([green!, other, red!, green!])).toEqual([green, other, red])
  expect(retainRuns([red!, other, green!])).toEqual(retainRuns([other, green!, red!]))
  const tied = { ...green!, runId: 'tied', at: green!.at }
  expect(retainRuns([green!, tied])).toEqual(retainRuns([tied, green!]))
})

test("run history bounds each argv and the total, keeping each argv's earliest red and the unit's earliest red", () => {
  const [red] = diagnoseRuns
  const loop = Array.from({ length: 30 }, (_, index) => ({ ...red!, runId: `loop-${index}`, tree: `t${index}`, at: 10 + index }))
  const kept = retainRuns([red!, ...loop])
  expect(kept).toHaveLength(10)
  expect(kept).toContainEqual(red)
  expect(kept[0]).toEqual(loop[29])
  const others = Array.from({ length: 80 }, (_, index) => ({ ...red!, argv: [`./other-${index}`], runId: `other-${index}`, at: 100 + index }))
  const capped = retainRuns([red!, ...others])
  expect(capped).toHaveLength(50)
  expect(capped).toContainEqual(red)
  expect(capped[0]).toEqual(others[79])
})

test('a pinned red needs its approval and the run identity fields, and a record without it still parses', () => {
  const { flow: _flow, issues: _issues, ...session } = createEmptySession('sid')
  const { outcome: _outcome, ...approvedRed } = diagnoseRuns[0]!
  const entry = { ...createEmptyUnit(), identity: { branch: 'fix', issues: [1] }, ...diagnosed }
  expect(parseSession({ ...session, units: [entry] })?.units[0]).toEqual(entry)
  expect(parseSession({ ...session, units: [{ ...entry, approvedRed }] })?.units[0]?.approvedRed).toEqual(approvedRed)
  for (const broken of [
    { approval: undefined, approvedRed }, { approvedRed: { ...approvedRed, outcome: diagnoseRuns[0]!.outcome } },
    { approvedRed: { ...approvedRed, argv: [] } }, { approvedRed: { ...approvedRed, tree: '' } }, { approvedRed: 'red' },
  ]) expect(parseSession({ ...session, units: [{ ...entry, ...broken }] })).toBeNull()
})

test('sessions merge matching command history and prefer this chat for scalar approval', async ($, on) => {
  const { files, sessions } = createWorld(on, { branch: 'feature' }, { session: noFlow,
    unit: { runs: [diagnoseRuns[0]], approval: diagnosisComment.url },
    comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
  })
  const base = sessions.get('sid')!
  const identity = { branch: 'feature', issues: [1] }
  for (const [name, evidence] of [
    ['a', { runs: [{ ...diagnoseRuns[0]!, argv: ['other'], runId: 'other', at: 1.5 }] }],
    ['b', { runs: [diagnoseRuns[1]], approval: 'other-comment' }],
  ] as const) files.set(`${records}/s/${name}.json`, JSON.stringify({ ...base, sessionId: name, unit: identity,
    units: [{ ...createEmptyUnit(), identity, ...evidence }],
  }))
  await declareFlow($, 'fix', [1])
  expect(sessions.get('sid')?.units[0]?.runs).toEqual([diagnoseRuns[1], { ...diagnoseRuns[0]!, argv: ['other'], runId: 'other', at: 1.5 }, diagnoseRuns[0]])
  expect(sessions.get('sid')?.units[0]?.approval).toEqual(diagnosed.approval)
  expect(await readFlowStatus($)).toContain('✓ Diagnose')
})

test("merged sessions take the approval and its pinned red from one entry, never another entry's pin", async ($, on) => {
  const { outcome: _outcome, ...approvedRed } = diagnoseRuns[0]!
  const { files, sessions } = createWorld(on, { branch: 'feature' }, { session: noFlow,
    unit: { runs: [diagnoseRuns[0]], approval: diagnosisComment.url },
    comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
  })
  const base = sessions.get('sid')!
  const identity = { branch: 'feature', issues: [1] }
  files.set(`${records}/s/b.json`, JSON.stringify({ ...base, sessionId: 'b', unit: identity,
    units: [{ ...createEmptyUnit(), identity, runs: [diagnoseRuns[0]], approval: 'other-comment', approvedRed: { ...approvedRed, runId: 'other' } }],
  }))
  await declareFlow($, 'fix', [1])
  expect(sessions.get('sid')?.units[0]?.approval).toEqual(diagnosisComment.url)
  expect(sessions.get('sid')?.units[0]?.approvedRed).toBeUndefined()
})

test('a unit recorded on the default branch before parent branches existed stays on it, even after re-declaring', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'b', graph: buildParentGraph() }, { unit: { base: 'c0', baseBranch: 'main' } })
  expect(await readFlowStatus($)).toContain('Slice     c0..b1\n')
  expect((await declareFlow($, 'small-feature', [1])).result).toContain('base from main.')
  expect(sessions.get('sid')?.units[0]).toMatchObject({ base: 'c0', baseBranch: 'main' })
  expect(await readFlowStatus($)).toContain('Slice     c0..b1\n')
})

test('a unit recorded with no base branch keeps its fixed base when its parent branch is merged in', async ($, on) => {
  const graph = buildParentGraph()
  createWorld(on, { branch: 'b', graph }, { unit: { base: 'p1' } })
  expect(await readFlowStatus($)).toContain('Slice     p1..b1\n')
  graph.refs = { ...graph.refs, par: 'p2', b: 'b2' }
  expect(await readFlowStatus($)).toContain('Slice     p1..b2\n')
})

test('re-declaring a unit whose recorded base left its history recomputes the base from its recorded base branch, not the reflog', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'b', graph: buildParentGraph() }, { unit: { base: 'a1', baseBranch: 'main' } })
  expect((await declareFlow($, 'small-feature', [1])).result).toContain('base from main.')
  expect(sessions.get('sid')?.units[0]).toMatchObject({ base: 'c0', baseBranch: 'main' })
})

test('a unit recorded on the default branch with a base off its first-parent chain keeps that base as the floor of its slice', async ($, on) => {
  const graph = buildParentGraph()
  graph.commits.mm = { parents: ['c0', 'p2'], files: { 'src/par.ts': 'p2', 'src/a.ts': 'a2' } }
  graph.refs = { ...graph.refs, main: 'mm', 'origin/main': 'mm' }
  createWorld(on, { branch: 'b', graph }, { unit: { base: 'p1', baseBranch: 'main' } })
  expect(await readFlowStatus($)).toContain('Slice     p1..b1\n')
})

test('re-declaring a unit recorded with a base and no base branch keeps both and says the base was kept', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'b', graph: buildParentGraph() }, { unit: { base: 'p1' } })
  expect((await declareFlow($, 'small-feature', [1])).result).toContain('Flow declared: Small feature for #1, base kept from the record.')
  expect(sessions.get('sid')?.units[0]?.base).toBe('p1')
  expect(sessions.get('sid')?.units[0]?.baseBranch).toBeUndefined()
})
