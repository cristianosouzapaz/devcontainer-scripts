import { expect } from 'claude-code/testing'

import { coordinator, noFlow } from '../support/builders'
import { callModTool, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { delegationCheckout, seedDelegatedChild } from '../support/parallel-worktrees'
import { createWorld, delegatedFile } from '../support/world'

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
  const world = createWorld(on, delegationCheckout(), { session: coordinator, comments: { 2: [decision('Which store?', 'low', 1), decision('Which branch?', 'high', 2)] } as never })
  await seedDelegatedChild(world)
  await callModTool($, 'merge_child', { child: 'a' })
  const result = await runFlowCommand($, 'report')
  expect(result.text).toBe([
    '#1 · par', 'Step       PR', 'Verify     no verify command configured', 'Commits    none', 'Merge      none', 'Decision   none', 'Notice     none', '',
    '#2 · a', 'Step       finished', 'Verify     no verify command configured', 'Commits    a1 a2', 'Merge      into par',
    'Decision   high · Which branch? · https://github.com/o/r/issues/2#issuecomment-2',
    'Decision   low · Which store? · https://github.com/o/r/issues/2#issuecomment-1', 'Notice     none', '',
    'Delegated commits are unsigned and local — sign and push them, in this order (every log line must start with G):',
    '  git -C /a switch --detach',
    '  git -C /par rebase --keep-base --rebase-merges --update-refs --force-rebase --gpg-sign origin/main par',
    '  git -C /par log --format=\'%G? %h %s\' origin/main..par',
    '  git -C /par push -u origin par',
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

test('/flow report gives no signing commands when no delegated commit is left', async ($, on) => {
  const world = createWorld(on, delegationCheckout(), { session: coordinator })
  await seedDelegatedChild(world)
  for (const sha of ['a1', 'a2']) world.files.delete(delegatedFile(sha))
  const text = (await runFlowCommand($, 'report')).text ?? ''
  expect(text).toMatch(/#2 · a\n[^#]*Commits\s+none/)
  expect(text).not.toContain('sign and push')
})

test('/flow report lists the issues by number, byte-identical on every run over the same records', async ($, on) => {
  const world = createWorld(on, delegationCheckout(), { session: coordinator })
  await seedDelegatedChild(world, [2, 1])
  const first = (await runFlowCommand($, 'report')).text ?? ''
  expect(first.indexOf('#1 · par')).toBeLessThan(first.indexOf('#2 · a'))
  expect((await runFlowCommand($, 'report')).text).toBe(first)
})
