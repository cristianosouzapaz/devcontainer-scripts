import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { noFlow } from '../support/builders'
import { callModTool, declareFlow, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { childCheckout } from '../support/parallel-worktrees'
import { createWorld, seedDelegation } from '../support/world'
import type { Checkout, Graph, World } from '../support/world'

/**
 * Where a test makes host calls fail once armed: a throw from the host on the first call the predicate matches, or a failed exit on the
 * first two, both attempts of a record write, which the mod's own code turns into a throw.
 */
interface Fault { isArmed: boolean; matches: (argv: string[]) => boolean; kind: 'throw' | 'exit'; exits?: number }

/**
 * Moves `par` onto a new commit cut from `p1`.
 * @param git - The reference workflow's history.
 * @returns The history with `par` at p3.
 */
const advancePar = (git: Graph): Graph => ({ ...git, commits: { ...git.commits, p3: { parents: ['p1'], files: { 'src/par.ts': 'p3' } } }, refs: { ...git.refs, par: 'p3' } })

/**
 * Tells whether an armed fault of a kind matches a host call.
 * @param fault - The fault.
 * @param kind - The kind asked about.
 * @param argv - The host call.
 * @returns Whether it fails the call.
 */
const isFailing = (fault: Fault, kind: Fault['kind'], argv: string[]): boolean => fault.isArmed && fault.kind === kind && fault.matches(argv)

/**
 * Builds a delegated unit on issue 2, in a Small feature, whose host fails the calls the fault matches once it is armed.
 * @param $ - The test engine.
 * @param on - The hook registrar.
 * @param live - The checkout.
 * @param fault - The fault.
 * @returns The world.
 */
async function arrangeUnit($: Engine, on: Parameters<typeof createWorld>[0], live: Checkout, fault: Fault): Promise<World> {
  const world = createWorld(on, live, { session: noFlow,
    beforeRun: argv => {
      if (!isFailing(fault, 'throw', argv)) return
      fault.isArmed = false
      throw new Error(`host lost ${argv.join(' ')}`)
    },
    failRun: argv => {
      if (!isFailing(fault, 'exit', argv)) return undefined
      fault.exits = (fault.exits ?? 0) + 1
      fault.isArmed = fault.exits < 2
      return { exitCode: 1, stderr: 'disk full' }
    } })
  seedDelegation(world, 'coord', [2])
  await declareFlow($, 'small-feature', [2])
  return world
}

/**
 * Tells whether an argv runs a git subcommand.
 * @param argv - The host call.
 * @param words - The subcommand's words.
 * @returns Whether every word follows git.
 */
const isGit = (argv: string[], ...words: string[]): boolean => {
  const at = argv.indexOf('git')
  return at >= 0 && words.every(word => argv.slice(at + 1).includes(word))
}

/**
 * Tells whether a host call moves a record into the delegated-commit records.
 * @param argv - The host call.
 * @returns Whether it does.
 */
const isDelegatedRecordWrite = (argv: string[]): boolean => argv[0] === 'mv' && (argv.at(-1) ?? '').includes('/delegated/')

// contract: a commit whose branch read fails before git commit runs is refused, naming the failed read: nothing changed
test('commit answers refused when it throws before any change', async ($, on) => {
  const live = childCheckout()
  const fault: Fault = { isArmed: false, matches: argv => isGit(argv, 'symbolic-ref'), kind: 'throw' }
  await arrangeUnit($, on, live, fault)
  live.worktrees!['/repo']!.staged = { 'src/a.ts': 'next' }
  fault.isArmed = true
  const outcome = await callModTool($, 'commit', { message: 'feat: next' })
  expect(outcome.isError).toBe(true)
  expect(outcome.text).toContain('commit refused: git could not read which branch this worktree has checked out')
  expect(live.graph?.refs.a).toBe('a2')
})

// contract: a commit that fails once git commit made the commit answers stopped, naming the commit made and the record not written
test('commit answers stopped when it throws after the commit is made', async ($, on) => {
  const live = childCheckout()
  const fault: Fault = { isArmed: false, matches: argv => isGit(argv, 'rev-parse', 'HEAD') && live.graph?.refs.a !== 'a2', kind: 'throw' }
  await arrangeUnit($, on, live, fault)
  live.worktrees!['/repo']!.staged = { 'src/a.ts': 'next' }
  fault.isArmed = true
  const outcome = await callModTool($, 'commit', { message: 'feat: next' })
  expect(outcome.isError).toBe(true)
  expect(outcome.text).toContain('commit stopped: ')
  expect(outcome.text).toContain('a commit was made on a')
  expect(outcome.text).not.toContain('refused')
  expect(live.graph?.refs.a).not.toBe('a2')
})

// contract: a commit that throws while it writes its delegated record answers in the mod's words that it did not finish, naming git log -1 to check
test('commit answers unknown when it throws during its record write', async ($, on) => {
  const live = childCheckout()
  const fault: Fault = { isArmed: false, matches: isDelegatedRecordWrite, kind: 'exit' }
  await arrangeUnit($, on, live, fault)
  live.worktrees!['/repo']!.staged = { 'src/a.ts': 'next' }
  fault.isArmed = true
  const outcome = await callModTool($, 'commit', { message: 'feat: next' })
  expect(outcome.text).toContain('[working-agreement] commit did not finish (disk full)')
  expect(outcome.text).toContain('git log -1')
  expect(outcome.text).not.toContain('may still be running')
  expect(outcome.isError).toBe(true)
})

// contract: merge_parent that throws while it writes its delegated record answers in the mod's words that it did not finish, never the engine's text
test('merge_parent answers unknown when it throws during its record write', async ($, on) => {
  const live = childCheckout(advancePar)
  const fault: Fault = { isArmed: false, matches: isDelegatedRecordWrite, kind: 'exit' }
  await arrangeUnit($, on, live, fault)
  fault.isArmed = true
  const outcome = await callModTool($, 'merge_parent', {})
  expect(outcome.text).toContain('[working-agreement] merge_parent did not finish (disk full)')
  expect(outcome.text).toContain('git log -1')
  expect(outcome.text).not.toContain('may still be running')
  expect(outcome.isError).toBe(true)
})

// contract: /flow that throws answers in the mod's words that it did not finish, never the engine's text
test('/flow answers unknown when its command throws', async ($, on) => {
  const live = childCheckout()
  const fault: Fault = { isArmed: false, matches: argv => argv.includes('git'), kind: 'throw' }
  await arrangeUnit($, on, live, fault)
  fault.isArmed = true
  const outcome = await runFlowCommand($, 'status')
  expect(outcome.text).toContain('/flow status did not finish (')
  expect(outcome.text).not.toContain('may still be running')
})
