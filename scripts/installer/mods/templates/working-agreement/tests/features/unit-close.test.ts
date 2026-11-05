import { expect } from 'claude-code/testing'

import { coordinator } from '../support/builders'
import { callModTool, inside, readPromptContext } from '../support/helpers'
import { test } from '../support/kit'
import { gatedCheckout, gateOptions, seedDelegatedChild } from '../support/parallel-worktrees'
import { createWorld, records, scopeFile } from '../support/world'
import type { Options, World } from '../support/world'

/** A herdr workspace the fake server holds: its label, its checkout, and whether its agent runs and works. */
interface Workspace { id: string; label: string; path: string; hasAgent: boolean; isWorking: boolean }

/**
 * Answers herdr like a live server holding these workspaces, closing one on `workspace close`.
 * @param workspaces - The open workspaces.
 * @returns The world's herdr reply.
 */
const herdrServer = (workspaces: Workspace[]): Options['herdrReply'] => args => {
  const [noun, verb] = args
  const option = (name: string) => args[args.indexOf(name) + 1] ?? ''
  if (noun === 'workspace' && verb === 'list') {
    return JSON.stringify({ result: { workspaces: workspaces.map(each => ({ workspace_id: each.id, label: each.label, worktree: { checkout_path: each.path } })) } })
  }
  if (noun === 'workspace' && verb === 'close') {
    const index = workspaces.findIndex(each => each.id === args[2])
    if (index >= 0) workspaces.splice(index, 1)
    return '{}'
  }
  if (noun === 'pane' && verb === 'list') {
    const workspace = workspaces.find(each => each.id === option('--workspace'))
    return JSON.stringify({ result: { panes: [{ pane_id: `${workspace?.id}:p1`, ...(workspace?.hasAgent ? { agent: 'claude' } : {}) }] } })
  }
  if (noun === 'agent' && verb === 'wait') {
    // herdr takes an agent's name or the pane it runs in as its target.
    const workspace = workspaces.find(each => each.label === `wa-spawn:${args[2]?.replace('issue-', '')}` || args[2] === `${each.id}:p1`)
    return workspace?.isWorking ? { exitCode: 1, stderr: 'timeout' } : '{}'
  }
  return '{}'
}

/**
 * Creates a coordinator inside herdr that delegates the finished child `a` (issue 2), whose session runs in workspace w2 on /a.
 * @param on - The test's hook registration.
 * @param unit - The child's workspace fields; a label other than the spawn label stands for a session spawn did not open.
 * @param isSpawned - Whether spawn recorded starting issue 2's session.
 * @param live - The checkout.
 * @param options - World options added to the defaults, such as a change while the gating Verify runs.
 * @returns The world and the workspaces.
 */
async function arrange(on: Parameters<typeof createWorld>[0], unit: Partial<Workspace> = {}, isSpawned = true, live = gatedCheckout(), options: Options = {}): Promise<{ world: World; workspaces: Workspace[] }> {
  const workspaces: Workspace[] = [{ id: 'w2', label: 'wa-spawn:2', path: '/a', hasAgent: true, isWorking: false, ...unit }]
  const world = createWorld(on, live, { session: coordinator, ...gateOptions, herdrEnv: inside, herdrReply: herdrServer(workspaces), ...options })
  await seedDelegatedChild(world)
  if (isSpawned) world.files.set(`${records}/spawn/2.json`, JSON.stringify({ isStarted: true, isPrompted: true }))
  return { world, workspaces }
}

/**
 * Lists the workspace closes a world asked herdr for.
 * @param world - The world.
 * @returns The command lines.
 */
const closes = (world: World): string[] => world.herdrCalls.map(call => call.argv.join(' ')).filter(line => line.startsWith('herdr workspace close'))

test('merge_child closes the idle child\'s spawned workspace, keeping its worktree, branch and records, and says so', async ($, on) => {
  const { world, workspaces } = await arrange(on)
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged).toEqual({ text: expect.stringContaining('#2\'s session is closed; its worktree, branch and records stay, and spawn 2 resumes it.'), isError: false })
  expect(closes(world)).toEqual(['herdr workspace close w2'])
  expect(workspaces).toEqual([])
  expect(world.herdrCalls.some(call => call.argv.includes('remove'))).toBe(false)
  expect(world.files.has(`${records}/spawn/2.json`)).toBe(true)
  expect(world.files.has(`${records}/s/child.json`)).toBe(true)
})

test('merge_child closes a start assignment the child never replied done to, and says so', async ($, on) => {
  const { world } = await arrange(on)
  world.files.set(`${records}/spawn/2.json`, JSON.stringify({ isStarted: true, isPrompted: true, assignId: 'a1' }))
  const assign = { v: 1, id: 'a1', kind: 'assign', from: 'coordinator-sid', to: '2', issue: 2, in_reply_to: '', seq: 1, created_at: '2026-01-01T00:00:00.000Z',
    expects: '', attempt: 1, body: 'Work on issue #2.', refs: [], author: 'agent' }
  world.files.set(`${records}/mail/2/cur/a1.1.json`, JSON.stringify(assign))
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged.text).toContain('#2\'s start assignment (message a1) is closed: integrated without a done.')
})

test('a child mid-turn is left running, and a coordinator prompt after its turn ends closes it', async ($, on) => {
  const { world, workspaces } = await arrange(on, { isWorking: true })
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged.text).toContain('#2\'s session is mid-turn, so its workspace is closed when that turn ends.')
  expect(closes(world)).toEqual([])
  const waiting = readPromptContext($)
  await world.clock.advance(6000)
  expect(await waiting).not.toContain('session is closed')
  expect(closes(world)).toEqual([])
  workspaces[0]!.isWorking = false
  expect(await readPromptContext($)).toContain('#2\'s turn ended, so its integrated unit\'s session is closed')
  expect(closes(world)).toEqual(['herdr workspace close w2'])
})

test('merge_child closes the idle child\'s session when its merge stands but is not recorded as delegated', async ($, on) => {
  const live = gatedCheckout()
  const moveChild = () => { live.graph = { ...live.graph!, commits: { ...live.graph!.commits, a3: { parents: ['a2'], files: live.graph!.commits.a2!.files } }, refs: { ...live.graph!.refs, a: 'a3' } } }
  const { world } = await arrange(on, {}, true, live, { afterSpawn: moveChild })
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged.text).toContain('not recorded as delegated')
  expect(merged.text).toContain('#2\'s session is closed')
  expect(closes(world)).toEqual(['herdr workspace close w2'])
})

test('a child session spawn did not open is never closed', async ($, on) => {
  const { world } = await arrange(on, { label: 'claude-1234abcd:a' }, false)
  const merged = await callModTool($, 'merge_child', { child: 'a' })
  expect(merged.text).toContain('Merged a into par')
  expect(merged.text).not.toContain('session is')
  expect(closes(world)).toEqual([])
})

test('without delegation merge_child closes nothing', async ($, on) => {
  const { world } = await arrange(on)
  world.files.delete(scopeFile('sid'))
  expect((await callModTool($, 'merge_child', { child: 'a' })).isError).toBe(true)
  expect(closes(world)).toEqual([])
})

test('the close never runs while a spawn holds the lock', async ($, on) => {
  const { world } = await arrange(on)
  world.files.set(`${records}/spawn/lock/held`, '')
  world.modified.set(`${records}/spawn/lock`, world.clock.now())
  const merging = callModTool($, 'merge_child', { child: 'a' })
  await world.clock.advance(31000)
  expect((await merging).text).toContain('#2\'s session is not closed: another spawn holds the lock')
  expect(closes(world)).toEqual([])
})

// contract: merge_child removes the stall record of the unit it integrates, so a later resume's stall is reported
test('merge_child removes the integrated child\'s stall record', async ($, on) => {
  const { world } = await arrange(on)
  world.files.set(`${records}/stalls/2.json`, JSON.stringify({ v: 1, session: 'child', stall: 'mail', key: 'child:mail:m1' }))
  await callModTool($, 'merge_child', { child: 'a' })
  expect(world.files.has(`${records}/stalls/2.json`)).toBe(false)
})
