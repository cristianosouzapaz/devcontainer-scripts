import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { conformanceGraph, gitChecks, treeChecks } from './graph-fixture'
import { createWorld, root } from './world'

/** What the world's process hook answers a git command with. */
interface Answer { exitCode: number; stdout: string }

// The mod runs its diffs in the repository root through `-C`, which is the form the world answers them in.
const toArgv = (command: string): string[] => ['git', ...(command.startsWith('diff ') ? ['-C', root] : []), ...command.split(' ')]

// Builds a world on the fixture's graph and returns a runner of git commands through its process hook, which the test
// engine does not raise itself.
function arrangeGraphWorld($: Engine, on: On): (argv: string[]) => Promise<Answer> {
  const hooks: Record<string, unknown> = {}
  const capturing = ((event: string, handler: unknown) => {
    hooks[event] = handler
    return (on as (event: string, handler: unknown) => unknown)(event, handler)
  }) as On
  createWorld(capturing, { branch: 'main', graph: conformanceGraph })
  const run = hooks['process.run'] as ($: Engine, e: { argv: string[] }) => { value: Answer } | Promise<{ value: Answer }>
  return async argv => (await run($, { argv })).value
}

for (const { command, exitCode, stdout } of gitChecks) {
  test(`the world's commit graph answers git ${command} as git does`, async ($, on) => {
    const answer = await arrangeGraphWorld($, on)(toArgv(command))
    expect(answer.exitCode).toBe(exitCode)
    if (exitCode === 0) expect(answer.stdout.trim()).toBe(stdout)
  })
}

for (const { commits: [a, b], isSame } of treeChecks) {
  test(`the world's commit graph gives ${a} and ${b} ${isSame ? 'the same tree' : 'different trees'}, as git does`, async ($, on) => {
    const run = arrangeGraphWorld($, on)
    const [first, second] = [await run(['git', 'rev-parse', `${a}^{tree}`]), await run(['git', 'rev-parse', `${b}^{tree}`])]
    expect(first.stdout === second.stdout).toBe(isSame)
  })
}
