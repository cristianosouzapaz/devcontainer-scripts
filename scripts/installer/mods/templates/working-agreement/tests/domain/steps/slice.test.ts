import { expect, test } from 'claude-code/testing'
import { noFlow } from '../../support/builders'
import { conformanceGraph } from '../../support/graph-fixture'
import { declareFlow, readFlowStatus, readPromptContext, runFlowCommand } from '../../support/helpers'
import { common, createWorld } from '../../support/world'
import type { Checkout } from '../../support/world'

function branch(): Checkout {
  return { branch: 'feat', graph: structuredClone(conformanceGraph) }
}

test('switching branches preserves done Code and Commit and names the checkout in pane and prompt', async ($, on) => {
  const checkout = branch()
  createWorld(on, checkout, { session: { flow: 'trivial' } })
  expect(await readFlowStatus($)).toContain('✓ Commit')
  checkout.branch = 'other'
  checkout.dirty = { 'src/elsewhere.ts': 'uncommitted' }
  const status = await readFlowStatus($)
  expect(status).toContain('✓ Code')
  expect(status).toContain('✓ Commit')
  expect(status).toContain("other, not this unit's branch")
  expect(await readPromptContext($)).toContain("checked out: other (not this unit's branch)")
})

test('only the linked worktree holding the unit branch contributes dirty content', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'm1'
  checkout.worktrees = { '/repo': { branch: 'other', dirty: { 'foreign': 'x' } }, '/linked': { branch: 'feat' } }
  createWorld(on, checkout, { session: { flow: 'trivial' } })
  checkout.branch = 'other'
  expect(await readFlowStatus($)).toContain('▸ Code · no change from the base')
  checkout.worktrees['/linked']!.dirty = { 'src/new.ts': 'new' }
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readFlowStatus($)).toContain('▸ Verify · no verify command configured')
  checkout.worktrees['/repo']!.dirty = { 'foreign': 'another edit' }
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readFlowStatus($)).not.toContain('✓ Commit')
})

test('two units use separate slices and the earlier unit freezes at the later base', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const { chat, sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  expect((await declareFlow($, 'small-feature', [2])).deny).toBeUndefined()
  expect(sessions.get('second')?.units[0]?.base).toBe('f1')
  expect(await readFlowStatus($)).toContain('▸ Code · no change from the base')
  chat.id = 'empty-third'
  expect((await declareFlow($, 'small-feature', [3])).deny).toContain('empty slice')
  chat.id = 'second'
  checkout.graph!.refs.feat = 'f2'
  expect(await readFlowStatus($)).toContain('✓ Commit')
  checkout.dirty = { 'src/a.ts': 'a0' }
  expect(await readFlowStatus($)).toContain('▸ Verify · no verify command configured')
  chat.id = 'sid'
  const first = await readFlowStatus($)
  expect(first).toContain('feat · frozen')
  expect(first).toContain('✓ Commit')
  expect((await declareFlow($, 'small-feature', [1])).deny).toContain('declare on a new branch')
})

test('frozen Code reads the end tree even when later commits restore the base tree', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const { chat } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await runFlowCommand($, 'trivial')
  chat.id = 'second'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.commits.revert = { parents: ['f1'], files: { 'src/a.ts': 'a0' } }
  checkout.graph!.refs.feat = 'revert'
  chat.id = 'sid'
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readFlowStatus($)).toContain('feat · frozen')
})

test('an empty latest slice refuses another unit, including one declared from another chat', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'm1'
  const { chat, sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  expect((await declareFlow($, 'small-feature', [2])).deny).toContain('empty slice')
  expect(sessions.get('second')?.unit).toBeUndefined()
})

test('re-declaring a rewritten first unit restores its slice from the live merge-base', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'm2'
  const { sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'] } })
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(sessions.get('sid')?.units[0]?.base).toBe('m2')
  checkout.graph!.commits.c = { parents: ['m2'], files: { 'src/a.ts': 'a1', 'src/m.ts': 'm2' } }
  checkout.graph!.refs.feat = 'c'
  expect(await readFlowStatus($)).toContain('✓ Commit')
  checkout.graph!.commits.rebased = { parents: ['m1'], files: { 'src/a.ts': 'a1' } }
  checkout.graph!.refs.feat = 'rebased'
  expect(await readFlowStatus($)).toContain('feat · rewritten')
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(sessions.get('sid')?.units[0]?.base).toBe('m1')
  const repaired = await readFlowStatus($)
  expect(repaired).not.toContain('rewritten')
  expect(repaired).toContain('✓ Code')
  expect(repaired).toContain('✓ Commit')
})

test('re-declaring a rewritten later unit still takes the tip as its base', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const { chat, sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.refs.feat = 'o1'
  const status = await readFlowStatus($)
  expect(status).toContain('?/7')
  expect(status).toContain('feat · rewritten')
  expect(status).toContain('? Commit')
  expect(status).toContain('? PR')
  expect(await readPromptContext($)).toContain('branch history rewritten since this unit was declared — re-declare')
  expect((await declareFlow($, 'small-feature', [2])).deny).toBeUndefined()
  expect(sessions.get('second')?.units[0]?.base).toBe('o1')
  expect(await readFlowStatus($)).not.toContain('rewritten')
  expect(await readFlowStatus($)).toContain('▸ Code · no change from the base')
  expect(await readFlowStatus($)).not.toContain('✓ Commit')
})

test('a continuation in a separate chat preserves an inherited base and advances only after a rewrite', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const { chat, sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.refs.feat = 'f2'
  chat.id = 'third'
  await declareFlow($, 'small-feature', [2])
  expect(sessions.get('third')?.units[0]?.base).toBe('f1')
  expect(await readFlowStatus($)).toContain('✓ Commit')
})

test('the first unit records its declaration merge-base', async ($, on) => {
  const checkout = branch()
  const { sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await runFlowCommand($, 'trivial')
  expect(sessions.get('sid')?.units[0]?.base).toBe('m1')
  checkout.graph!.refs.main = 'f2'
  checkout.graph!.refs['origin/main'] = 'f2'
  expect(await readFlowStatus($)).toContain('✓ Code')
})

test('a unit declared on the default branch has no Code or Commit evidence', async ($, on) => {
  const checkout = { ...branch(), branch: 'main', dirty: { 'src/new': 'new' } }
  createWorld(on, checkout, { session: { flow: 'trivial' } })
  const status = await readFlowStatus($)
  expect(status).toContain("▸ Code · check out the unit's branch and re-declare")
  expect(status).toContain('○ Commit\n')
  expect(status).not.toContain('✓ Code')
  expect(status).not.toContain('✓ Commit')
})

test('default-branch declarations neither acquire bases nor freeze or block other units', async ($, on) => {
  const checkout = { ...branch(), branch: 'main' }
  const { chat, sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect((await declareFlow($, 'small-feature', [2])).deny).toBeUndefined()
  expect(sessions.get('sid')?.units.map(entry => entry.base)).toEqual([undefined, undefined])
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  chat.id = 'another-default-chat'
  expect((await declareFlow($, 'small-feature', [3])).deny).toBeUndefined()
  expect(sessions.get(chat.id)?.units[0]?.base).toBeUndefined()
  chat.id = 'sid'
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(await readFlowStatus($)).not.toContain('frozen')
  expect(await readFlowStatus($)).not.toContain('rewritten')
})

test('continuing a default-branch unit discards an inherited base without judging its history', async ($, on) => {
  const checkout = { ...branch(), branch: 'main' }
  const { sessions } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] }, unit: { base: 'f1' } })
  expect((await declareFlow($, 'small-feature', [1])).deny).toBeUndefined()
  expect(sessions.get('sid')?.units[0]?.base).toBeUndefined()
  expect(await readFlowStatus($)).not.toContain('rewritten')
})

test('known limit: detached HEAD at main is not on the default branch', async ($, on) => {
  const checkout = { ...branch(), branch: 'feat', dirty: { new: 'new' } }
  checkout.graph!.refs.feat = checkout.graph!.refs.main!
  createWorld(on, checkout, { session: { flow: 'trivial' } })
  checkout.branch = 'HEAD'
  checkout.graph!.refs.HEAD = checkout.graph!.refs.main!
  const prompt = await readPromptContext($)
  expect(prompt).not.toContain('create a branch')
  expect(prompt).not.toContain("check out the unit's branch and re-declare")
  expect(prompt).toContain("checked out: HEAD (not this unit's branch)")
})

test('Code compares trees rather than the number of commits and only the current step displays a fact', async ($, on) => {
  const checkout = branch()
  checkout.graph!.commits.empty = { parents: ['m1'], files: { 'src/a.ts': 'a0' } }
  checkout.graph!.refs.feat = 'empty'
  createWorld(on, checkout, { session: { flow: 'trivial' } })
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Code · no change from the base')
  expect(status).toContain('✓ Commit')
  expect(status).not.toContain('no verify command configured')
  expect(status).not.toContain('uncommitted changes')
})

test('skip unions across session records and done wins over a recorded skip', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'm1'
  const { chat, files } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await runFlowCommand($, 'trivial')
  expect((await runFlowCommand($, 'skip CoDe reviewed elsewhere')).text).toContain('Skipped Code')
  expect(await readFlowStatus($)).toContain('↷ Code · reviewed elsewhere')
  expect(await readFlowStatus($)).toContain('▸ Verify · no verify command configured')
  chat.id = 'second'
  await runFlowCommand($, 'trivial')
  expect(await readFlowStatus($)).toContain('↷ Code · reviewed elsewhere')
  const saved = JSON.parse(files.get(`${common}/working-agreement/s/sid.json`)!)
  expect(saved.units[0].skips).toEqual([{ step: 'code', reason: 'reviewed elsewhere' }])
  checkout.graph!.refs.feat = 'f1'
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readFlowStatus($)).not.toContain('reviewed elsewhere')
})

test('skip refuses absent flow, unknown step, empty reason, and every non-composer origin', async ($, on) => {
  createWorld(on, branch(), { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  expect((await runFlowCommand($, 'skip code why')).text).toContain('No flow declared')
  await runFlowCommand($, 'trivial')
  expect((await runFlowCommand($, 'skip absent why')).text).toContain('Unknown step')
  expect((await runFlowCommand($, 'skip code')).text).toContain('non-empty reason')
  expect((await runFlowCommand($, 'skip code why', { kind: 'plugin', name: 'working-agreement' })).text).toContain("user's to run")
})

test('base ancestry orders three slices independently of session filename order', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const { chat } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'z-last-filename'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.refs.feat = 'f2'
  chat.id = 'a-first-filename'
  await declareFlow($, 'small-feature', [3])
  expect(await readFlowStatus($)).toContain('no change from the base')
  chat.id = 'z-last-filename'
  expect(await readFlowStatus($)).toContain('feat · frozen')
  expect(await readFlowStatus($)).toContain('✓ Commit')
  chat.id = 'sid'
  expect(await readFlowStatus($)).toContain('feat · frozen')
  expect(await readFlowStatus($)).toContain('✓ Commit')
})

test('a base repaired in another chat replaces the inherited rewritten base for every chat', async ($, on) => {
  const checkout = branch()
  checkout.graph!.refs.feat = 'f1'
  const { chat } = createWorld(on, checkout, { session: noFlow, issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'], 3: ['ready-for-agent'] } })
  await declareFlow($, 'small-feature', [1])
  chat.id = 'second'
  await declareFlow($, 'small-feature', [2])
  checkout.graph!.refs.feat = 'o1'
  chat.id = 'repair'
  await declareFlow($, 'small-feature', [2])
  chat.id = 'second'
  expect(await readFlowStatus($)).not.toContain('rewritten')
  expect(await readFlowStatus($)).toContain('no change from the base')
})
