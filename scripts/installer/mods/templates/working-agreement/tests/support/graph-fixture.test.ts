import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

import { test } from './kit'
import { readContentTree } from '../../hooks/lib/git'
import { conformanceCheckout, gitCheckArgs, gitChecks, treeChecks } from './graph-fixture'
import { createTestPort, createWorld, gitAnswerNames, root } from './world'

/** What the world's process hook answers a git command with. */
interface Answer { exitCode: number; stdout: string }

/**
 * Selects the repository root for the mod's diff form.
 * @param command - Fixture command.
 * @returns Process arguments.
 */
const toArgv = (command: string): string[] => ['git', ...(command.startsWith('diff ') ? ['-C', root] : []), ...gitCheckArgs(command)]

/**
 * Runs fixture commands through the shared world process boundary.
 * @param on - Hook registrar.
 * @param dirty - Main checkout overlay.
 * @param staged - Main checkout index overlay.
 * @returns A runner through the shared world.
 */
function arrangeGraphWorld(on: On, dirty?: Record<string, string>, staged?: Record<string, string>): (argv: string[], stdin?: string) => Promise<Answer> {
  const world = createWorld(on, { ...conformanceCheckout, dirty,
    worktrees: { ...conformanceCheckout.worktrees, [root]: { branch: 'main', dirty, staged } } })
  const port = createTestPort(world)
  return (argv, stdin) => port.processes.run(argv, { stdin, timeoutMs: 5000 })
}

for (const { command, exitCode, stdout, stdin, dirty, staged, label } of gitChecks) {
  test(`the world's commit graph answers git ${command} as git does${label ? ` (${label})` : ''}`, async (_$, on) => {
    const answer = await arrangeGraphWorld(on, dirty, staged)(toArgv(command), stdin)
    expect(answer.exitCode).toBe(exitCode)
    if (exitCode === 0) expect(answer.stdout.trim()).toBe(stdout)
  })
}

test('every git answer entry has a real-git fixture row', async (_$, on) => {
  const world = createWorld(on, conformanceCheckout)
  const port = createTestPort(world)
  for (const check of gitChecks) await port.processes.run(toArgv(check.command), { stdin: check.stdin, timeoutMs: 5000 })
  expect(gitAnswerNames.filter(name => !world.answeredEntries.has(name))).toEqual([])
  await expect(port.processes.run(['git', 'unmodelled-command'], { timeoutMs: 5000 })).rejects.toThrow('Unmodelled git command')
})

for (const { commits: [a, b], isSame, dirty } of treeChecks) {
  test(`the world's commit graph gives ${a} and ${b} ${isSame ? 'the same tree' : 'different trees'}, as git does`, async (_$, on) => {
    const run = arrangeGraphWorld(on, dirty)
    const processes = { run: async (argv: string[]) => ({ ...await run(argv), stderr: '' }) }
    const tree = async (revision: string) => revision === 'WORKTREE'
      ? readContentTree(processes, root, '/repo.git/working-agreement/.index-check')
      : (await run(['git', 'rev-parse', `${revision}^{tree}`])).stdout
    const [first, second] = [await tree(a), await tree(b)]
    expect(first === second).toBe(isSame)
  })
}

test('generated linear graphs remember branch tips and use the registered answers', async (_$, on) => {
  const checkout = { branch: 'first', ahead: 2 }
  const world = createWorld(on, checkout)
  const port = createTestPort(world)
  const run = (command: string) => port.processes.run(['git', ...gitCheckArgs(command)], { timeoutMs: 5000 })
  expect((await run('rev-parse HEAD')).stdout).toBe('c2')
  checkout.branch = 'second'
  checkout.ahead = 1
  expect((await run('rev-parse HEAD')).stdout).toBe('c1')
  expect((await run('rev-parse --verify --quiet first')).stdout).toBe('c2')
  expect((await run('rev-parse --verify --quiet origin/main')).stdout).toBe('c0')
  expect((await run('rev-list --count c0..c2')).stdout).toBe('2')
})

test('linear tree aliases and retained commits survive a branch reset', async (_$, on) => {
  const checkout = { branch: 'feat', ahead: 3, isDirty: false }
  const world = createWorld(on, checkout)
  const port = createTestPort(world)
  const run = (command: string) => port.processes.run(['git', ...gitCheckArgs(command)], { timeoutMs: 5000 })
  expect((await run('rev-parse HEAD^{tree}')).stdout).toBe('tree')
  checkout.isDirty = true
  expect((await run('write-tree')).stdout).toBe('tree')
  expect((await run('status --porcelain=v2 -z --untracked-files=all')).stdout.length > 0).toBe(true)
  checkout.ahead = 1
  expect((await run('rev-parse --verify --quiet c3')).stdout).toBe('c3')
  expect((await run('rev-list --count c1..c3')).stdout).toBe('2')
  checkout.branch = 'main'
  checkout.ahead = 0
  checkout.isDirty = false
  expect((await run('write-tree')).stdout).toBe('base-tree')
})
