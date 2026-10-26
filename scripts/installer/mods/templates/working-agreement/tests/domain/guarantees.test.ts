import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { handleGuarantees } from '../../hooks/handlers/guarantees'
import { describeViolation } from '../../hooks/core/guarantees'
import { parseSession } from '../../hooks/domain/records'
import { mountPane, endTurn, readFlowStatus } from '../support/helpers'
import { buildPullRequest } from '../support/builders'
import { common, createTestPort, createWorld } from '../support/world'
import type { Checkout, Gate, Graph, Options } from '../support/world'

interface EntryGate extends Gate { entered: number }

const graph = (): Graph => ({ commits: { a: { parents: [], files: {} } }, refs: { main: 'a', feature: 'a', 'origin/main': 'a' } })
/**
 * Adds a changed commit without altering the input graph.
 * @param git - The history before the commit.
 * @returns The history with the feature ref advanced.
 */
const commit = (git: Graph): Graph => ({ ...git, commits: { ...git.commits, b: { parents: ['a'], files: { file: 'changed' } } }, refs: { ...git.refs, feature: 'b' } })

// Direct dispatch is reserved for pinned subagent ids and a throwing run: tool.call drops supplied ids, and the engine skips a throwing boundary hook.

for (const agentId of [undefined, 'child']) {
  test(`a new commit records the call and loop and tells that loop (${agentId ?? 'main'})`, async ($, on) => {
    const git = graph()
    const checkout: Checkout = { branch: 'feature', graph: git }
    const toolUseIds: string[] = []
    if (!agentId) on('tool.call', { tool: 'Bash' }, (_$, event) => {
      toolUseIds.push(event.tool_use_id)
      checkout.graph = commit(checkout.graph!)
      return { result: 'written', context: ['existing context'] }
    })
    const world = createWorld(on, checkout)
    const { sessions, views } = world
    const result = agentId ? await handleGuarantees(createTestPort(world),
      { tool: 'Bash', command: 'opaque', tool_use_id: 'call', agentId }, async () => {
        checkout.graph = commit(checkout.graph!)
        return { result: 'written', context: ['existing context'] }
      }) : await $.tool.call({ tool: 'Bash', command: 'opaque' })
    const record = sessions.get('sid')?.violations?.[0]
    expect(record?.kind).toBe('commit')
    expect(record?.fact).toEqual({ shas: ['b'] })
    expect(record?.toolUseIds).toEqual(agentId ? ['call'] : toolUseIds)
    expect(record?.agentIds).toEqual(agentId ? [agentId] : [])
    expect(result.context?.[0]).toBe('existing context')
    expect(result.context?.[1]).toContain("a commit appeared during your call (it may be the user's): stop and tell the user")
    expect(views.at(-1)?.violations?.[0]?.tone).toBe('error')
    expect(views.at(-1)?.violations?.[0]?.text).toBe('A commit appeared during an agent call (it may be yours)')
    expect(parseSession(sessions.get('sid'))).not.toBe(null)
    // The direct-dispatch port's record never reaches the engine store, so only the dispatched call continues there.
    if (agentId) return
    expect((await readFlowStatus($))?.split('\n').find(line => line.startsWith('Violation'))).toContain('✗ A commit appeared during an agent call (it may be yours) · ')
    expect((await $.tool.call({ tool: 'Bash', command: 'later' })).deny).toBeUndefined()
    expect(sessions.get('sid')?.violations).toHaveLength(1)
  })
}

for (const tool of ['mcp__unknown__write', 'FutureTool', 'Skill']) {
  test(`the window covers ${tool} without inspecting arguments`, async ($, on) => {
    const git = graph()
    const checkout: Checkout = { branch: 'feature', graph: git }
    const { sessions } = createWorld(on, checkout, { afterTool: () => checkout.graph = commit(checkout.graph!) })
    const result = await $.tool.call({ tool, ...(tool === 'Skill' ? { skill: 'unrelated' } : {}) } as never)
    expect(result.context?.join('')).toContain('a commit appeared')
    expect(sessions.get('sid')?.violations?.[0]?.kind).toBe('commit')
  })
}

for (const tool of [
  'Read', 'Grep', 'Glob', 'LS', 'LSP', 'WebFetch', 'WebSearch', 'AskUserQuestion', 'TodoWrite', 'ToolSearch', 'TaskOutput',
  'ExitPlanMode', 'EnterPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool',
]) {
  test(`${tool} is excluded from guarantee windows`, async ($, on) => {
    const git = graph()
    const checkout: Checkout = { branch: 'feature', graph: git }
    const { sessions } = createWorld(on, checkout, { afterTool: () => checkout.graph = commit(checkout.graph!) })
    const result = await $.tool.call({ tool } as never)
    expect(result.result).toBe('written')
    expect(sessions.get('sid')?.violations).toBeUndefined()
    expect(result.context ?? []).toEqual([])
  })
}

for (const change of ['branch', 'reset', 'delete', 'switch', 'stash', 'notes', 'fetch', 'fast-forward']) {
  test(`${change} does not invent a new commit or push`, async ($, on) => {
    const git = graph()
    const checkout: Checkout = { branch: 'feature', graph: git }
    checkout.graph!.commits.b = { parents: ['a'], files: {} }
    checkout.graph!.refs['refs/tags/existing'] = 'b'
    if (change === 'fetch' || change === 'fast-forward') checkout.graph!.refs['origin/feature'] = 'b'
    else checkout.graph!.refs.other = 'b'
    const { sessions } = createWorld(on, checkout, { afterTool: () => {
      if (change === 'branch') checkout.graph!.refs.another = 'b'
      if (change === 'reset') checkout.graph!.refs.feature = 'b'
      if (change === 'delete') delete checkout.graph!.refs.other
      if (change === 'switch') checkout.branch = 'other'
      if (change === 'stash' || change === 'notes') { checkout.graph!.commits.c = { parents: ['b'], files: {} }; checkout.graph!.refs[`refs/${change}`] = 'c' }
      if (change === 'fetch') { checkout.graph!.commits.c = { parents: ['b'], files: {} }; checkout.graph!.refs['origin/feature'] = 'c' }
      if (change === 'fast-forward') { checkout.graph!.refs['origin/feature'] = 'b'; checkout.graph!.refs.feature = 'b' }
    } })
    const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
    expect(result.context ?? []).toEqual([])
    expect(sessions.get('sid')?.violations ?? []).toEqual([])
  })
}

for (const change of ['fast-forward', 'merge']) {
  test(`a pull ${change} excludes the old fetched commit`, async ($, on) => {
    const checkout: Checkout = { branch: 'feature', graph: change === 'merge' ? commit(graph()) : graph() }
    const { sessions, clock } = createWorld(on, checkout, { afterTool: () => {
      checkout.graph!.commits.c = { parents: ['a'], files: {}, committerDate: 0 }
      checkout.graph!.refs['origin/feature'] = 'c'
      if (change === 'merge') checkout.graph!.commits.d = { parents: ['b', 'c'], files: { file: 'changed' } }
      checkout.graph!.refs.feature = change === 'merge' ? 'd' : 'c'
    } })
    await clock.advance(1000)
    await $.tool.call({ tool: 'Bash', command: 'opaque' })
    expect(sessions.get('sid')?.violations?.map(({ kind, fact }) => ({ kind, fact })) ?? []).toEqual(
      change === 'merge' ? [{ kind: 'commit', fact: { shas: ['d'] } }] : [],
    )
  })
}

test('a commit created and pushed in the opening second is still recorded', async ($, on) => {
  const checkout: Checkout = { branch: 'feature', graph: graph() }
  const { sessions } = createWorld(on, checkout, { afterTool: () => {
    checkout.graph = commit(checkout.graph!)
    checkout.graph.refs['origin/feature'] = 'b'
  } })
  await $.tool.call({ tool: 'Bash', command: 'opaque' })
  expect(sessions.get('sid')?.violations?.map(({ kind, fact }) => ({ kind, fact }))).toEqual([
    { kind: 'commit', fact: { shas: ['b'] } },
  ])
})

test('an unreadable fetched-history check leaves the call unchecked', async ($, on) => {
  const checkout: Checkout = { branch: 'feature', graph: graph() }
  const options: Options = { afterTool: () => {
    checkout.graph = commit(checkout.graph!)
    checkout.graph.refs['origin/feature'] = 'b'
    options.failing = 'git rev-list --min-age='
  } }
  const { sessions } = createWorld(on, checkout, options)
  await $.tool.call({ tool: 'Bash', command: 'opaque' })
  expect(sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['unchecked'])
})

test('a moved tracking ref records a push of previously local history', async ($, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'feature', graph: git }
  checkout.graph = commit(checkout.graph!)
  const { sessions, views } = createWorld(on, checkout, { afterTool: () => { checkout.graph!.refs['origin/feature'] = 'b' } })
  const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  expect(sessions.get('sid')?.violations?.map(({ kind, fact }) => ({ kind, fact }))).toEqual([
    { kind: 'push', fact: { ref: 'refs/remotes/origin/feature', before: null, after: 'b' } },
  ])
  expect(result.context?.join('')).toContain("a push appeared on refs/remotes/origin/feature during your call (it may be the user's): stop and tell the user")
  expect(views.at(-1)?.violations?.[0]?.text).toBe('A push appeared on refs/remotes/origin/feature during an agent call (it may be yours)')
})

test('default checkout content is judged independently and names another worktree', async ($, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'feature', graph: git, worktrees: { '/repo': { branch: 'feature' }, '/other': { branch: 'main', dirty: { file: 'before' } } } }
  const { sessions, views } = createWorld(on, checkout, { afterTool: () => { checkout.worktrees!['/other']!.dirty = { file: 'after' } } })
  const result = await $.tool.call({ tool: 'mcp__unknown__write' })
  expect(sessions.get('sid')?.violations?.[0]?.fact).toEqual({ root: '/other', before: 'tree:file=before', after: 'tree:file=after' })
  expect(result.context?.join('')).toContain("in another worktree, during your call (it may be the user's or another session's)")
  expect(views.at(-1)?.violations?.[0]?.text).toBe("The default-branch tree changed at /other, in another worktree, during an agent call (it may be yours or another session's)")
})

test('a commit on a branch in another worktree is attributed conservatively', async ($, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'main', graph: git, worktrees: { '/repo': { branch: 'main' }, '/other': { branch: 'feature' } } }
  const { sessions, views } = createWorld(on, checkout, { afterTool: () => checkout.graph = commit(checkout.graph!) })
  expect((await $.tool.call({ tool: 'mcp__unknown__write' })).context?.join('')).toContain('on feature, checked out in another worktree')
  expect(views.at(-1)?.violations?.[0]?.text).toContain('on feature, checked out in another worktree')
  const record = sessions.get('sid')!.violations!.find(record => record.kind === 'commit')!
  expect(record.checkouts).toEqual([{ root: '/other', branch: 'feature' }])
  expect(parseSession(sessions.get('sid'))).not.toBe(null)
  // The diagnostic retains the observed checkout even after that branch is no longer checked out.
  checkout.worktrees!['/other']!.branch = 'main'
  expect((await readFlowStatus($))?.split('\n').find(line => line.startsWith('Violation'))).toContain('on feature, checked out in another worktree')
  expect(views.at(-1)?.violations?.[0]?.text).toBe("A commit appeared on feature, checked out in another worktree, during an agent call (it may be yours or another session's)")
  expect(describeViolation(record, 'agent', '/other')).not.toContain('another worktree')
  expect(describeViolation(record, 'agent', '/other')).not.toContain("another session's")
})

test('a legacy commit violation remains readable without worktree attribution', async ($, on) => {
  const checkout: Checkout = { branch: 'feature', graph: graph() }
  const { sessions } = createWorld(on, checkout, { afterTool: () => checkout.graph = commit(checkout.graph!) })
  await $.tool.call({ tool: 'Bash', command: 'opaque' })
  const session = sessions.get('sid')!
  const record = session.violations!.find(record => record.kind === 'commit')!
  const { checkouts: _checkouts, ...legacy } = record
  const parsed = parseSession({ ...session, violations: [legacy] })
  expect(parsed).not.toBe(null)
  expect(describeViolation(parsed!.violations![0]!, 'agent', '/other')).toBe("a commit appeared during your call (it may be the user's): stop and tell the user")
})

for (const held of [undefined, [], [{ root: '/first', branch: 'first' }]]) {
  test(`repeated commit observations retain checkout attribution (${held === undefined ? 'legacy' : held.length ? 'recorded' : 'empty'})`, async ($, on) => {
    const checkout: Checkout = { branch: 'feature', graph: graph() }
    const { sessions, views, chat, seedChat } = createWorld(on, checkout, { afterTool: () => checkout.graph = commit(checkout.graph!) })
    await $.tool.call({ tool: 'Bash', command: 'first' })
    const session = sessions.get('sid')!
    const record = session.violations!.find(record => record.kind === 'commit')!
    // A chat resumed from this record, as an earlier version wrote its checkouts.
    chat.id = 'resumed'
    seedChat(chat.id, { ...session, sessionId: chat.id, violations: [{ ...record, sessionId: chat.id, checkouts: held }] })
    checkout.graph = graph()
    const result = await $.tool.call({ tool: 'Bash', command: 'second' })
    const merged = sessions.get(chat.id)?.violations?.find(record => record.kind === 'commit')
    expect(sessions.get(chat.id)?.violations).toHaveLength(1)
    expect(merged?.factId).toBe(record.factId)
    expect(merged?.toolUseIds).toHaveLength(2)
    expect(merged?.checkouts).toEqual(held ?? [{ root: '/repo', branch: 'feature' }])
    expect(result.context?.join('')).toContain(held?.length ? 'on first, checked out in another worktree' : 'a commit appeared during your call')
    expect(views.at(-1)?.violations?.[0]?.text).toContain(held?.length ? 'on first, checked out in another worktree' : 'A commit appeared during an agent call')
  })
}

for (const missing of ['before', 'after']) {
  test(`a missing ${missing} snapshot is visibly unchecked, never told or denied`, async ($, on) => {
    const git = graph()
    const checkout: Checkout = { branch: 'feature', graph: git }
    const options: Options = { failing: missing === 'before' ? 'git for-each-ref' : undefined }
    options.afterTool = () => { options.failing = missing === 'after' ? 'git for-each-ref' : undefined; checkout.graph = commit(checkout.graph!) }
    const { sessions, views } = createWorld(on, checkout, options)
    const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
    expect(result.result).toBe('written')
    expect(result.context ?? []).toEqual([])
    expect(sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['unchecked'])
    expect(views.at(-1)?.violations?.[0]?.tone).toBe('warn')
  })
}

for (const change of [
  { state: 'MERGED', closedAt: '2026-10-19T10:00:00Z' },
  { state: 'CLOSED', closedAt: '2026-10-19T10:00:00Z' },
  { reviews: { totalCount: 1 } },
  { autoMergeRequest: { authorEmail: null, commitBody: null, commitHeadline: null, enabledAt: '2026-10-19T10:00:00Z', enabledBy: { login: 'user' }, mergeMethod: 'MERGE' } },
  { isInMergeQueue: true },
]) {
  test(`fresh GraphQL PR fields detect ${JSON.stringify(change)}`, async ($, on) => {
    const options: Options = { prs: [buildPullRequest()], prFields: { state: 'OPEN', closedAt: null, autoMergeRequest: null, isInMergeQueue: false, reviews: { totalCount: 0 } } }
    options.afterTool = () => { options.prFields = { ...options.prFields, ...change } }
    const { sessions } = createWorld(on, { branch: 'feature', ahead: 1 }, options)
    const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
    expect(sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['pr'])
    expect(result.context?.join('')).toContain('PR #5 changed its protected fields')
    expect(parseSession(sessions.get('sid'))).not.toBe(null)
  })
}

test('a failed fresh GitHub read leaves git verdicts intact and only PR unchecked', async ($, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'feature', graph: git }
  const options: Options = { prs: [buildPullRequest()], afterTool: () => { options.prReadError = true; checkout.graph = commit(checkout.graph!) } }
  const { sessions } = createWorld(on, checkout, options)
  const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  expect(sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['commit', 'unchecked'])
  expect(result.context).toHaveLength(1)
})

for (const call of [
  { tool: 'Edit', file_path: '/repo/file', old_string: 'before', new_string: 'after' },
  { tool: 'Write', file_path: '/repo/file', content: 'after' },
  { tool: 'NotebookEdit', notebook_path: '/repo/file.ipynb', new_source: 'after' },
]) {
  test(`${call.tool} leaves the PR check untouched even when GitHub cannot be read`, async ($, on) => {
    const git = graph()
    const checkout: Checkout = { branch: 'feature', graph: git }
    const { sessions } = createWorld(on, checkout, { prs: [buildPullRequest()], prReadError: true, afterTool: () => checkout.graph = commit(checkout.graph!) })
    const result = await $.tool.call(call as never)
    expect(result.deny).toBeUndefined()
    expect(result.context?.join('')).toContain('a commit appeared')
    expect(sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['commit'])
    expect(sessions.get('sid')?.prSnapshot).toBeUndefined()
  })
}

for (const tool of ['Bash', 'mcp__unknown__write', 'Task', 'Agent', 'Skill', 'FutureTool']) {
  test(`${tool} marks the PR check unchecked when GitHub cannot be read`, async ($, on) => {
    const world = createWorld(on, { branch: 'feature' }, { prs: [buildPullRequest()], prReadError: true })
    const result = await $.tool.call({ tool, command: 'opaque' } as never)
    expect(result.context ?? []).toEqual([])
    expect(world.sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['unchecked'])
  })
}

for (const tool of ['Skill', 'Agent']) {
  test(`${tool} records a changed PR field`, async ($, on) => {
    const options: Options = { prs: [buildPullRequest()], prFields: { state: 'OPEN', closedAt: null, autoMergeRequest: null, isInMergeQueue: false, reviews: { totalCount: 0 } } }
    options.afterTool = () => { options.prFields = { ...options.prFields, reviews: { totalCount: 1 } } }
    const { sessions } = createWorld(on, { branch: 'feature', ahead: 1 }, options)
    const result = await $.tool.call((tool === 'Skill' ? { tool, skill: 'unrelated' } : { tool, description: 'Change a file', prompt: 'Change a file' }) as never)
    expect(sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['pr'])
    expect(result.context?.join('')).toContain('PR #5 changed its protected fields')
  })
}

test('unchecked calls retain only the latest warning and restart their count after dismissal', async ($, on) => {
  const toolUseIds: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, event) => {
    toolUseIds.push(event.tool_use_id)
    return { result: 'written' }
  })
  const { sessions, clock, views } = createWorld(on, { branch: 'feature' }, { prs: [buildPullRequest()], prReadError: true })
  const start = clock.now()
  for (const command of ['first', 'second', 'third']) {
    const result = await $.tool.call({ tool: 'Bash', command })
    expect(result.context ?? []).toEqual([])
    expect(result.deny).toBeUndefined()
    await clock.advance(10)
  }
  const session = sessions.get('sid')!
  const record = session.violations![0]!
  expect(session.violations).toHaveLength(1)
  expect(record.kind).toBe('unchecked')
  expect(record.count).toBe(3)
  expect(record.fact).toEqual({ toolUseId: toolUseIds[2] })
  expect(record.toolUseIds).toEqual([toolUseIds[2]])
  expect(record.agentIds).toEqual([])
  expect(record.start).toBe(start)
  expect(record.end).toBe(clock.now() - 10)
  expect(views.at(-1)?.violations?.[0]).toEqual({ factId: record.factId, tone: 'warn', text: `unchecked: guarantee snapshots unavailable for 3 calls, latest ${toolUseIds[2]}` })
  expect(parseSession(session)).not.toBe(null)
  expect(parseSession({ ...session, violations: [{ ...record, count: undefined }] })).not.toBe(null)
  for (const count of [0, -1, 1.5, '3', null]) expect(parseSession({ ...session, violations: [{ ...record, count }] })).toBe(null)
  const ui = await mountPane($, { columns: 120, rows: 80 })
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
  expect(views.at(-1)?.violations).toEqual([])
  const nextStart = clock.now()
  expect((await $.tool.call({ tool: 'Bash', command: 'fourth' })).context ?? []).toEqual([])
  const latest = sessions.get('sid')?.violations
  expect(latest).toHaveLength(1)
  expect(latest?.[0]?.count).toBe(1)
  expect(latest?.[0]?.factId).not.toBe(record.factId)
  expect(latest?.[0]?.fact).toEqual({ toolUseId: toolUseIds[3] })
  expect(latest?.[0]?.toolUseIds).toEqual([toolUseIds[3]])
  expect(latest?.[0]?.start).toBe(nextStart)
  expect(views.at(-1)?.violations?.[0]?.text).toBe(`unchecked: guarantee snapshots unavailable for 1 call, latest ${toolUseIds[3]}`)
})

test('parallel unchecked calls keep one warning without losing their count', async ($, on) => {
  const toolUseIds: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, event) => {
    toolUseIds.push(event.tool_use_id)
    return { result: 'written' }
  })
  const { sessions } = createWorld(on, { branch: 'feature' }, { prs: [buildPullRequest()], prReadError: true })
  const results = await Promise.all(['one', 'two'].map(command => $.tool.call({ tool: 'Bash', command })))
  expect(results.every(result => result.deny === undefined && !(result.context?.length))).toBe(true)
  const records = sessions.get('sid')?.violations
  expect(records).toHaveLength(1)
  expect(records?.[0]?.count).toBe(2)
  const latest = records?.[0]
  expect(latest?.kind).toBe('unchecked')
  if (latest?.kind === 'unchecked') {
    expect(toolUseIds).toContain(latest.fact.toolUseId)
    expect(latest.toolUseIds).toEqual([latest.fact.toolUseId])
    expect(latest.agentIds).toEqual([])
  }
})

for (const tool of ['run', 'verify']) {
  test(`registration order wraps the answering ${tool} handler`, async ($, on) => {
    const git = graph()
    const checkout: Checkout = { branch: 'feature', graph: git, dirty: { file: 'pending' } }
    const options: Options = { session: { flow: 'fix' }, verifyFile: '{"verify":["./check"]}', afterSpawn: () => checkout.graph = commit(checkout.graph!) }
    options.approvedConfig = options.verifyFile!
    const { sessions } = createWorld(on, checkout, options)
    const result = await $.tool.call({ tool: `mcp__working-agreement__${tool}`, ...(tool === 'run' ? { argv: ['./check'] } : {}) })
    expect(result.result).toContain(tool === 'verify' ? 'Verify passed' : 'Run pass:')
    expect(sessions.get('sid')?.violations?.[0]?.kind).toBe('commit')
    expect(result.context?.join('')).toContain('a commit appeared')
  })
}

test('each session tells the same fact; dismissing the displayed fact clears both views and future telling', async ($, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'feature', graph: git }
  const options: Options = { afterTool: () => checkout.graph = commit(checkout.graph!) }
  const { sessions, files, chat, clock, views, seedChat } = createWorld(on, checkout, options)
  const initial = sessions.get('sid')!
  const first = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  checkout.graph!.refs.feature = 'a'
  delete checkout.graph!.commits.b
  chat.id = 'second'
  seedChat(chat.id, { ...initial, sessionId: chat.id })
  const second = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  const factId = sessions.get('sid')!.violations![0]!.factId
  expect(sessions.get('second')?.violations?.[0]?.factId).toBe(factId)
  expect(first.context).toEqual(second.context)
  expect(second.context).toHaveLength(1)
  const ui = await mountPane($, { columns: 120, rows: 80 })
  await ui.press({ key: 'dismiss' })
  await ui.unmount()
  expect(JSON.parse(files.get(`${common}/working-agreement/d/${factId}.json`)!)).toEqual({ v: 1, factId })
  expect(views.at(-1)?.violations).toEqual([])
  chat.id = 'sid'
  await endTurn($)
  await clock.settle()
  expect(views.at(-1)?.violations).toEqual([])
  checkout.graph!.refs.feature = 'a'
  delete checkout.graph!.commits.b
  expect((await $.tool.call({ tool: 'Bash', command: 'opaque' })).context ?? []).toEqual([])
  expect(sessions.get('sid')?.violations).toHaveLength(1)
  expect(sessions.get('sid')?.violations?.[0]?.toolUseIds).toHaveLength(2)
})

test('an interrupted tool result keeps its error and records its closing snapshot', async ($, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'feature', graph: git }
  const toolUseIds: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, event) => {
    toolUseIds.push(event.tool_use_id)
    checkout.graph = commit(checkout.graph!)
    return { result: 'interrupted', isError: true }
  })
  const { sessions } = createWorld(on, checkout)
  const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  expect(result.isError).toBe(true)
  expect(result.result).toBe('interrupted')
  expect(result.context?.join('')).toContain('a commit appeared')
  expect(sessions.get('sid')?.violations?.[0]?.kind).toBe('commit')
  expect(sessions.get('sid')?.violations?.[0]?.toolUseIds).toEqual(toolUseIds)
})

test('a throwing interrupted run still records its closing snapshot and preserves the interruption', async (_$, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'feature', graph: git }
  const world = createWorld(on, checkout)
  await expect(handleGuarantees(createTestPort(world), { tool: 'Bash', command: 'opaque', tool_use_id: 'interrupted', agentId: 'child' }, async () => {
    checkout.graph = commit(checkout.graph!)
    throw new Error('interrupted')
  })).rejects.toThrow('interrupted')
  expect(world.sessions.get('sid')?.violations?.[0]?.kind).toBe('commit')
  expect(world.sessions.get('sid')?.violations?.[0]?.fact).toEqual({ shas: ['b'] })
  expect(world.sessions.get('sid')?.violations?.[0]?.toolUseIds).toEqual(['interrupted'])
  expect(world.sessions.get('sid')?.violations?.[0]?.agentIds).toEqual(['child'])
})

test('parallel windows merge call and loop attribution without losing records', async ($, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'feature', graph: git }
  const toolUseIds: string[] = []
  const pending: Gate = {}
  const ready = new Promise<void>(resolve => { pending.open = resolve })
  on('tool.call', { tool: 'Bash' }, async (_$, event) => {
    toolUseIds.push(event.tool_use_id)
    if (toolUseIds.length === 2) { checkout.graph = commit(checkout.graph!); pending.open?.() }
    await ready
    return { result: 'done' }
  })
  const { sessions } = createWorld(on, checkout)
  const results = await Promise.all(['one', 'two'].map(command => $.tool.call({ tool: 'Bash', command })))
  expect(results.every(result => result.context?.length === 1)).toBe(true)
  const records = sessions.get('sid')?.violations
  expect(records).toHaveLength(1)
  expect(records?.[0]?.kind).toBe('commit')
  expect(records?.[0]?.toolUseIds.slice().sort()).toEqual(toolUseIds.slice().sort())
  expect(records?.[0]?.toolUseIds).toHaveLength(2)
  expect(records?.[0]?.agentIds).toEqual([])
})

test('parallel subagent windows preserve both pinned loop ids', async (_$, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'feature', graph: git }
  const world = createWorld(on, checkout)
  const pending: EntryGate = { entered: 0 }
  const ready = new Promise<void>(resolve => { pending.open = resolve })
  const results = await Promise.all(['one', 'two'].map(toolUseId => handleGuarantees(createTestPort(world),
    { tool: 'Bash', command: 'opaque', tool_use_id: toolUseId, agentId: toolUseId }, async () => {
      pending.entered += 1
      if (pending.entered === 2) { checkout.graph = commit(checkout.graph!); pending.open?.() }
      await ready
      return { result: 'done' }
    })))
  expect(results.every(result => result.context?.length === 1)).toBe(true)
  const records = world.sessions.get('sid')?.violations
  expect(records).toHaveLength(1)
  expect(records?.[0]?.kind).toBe('commit')
  expect(records?.[0]?.toolUseIds.slice().sort()).toEqual(['one', 'two'])
  expect(records?.[0]?.agentIds?.slice().sort()).toEqual(['one', 'two'])
})

for (const state of ['CLOSED', 'MERGED']) {
  test(`a ${state} PR is not checked`, async ($, on) => {
    const { sessions } = createWorld(on, { branch: 'feature' }, { prs: [buildPullRequest({ state })], prReadError: true })
    const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
    expect(result.context ?? []).toEqual([])
    expect(sessions.get('sid')?.violations ?? []).toEqual([])
  })
}

test('strict session parsing rejects malformed guarantee facts and attribution', async ($, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'feature', graph: git }
  const { sessions } = createWorld(on, checkout, { afterTool: () => checkout.graph = commit(checkout.graph!) })
  await $.tool.call({ tool: 'Bash', command: 'opaque' })
  const session = sessions.get('sid')!
  const record = session.violations![0]!
  for (const invalid of [
    { ...record, kind: 'unknown' }, { ...record, fact: { shas: [] } }, { ...record, fact: { shas: ['b'], extra: true } },
    { ...record, toolUseIds: [] }, { ...record, agentIds: [1] }, { ...record, factId: '../unsafe' },
    { ...record, sessionId: 'another' }, { ...record, end: record.start - 1 }, { ...record, count: 1 },
    ...[null, {}, 'bad', [null], [{ root: '', branch: null }], [{ root: 1, branch: 'feature' }],
      [{ root: '/other' }], [{ root: '/other', branch: 1 }], [{ root: '/other', branch: null, extra: true }]]
      .map(checkouts => ({ ...record, checkouts })),
    { ...record, kind: 'push', fact: { ref: 'refs/remotes/origin/feature', before: 'a', after: 'b' }, checkouts: [] },
  ]) expect(parseSession({ ...session, violations: [invalid] })).toBe(null)
})

test('a new commit on a detached worktree HEAD is still observed', async ($, on) => {
  const git = graph()
  const checkout: Checkout = { branch: 'feature', graph: git, worktrees: { '/repo': { branch: 'feature' }, '/detached': { branch: 'HEAD', head: 'a' } } }
  const { sessions, views } = createWorld(on, checkout, { afterTool: () => {
    checkout.graph!.commits.b = { parents: ['a'], files: {} }
    checkout.worktrees!['/detached']!.head = 'b'
  } })
  expect((await $.tool.call({ tool: 'Bash', command: 'opaque' })).context?.join('')).toContain('on a detached HEAD, checked out in another worktree')
  expect(sessions.get('sid')?.violations?.[0]?.fact).toEqual({ shas: ['b'] })
  expect(sessions.get('sid')?.violations?.find(record => record.kind === 'commit')?.checkouts).toEqual([{ root: '/detached', branch: null }])
  expect(parseSession(sessions.get('sid'))).not.toBe(null)
  expect(views.at(-1)?.violations?.[0]?.text).toContain('on a detached HEAD, checked out in another worktree')
  expect((await readFlowStatus($))?.split('\n').find(line => line.startsWith('Violation'))).toContain('on a detached HEAD, checked out in another worktree')
})

test('the previous turn-end PR read supplies the next window baseline, and the pane and status tell the user what the agent call changed', async ($, on) => {
  const fields = { state: 'OPEN', closedAt: null, autoMergeRequest: null, isInMergeQueue: false, reviews: { totalCount: 0 } }
  const options: Options = { prs: [buildPullRequest()], prFields: fields }
  const { sessions, views } = createWorld(on, { branch: 'feature', ahead: 1 }, options)
  await $.tool.call({ tool: 'Bash', command: 'opaque' })
  options.prFields = { ...fields, reviews: { totalCount: 1 } }
  await endTurn($)
  expect(sessions.get('sid')?.prSnapshot?.fields.reviews.totalCount).toBe(1)
  options.afterTool = () => { options.prFields = { ...fields, reviews: { totalCount: 2 } } }
  const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  const record = sessions.get('sid')?.violations?.[0]
  expect(record?.kind).toBe('pr')
  const number = buildPullRequest()['number']
  expect(result.context?.join('')).toContain(`PR #${number} changed its protected fields during your call (it may be the user's): stop and tell the user`)
  expect(views.at(-1)?.violations?.[0]?.text).toBe(`PR #${number} changed its protected fields during an agent call (it may be yours)`)
  expect((await readFlowStatus($))?.split('\n').find(line => line.startsWith('Violation'))).toContain(`✗ PR #${number} changed its protected fields during an agent call (it may be yours) · `)
  if (record?.kind === 'pr') {
    expect(record.fact.before.reviews.totalCount).toBe(1)
    expect(record.fact.after.reviews.totalCount).toBe(2)
  }
})

for (const kind of ['commit', 'default-tree']) {
  test(`${kind} in the session checkout is local when cwd is a subdirectory`, async ($, on) => {
    const git = graph()
    const checkout: Checkout = { branch: kind === 'commit' ? 'feature' : 'main', graph: git, dirty: { file: 'before' } }
    const { views } = createWorld(on, checkout, { cwd: '/repo/subdirectory', afterTool: () => {
      if (kind === 'commit') checkout.graph = commit(checkout.graph!)
      else checkout.dirty = { file: 'after' }
    } })
    const result = await $.tool.call({ tool: 'mcp__unknown__write' })
    expect(result.context?.join('')).toContain(kind === 'commit' ? 'a commit appeared during your call' : 'the default-branch tree changed at /repo during your call')
    expect(result.context?.join('')).not.toContain('another worktree')
    expect(views.at(-1)?.violations?.[0]?.text).not.toContain('another worktree')
  })
}

test('a failed PR snapshot read logs only to debug and preserves the tool result', async ($, on) => {
  const { logs, sessions } = createWorld(on, { branch: 'feature', graph: graph() }, {
    prs: [buildPullRequest()], prReadError: true,
  })
  const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  expect(result.result).toBe('written')
  expect(result.context ?? []).toEqual([])
  expect(sessions.get('sid')?.violations?.map(record => record.kind)).toEqual(['unchecked'])
  expect(logs.some(log => log.to === 'debug' && log.text.includes('PR snapshot read failed:') && log.text.includes('unreachable'))).toBe(true)
  expect(logs.filter(log => log.to === 'transcript')).toEqual([])
})

test('a subagent commit in its own worktree records and tells that loop', async (_$, on) => {
  const checkout: Checkout = { branch: 'feature', graph: { ...graph(), refs: { ...graph().refs, child: 'a' } },
    worktrees: { '/repo': { branch: 'feature' }, '/child': { branch: 'child' } } }
  const world = createWorld(on, checkout)
  const result = await handleGuarantees(createTestPort(world),
    { tool: 'Bash', command: 'git -C /child commit', tool_use_id: 'child-call', agentId: 'child-agent' }, async () => {
      checkout.graph = { ...commit(checkout.graph!), refs: { ...checkout.graph!.refs, child: 'b' } }
      return { result: 'committed' }
    })
  const violations = world.sessions.get('sid')?.violations
  expect(violations).toHaveLength(1)
  expect(violations?.[0]?.kind).toBe('commit')
  expect(violations?.[0]?.fact).toEqual({ shas: ['b'] })
  expect(violations?.[0]?.agentIds).toEqual(['child-agent'])
  expect(violations?.[0]?.toolUseIds).toEqual(['child-call'])
  expect(result.context?.join('')).toContain('on child, checked out in another worktree')
})
