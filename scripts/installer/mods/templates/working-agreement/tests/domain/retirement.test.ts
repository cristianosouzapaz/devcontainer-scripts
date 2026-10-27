import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { Identity, SessionRecord, UnitEntry } from '../../hooks/domain/records'
import { test } from '../support/kit'
import { buildPullRequest, diagnoseRuns, noFlow } from '../support/builders'
import { conformanceGraph } from '../support/graph-fixture'
import { declareFlow, readFlowStatus } from '../support/helpers'
import { common, createWorld, hashIdentity, root } from '../support/world'
import type { Checkout, Options, World } from '../support/world'

/** The record files that make up one unit on disk. */
interface UnitFiles { declaration: string; log: string; end: string }

const directory = `${common}/working-agreement`
const issueRead = 'gh api graphql -F owner={owner} -F name={repo} -f query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issue(number:'

/**
 * Checks out `feat` in a graph that also holds the readable branch `other`; `gone` has no local branch.
 * @returns The checkout.
 */
function checkout(): Checkout {
  return { branch: 'feat', graph: structuredClone(conformanceGraph) }
}

/**
 * Builds a unit entry shaped like the records sessions leave behind.
 * @param branch - The unit's branch.
 * @param issues - The unit's issues.
 * @returns The entry.
 */
function buildEntry(branch: string, issues: number[]): UnitEntry {
  return { identity: { branch, issues }, base: 'm1', baseBranch: 'main', skills: ['to-spec'], verifyRuns: [], runs: [{ ...diagnoseRuns[0]!, runId: `1-1-${branch.replace(/\W/g, '-')}` }],
    approval: 'https://github.com/o/r/issues/1#issuecomment-1', skips: [{ step: 'verify', reason: 'old' }], generation: `dead:${branch}:1` }
}

/**
 * Writes another chat's mirror holding the given entries.
 * @param world - The world.
 * @param owner - The other chat's id.
 * @param units - Its entries.
 * @returns The mirror's path and text.
 */
function seedMirror(world: World, owner: string, units: UnitEntry[]): [string, string] {
  const record: SessionRecord = { ...world.sessions.get('sid')!, sessionId: owner, unit: units[0]?.identity ?? null, units }
  const path = `${directory}/s/${owner}.json`
  const text = JSON.stringify(record)
  world.files.set(path, text)
  return [path, text]
}

/**
 * Writes a unit's declaration, transition log and an observed slice end.
 * @param world - The world.
 * @param identity - The unit identity.
 * @param flow - The declared flow.
 * @returns The two paths.
 */
async function seedDeclaration(world: World, identity: Identity, flow: string): Promise<UnitFiles> {
  const hash = await hashIdentity(identity.branch, identity.issues)
  const files = { declaration: `${directory}/u/${hash}.json`, log: `${directory}/log/${hash}.jsonl`, end: `${directory}/end/${hash}/dead.json` }
  world.files.set(files.declaration, JSON.stringify({ v: 1, identity, flow, generation: `dead:${identity.branch}:1` }))
  world.files.set(files.log, '{"event":"declare"}\n')
  world.files.set(files.end, JSON.stringify({ v: 1, identity, generation: `dead:${identity.branch}:1`, end: 'm1' }))
  return files
}

/**
 * Runs one pruning trigger.
 * @param $ - The engine.
 * @param trigger - Session start or a declaration.
 */
async function prune($: Engine, trigger: string): Promise<void> {
  if (trigger === 'startup') await $.session.start({ cwd: root, surface: null, isInteractive: false })
  else expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
}

for (const trigger of ['startup', 'declaration']) {
  test(`${trigger} retires a unit on a deleted branch whose issues are all closed`, async ($, on) => {
    const world = createWorld(on, checkout(), { issues: { 2: 'CLOSED', 3: 'CLOSED' } })
    await world.ready
    const [mirror] = seedMirror(world, 'dead', [buildEntry('gone', [2, 3])])
    const unit = await seedDeclaration(world, { branch: 'gone', issues: [2, 3] }, 'fix')
    const run = `${directory}/runs/1-1-gone.json`
    world.files.set(run, 'run file')
    await prune($, trigger)
    for (const path of [mirror, unit.declaration, unit.log, unit.end, run]) expect(world.files.has(path)).toBe(false)
  })
}

for (const [flow, isRetired] of [['fix', true], ['small-feature', true], ['follow-up', false]] as const) {
  test(`a default-branch ${flow} unit whose issues are all closed is ${isRetired ? 'retired' : 'kept'}`, async ($, on) => {
    const world = createWorld(on, checkout(), { issues: { 2: 'CLOSED' } })
    await world.ready
    const [mirror, text] = seedMirror(world, 'dead', [buildEntry('main', [2])])
    const unit = await seedDeclaration(world, { branch: 'main', issues: [2] }, flow)
    await prune($, 'startup')
    expect(world.files.get(mirror)).toBe(isRetired ? undefined : text)
    expect(world.files.has(unit.declaration)).toBe(!isRetired)
    expect(world.files.has(unit.log)).toBe(!isRetired)
    expect(world.files.has(unit.end)).toBe(!isRetired)
  })
}

for (const [name, branch, issues] of [
  ['one open issue', 'gone', [2, 3]],
  ['a readable branch', 'other', [2]],
  ['no declared issue', 'gone', []],
] as const) {
  test(`a unit with ${name} is kept`, async ($, on) => {
    const world = createWorld(on, checkout(), { issues: { 2: 'CLOSED', 3: 'OPEN' } })
    await world.ready
    const [mirror, text] = seedMirror(world, 'dead', [buildEntry(branch, [...issues])])
    const unit = await seedDeclaration(world, { branch, issues: [...issues] }, issues.length ? 'fix' : 'trivial')
    await prune($, 'startup')
    expect(world.files.get(mirror)).toBe(text)
    expect(world.files.has(unit.declaration)).toBe(true)
    expect(world.files.has(unit.log)).toBe(true)
  })
}

for (const [name, failure] of [['issue #2', `${issueRead}2)`], ['issue #3', `${issueRead}3)`], ['local branches', 'git for-each-ref']]) {
  test(`a sweep retires nothing when the ${name} read fails`, async ($, on) => {
    const options: Options = { issues: { 2: 'CLOSED', 3: 'CLOSED' }, unit: { base: 'm1' }, prs: [buildPullRequest({ state: 'MERGED', headRefOid: 'f1', headRefName: 'feat' })] }
    const world = createWorld(on, checkout(), options)
    await world.ready
    const [mirror, text] = seedMirror(world, 'dead', [buildEntry('gone', [2])])
    const [other, otherText] = seedMirror(world, 'other', [buildEntry('main', [3])])
    const units = [await seedDeclaration(world, { branch: 'gone', issues: [2] }, 'fix'), await seedDeclaration(world, { branch: 'main', issues: [3] }, 'fix')]
    const concluded = world.sessions.get('sid')!.units
    options.failing = failure
    await prune($, 'startup')
    expect(world.sessions.get('sid')?.units).toEqual(concluded)
    expect(world.files.get(mirror)).toBe(text)
    expect(world.files.get(other)).toBe(otherText)
    for (const unit of units) for (const path of [unit.declaration, unit.log]) expect(world.files.has(path)).toBe(true)
  })
}

test('retirement removes own entries through the session record and leaves a mixed mirror whole', async ($, on) => {
  const live: UnitEntry = { identity: { branch: 'feat', issues: [1] }, skills: ['to-spec'], verifyRuns: [], runs: [] }
  const world = createWorld(on, checkout(), { issues: { 2: 'CLOSED' }, session: { units: [live, buildEntry('gone', [2])] } })
  await world.ready
  const [mixed, text] = seedMirror(world, 'mixed', [buildEntry('gone', [2]), buildEntry('other', [4])])
  const unit = await seedDeclaration(world, { branch: 'gone', issues: [2] }, 'fix')
  await prune($, 'startup')
  expect(world.files.get(mixed)).toBe(text)
  expect(world.files.has(unit.declaration)).toBe(false)
  expect(world.sessions.get('sid')?.units).toEqual([live])
})

test('records shaped like the stuck units retire with no migration', async ($, on) => {
  const world = createWorld(on, checkout(), { issues: { 349: 'CLOSED', 353: 'CLOSED', 361: 'CLOSED', 364: 'CLOSED' } })
  await world.ready
  const [first] = seedMirror(world, 'pr-363', [buildEntry('fix/361-non-default-base', [361]), buildEntry('feat/364-pending-after-current', [364])])
  const [second] = seedMirror(world, 'main-349', [{ ...buildEntry('main', [349]), base: undefined, baseBranch: undefined }])
  const units = [
    await seedDeclaration(world, { branch: 'fix/361-non-default-base', issues: [361] }, 'fix'),
    await seedDeclaration(world, { branch: 'feat/364-pending-after-current', issues: [364] }, 'small-feature'),
    await seedDeclaration(world, { branch: 'main', issues: [349] }, 'small-feature'),
    await seedDeclaration(world, { branch: 'main', issues: [353] }, 'fix'),
    await seedDeclaration(world, { branch: 'fix/353-report-red-main-permissions', issues: [353] }, 'fix'),
  ]
  await prune($, 'startup')
  expect([first, second, ...units.flatMap(unit => [unit.declaration, unit.log])].filter(path => world.files.has(path))).toEqual([])
})

test('a tick never retires a unit', async ($, on) => {
  const world = createWorld(on, checkout(), { issues: { 2: 'CLOSED' } })
  await world.ready
  const [mirror, text] = seedMirror(world, 'dead', [buildEntry('gone', [2])])
  const unit = await seedDeclaration(world, { branch: 'gone', issues: [2] }, 'fix')
  await world.clock.advance(61000)
  expect(await readFlowStatus($)).toBeDefined()
  expect(world.files.get(mirror)).toBe(text)
  expect(world.files.has(unit.declaration)).toBe(true)
})

test('an unreadable declaration retires nothing, so a Follow-up it holds is never judged without it', async ($, on) => {
  const world = createWorld(on, checkout(), { issues: { 2: 'CLOSED', 3: 'CLOSED' } })
  await world.ready
  const [mirror, text] = seedMirror(world, 'dead', [buildEntry('main', [2])])
  const [other, otherText] = seedMirror(world, 'other', [buildEntry('gone', [3])])
  const followUp = await seedDeclaration(world, { branch: 'main', issues: [2] }, 'follow-up')
  const declared = JSON.stringify({ v: 1, identity: { branch: 'main', issues: [2] }, flow: 'follow-up', generation: 'dead:main:1', added: true })
  world.files.set(followUp.declaration, declared)
  const unit = await seedDeclaration(world, { branch: 'gone', issues: [3] }, 'fix')
  await prune($, 'startup')
  expect(world.files.get(mirror)).toBe(text)
  expect(world.files.get(other)).toBe(otherText)
  expect(world.files.get(followUp.declaration)).toBe(declared)
  for (const path of [followUp.log, unit.declaration, unit.log]) expect(world.files.has(path)).toBe(true)
})

test('a repository with no declaration yet still prunes concluded units', async ($, on) => {
  const prs = [buildPullRequest({ state: 'MERGED', headRefOid: 'f1', headRefName: 'feat' })]
  const world = createWorld(on, checkout(), { session: noFlow, unit: { base: 'm1' }, prs, isMissingListFailed: true })
  await world.ready
  expect(world.sessions.get('sid')?.units).toHaveLength(1)
  expect([...world.files.keys()].some(path => path.startsWith(`${directory}/u/`))).toBe(false)
  await prune($, 'startup')
  expect(world.sessions.get('sid')?.units).toEqual([])
})
