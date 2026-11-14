import { expect } from 'claude-code/testing'

import { coordinator, noFlow } from '../support/builders'
import { callModTool, runFlowCommand, startSession } from '../support/helpers'
import { test } from '../support/kit'
import { delegationCheckout, gatedCheckout, gateOptions, seedDelegatedChild, tipA } from '../support/parallel-worktrees'
import { coordinatorHost, createWorld, delegatedFile, scopeFile } from '../support/world'

/**
 * Writes a well-formed delegated decision comment.
 * @param question - The decision's question.
 * @param cost - Its cost of going back.
 * @param id - The comment's number.
 * @returns The comment.
 */
const decision = (question: string, cost: string, id: number): { url: string; body: string } => ({
  url: `https://github.com/o/r/issues/2#issuecomment-${id}`,
  body: `## Delegated decision\n\n### Question\n${question}\n\n### Alternatives considered\nA; B.\n\n### Choice\nA.\n\n### Reason\nSimpler.\n\n### Cost of going back\n${cost}`,
})

test('/flow report is the rendered report itself: each issue\'s step, commits, merge, decisions high-cost first and notices, then the signing commands', async ($, on) => {
  const world = createWorld(on, gatedCheckout(git => ({ ...git, moved: ['a'], cuts: { a: 'p1' } })), { session: coordinator, ...gateOptions, comments: { 2: [decision('Which store?', 'low', 1), decision('Which branch?', 'high', 2)] } as never })
  await seedDelegatedChild(world)
  await callModTool($, 'merge_child', { child: 'a', tip: tipA })
  await startSession($)
  const result = await runFlowCommand($, 'report')
  expect(result.text?.replace(/\S+\/sign\/par\.sh/g, '<script>')).toBe([
    // why: the gate's pass on the merged tree is a gate-stage pass, which never stands for a unit's own Verify.
    '#1 · par', 'Step        PR', 'Verify      not run', 'Commits     none', 'Merge       none', 'Decision    none', 'Notice      none', '',
    '#2 · a', 'Step        finished', 'Verify      not run', 'Commits     a1 a200000', 'Merge       into par',
    'Decision    high · Which branch? · https://github.com/o/r/issues/2#issuecomment-2',
    'Decision    low · Which store? · https://github.com/o/r/issues/2#issuecomment-1', 'Notice      none', '',
    'To sign  par',
    '  Commits      3 above origin/main (3 unsigned, 0 signed)',
    '  Child refs   1 move with it (a)',
    '  Checks       tree unchanged · every commit signed · verify: off (no keyring)',
    '  Pre-check    ✔ every child is inside the head',
    '', 'Run',
    '  1. bash <script> --dry-run    # lists, moves nothing',
    '  2. bash <script>',
    '  3. git -C /par push -u origin par',
  ].join('\n'))
  expect(world.prompts).toEqual([])
})

test('/flow report shows unreadable decisions as unknown', async ($, on) => {
  const world = createWorld(on, delegationCheckout(), { session: coordinator, comments: { 1: { error: 'HTTP 502' }, 2: { error: 'HTTP 502' } } as never })
  await seedDelegatedChild(world)
  expect((await runFlowCommand($, 'report')).text).toMatch(/Decision\s+unknown/)
})

test('/flow report runs only in a coordinator session', async ($, on) => {
  createWorld(on, delegationCheckout(), { session: noFlow })
  expect((await runFlowCommand($, 'report')).text).toBe('/flow report runs only in a coordinator session.')
})

test('/flow report with nothing delegated says so and gives no signing commands', async ($, on) => {
  createWorld(on, delegationCheckout(), { session: coordinator })
  const text = (await runFlowCommand($, 'report')).text ?? ''
  expect(text).toBe('This coordinator delegates no issue.')
})

test('/flow report for a coordinator that delegates the issues it creates, with none yet, says so', async ($, on) => {
  const world = createWorld(on, delegationCheckout(), { session: coordinator })
  await world.ready
  world.files.set(scopeFile('sid'), JSON.stringify({ v: 1, sessionId: 'sid', issues: [], coversCreated: true, host: coordinatorHost }))
  expect((await runFlowCommand($, 'report')).text).toBe('This coordinator delegates the issues it creates; none yet.')
})

test('/flow report gives no signing commands when no delegated commit is left', async ($, on) => {
  const world = createWorld(on, delegationCheckout(), { session: coordinator })
  await seedDelegatedChild(world)
  for (const sha of ['a1', tipA]) world.files.delete(delegatedFile(sha))
  const text = (await runFlowCommand($, 'report')).text ?? ''
  expect(text).toMatch(/#2 · a\n[^#]*Commits\s+none/)
  expect(text).not.toContain('To sign')
})

test('/flow report lists the issues by number, byte-identical on every run over the same records', async ($, on) => {
  const world = createWorld(on, delegationCheckout(), { session: coordinator })
  await seedDelegatedChild(world, [2, 1])
  const first = (await runFlowCommand($, 'report')).text ?? ''
  expect(first.indexOf('#1 · par')).toBeLessThan(first.indexOf('#2 · a'))
  expect((await runFlowCommand($, 'report')).text).toBe(first)
})

// contract: a branch cut from its parent with no commit since is reported as no merge, however its tip sits inside the parent
test('/flow report shows a just-cut branch as no merge, not as merged into its parent', async ($, on) => {
  const world = createWorld(on, delegationCheckout(git => ({ ...git, refs: { ...git.refs, a: 'p1' } })), { session: coordinator })
  await seedDelegatedChild(world)
  expect((await runFlowCommand($, 'report')).text).toMatch(/#2 · a\n[^#]*Merge\s+none \(no commits since the cut\)\n/)
})

// contract: a branch whose reflog does not prove where it was cut is reported with an unknown merge state, never as merged
test('/flow report shows a branch with no reflog as merge state unknown', async ($, on) => {
  const world = createWorld(on, delegationCheckout(git => ({ ...git, refs: { ...git.refs, a: 'p1' }, created: {} })), { session: coordinator })
  await seedDelegatedChild(world)
  expect((await runFlowCommand($, 'report')).text).toMatch(/#2 · a\n[^#]*Merge\s+merge state unknown \(branch history unavailable\); check with git log par\.\.a\n/)
})

// contract: a branch that moved and was reset back to the commit it was cut at is reported as no merge
test('/flow report shows a branch reset back to its cut as no merge', async ($, on) => {
  const world = createWorld(on, delegationCheckout(git => ({ ...git, refs: { ...git.refs, a: 'p1' }, moved: ['a'], cuts: { a: 'p1' } })), { session: coordinator })
  await seedDelegatedChild(world)
  expect((await runFlowCommand($, 'report')).text).toMatch(/#2 · a\n[^#]*Merge\s+none \(no commits since the cut\)\n/)
})

// contract: a merged branch whose reflog no longer holds its creation entry is reported with an unknown merge state, never as merged
test('/flow report shows a merged branch whose reflog expired as merge state unknown', async ($, on) => {
  const world = createWorld(on, delegationCheckout(git => ({ ...git, refs: { ...git.refs, par: 'ma' }, moved: ['a'], created: {} })), { session: coordinator })
  await seedDelegatedChild(world)
  expect((await runFlowCommand($, 'report')).text).toMatch(/#2 · a\n[^#]*Merge\s+merge state unknown \(branch history unavailable\); check with git log par\.\.a\n/)
})

// contract: an ancestry read that fails is reported as an unknown merge state, never as no merge
test('/flow report shows a failed ancestry read as merge state unknown', async ($, on) => {
  const world = createWorld(on, delegationCheckout(), { session: coordinator, failing: 'git merge-base --is-ancestor refs/heads/a ' })
  await seedDelegatedChild(world)
  expect((await runFlowCommand($, 'report')).text).toMatch(/#2 · a\n[^#]*Merge\s+merge state unknown \(branch history unavailable\); check with git log par\.\.a\n/)
})
