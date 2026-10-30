import type { SessionContextBreakdown, SessionContextUsage } from 'claude-code'
import { isLongSession } from '../../hooks/features/handoff'
import { diagnosed, diagnosisComment, pushedCloseOut } from '../support/builders'
import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { endTurn, readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand } from '../support/helpers'
import { createWorld, root } from '../support/world'
import type { Gate, Options } from '../support/world'


test('a handoff whose /handoff turn leaves one document clears and continues from it in a new session', async ($, on) => {
  const { commands, prompts, clock } = createWorld(on, { branch: 'feat', isDirty: true })
  await runFlowCommand($, 'handoff')
  await clock.settle()
  await $.prompt.submit({ text: '/handoff', wait: false, origin: { kind: 'plugin', name: 'working-agreement' } })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  await endTurn($)
  await clock.settle()
  expect(commands).toEqual(['handoff', 'clear'])
  expect(prompts.join('\n')).toContain('Continue from the handoff document at /tmp/handoff.md')
})

test('a handoff cancelled with /flow handoff cancel runs no /clear', async ($, on) => {
  const { commands, clock } = createWorld(on, { branch: 'feat' }, {})
  await runFlowCommand($, 'handoff')
  await clock.settle()
  expect((await runFlowCommand($, 'handoff cancel')).text).toContain('Handoff reset')
  await $.prompt.submit({ text: '/handoff', wait: false, origin: { kind: 'plugin', name: 'working-agreement' } })
  await endTurn($)
  await clock.settle()
  expect(commands).toEqual(['handoff'])
})

// The handoff reads the checkout before it records itself; an issue sync landing meanwhile must survive that write.
test('labels an issue sync stores while a handoff starts survive the handoff\'s own write', async ($, on) => {
  const options: Options = { issueLabels: { 1: ['ready-for-agent'] } }
  const { clock } = createWorld(on, { branch: 'feat', isDirty: true }, options)
  const release: Gate = {}
  options.statusGate = new Promise<void>(resolve => { release.open = resolve })
  const starting = runFlowCommand($, 'handoff')
  await clock.settle()
  options.issueLabels = { 1: ['ready-for-agent', 'bug'] }
  await clock.advance(61000)
  await readPromptContext($)
  release.open?.()
  await starting
  expect(await readFlowStatus($)).toContain('bug')
})

test('handoff continues the previous identity and its mirror evidence in the new chat without copying it', async ($, on) => {
  // This probe precedes the world, whose command handler ends the chain.
  on('command.run', { command: 'clear' }, (_$, event, next) => { chat.id = 'next'; return next(event) })
  const { chat, clock, sessions } = createWorld(on, { branch: 'feature' }, {
    session: { flow: 'fix' }, unit: { skills: ['diagnosing-bugs'], ...diagnosed }, issueLabels: { 1: ['ready-for-agent'] }, comments: { 1: [diagnosisComment] },
  })
  await runFlowCommand($, 'handoff')
  await clock.settle()
  await $.prompt.submit({ text: '/handoff', wait: false, origin: { kind: 'plugin', name: 'working-agreement' } })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  await endTurn($)
  await clock.settle()
  expect(sessions.get('next')?.unit).toEqual({ branch: 'feature', issues: [1] })
  expect(sessions.get('next')?.sessionId).toBe('next')
  expect(sessions.get('next')?.units).toEqual([])
  expect(await readFlowStatus($)).toContain('Fix')
  expect(await readCurrentStep($)).toBe('Code')
})

for (const failure of ['carry-over', 'prompt'] as const) {
  test(`handoff ${failure} failure after clear is visible in the new session pane and status`, async ($, on) => {
    const fault = { isPending: false }
    on('command.run', { command: 'clear' }, (_$, event, next) => {
      chat.id = 'next'
      fault.isPending = failure === 'carry-over'
      return next(event)
    })
    const { chat, clock, sessions, views, commands, prompts } = createWorld(on, { branch: 'feature' }, {
      beforeSessionId: () => {
        if (fault.isPending) { fault.isPending = false; throw new Error('carry-over failed') }
      },
      beforePromptSubmit: text => {
        if (failure === 'prompt' && text.startsWith('Continue from the handoff')) throw new Error('prompt failed')
      },
    })
    await runFlowCommand($, 'handoff')
    await clock.settle()
    await $.prompt.submit({ text: '/handoff', wait: false, origin: { kind: 'plugin', name: 'working-agreement' } })
    await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
    await endTurn($)
    await clock.settle()
    expect(commands).toEqual(['handoff', 'clear'])
    expect(prompts.some(text => text.startsWith('Continue from the handoff'))).toBe(false)
    const handoff = sessions.get('next')?.handoff
    expect(handoff?.state).toBe('failed')
    const reason = handoff?.state === 'failed' ? handoff.reason : ''
    expect(reason.length).toBeGreaterThan(0)
    expect(views.at(-1)?.notes.find(note => note.key === 'Handoff')?.value).toContain(`not completed — ${reason}`)
    expect(await readFlowStatus($)).toContain(`Handoff    handoff not completed · ${reason}`)
  })
}

function context(window: number, tokens: number | undefined, totalTokens: number, free: number, threshold?: number): SessionContextUsage {
  const breakdown: SessionContextBreakdown = {
    categories: [{ kind: 'free', name: 'arbitrary label', tokens: free, color: 'inactive', isDeferred: false }],
    totalTokens, maxTokens: window, rawMaxTokens: window, autocompactSource: 'auto', percentage: 0,
    gridRows: [], model: 'test', memoryFiles: [], mcpTools: [], agents: [],
    autoCompactThreshold: threshold, isAutoCompactEnabled: threshold !== undefined, apiUsage: null,
  }
  return { window, tokens, breakdown }
}

for (const [name, usage, expected] of [
  ['200k room boundary without buffer', context(200000, 100000, 142000, 58000, 167000), true],
  ['200k one token above room boundary', context(200000, 100000, 141999, 58001, 167000), false],
  ['200k absent API tokens still uses room', context(200000, undefined, 142000, 58000, 167000), true],
  ['200k past compaction threshold', context(200000, 100000, 168000, 32000, 167000), true],
  ['1M used token boundary', context(1000000, 150000, 150000, 817000, 967000), true],
  ['1M below used token boundary', context(1000000, 149999, 149999, 817001, 967000), false],
  ['auto-compact off free boundary', context(200000, 100000, 100000, 25000), true],
  ['auto-compact off above free boundary', context(200000, 100000, 100000, 25001), false],
  ['no breakdown used boundary', { window: 200000, tokens: 150000 }, true],
  ['no breakdown below used boundary', { window: 200000, tokens: 149999 }, false],
  ['no breakdown absent tokens', { window: 200000 }, false],
] as [string, SessionContextUsage, boolean][]) {
  test(`session length: ${name}`, () => { expect(isLongSession(usage, 150000)).toBe(expected) })
}

test('the configured used-token threshold remains effective', () => {
  expect(isLongSession({ window: 1000000, tokens: 49999 }, 50000)).toBe(false)
  expect(isLongSession({ window: 1000000, tokens: 50000 }, 50000)).toBe(true)
})

test('session start applies a lowered handoff threshold before any turn completes', { options: { handoffTokens: 50000 } }, async ($, on) => {
  createWorld(on, { branch: 'feature' }, { contextUsage: () => ({ window: 200000, tokens: 50001 }) })

  await $.session.start({ cwd: root, surface: null, isInteractive: false })

  expect(await readFlowStatus($)).toContain('Continue in new session: /flow handoff')
})

test('summary context room marks the session long and offers continuation', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feature' }, {
    contextUsage: args => {
      expect(args.breakdown).toBe('summary')
      return context(200000, 100000, 142000, 58000, 167000)
    },
  })
  await endTurn($)
  await clock.settle()
  expect(await readFlowStatus($)).toContain('Continue in new session: /flow handoff')
})

for (const issues of [[], [1], [1, 2]]) {
  test(`handoff brief continues ${issues.length ? 'the finished unit' : 'work without a flow'} (${issues.length} issues)`, async ($, on) => {
    const briefs: string[] = []
    on('command.run', { command: 'handoff' }, (_$, event, next) => { briefs.push(event.args); return next(event) })
    const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: { ...pushedCloseOut.session, flow: issues.length ? 'close-out' : null, issues } })
    await runFlowCommand($, 'handoff')
    await clock.settle()
    expect(briefs.join('\n')).toContain(issues.length ? 'The next session continues this unit.' : 'The next session continues this work.')
    expect(briefs.join('\n')).not.toContain('follow-up on')
  })
}
