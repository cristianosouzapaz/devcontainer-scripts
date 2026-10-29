import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { buildWriteCall, coordinator, noFlow } from '../support/builders'
import { declareFlow, inside, readFlowStatus, readPromptContext, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { createWorld } from '../support/world'
import type { Options } from '../support/world'

const loops = [undefined, 'sub'] as const

/**
 * Builds a world whose permission check, beneath the mod, allows every call and every spawn starts.
 * @param on - The test's hook registration.
 * @param options - The world's options.
 * @returns The world.
 */
function createAllowingWorld(on: On, options: Options = { session: coordinator }): ReturnType<typeof createWorld> {
  const world = createWorld(on, { branch: 'feat' }, options)
  on('tool.check', () => ({ decision: 'allow' }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'spawned' }))
  return world
}

/**
 * Runs a tool call in a loop and returns what the model reads of its outcome.
 * @param $ - The test's engine.
 * @param call - The tool and its arguments.
 * @param agentId - The subagent's loop, or undefined for the main loop.
 * @returns The deny reason or the error text, empty for a call that ran.
 */
async function readRefusal($: Engine, call: object, agentId: string | undefined): Promise<string> {
  const result = await $.tool.call({ ...call, ...(agentId ? { agentId } : {}) } as never)
  return result.deny ?? (result.isError ? result.text : '') ?? ''
}

/**
 * Raises a spawn of a subagent or teammate from the main loop.
 * @param $ - The test's engine.
 * @param isTeammate - Whether the spawn starts a teammate.
 * @returns What the spawn chain settled on.
 */
const spawn = ($: Engine, isTeammate: boolean) => $.agent.spawn({
  tool_use_id: 'call', prompt: 'look', description: 'look', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'sonnet', background: true, fork: false, ...(isTeammate ? { isTeammate: true } : {}),
} as never)

test('/flow coordinate records the role and every surface shows it', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow, herdrEnv: inside })
  expect((await runFlowCommand($, 'coordinate')).text).toContain('Coordinator')
  expect(world.views.at(-1)?.flow).toContain('Coordinator')
  expect(world.herdrCalls.at(-1)?.argv).toContain('flow_unit=Coordinator')
  expect(await readFlowStatus($)).toContain('Coordinator')
  expect(await readPromptContext($)).toContain('This session is the coordinator')
})

test('/flow coordinate is refused from a non-composer origin and on a session with a flow', async ($, on) => {
  createAllowingWorld(on, { session: noFlow })
  expect((await runFlowCommand($, 'coordinate', { kind: 'plugin', name: 'working-agreement' })).text).toContain("user's to run")
  expect(await readRefusal($, buildWriteCall('/tmp/notes.md'), undefined)).toBe('')
  await declareFlow($, 'fix', [3])
  expect((await runFlowCommand($, 'coordinate')).text).toContain('declared flow')
})

test('asking for a manager pre-fills /flow coordinate without setting the role', async ($, on) => {
  const world = createAllowingWorld(on, { session: noFlow })
  const result = await $.tool.call({ tool: 'mcp__working-agreement__suggest_coordinate' } as never)
  expect(String(result.result)).toContain('/flow coordinate')
  expect(world.suggestions).toContain('/flow coordinate')
  expect(await readRefusal($, buildWriteCall('/tmp/notes.md'), undefined)).toBe('')
})

for (const agentId of loops) {
  for (const [name, call] of [
    ['a file write', buildWriteCall('/tmp/notes.md')],
    ['a Bash redirection', { tool: 'Bash', command: 'gh issue view 1 > notes.md' }],
    ['a heredoc', { tool: 'Bash', command: 'cat <<EOF\nx\nEOF' }],
    ['python -c', { tool: 'Bash', command: 'python -c "open(\'f\', \'w\')"' }],
    ['an MCP call', { tool: 'mcp__github__create_issue', title: 'x' }],
    ['a Bash herdr prompt, which goes through unit_prompt', { tool: 'Bash', command: 'herdr agent prompt issue-1 "take A"' }],
    ['the mod\'s Verify', { tool: 'mcp__working-agreement__verify' }],
    ['the mod\'s Run', { tool: 'mcp__working-agreement__run', argv: ['true'] }],
    ['a flow declaration', { tool: 'mcp__working-agreement__declare_flow', flow: 'fix', issues: [3] }],
    ['worktree creation', { tool: 'EnterWorktree', name: 'x' }],
    ['a worktree-isolated agent', { tool: 'Agent', description: 'x', prompt: 'x', isolation: 'worktree' }],
    ['a remote agent', { tool: 'Agent', description: 'x', prompt: 'x', isolation: 'remote' }],
    ['a workflow', { tool: 'Workflow', script: 'x' }],
  ] as const) {
    test(`a coordinator denies ${name} (${agentId ?? 'main'})`, async ($, on) => {
      createAllowingWorld(on)
      expect(await readRefusal($, call, agentId)).toContain('unit session')
    })
  }

  for (const [name, call] of [
    ['an allowlisted gh read', { tool: 'Bash', command: 'gh issue view 445 --comments' }],
    ['an allowlisted herdr read', { tool: 'Bash', command: 'herdr agent list' }],
    ['a plain subagent', { tool: 'Agent', description: 'x', prompt: 'x' }],
  ] as const) {
    test(`a coordinator allows ${name} (${agentId ?? 'main'})`, async ($, on) => {
      createAllowingWorld(on)
      expect(await readRefusal($, call, agentId)).toBe('')
    })
  }
}

test('a coordinator permission check allows a read-only call and denies any other', async ($, on) => {
  createAllowingWorld(on)
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '/repo/a' }, isReadOnly: true } as never)).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '/repo/a' } })).decision).toBe('deny')
})

test('a coordinator refuses a teammate and starts a subagent', async ($, on) => {
  createAllowingWorld(on)
  expect((await spawn($, true)).deny).toContain('unit session')
  expect((await spawn($, false)).deny).toBeUndefined()
})

test('a session without the role allows what the coordinator denies', async ($, on) => {
  createAllowingWorld(on, { session: noFlow })
  expect(await readRefusal($, { tool: 'Bash', command: 'python -c "print(1)" > out' }, 'sub')).toBe('')
  expect((await spawn($, true)).deny).toBeUndefined()
})

test('an unreadable role denies the call', async ($, on) => {
  createAllowingWorld(on, { isStateAbsent: true, beforeSessionId: () => { throw new Error('unreadable') } })
  expect((await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })).decision).toBe('deny')
})
