import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { temporaryExpiryMs } from '../../hooks/core/timing'
import { buildPullRequest, diagnoseRuns, noFlow, verifyFile } from '../support/builders'
import { conformanceGraph } from '../support/graph-fixture'
import { declareFlow, readFlowStatus, readStepStates, runFlowCommand } from '../support/helpers'
import { common, createWorld, root } from '../support/world'
import type { Checkout, Options } from '../support/world'

const directory = `${common}/working-agreement`
const expiredAgeMs = temporaryExpiryMs + 1

function branch(): Checkout {
  return { branch: 'feat', graph: structuredClone(conformanceGraph) }
}

function mergedOptions(extra: Options = {}): Options {
  return { unit: { base: 'm1' }, prs: [buildPullRequest({ state: 'MERGED', headRefOid: 'f1', headRefName: 'feat' })], ...extra }
}

/**
 * Builds run artifact content keyed by path.
 * @param owner - The owning session.
 * @param runId - The run identifier.
 * @returns The run files keyed by artifact path.
 */
function buildRunFiles(owner: string, runId: string): Map<string, string> {
  const log = `${directory}/runs/${owner}-${runId}.log`
  const paths = [log, `${log}.output`, `${log}.tmp`, `${directory}/runs/${runId}.json`]
  return new Map(paths.map(path => [path, 'run file']))
}

for (const [method, tip] of [['squash', 's1'], ['rebase', 'r1'], ['merge-commit', 'g1']]) {
  test(`a ${method} merge concludes every step even with later local work`, async ($, on) => {
    const checkout = branch()
    checkout.graph!.commits.r1 = { parents: ['m2'], files: { 'src/a.ts': 'a1', 'src/m.ts': 'm2' } }
    checkout.graph!.refs.main = tip!
    checkout.graph!.refs['origin/main'] = tip!
    const options = mergedOptions()
    const { clock } = createWorld(on, checkout, options)
    const status = await readFlowStatus($)
    expect(status).toContain('✓ PR #5 · merged')
    expect(status).toContain('7/7')
    expect(status).toContain('Start new session: /clear')
    options.failing = 'gh'
    checkout.graph!.refs.feat = 'o1'
    await clock.advance(61000)
    expect(await readFlowStatus($)).toContain('✓ PR #5 · merged')
  })
}

for (const flow of ['small-feature', 'close-out']) {
  test(`the first ${flow} unit concludes after a merge commit advances the default branch`, async ($, on) => {
    const checkout = branch()
    checkout.graph!.refs.feat = 'f1'
    const options: Options = { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } }
    const { clock, sessions } = createWorld(on, checkout, options)
    expect((await declareFlow($, flow, [1])).deny).toBeUndefined()
    expect(sessions.get('sid')?.units[0]?.base).toBe('m1')
    options.prs = [buildPullRequest({ state: 'MERGED', headRefOid: 'f1' })]
    checkout.graph!.refs.main = 'g1'
    checkout.graph!.refs['origin/main'] = 'g1'
    await clock.advance(61000)
    expect(await readFlowStatus($)).toContain('✓ PR #5 · merged')
    expect(await readFlowStatus($)).toContain('Start new session: /clear')
  })
}

test('a merged head diverged from the recorded base never concludes the unit', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'o1'
  createWorld(on, checkout, mergedOptions({ unit: { base: 'o1' } }))
  expect(await readFlowStatus($)).not.toContain('PR #5 · merged')
  expect(await readFlowStatus($)).not.toContain('Start new session: /clear')
})

for (const head of ['feat', 'main']) {
  test(`a ${head} unit without a recorded base never concludes`, async ($, on) => {
    const checkout = { ...branch(), branch: head }
    checkout.graph!.refs.main = 'm1'
    checkout.graph!.refs['origin/main'] = 'm1'
    createWorld(on, checkout, mergedOptions({ unit: {} }))
    expect(await readFlowStatus($)).not.toContain('PR #5 · merged')
    expect(await readFlowStatus($)).not.toContain('Start new session: /clear')
  })
}

test('conclusion needs no local unit branch and picks the lowest merged PR number', async ($, on) => {
  const checkout = branch()
  delete checkout.graph!.refs.feat
  createWorld(on, checkout, mergedOptions({ prs: [buildPullRequest({ number: 12, state: 'MERGED', headRefOid: 'f2' }), buildPullRequest({ number: 7, state: 'MERGED', headRefOid: 'f1' })] }))
  checkout.branch = 'main'
  expect(await readFlowStatus($)).toContain('PR #7 · merged')
})

test('a comparison that fails after the first merged match leaves the conclusion standing', async ($, on) => {
  const prs = [buildPullRequest({ state: 'MERGED', headRefOid: 'f1', headRefName: 'feat' }), buildPullRequest({ number: 6, state: 'MERGED', headRefOid: 'o1', headRefName: 'feat' })]
  createWorld(on, branch(), mergedOptions({ prs, failing: 'gh api repos/{owner}/{repo}/compare/m1...o1' }))
  expect(await readFlowStatus($)).toContain('✓ PR #5 · merged')
})

test('a partial merge followed by more commits starts a fresh unit on re-declaration', async ($, on) => {
  const checkout = branch()
  const { sessions } = createWorld(on, checkout, mergedOptions({ unit: { base: 'm1', skills: ['old'], runs: diagnoseRuns, approval: 'd', skips: [{ step: 'verify', reason: 'old' }] }, issueLabels: { 1: ['ready-for-agent'] } }))
  expect(await readFlowStatus($)).toContain('PR #5 · merged')
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  const fresh = sessions.get('sid')?.units[0]
  expect(fresh?.base).toBe('f2')
  expect(fresh?.skills).toEqual([])
  expect(fresh?.approval).toBeUndefined()
  expect(fresh?.skips).toBeUndefined()
  expect(fresh?.verifyRuns).toEqual([])
  expect(fresh?.runs).toEqual([])
  expect(await readFlowStatus($)).toContain('▸ Code · no change from the base')
  expect(await readFlowStatus($)).not.toContain('PR #5 · merged')
})

test('a branch deleted after merge and recreated from main starts a new lifetime', async ($, on) => {
  const checkout = branch()
  const { sessions } = createWorld(on, checkout, mergedOptions({ unit: { base: 'm1', runs: diagnoseRuns, approval: 'old' }, issueLabels: { 1: ['ready-for-agent'] } }))
  delete checkout.graph!.refs.feat
  checkout.graph!.refs.main = 's1'
  checkout.graph!.refs['origin/main'] = 's1'
  checkout.graph!.commits.new = { parents: ['s1'], files: { 'src/a.ts': 'new' } }
  checkout.graph!.refs.feat = 'new'
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(sessions.get('sid')?.units[0]?.base).toBe('s1')
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(sessions.get('sid')?.units[0]?.approval).toBeUndefined()
  expect(await readFlowStatus($)).not.toContain('PR #5 · merged')
})

test('a new unit on a previously merged branch counts only undelivered commits in its notice', async ($, on) => {
  const { sessions } = createWorld(on, branch(), mergedOptions({ session: noFlow, issueLabels: { 1: ['ready-for-agent'] } }))
  const reply = await declareFlow($, 'small-feature', [1])
  expect(reply.deny).toBeUndefined()
  expect(String(reply.result)).toContain('1 commits already on this branch are not counted for this unit')
  expect(sessions.get('sid')?.units[0]?.base).toBe('f2')
})

test('a dead chat holding both concluded and live units cannot donate old evidence to the next lifetime', async ($, on) => {
  const checkout = branch()
  const { files, sessions } = createWorld(on, checkout, mergedOptions({ issueLabels: { 1: ['ready-for-agent'] } }))
  const old = { ...sessions.get('sid')!, sessionId: 'dead', units: [
    { identity: { branch: 'feat', issues: [1] }, base: 'm1', skills: ['old'], verifyRuns: [], runs: diagnoseRuns, approval: 'old', skips: [{ step: 'code', reason: 'old' }] },
    { identity: { branch: 'other', issues: [2] }, base: 'm1', skills: [], verifyRuns: [], runs: [] },
  ] }
  const path = `${directory}/s/dead.json`
  const text = JSON.stringify(old)
  files.set(path, text)
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(files.get(path)).toBe(text)
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(files.get(path)).toBe(text)
  expect(sessions.get('sid')?.units[0]?.approval).toBeUndefined()
  expect(sessions.get('sid')?.units[0]?.skills).toEqual([])
  expect(sessions.get('sid')?.units[0]?.skips ?? []).toEqual([])
  expect(await readFlowStatus($)).toContain('▸ Code · no change from the base')
})

for (const trigger of ['startup', 'declaration']) {
  test(`${trigger} prunes concluded own entries and whole concluded chat mirrors`, async ($, on) => {
    const checkout = branch()
    const world = createWorld(on, checkout, mergedOptions({ unit: { base: 'm1', runs: [{ ...diagnoseRuns[0]!, runId: '1-1-sid' }] } }))
    const { files, sessions } = world
    const previous = sessions.get('sid')!
    files.set(`${directory}/s/other.json`, JSON.stringify({ ...previous, sessionId: 'other', units: previous.units.map(unit => ({ ...unit, runs: [{ ...diagnoseRuns[0]!, runId: '1-1-other' }] })) }))
    files.set(`${directory}/s/empty.json`, JSON.stringify({ ...previous, sessionId: 'empty', unit: null, units: [] }))
    const runFiles = new Map([...buildRunFiles('sid', '1-1-sid'), ...buildRunFiles('other', '1-1-other')])
    for (const [path, text] of runFiles) files.set(path, text)
    const paths = [...runFiles.keys()]
    if (trigger === 'startup') await $.session.start({ cwd: root, surface: null, isInteractive: false })
    else await declareFlow($, 'large-feature', [3])
    expect(files.has(`${directory}/s/other.json`)).toBe(false)
    expect(files.has(`${directory}/s/empty.json`)).toBe(false)
    expect(sessions.get('sid')?.units.some(unit => unit.identity.issues.includes(1))).toBe(false)
    expect([...files.entries()].some(([path, text]) => path.startsWith(`${directory}/u/`) && text.includes('"issues":[1]'))).toBe(false)
    for (const path of paths) expect(files.has(path)).toBe(false)
  })
}

for (const failure of ['gh', 'gh api graphql -F owner={owner} -F name={repo} -f head=other ', 'gh api repos/{owner}/{repo}/compare/m1...o1']) {
  test(`a sweep prunes nothing when any GitHub read fails: ${failure}`, async ($, on) => {
    const checkout = branch()
    const options = mergedOptions({ failing: failure, prs: [buildPullRequest({ state: 'MERGED', headRefOid: 'f1', headRefName: 'feat' }), buildPullRequest({ number: 6, state: 'MERGED', headRefOid: 'o1', headRefName: 'other' })] })
    const world = createWorld(on, checkout, options)
    const { files, sessions } = world
    const previous = sessions.get('sid')!
    const path = `${directory}/s/other.json`
    const text = JSON.stringify({ ...previous, sessionId: 'other', units: [{ identity: { branch: 'other', issues: [2] }, base: 'm1', skills: [], verifyRuns: [], runs: [] }] })
    files.set(path, text)
    const orphansFiles = buildRunFiles('dead', '1-1-dead')
    for (const [path, text] of orphansFiles) files.set(path, text)
    const orphans = [...orphansFiles.keys()]
    for (const bucket of ['s', 'u', 'd', 'ok', 'runs']) {
      const temporary = `${directory}/${bucket}/.tmp-dead-1`
      files.set(temporary, 'temporary')
      orphans.push(temporary)
    }
    await world.ready
    const declarations = [...files.entries()].filter(([name]) => name.includes('/u/'))
    await $.session.start({ cwd: root, surface: null, isInteractive: false })
    expect(files.get(path)).toBe(text)
    expect([...files.entries()].filter(([name]) => name.includes('/u/'))).toEqual(declarations)
    expect(sessions.get('sid')?.units).toEqual(previous.units)
    for (const orphan of orphans) expect(files.has(orphan)).toBe(true)
  })
}

test('a tick can discover conclusion but never prunes records or files', async ($, on) => {
  const options: Options = { unit: { base: 'm1' }, prs: [buildPullRequest({ headRefOid: 'f1' })] }
  const world = createWorld(on, branch(), options)
  const { clock, files, sessions } = world
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  const orphansFiles = buildRunFiles('dead', '1-1-dead')
  for (const [path, text] of orphansFiles) files.set(path, text)
  const orphans = [...orphansFiles.keys()]
  files.set(`${directory}/runs/.tmp-dead-1`, 'temporary')
  options.prs = [buildPullRequest({ state: 'MERGED', headRefOid: 'f1' })]
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('PR #5 · merged')
  expect(sessions.get('sid')?.units).toHaveLength(1)
  expect([...files.keys()].some(path => path.includes('/u/'))).toBe(true)
  for (const path of [...orphans, `${directory}/runs/.tmp-dead-1`]) expect(files.has(path)).toBe(true)
})

for (const trigger of ['startup', 'declaration']) {
  test(`${trigger} deletes only unreferenced own or dead run files and expired temp files`, async ($, on) => {
    const world = createWorld(on, branch(), { unit: { base: 'm1' } })
    const { clock, files, modified, sessions } = world
    const previous = sessions.get('sid')!
    files.set(`${directory}/s/live-with-hyphens.json`, JSON.stringify({ ...previous, sessionId: 'live-with-hyphens', units: [
      { ...previous.units[0]!, runs: [{ ...diagnoseRuns[0]!, runId: '1-1-sid' }, { ...diagnoseRuns[1]!, runId: '1-2-dead' }] },
    ] }))
    files.set(`${directory}/s/unparseable.json`, 'not json')
    const keptFiles = new Map([
      ...buildRunFiles('sid', '1-1-sid'),
      ...buildRunFiles('dead', '1-2-dead'),
      ...buildRunFiles('live-with-hyphens', '1-1-live-with-hyphens'),
      ...buildRunFiles('unparseable', '1-1-unparseable'),
    ])
    for (const [path, text] of keptFiles) files.set(path, text)
    const kept = [...keptFiles.keys()]
    const deletedFiles = new Map([...buildRunFiles('sid', '1-3-sid'), ...buildRunFiles('dead-with-hyphens', '1-1-dead-with-hyphens')])
    for (const [path, text] of deletedFiles) files.set(path, text)
    const deleted = [...deletedFiles.keys()]
    for (const bucket of ['s', 'u', 'd', 'ok', 'runs']) {
      const dead = `${directory}/${bucket}/.tmp-dead-with-hyphens-1`
      files.set(dead, 'temporary')
      modified.set(dead, clock.now() - expiredAgeMs)
      deleted.push(dead)
      for (const owner of ['sid', 'live-with-hyphens', 'unparseable']) {
        const path = `${directory}/${bucket}/.tmp-${owner}-999999`
        files.set(path, 'temporary')
        kept.push(path)
      }
    }
    for (const name of ['unknown.log', '1-dead.json', 'wrong-1-1-dead.log', 'wrong-1-1-dead.log.output', 'dead-1-1-dead.log.extra', '.tmp-dead-no-sequence']) {
      const path = `${directory}/runs/${name}`
      files.set(path, 'unmatched')
      kept.push(path)
    }
    if (trigger === 'startup') await $.session.start({ cwd: root, surface: null, isInteractive: false })
    else expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
    for (const path of deleted) expect(files.has(path)).toBe(false)
    for (const path of kept) expect(files.has(path)).toBe(true)
  })
}

test("a prune by another session keeps a flowless session's fresh temporary files and removes expired ones, whoever owns them", async ($, on) => {
  const world = createWorld(on, branch(), { unit: { base: 'm1' } })
  const { clock, files, modified } = world
  const fresh = [`${directory}/s/.tmp-flowless-1`, `${directory}/s/.tmp-flowless-1.lock`]
  const expired = [`${directory}/s/.tmp-flowless-2`, `${directory}/s/.tmp-flowless-2.lock`, `${directory}/s/.tmp-sid-999999`]
  for (const path of [...fresh, ...expired]) files.set(path, 'index')
  for (const path of expired) modified.set(path, clock.now() - expiredAgeMs)
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  for (const path of fresh) expect(files.has(path)).toBe(true)
  for (const path of expired) expect(files.has(path)).toBe(false)
})

for (const trigger of ['startup', 'declaration']) {
  for (const mirror of ['missing', 'stale']) {
    test(`${trigger} retains run files named by own authoritative state when its mirror is ${mirror}`, async ($, on) => {
      const world = createWorld(on, branch(), { unit: { base: 'm1', runs: [{ ...diagnoseRuns[0]!, runId: '1-1-sid' }] } })
      const { files, sessions } = world
      if (mirror === 'stale') {
        const session = sessions.get('sid')!
        files.set(`${directory}/s/sid.json`, JSON.stringify({ ...session, units: session.units.map(unit => ({ ...unit, runs: [] })) }))
      }
      const pathsFiles = buildRunFiles('sid', '1-1-sid')
      for (const [path, text] of pathsFiles) files.set(path, text)
      const paths = [...pathsFiles.keys()]
      if (trigger === 'startup') await $.session.start({ cwd: root, surface: null, isInteractive: false })
      else await declareFlow($, 'small-feature', [1])
      for (const path of paths) expect(files.has(path)).toBe(true)
    })
  }
}

test('a Verify re-run retires the replaced log and sidecar at the next declaration', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', isDirty: true, tree: 'changed' }, { approvedConfig: verifyFile, verifyFile })
  const { files, sessions } = world
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  const first = sessions.get('sid')!.units[0]!.verifyRuns[0]!
  const oldFiles = buildRunFiles('sid', first.runId)
  for (const [path, text] of oldFiles) files.set(path, text)
  const old = [...oldFiles.keys()]
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  const runs = sessions.get('sid')!.units[0]!.verifyRuns
  expect(runs).toHaveLength(1)
  expect(runs[0]!.runId).not.toBe(first.runId)
  const currentFiles = buildRunFiles('sid', runs[0]!.runId)
  for (const [path, text] of currentFiles) files.set(path, text)
  const current = [...currentFiles.keys()]
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  for (const path of old) expect(files.has(path)).toBe(false)
  for (const path of current) expect(files.has(path)).toBe(true)
})

test('an unrecorded just-ended run stays until this session replaces its Run log view', async ($, on) => {
  const checkout = { branch: 'feat', isDirty: true, tree: 'before' }
  const options: Options = { approvedConfig: verifyFile, verifyFile, afterSpawn: () => { checkout.tree = 'after' } }
  const world = createWorld(on, checkout, options)
  const { files, sessions } = world
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect(sessions.get('sid')!.units[0]!.verifyRuns).toEqual([])
  const sidecar = [...files.keys()].find(path => path.startsWith(`${directory}/runs/`) && path.endsWith('.json'))!
  const runId = sidecar.slice(`${directory}/runs/`.length, -5)
  const heldFiles = buildRunFiles('sid', runId)
  for (const [path, text] of heldFiles) files.set(path, text)
  const held = [...heldFiles.keys()]
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  for (const path of held) expect(files.has(path)).toBe(true)
  options.afterSpawn = () => {}
  await $.tool.call({ tool: 'mcp__working-agreement__verify' })
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  for (const path of held) expect(files.has(path)).toBe(false)
})

for (const failure of ['throw', 'exit']) {
  test(`failed deletes (${failure}) do not fail startup or declarations and retry next sweep`, async ($, on) => {
    const options: Options = { failing: failure === 'throw' ? 'rm' : undefined, removeExitCode: failure === 'exit' ? 1 : undefined }
    const world = createWorld(on, branch(), options)
    const { files } = world
    const pathsFiles = buildRunFiles('dead', '1-1-dead')
    for (const [path, text] of pathsFiles) files.set(path, text)
    const paths = [...pathsFiles.keys()]
    await $.session.start({ cwd: root, surface: null, isInteractive: false })
    expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
    for (const path of paths) expect(files.has(path)).toBe(true)
    options.failing = undefined
    options.removeExitCode = undefined
    expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
    for (const path of paths) expect(files.has(path)).toBe(false)
  })
}

test('failed directory listings do not fail startup or declarations or delete files', async ($, on) => {
  const world = createWorld(on, branch(), { listFailurePrefix: directory })
  const { files } = world
  const pathsFiles = buildRunFiles('dead', '1-1-dead')
  for (const [path, text] of pathsFiles) files.set(path, text)
  const paths = [...pathsFiles.keys()]
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  for (const path of paths) expect(files.has(path)).toBe(true)
})

test('a frozen unit keeps reading CI on its own slice end', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const options: Options = { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'] }, prs: [buildPullRequest({ headRefOid: 'f2' })], statuses: { f1: [{ context: 'first', state: 'failure' }], f2: [{ context: 'second', state: 'success' }] } }
  const { chat, clock } = createWorld(on, checkout, options)
  await declareFlow($, 'small-feature', [1])
  await runFlowCommand($, 'skip verify covered separately')
  chat.id = 'second'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.refs.feat = 'f2'
  chat.id = 'sid'
  expect(await readFlowStatus($)).toContain('feat · frozen')
  expect(await readFlowStatus($)).toContain('CI failing: first')
  options.statuses = { f1: [{ context: 'first', state: 'success' }], f2: [{ context: 'second', state: 'failure' }] }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

test('Close out always uses merge-base through tip and never freezes an earlier unit', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const world = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  const { chat, sessions } = world
  await declareFlow($, 'small-feature', [1])
  chat.id = 'close'
  await declareFlow($, 'close-out', [2])
  expect(sessions.get('close')?.units[0]?.base).toBe('f1')
  expect((await readStepStates(world)).Commit).toBe('done')
  checkout.graph!.refs.feat = 'f2'
  chat.id = 'sid'
  expect(await readFlowStatus($)).not.toContain('frozen')
})

test('Close out keeps its recorded conclusion base while its slice follows the live default branch', async ($, on) => {
  const checkout = branch()
  const { sessions } = createWorld(on, checkout, { session: noFlow })
  expect((await declareFlow($, 'close-out', [1])).deny).toBeUndefined()
  await runFlowCommand($, 'skip verify covered separately')
  expect(sessions.get('sid')?.units[0]?.base).toBe('m1')
  expect(await readFlowStatus($)).toContain('✓ Commit')
  checkout.graph!.refs.main = 'f2'
  checkout.graph!.refs['origin/main'] = 'f2'
  expect(await readFlowStatus($)).toContain('▸ Commit · no commit in the slice')
  expect(sessions.get('sid')?.units[0]?.base).toBe('m1')
})
