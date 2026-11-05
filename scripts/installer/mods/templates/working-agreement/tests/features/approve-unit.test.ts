import { expect } from 'claude-code/testing'

import { coordinator, diagnoseRuns } from '../support/builders'
import { callModTool, inside } from '../support/helpers'
import { test } from '../support/kit'
import { readDelegated, seedUnit } from '../support/parallel-worktrees'
import { buildScope, createWorld, markSpawned, scopeFile } from '../support/world'
import type { Options, World } from '../support/world'

const diagnosis = { url: 'https://github.com/o/r/issues/3#issuecomment-10', createdAt: new Date(3).toISOString(), body: 'Cause: x. Red: ./check' }
const decisionUrl = 'https://github.com/o/r/issues/3#issuecomment-11'

const message = { number: 3, kind: 'approve', decision: decisionUrl, diagnosis: diagnosis.url, red: './check' }

/**
 * Builds a delegated decision comment on issue 3.
 * @param choice - The Choice text.
 * @param reason - The Reason text.
 * @returns The comment.
 */
const decision = (choice: string, reason: string): { url: string; createdAt: string; body: string } => ({
  url: decisionUrl, createdAt: new Date(4).toISOString(),
  body: `## Delegated decision\n\n### Question\nApprove?\n\n### Alternatives considered\n- no\n\n### Choice\n${choice}\n\n### Reason\n${reason}\n\n### Cost of going back\nlow`,
})

/** A unit session on `feat` for issue 3 at Diagnose: a red, then its diagnosis comment, no approval yet. */
const waiting = (): Options => ({
  session: { flow: 'fix', issues: [3], info: { 3: { title: 'bug', labels: ['ready-for-agent'] } } },
  unit: { runs: [diagnoseRuns[0]!] }, comments: { 3: [diagnosis] }, issueLabels: { 3: ['ready-for-agent'] },
})

/**
 * Builds a coordinator over issue 3 whose unit session `unit3` sits at Diagnose: a red, then its diagnosis comment, no approval.
 * @param on - The hook registrar.
 * @param approval - The decision comment on issue 3.
 * @returns The world.
 */
async function arrangeCoordinator(on: Parameters<typeof createWorld>[0], approval = decision('Approve.', 'Looks fine.')): Promise<World> {
  const world = createWorld(on, { branch: 'main' }, { session: coordinator, herdrEnv: inside, herdrReply: () => '{}', comments: { 3: [diagnosis, approval] } })
  world.files.set(scopeFile('sid'), buildScope('sid', [3]))
  await seedUnit(world, 'unit3', { branch: 'fix/3-bug', issues: [3] }, { runs: [diagnoseRuns[0]!] }, 'fix')
  return world
}

/**
 * Lists the prompts herdr sent to unit sessions.
 * @param world - The world.
 * @returns Each prompt's command line.
 */
const prompts = (world: World): string[] => world.herdrCalls.map(call => call.argv.join(' ')).filter(line => line.startsWith('herdr agent prompt'))

test('approve_unit refuses a red command other than the one recorded before the diagnosis', async ($, on) => {
  const world = await arrangeCoordinator(on, decision(`Approve ${diagnosis.url}.`, 'The red ./other fails.'))
  const result = await callModTool($, 'approve_unit', { ...message, red: './other' })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('which the unit recorded as: ./check')
  expect(prompts(world)).toEqual([])
})

test('unit_prompt refuses a literal /flow approve, which goes only through approve_unit', async ($, on) => {
  const world = await arrangeCoordinator(on)
  const result = await callModTool($, 'unit_prompt', { number: 3, text: `/flow approve ${decisionUrl}` })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('approve_unit')
  expect(prompts(world)).toEqual([])
})

test('a delegated unit\'s commit tool is refused while its Diagnose waits for approval, naming the missing /flow approve', async ($, on) => {
  const checkout = { branch: 'feat', graph: { commits: { a: { parents: [], files: { f: 'a' } } }, refs: { main: 'a', 'origin/main': 'a', feat: 'a' } }, staged: { f: 'b' } }
  const world = createWorld(on, checkout, waiting())
  markSpawned(world, [3])
  world.files.set(scopeFile('coord'), buildScope('coord', [3]))
  const result = await callModTool($, 'commit', { message: 'fix: change' })
  expect(result.isError).toBe(true)
  expect(result.text).toContain(`/flow approve ${diagnosis.url}`)
  expect(checkout.graph.refs.feat).toBe('a')
  expect(readDelegated(world)).toEqual([])
})

test('a Bash git commit outside delegation is refused while Diagnose waits for approval, naming the missing /flow approve', async ($, on) => {
  createWorld(on, { branch: 'feat' }, waiting())
  const deny = (await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })).deny
  expect(deny).toContain(`/flow approve ${diagnosis.url}`)
})
