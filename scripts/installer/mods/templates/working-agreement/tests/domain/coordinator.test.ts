import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { allowedCommands } from '../../hooks/domain/coordinator'
import { buildWriteCall, coordinator, noFlow, trivialFlow } from '../support/builders'
import { declareFlow, inside, readFlowStatus, readPromptContext, runFlowCommand, startSession } from '../support/helpers'
import { test } from '../support/kit'
import { createWorld } from '../support/world'
import type { Options } from '../support/world'
import { tickMs } from '../../hooks/core/timing'

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

// contract: (pin, not a red: its change only lets the ticks pass that deliver fixed prompts one idle window at a time) /flow coordinate submits the same fixed prompt each time, with free text appended verbatim
test('/flow coordinate submits a fixed prompt that starts nothing, with the free text appended verbatim', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow, herdrEnv: inside })
  await startSession($)
  await runFlowCommand($, 'coordinate')
  await runFlowCommand($, 'coordinate')
  await runFlowCommand($, 'coordinate  focus on #12\n  first')
  // why: each fixed prompt waits for the idle window the one before it claimed, so the ticks after it deliver the rest in order.
  await world.clock.advance(3 * tickMs)
  await world.clock.settle()
  expect(world.prompts).toHaveLength(3)
  expect(world.prompts[0]).toBe(world.prompts[1] ?? '')
  expect(world.prompts[0]).toContain('Start nothing: spawn no unit')
  expect(world.prompts[0]).not.toContain("User's instructions:")
  expect(world.prompts[2]).toBe(`${world.prompts[0]}\n\nUser's instructions:\nfocus on #12\n  first`)
})

test('a refused /flow coordinate submits no prompt', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: trivialFlow() })
  await startSession($)
  await runFlowCommand($, 'coordinate')
  await world.clock.settle()
  expect(world.prompts).toEqual([])
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
    ['a subagent\'s handback', { tool: 'SubagentHandback', message: 'x' }],
    ['a ShellCheck read', { tool: 'Bash', command: 'shellcheck -x -f diff public/scripts/setup/lib/logging.sh' }],
  ] as const) {
    test(`a coordinator allows ${name} (${agentId ?? 'main'})`, async ($, on) => {
      createAllowingWorld(on)
      expect(await readRefusal($, call, agentId)).toBe('')
    })
  }
}

test('a coordinator denies a compound read as unrecognized and suggests running each part on its own', async ($, on) => {
  createAllowingWorld(on)
  const refusal = await readRefusal($, { tool: 'Bash', command: 'gh issue view 445 --comments | head -20; herdr agent list' }, undefined)
  expect(refusal).toContain('not recognized as read-only')
  expect(refusal).toContain('each part')
  expect(refusal).not.toContain('never writes')
})

// contract: a simple Bash command off the coordinator's read allowlist is refused as unrecognized, naming the allowlist and the read tools, not as a write
test('a coordinator refuses a simple off-list read as unrecognized, names the allowlist and the alternatives, and does not call it a write', async ($, on) => {
  createAllowingWorld(on)
  const refusal = await readRefusal($, { tool: 'Bash', command: 'grep -n x /root/.claude/projects/-repo/session.jsonl' }, undefined)
  expect(refusal).toContain('not on the coordinator\'s read allowlist')
  for (const argv of allowedCommands) expect(refusal).toContain(`\`${argv.join(' ')}\``)
  expect(refusal).toContain('Read, Grep or Glob tools or a read-only subagent, which the mod does not refuse')
  expect(refusal).not.toContain('never writes')
})

// contract: each alternative the off-list refusal names reads a path outside the repository in a coordinator session
test('a coordinator may start a read-only subagent and Read, Grep or Glob a path outside the repository', async ($, on) => {
  createAllowingWorld(on)
  expect(await readRefusal($, { tool: 'Agent', description: 'x', prompt: 'x', subagent_type: 'Explore' }, undefined)).toBe('')
  // why: a test's $.tool.call carries no isReadOnly, which the engine sets from the tool's own word, so the read is asked as the engine asks it.
  for (const [tool, input] of [
    ['Read', { file_path: '/root/.claude/projects/-repo/session.jsonl' }],
    ['Grep', { pattern: 'x', path: '/root/.claude/projects/-repo' }],
    ['Glob', { pattern: '*.jsonl', path: '/root/.claude/projects/-repo' }],
  ] as const) {
    expect((await $.tool.check({ tool, input, isReadOnly: true } as never)).decision).toBe('allow')
  }
})

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

// contract: /flow coordinate refuses in a linked worktree, where herdr cannot create the unit worktrees, and records no role
test('/flow coordinate refuses in a linked worktree, names the main checkout and records no role', async ($, on) => {
  createWorld(on, { branch: 'feat', main: '/main', worktrees: { '/repo': { branch: 'feat' }, '/main': { branch: 'main' } } }, { session: noFlow, herdrEnv: inside })
  const text = (await runFlowCommand($, 'coordinate')).text
  expect(text).toContain('linked worktree')
  expect(text).toContain('/main')
  expect(await readFlowStatus($)).not.toContain('Coordinator')
})
