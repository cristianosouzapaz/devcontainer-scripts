import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

import { reportStalledUnits } from '../../hooks/core/liveness'
import { deriveSessionId } from '../../hooks/core/spawn'
import { coordinator } from '../support/builders'
import { callModTool, inside, readRevision, runFlowCommand } from '../support/helpers'
import { defaultIssueLabels } from '../support/issue-github'
import { test } from '../support/kit'
import { buildScope, buildStat, common, coordinatorHost, createTestPort, createWorld, declarationFile, hashIdentity, markSpawned, records, scopeFile } from '../support/world'
import type { Checkout, Graph, Options, World } from '../support/world'

/** A herdr workspace the fake server holds: its label, checkout and whether an agent runs in its pane. */
interface Workspace { id: string; label: string; path: string; hasAgent?: boolean }

/**
 * How the fake herdr treats the unit's workspace: its path, a hook run as it closes it, whether the close leaves the session running, and
 * whether herdr holds no workspace of the unit at all.
 */
interface Host { path?: string; onClose?: () => void; isCloseIgnored?: boolean; isAbsent?: boolean }

/** A retirement scene: its world, its repository and the unit's session id. */
interface Scene { world: World; checkout: Checkout; session: string }

const branch = 'feat/12-redo-the-unit'
const worktree = `/wt/${branch}`
const claudeDir = '/claude'
const transcripts = `${claudeDir}/projects/-wt-feat-12-redo-the-unit`
// why: a retirement stamps with the world's clock, which starts at the epoch.
const stamp = '19700101T000000Z'
const aside = `${worktree}.retired-${stamp}`

/**
 * Answers herdr like a live server: it opens, closes and removes labelled worktree workspaces, a close keeps the git worktree and a
 * removal drops it, and an agent start marks the unit's session as running.
 * @param workspaces - The open workspaces.
 * @param checkout - The repository, whose worktrees a removal changes.
 * @param session - Whether the unit's session runs, set by an agent start.
 * @returns The world's herdr reply.
 */
const herdrServer = (workspaces: Workspace[], checkout: Checkout, session: { isLive: boolean } & Host): Options['herdrReply'] => args => {
  const [noun, verb] = args
  const option = (name: string): string => args[args.indexOf(name) + 1] ?? ''
  if (noun === 'workspace' && verb === 'close') {
    session.onClose?.()
    const index = workspaces.findIndex(each => each.id === args[2])
    if (index >= 0 && !session.isCloseIgnored) workspaces.splice(index, 1)
    return '{}'
  }
  if (noun === 'workspace' && verb === 'list') {
    return JSON.stringify({ result: { workspaces: workspaces.map(each => ({ workspace_id: each.id, label: each.label, worktree: { checkout_path: each.path } })) } })
  }
  if (noun === 'worktree' && verb === 'remove') {
    const index = workspaces.findIndex(each => each.id === option('--workspace'))
    const [removed] = workspaces.splice(index, 1)
    checkout.worktrees = Object.fromEntries(Object.entries(checkout.worktrees ?? {}).filter(([path]) => path !== removed?.path))
    return '{}'
  }
  if (noun === 'worktree') {
    const opened = { id: `w${workspaces.length + 10}`, label: option('--label'), path: `/wt/${option('--branch')}` }
    workspaces.push(opened)
    return JSON.stringify({ result: { root_pane: { pane_id: `${opened.id}:p1` } } })
  }
  if (noun === 'pane' && verb === 'list') {
    const workspace = workspaces.find(each => each.id === option('--workspace'))
    return JSON.stringify({ result: { panes: [{ pane_id: `${workspace?.id}:p1`, ...(workspace?.hasAgent ? { agent: 'claude' } : {}) }] } })
  }
  if (noun === 'agent' && verb === 'start') session.isLive = true
  return '{}'
}

/**
 * Acts as a running unit session's mod acknowledging the mail that reached its mailbox.
 * @param mail - The world's files.
 */
function acknowledgeMail(mail: Map<string, string>): void {
  for (const path of [...mail.keys()].filter(each => each.startsWith(`${records}/mail/12/new/`))) {
    mail.set(path.replace('/new/', '/cur/'), mail.get(path) ?? '')
    mail.delete(path)
  }
}

/**
 * Answers the issue read spawn makes and the comment a retirement posts.
 * @param args - The gh arguments.
 * @returns The answer, or undefined for the world's modelled ones.
 */
const github: Options['gh'] = args => {
  if (args[0] === 'issue' && args[1] === 'comment') return { stdout: 'https://github.com/o/r/issues/12#issuecomment-9\n' }
  if (args[0] === 'api' && args[1] === 'repos/{owner}/{repo}/labels') return { stdout: defaultIssueLabels.join('\n') }
  const query = args.find(arg => arg.startsWith('query=') && arg.includes('blockedBy(first:50){nodes{number state}}'))
  if (!query) return undefined
  return { stdout: JSON.stringify({ data: { repository: { issue: { state: 'OPEN', title: 'feat(mod): redo the unit',
    labels: { nodes: [{ name: 'ready-for-agent' }] }, blockedBy: { nodes: [] } } } } }) }
}

/**
 * Builds main on m0 and issue 12's unit branch one commit past it, checked out in its own worktree with an untracked file.
 * @param graph - Fields replacing the graph's defaults.
 * @returns The coordinator's checkout on main.
 */
const repository = (graph: Partial<Graph> = {}): Checkout => ({
  branch: 'main',
  graph: { commits: { m0: { parents: [], files: {} }, u1: { parents: ['m0'], files: { a: '1' } } },
    refs: { main: 'm0', 'origin/main': 'm0', [branch]: 'u1' }, created: { [branch]: 'main' }, ...graph },
  worktrees: { '/repo': { branch: 'main' }, [worktree]: { branch, dirty: { 'src/new.ts': 'new' } } },
})

/**
 * Creates a coordinator inside herdr with issue 12's spawned unit: its workspace, session mirror, declaration, spawn record and transcript.
 * @param on - The test's hook registration.
 * @param options - Options replacing the coordinator defaults.
 * @param checkout - The repository.
 * @param host - How herdr treats the unit's workspace.
 * @returns The scene.
 */
async function createScene(on: On, options: Options = {}, checkout = repository(), host: Host = {}): Promise<Scene> {
  const workspaces = host.isAbsent ? [] : [{ id: 'w1', label: 'wa-spawn:12', path: host.path ?? worktree, hasAgent: true }]
  const holder: { world?: World } = {}
  const unit = { isLive: false, ...host }
  const world = createWorld(on, checkout, { session: coordinator, herdrEnv: { ...inside, CLAUDE_CONFIG_DIR: claudeDir },
    herdrReply: herdrServer(workspaces, checkout, unit), gh: github,
    beforeRun: () => { if (unit.isLive && holder.world) acknowledgeMail(holder.world.files) }, ...options })
  holder.world = world
  await world.ready
  const session = await deriveSessionId(common, 12)
  const identity = { branch, issues: [12] }
  world.files.set(`${records}/s/${session}.json`, JSON.stringify({ ...world.sessions.get('sid'), role: undefined, sessionId: session, info: {},
    unit: identity, units: [{ identity, skills: [], verifyRuns: [], runs: [] }] }))
  world.files.set(await declarationFile(identity), JSON.stringify({ v: 1, identity, flow: 'small-feature' }))
  markSpawned(world, [12], session)
  world.files.set(`${transcripts}/${session}.jsonl`, '{}\n')
  return { world, checkout, session }
}

/**
 * Delegates issues to the scene's coordinator.
 * @param world - The world.
 * @param issues - The delegated issues.
 */
const delegate = (world: World, issues: number[]): void => { world.files.set(scopeFile('sid'), buildScope('sid', issues)) }

/**
 * Tells whether the scene's unit is still in place: its branch, worktree, records and transcript.
 * @param scene - The scene.
 * @returns Whether nothing of it was removed.
 */
async function isIntact(scene: Scene): Promise<boolean> {
  return await readRevision(scene.world, branch) === 'u1' && !!scene.checkout.worktrees?.[worktree] && scene.world.files.has(`${records}/spawn/12.json`)
    && scene.world.files.has(`${transcripts}/${scene.session}.jsonl`)
}

/**
 * Lists the commands a retirement must never issue: a worktree removal, by git or herdr, and a forced branch deletion.
 * @param world - The world.
 * @returns The deleting commands it ran.
 */
const listDeletions = (world: World): string[] => world.runs.filter(run => /^(?:git|herdr) .*(?:worktree remove|branch -D)/.test(run))

/**
 * Tells whether the unit's transition log holds a retired event.
 * @param world - The world.
 * @returns Whether the retirement was logged.
 */
async function hasLoggedRetired(world: World): Promise<boolean> {
  await world.clock.advance(1)
  return (world.files.get(`${records}/log/${await hashIdentity(branch, [12])}.jsonl`) ?? '').includes('"event":"retired"')
}

test('a delegating coordinator retires an in-scope unit: session closed, checkout aside, a delegated decision, and a fresh spawn after', async ($, on) => {
  const scene = await createScene(on)
  const { world, session } = scene
  delegate(world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'cut from the wrong base' })
  expect(outcome).toEqual({ text: expect.stringContaining('Retired #12\'s unit'), isError: false })
  expect(world.runs).toContain('herdr workspace close w1')
  expect(await readRevision(world, `refs/retired/12/${stamp}`)).toBe('u1')
  expect(outcome.text).toContain(`Resume the work with: git -C '${aside}' switch -c '${branch}-retired-${stamp}'`)
  expect(outcome.text).toContain(`Reclaim its disk with: git worktree remove --force '${aside}'`)
  expect(scene.checkout.worktrees?.[aside]).toEqual({ branch: 'HEAD', head: 'u1', dirty: { 'src/new.ts': 'new' } })
  const comment = world.runs.find(run => run.startsWith('gh issue comment 12 --body ## Delegated decision')) ?? ''
  expect(comment).toContain('### Reason\ncut from the wrong base')
  expect(comment).toContain(`refs/retired/12/${stamp}`)
  expect(listDeletions(world)).toEqual([])
  expect(await readRevision(world, branch)).toBe('')
  for (const path of ['spawn/12.json', `s/${session}.json`, `u/${await hashIdentity(branch, [12])}.json`]) expect(world.files.has(`${records}/${path}`)).toBe(false)
  expect(world.files.has(`${transcripts}/${session}.jsonl`)).toBe(false)
  await world.clock.advance(1)
  expect(world.files.get(`${records}/log/${await hashIdentity(branch, [12])}.jsonl`)).toContain('"event":"retired"')
  const planned = (await callModTool($, 'plan')).text.split('\n').find(line => line.startsWith('#12 ')) ?? ''
  expect(planned).toContain('can start now')
  expect(planned).not.toContain('.retired-')
  expect(((await runFlowCommand($, 'report')).text ?? '').split('\n').filter(line => line.includes('.retired-') && !/^\s*Retired /.test(line))).toEqual([])
  const spawned = await callModTool($, 'spawn', { number: 12 })
  expect(spawned).toEqual({ text: expect.stringContaining('started'), isError: false })
  expect(world.runs.find(run => run.startsWith('herdr agent start issue-12'))).toContain(`--session-id ${session}`)
  // why: a create on the branch, never an open of a listed checkout, so the respawn neither reuses the retired checkout nor its path.
  expect(world.runs.filter(run => run.startsWith('herdr worktree') && run.includes('--label wa-spawn:12'))).toEqual([
    `herdr worktree create --cwd /repo --branch ${branch} --base ${branch} --label wa-spawn:12 --no-focus`])
  expect(await readRevision(world, branch)).not.toBe('')
  expect(scene.checkout.worktrees?.[aside]).toEqual({ branch: 'HEAD', head: 'u1', dirty: { 'src/new.ts': 'new' } })
})

// contract: retire_unit after a handoff removes the conversation and mirror of the recorded session and of the derived one a later spawn would start, so that spawn starts it fresh, never resuming the old conversation
test('a unit whose handoff rebound its spawn record is retired as both sessions, and the next spawn starts afresh', async ($, on) => {
  const scene = await createScene(on)
  const { world, session } = scene
  delegate(world, [12])
  const handed = 'handed-off'
  world.files.set(`${records}/s/${handed}.json`, JSON.stringify({ ...JSON.parse(world.files.get(`${records}/s/${session}.json`) ?? '{}') as Record<string, unknown>, sessionId: handed }))
  world.files.set(`${transcripts}/${handed}.jsonl`, '{}\n')
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ isStarted: true, isPrompted: true, mode: 'default', sessionId: handed, predecessors: [session] }))
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'handed off' })).toEqual({ text: expect.stringContaining('Retired #12\'s unit'), isError: false })
  expect([handed, session].flatMap(each => [world.files.has(`${transcripts}/${each}.jsonl`), world.files.has(`${records}/s/${each}.json`)])).toEqual([false, false, false, false])
  expect(await callModTool($, 'spawn', { number: 12 })).toEqual({ text: expect.stringContaining('started'), isError: false })
  expect(world.runs.find(run => run.startsWith('herdr agent start issue-12'))).toContain(`--session-id ${session}`)
})

// contract: retire_unit refuses, naming the session and changing nothing, while a session a handoff superseded runs on its own in another process than its unit's
test('a unit whose superseded session runs on its own is not retired, naming that session', async ($, on) => {
  const scene = await createScene(on)
  const { world, session } = scene
  delegate(world, [12])
  const handed = 'handed-off'
  world.files.set(`${records}/s/${handed}.json`, JSON.stringify({ ...JSON.parse(world.files.get(`${records}/s/${session}.json`) ?? '{}') as Record<string, unknown>, sessionId: handed }))
  world.files.set(`${transcripts}/${handed}.jsonl`, '{}\n')
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ isStarted: true, isPrompted: true, mode: 'default', sessionId: handed, predecessors: [session] }))
  world.files.set(`${records}/host/${handed}.json`, JSON.stringify(coordinatorHost))
  world.files.set('/proc/201/stat', buildStat(201, '7100'))
  world.files.set(`${records}/host/${session}.json`, JSON.stringify({ ...coordinatorHost, pid: 201, pidStart: '7100' }))
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'handed off' }))
    .toEqual({ text: expect.stringContaining(`#12's superseded session ${session} runs on its own, in another process than its unit's, so its conversation is not removed; nothing was removed`), isError: true })
  expect(await isIntact(scene)).toBe(true)
})

// contract: retire_unit refuses as unknown, naming the record and changing nothing, while a superseded session's host record cannot be read
test('a unit whose superseded session\'s host record cannot be read is not retired, and says whether it runs is unknown', async ($, on) => {
  const fault = { path: '' }
  const scene = await createScene(on, { failRead: path => path === fault.path })
  const { world, session } = scene
  fault.path = `${records}/host/${session}.json`
  delegate(world, [12])
  const handed = 'handed-off'
  world.files.set(`${records}/s/${handed}.json`, JSON.stringify({ ...JSON.parse(world.files.get(`${records}/s/${session}.json`) ?? '{}') as Record<string, unknown>, sessionId: handed }))
  world.files.set(`${records}/spawn/12.json`, JSON.stringify({ isStarted: true, isPrompted: true, mode: 'default', sessionId: handed, predecessors: [session] }))
  world.files.set(`${records}/host/${session}.json`, JSON.stringify(coordinatorHost))
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'handed off' })).toEqual({ isError: true,
    text: expect.stringContaining(`whether #12's superseded session ${session} runs on its own is unknown: the host record ${records}/host/${session}.json could not be read; nothing was removed`) })
  expect(await isIntact(scene)).toBe(true)
})

// contract: retiring a unit removes its stall record, so the unit spawned after it is reported afresh
test('retirement removes the unit\'s stall record', async ($, on) => {
  const scene = await createScene(on)
  delegate(scene.world, [12])
  scene.world.files.set(`${records}/stalls/12.json`, JSON.stringify({ v: 1, session: scene.session, stall: 'turn', key: `${scene.session}:turn:1` }))
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'stalled' })).toEqual({ text: expect.stringContaining('Retired #12\'s unit'), isError: false })
  expect(scene.world.files.has(`${records}/stalls/12.json`)).toBe(false)
})

// contract: retiring a unit moves its mailbox's messages into the archive, keeps its sequence file, and says how many it moved
test('retirement archives the unit\'s mailbox, counting unread, read and invalid messages, and keeps its sequence', async ($, on) => {
  const { world } = await createScene(on)
  delegate(world, [12])
  for (const path of ['new/a.1.json', 'cur/b.1.json', 'cur/c.1.json', 'bad/d.1.json']) world.files.set(`${records}/mail/12/${path}`, '{}')
  world.files.set(`${records}/mail/12/seq.json`, '7')
  expect((await runFlowCommand($, 'retire #12')).text).toContain('- 1 unread, 2 read and 1 invalid message(s) in its mailbox, moved into the archive')
  expect((await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).isError).toBe(false)
  expect([...world.files.keys()].filter(path => path.startsWith(`${records}/mail/12/`))).toEqual([`${records}/mail/12/seq.json`])
  const archived = [...world.files.keys()].filter(path => /\/retired\/12-[^/]+-mail\//.test(path)).map(path => path.replace(/^.*-mail\//, '')).sort()
  expect(archived).toEqual(['bad/d.1.json', 'cur/b.1.json', 'cur/c.1.json', 'new/a.1.json'])
  expect(world.runs.find(run => run.startsWith('gh issue comment 12 --body ## Delegated decision'))).toContain('1 unread, 2 read and 1 invalid message(s) move into the archive')
})

// contract: a reply to a message of a retired session is archived with that retirement and never reaches the new unit's mailbox
test('an answer to a question the retired session sent is kept in the retirement\'s archive, not delivered to the new unit', async ($, on) => {
  const { world } = await createScene(on)
  delegate(world, [12])
  world.files.set(`${records}/mail/coordinator-sid/new/q.1.json`, JSON.stringify({ v: 1, id: 'q', kind: 'question', from: '12', to: 'coordinator-sid', issue: 12,
    in_reply_to: '', seq: 1, created_at: new Date(world.clock.now()).toISOString(), expects: '', attempt: 1, body: 'A or B?', refs: [], author: 'agent' }))
  await world.clock.advance(5000)
  expect((await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).isError).toBe(false)
  expect(await callModTool($, 'send', { kind: 'answer', in_reply_to: 'q', body: 'A.' })).toEqual({ text: expect.stringContaining('Not delivered'), isError: false })
  expect([...world.files.keys()].filter(path => path.startsWith(`${records}/mail/12/new/`))).toEqual([])
  expect([...world.files.keys()].some(path => /\/retired\/12-[^/]+-mail\/late\/q-re-coordinator-sid\.json$/.test(path))).toBe(true)
})

// contract: the user's answer to a question a retired session asked is kept in the retirement's archive, and the question no longer waits in the inbox
test('the user\'s answer to a forwarded question of a retired session is archived, not delivered, and the question leaves the inbox', async ($, on) => {
  const { world } = await createScene(on)
  delegate(world, [12])
  world.files.set(`${records}/mail/user/new/q.1.json`, JSON.stringify({ v: 2, id: 'q', kind: 'question', from: '12', to: 'user', issue: 12, in_reply_to: '', seq: 1,
    created_at: new Date(world.clock.now()).toISOString(), expects: '', attempt: 1, body: 'A or B?', refs: [], author: 'agent', options: ['A', 'B'] }))
  world.files.set(`${records}/forwards/q.json`, JSON.stringify({ v: 1, id: 'q', coordinator: 'coordinator-sid', at: new Date(world.clock.now()).toISOString(), note: 'yours' }))
  expect((await runFlowCommand($, 'inbox')).text).toContain('/flow inbox answer q ')
  await world.clock.advance(5000)
  expect((await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).isError).toBe(false)
  expect((await runFlowCommand($, 'inbox')).text).not.toContain('/flow inbox answer q ')
  expect((await runFlowCommand($, 'inbox answer q a')).text).toContain('Not delivered')
  expect([...world.files.keys()].filter(path => path.startsWith(`${records}/mail/12/new/`))).toEqual([])
  expect([...world.files.keys()].some(path => /\/retired\/12-[^/]+-mail\/late\/q-re-user\.json$/.test(path))).toBe(true)
})

// contract: a cancel the retired session never replied to does not hold back a cancel to the unit spawned after the retirement
test('a cancel left open by a retired session does not stop the coordinator cancelling the respawned unit', async ($, on) => {
  const { world } = await createScene(on)
  delegate(world, [12])
  world.files.set(`${records}/mail/12/new/c.1.json`, JSON.stringify({ v: 2, id: 'c', kind: 'cancel', from: 'coordinator-sid', to: '12', issue: 12, in_reply_to: '', seq: 1,
    created_at: new Date(world.clock.now()).toISOString(), expects: '', attempt: 1, body: 'Stop.', refs: [], author: 'agent', options: [] }))
  await world.clock.advance(5000)
  expect((await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).isError).toBe(false)
  expect((await callModTool($, 'spawn', { number: 12 })).isError).toBe(false)
  expect(await callModTool($, 'unit_prompt', { number: 12, kind: 'cancel', text: 'Stop the new work.' })).toMatchObject({ isError: false })
})

// contract: retirement moves the unit's checkout aside with its uncommitted files and never removes a worktree or force-deletes a branch
test('retirement keeps the checkout aside and never deletes a worktree or force-deletes the branch', async ($, on) => {
  const scene = await createScene(on)
  delegate(scene.world, [12])
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).toEqual({ text: expect.stringContaining('Retired #12\'s unit'), isError: false })
  expect(listDeletions(scene.world)).toEqual([])
  const kept = Object.entries(scene.checkout.worktrees ?? {}).find(([path]) => path.startsWith(`${worktree}.retired-`))?.[1]
  expect(kept?.dirty).toEqual({ 'src/new.ts': 'new' })
})

// contract: the retired event is logged only once every step of the retirement has succeeded
// contract: a records removal that fails after the work is set aside leaves the archive record, so /flow report lists the retirement with its resume and reclaim commands, and the reply says how to finish
test('a retirement that stops on a failed step logs no retired event', async ($, on) => {
  const { world } = await createScene(on, { removeExitCode: 1 })
  delegate(world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining('retire_unit stopped: #12\'s retirement: session stopped; '), isError: true })
  expect(outcome.text).not.toContain('refused')
  expect(outcome.text).toContain('archive record written; removing its mailbox, records and transcript failed')
  expect(outcome.text).toContain('remove by hand whichever of these is left: ')
  expect(outcome.text).toContain(`Resume the work with: git -C '${aside}' switch -c`)
  expect((await runFlowCommand($, 'report')).text).toContain(`Retired`)
  expect((await runFlowCommand($, 'report')).text).toContain(`reclaim: git worktree remove --force '${aside}'`)
  await world.clock.advance(1)
  expect(world.files.get(`${records}/log/${await hashIdentity(branch, [12])}.jsonl`) ?? '').not.toContain('"event":"retired"')
})

// contract: a unit whose session does not end after its host closes it is not retired, and nothing of it is kept aside or removed
test('a session that does not end stops the retirement before anything changes', async ($, on) => {
  const scene = await createScene(on, {}, repository(), { isCloseIgnored: true })
  delegate(scene.world, [12])
  const retiring = callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  await scene.world.clock.advance(60000)
  expect(await retiring).toEqual({ text: expect.stringContaining('did not end after its host was asked to close it; nothing was removed'), isError: true })
  expect(await isIntact(scene)).toBe(true)
  expect(scene.world.runs.some(run => run.includes('refs/retired/') || run.startsWith('gh issue comment'))).toBe(false)
  expect(await hasLoggedRetired(scene.world)).toBe(false)
})

// contract: a branch that moves while the unit's session closes stops the retirement before anything is kept aside
test('a tip that moves during the close stops the retirement', async ($, on) => {
  const checkout = repository({ commits: { m0: { parents: [], files: {} }, u1: { parents: ['m0'], files: { a: '1' } }, u2: { parents: ['u1'], files: { a: '2' } } } })
  const onClose = (): void => { if (checkout.graph) checkout.graph = { ...checkout.graph, refs: { ...checkout.graph.refs, [branch]: 'u2' } } }
  const scene = await createScene(on, {}, checkout, { onClose })
  delegate(scene.world, [12])
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).toEqual({ text: expect.stringContaining(`#12's retirement: session stopped; `
    + `checkout kept at '${worktree}' and branch ${branch} kept; re-reading the plan failed: ${branch} or its worktree changed while the session closed`), isError: true })
  expect(await readRevision(scene.world, branch)).toBe('u2')
  expect(scene.checkout.worktrees?.[worktree]).toBeDefined()
  expect(scene.world.runs.some(run => run.includes('refs/retired/'))).toBe(false)
  expect(await hasLoggedRetired(scene.world)).toBe(false)
})

// contract: a unit workspace whose path is not the branch's worktree is refused before its session is closed
test('a workspace path that differs from the branch\'s worktree is refused', async ($, on) => {
  const scene = await createScene(on, {}, repository(), { path: '/wt/elsewhere' })
  delegate(scene.world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining('workspace holds \'/wt/elsewhere\''), isError: true })
  expect(outcome.text).toContain('nothing was removed')
  expect(await isIntact(scene)).toBe(true)
  expect(scene.world.runs.some(run => run.startsWith('herdr workspace close'))).toBe(false)
})

// contract: a session running in its unit's workspace never retires that unit, even when the workspace's path is not the branch's worktree
test('a session in the unit\'s workspace cannot retire it', async ($, on) => {
  const scene = await createScene(on, { cwd: '/wt/elsewhere/src' }, repository(), { path: '/wt/elsewhere' })
  expect((await runFlowCommand($, 'retire 12')).text).toContain('never retires itself')
  expect(await isIntact(scene)).toBe(true)
})

// contract: a session in a subdirectory of its unit's worktree never retires that unit
test('a session under the unit\'s worktree cannot retire it', async ($, on) => {
  const scene = await createScene(on, { cwd: `${worktree}/src` })
  expect((await runFlowCommand($, 'retire 12')).text).toContain('never retires itself')
  expect(await isIntact(scene)).toBe(true)
})

// contract: outside herdr the mod cannot stop a unit's session, so the user's /flow retire is refused and removes nothing
test('/flow retire outside herdr is refused and changes nothing', async ($, on) => {
  const scene = await createScene(on, { herdrEnv: { CLAUDE_CONFIG_DIR: claudeDir } })
  const reply = (await runFlowCommand($, 'retire 12 u1')).text
  expect(reply).toContain('does not run inside herdr')
  expect(reply).toContain('nothing was removed')
  expect(await isIntact(scene)).toBe(true)
  expect(listDeletions(scene.world)).toEqual([])
})

// contract: a branch with no worktree of its own whose detached checkout still holds its tip is refused, the checkout named, nothing removed
test('a detached checkout of the unit with no workspace is refused', async ($, on) => {
  const checkout = repository()
  checkout.worktrees = { '/repo': { branch: 'main' }, [worktree]: { branch: 'HEAD', head: 'u1', dirty: { 'src/new.ts': 'new' } } }
  const scene = await createScene(on, {}, checkout, { isAbsent: true })
  delegate(scene.world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining(`the checkout at '${worktree}' #12's session worked in is detached at u1`), isError: true })
  expect(outcome.text).toContain('nothing was removed')
  expect(await readRevision(scene.world, branch)).toBe('u1')
  expect(scene.checkout.worktrees?.[worktree]?.dirty).toEqual({ 'src/new.ts': 'new' })
  expect(scene.world.runs.some(run => run.includes('refs/retired/'))).toBe(false)
})

// contract: a unit whose session still runs with no herdr workspace the mod can close is refused, and its checkout is not moved under it
test('a live session without a workspace is refused', async ($, on) => {
  const unitProcess = { pid: 300, pidStart: '8000' }
  const scene = await createScene(on, {}, repository(), { isAbsent: true })
  delegate(scene.world, [12])
  scene.world.files.set(`${records}/host/${scene.session}.json`, JSON.stringify({ ...coordinatorHost, ...unitProcess }))
  scene.world.files.set(`/proc/${unitProcess.pid}/stat`, buildStat(unitProcess.pid, unitProcess.pidStart))
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining('#12\'s session still runs'), isError: true })
  expect(outcome.text).toContain('nothing was removed')
  expect(await isIntact(scene)).toBe(true)
  expect(scene.world.runs.some(run => run.includes('refs/retired/'))).toBe(false)
})

// contract: a unit with no workspace whose session recorded no process may still run, so it is refused, and the preview never says there is no session to close
test('a session of unknown liveness without a workspace is refused', async ($, on) => {
  const scene = await createScene(on, {}, repository(), { isAbsent: true })
  delegate(scene.world, [12])
  const preview = (await runFlowCommand($, 'retire #12')).text ?? ''
  expect(preview).toContain('- its session may still run with no herdr workspace to close, so retiring it is refused')
  expect(preview).not.toContain('no session to close')
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining('#12\'s session may still run'), isError: true })
  expect(outcome.text).toContain('nothing was removed')
  expect(await isIntact(scene)).toBe(true)
})

// contract: a unit with no workspace whose recorded process has ended is retired, its checkout moved aside
test('a session whose process ended is retired without a workspace', async ($, on) => {
  const scene = await createScene(on, {}, repository(), { isAbsent: true })
  delegate(scene.world, [12])
  scene.world.files.set(`${records}/host/${scene.session}.json`, JSON.stringify({ ...coordinatorHost, pid: 301, pidStart: '8001' }))
  expect((await runFlowCommand($, 'retire #12')).text).toContain('- no session to close: its recorded process has ended')
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).toEqual({ text: expect.stringContaining('Retired #12\'s unit'), isError: false })
  expect(scene.checkout.worktrees?.[aside]?.dirty).toEqual({ 'src/new.ts': 'new' })
})

// contract: a branch with no worktree whose checkout is detached at an older commit, as a stopped rebase, a bisect or a checkout of HEAD~n leaves it, is refused and named
test('a checkout detached at an ancestor of the tip with no workspace is refused', async ($, on) => {
  const checkout = repository()
  checkout.worktrees = { '/repo': { branch: 'main' }, [worktree]: { branch: 'HEAD', head: 'm0', dirty: { 'src/new.ts': 'new' } } }
  const scene = await createScene(on, {}, checkout, { isAbsent: true })
  delegate(scene.world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining(`the checkout at '${worktree}' #12's session worked in is detached at m0`), isError: true })
  expect(outcome.text).toContain('nothing was removed')
  expect(await readRevision(scene.world, branch)).toBe('u1')
  expect(scene.world.runs.some(run => run.includes('refs/retired/'))).toBe(false)
})

// contract: an unrelated detached checkout does not block a retirement whose transcript identifies the unit's own checkout
test('an unrelated detached checkout does not block a unit whose transcript identifies its checkout', async ($, on) => {
  const checkout = repository()
  checkout.worktrees = { ...checkout.worktrees, '/wt/feat/13-rebasing': { branch: 'HEAD', head: 'm0', dirty: { 'b.ts': 'mid-rebase' } } }
  const scene = await createScene(on, {}, checkout)
  delegate(scene.world, [12])
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).toEqual({ text: expect.stringContaining('Retired #12\'s unit'), isError: false })
  expect(scene.checkout.worktrees?.['/wt/feat/13-rebasing']).toEqual({ branch: 'HEAD', head: 'm0', dirty: { 'b.ts': 'mid-rebase' } })
  expect(scene.checkout.worktrees?.[aside]?.dirty).toEqual({ 'src/new.ts': 'new' })
})

// contract: when no transcript identifies the unit's checkout and its branch has no worktree, any linked checkout with a detached HEAD blocks the retirement, since it may hold the unit's work
test('a detached linked checkout elsewhere blocks retiring a branch with no worktree', async ($, on) => {
  const checkout = repository()
  checkout.worktrees = { '/repo': { branch: 'main' }, '/wt/bisect': { branch: 'HEAD', head: 'm0' } }
  const scene = await createScene(on, {}, checkout, { isAbsent: true })
  delegate(scene.world, [12])
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).toEqual({ text: expect.stringContaining('the checkout at \'/wt/bisect\' is detached at m0'), isError: true })
  expect(await readRevision(scene.world, branch)).toBe('u1')
})

// contract: the checkout the unit's session worked in, switched to another branch, is refused and named, whatever its HEAD
test('the unit\'s checkout switched to another branch with no workspace is refused', async ($, on) => {
  const checkout = repository({ refs: { main: 'm0', 'origin/main': 'm0', [branch]: 'u1', 'feat/other-work': 'u1' }, created: { [branch]: 'main' } })
  checkout.worktrees = { '/repo': { branch: 'main' }, [worktree]: { branch: 'feat/other-work', dirty: { 'src/new.ts': 'new' } } }
  const scene = await createScene(on, {}, checkout, { isAbsent: true })
  delegate(scene.world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining(`the checkout at '${worktree}' #12's session worked in is on feat/other-work`), isError: true })
  expect(await readRevision(scene.world, branch)).toBe('u1')
  expect(scene.checkout.worktrees?.[worktree]?.dirty).toEqual({ 'src/new.ts': 'new' })
})

// contract: a retirement whose tip ref cannot be written stops before the checkout moves, and, its session already stopped, says what it kept instead of that nothing was removed
test('a tip ref that cannot be written stops the retirement before the checkout moves', async ($, on) => {
  const checkout = repository()
  if (checkout.graph) checkout.graph.refs[`refs/retired/12/${stamp}`] = 'm0'
  const scene = await createScene(on, {}, checkout)
  delegate(scene.world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining(`#12's retirement: session stopped; checkout kept at '${worktree}' and branch ${branch} kept; `
    + `keeping the tip as refs/retired/12/${stamp} failed`), isError: true })
  expect(outcome.text).not.toContain('refused')
  expect(outcome.text).not.toContain('nothing was removed')
  expect(await isIntact(scene)).toBe(true)
  expect(await hasLoggedRetired(scene.world)).toBe(false)
})

// contract: a checkout git cannot move aside, as one holding submodules, keeps its branch and names the step that completed
test('a checkout that cannot be moved keeps the branch and names the ref already kept', async ($, on) => {
  const checkout = repository()
  checkout.worktrees = { ...checkout.worktrees, [aside]: { branch: 'HEAD', head: 'm0' } }
  const scene = await createScene(on, {}, checkout)
  delegate(scene.world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining(`#12's retirement: session stopped; tip of ${branch} kept as refs/retired/12/${stamp}; `
    + `checkout kept at '${worktree}' and branch ${branch} kept; moving the checkout aside to '${aside}' failed`), isError: true })
  expect(await isIntact(scene)).toBe(true)
  expect(await hasLoggedRetired(scene.world)).toBe(false)
})

// contract: a branch that moves after the plan was re-read is kept, its checkout moved aside and listed by /flow report, and the retirement reported as stopped
test('a branch that moves before its deletion is kept', async ($, on) => {
  const checkout = repository({ commits: { m0: { parents: [], files: {} }, u1: { parents: ['m0'], files: { a: '1' } }, u2: { parents: ['u1'], files: { a: '2' } } } })
  const beforeRun = (argv: string[]): void => {
    if (argv.includes('move') && checkout.graph) checkout.graph = { ...checkout.graph, refs: { ...checkout.graph.refs, [branch]: 'u2' } }
  }
  const scene = await createScene(on, { beforeRun }, checkout)
  delegate(scene.world, [12])
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).toEqual({ text: expect.stringContaining(`checkout kept at '${aside}' and branch ${branch} kept; `
    + `deleting branch ${branch} failed: it no longer points at u1`), isError: true })
  expect(await readRevision(scene.world, branch)).toBe('u2')
  expect(scene.checkout.worktrees?.[aside]?.dirty).toEqual({ 'src/new.ts': 'new' })
  expect((await runFlowCommand($, 'report')).text).toContain(`resume: git -C '${aside}' switch -c`)
  expect(listDeletions(scene.world)).toEqual([])
  expect(scene.world.runs.some(run => run.startsWith('gh issue comment'))).toBe(false)
  expect(await hasLoggedRetired(scene.world)).toBe(false)
})

// contract: a delegated decision that cannot be posted leaves the work set aside, reports the failure and logs no retired event
test('a decision comment that fails is reported and logs no retired event', async ($, on) => {
  const gh: Options['gh'] = args => args[0] === 'issue' && args[1] === 'comment' ? { exitCode: 1, stderr: 'HTTP 502' } : github(args)
  const scene = await createScene(on, { gh })
  delegate(scene.world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining('recording the decision failed: the delegated decision was not posted ('), isError: true })
  expect(outcome.text).toContain('post it on #12 with issue_comment:\n\n## Delegated decision')
  expect(outcome.text).toContain(`Reclaim its disk with: git worktree remove --force '${aside}'`)
  expect((await runFlowCommand($, 'report')).text).toContain(`resume: git -C '${aside}' switch -c`)
  expect(scene.checkout.worktrees?.[aside]?.dirty).toEqual({ 'src/new.ts': 'new' })
  expect(listDeletions(scene.world)).toEqual([])
  expect(await hasLoggedRetired(scene.world)).toBe(false)
})

// contract: a moved checkout whose HEAD cannot be detached keeps the branch, names where the checkout is, stays listed by /flow report and logs no retired event
test('a detach that fails keeps the branch and names the moved checkout', async ($, on) => {
  const scene = await createScene(on, { failing: `git -C ${aside} update-ref` })
  delegate(scene.world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining(`checkout moved to '${aside}'; checkout kept at '${aside}' and branch ${branch} kept; `
    + 'detaching its HEAD failed'), isError: true })
  expect(outcome.text).toContain(`archive record written.\nResume the work with: git -C '${aside}' switch -c`)
  expect((await runFlowCommand($, 'report')).text).toContain(`reclaim: git worktree remove --force '${aside}'`)
  expect(await readRevision(scene.world, branch)).toBe('u1')
  expect(scene.checkout.worktrees?.[aside]?.dirty).toEqual({ 'src/new.ts': 'new' })
  expect(await hasLoggedRetired(scene.world)).toBe(false)
})

// contract: an archive record that cannot be written stops the retirement before the mailbox, records and transcript go, and lists them to remove by hand
test('an archive record that cannot be written lists what is left to remove', async ($, on) => {
  const beforeRun = (argv: string[]): void => {
    if (argv[0] === 'mv' && /\/retired\/12-\d{8}T\d{6}Z\.json$/.test(argv.at(-1) ?? '')) throw new Error('disk full')
  }
  const scene = await createScene(on, { beforeRun })
  delegate(scene.world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect(outcome).toEqual({ text: expect.stringContaining('its mailbox, records and transcript are left in place, so remove by hand: '), isError: true })
  expect(outcome.text).toContain(`'${transcripts}/${scene.session}.jsonl'`)
  expect(outcome.text).toContain('writing the archive record failed')
  expect(outcome.text).toContain(`Reclaim its disk with: git worktree remove --force '${aside}'`)
  expect(scene.world.files.has(`${transcripts}/${scene.session}.jsonl`)).toBe(true)
  expect(await hasLoggedRetired(scene.world)).toBe(false)
})

test('/flow report lists a retired unit with its resume and reclaim commands', async ($, on) => {
  const { world } = await createScene(on)
  delegate(world, [12])
  await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect((await runFlowCommand($, 'report')).text).toMatch(/Retired +refs\/retired\/12\/\S+ · resume: git -C '\S+' switch -c \S+ · reclaim: git worktree remove --force '/)
})

test('retire_unit is refused outside the delegation scope and outside a coordinator, and changes nothing', async ($, on) => {
  const scene = await createScene(on)
  delegate(scene.world, [13])
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).toEqual({ text: expect.stringContaining('/flow retire 12'), isError: true })
  scene.world.files.delete(scopeFile('sid'))
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).toEqual({ text: expect.stringContaining('/flow retire 12'), isError: true })
  expect(await isIntact(scene)).toBe(true)
  expect(scene.world.runs.some(run => run.startsWith('gh issue comment'))).toBe(false)
})

test('a unit whose branch has a PR is refused and left in place', async ($, on) => {
  const withPr = await createScene(on, { prs: [{ number: 3, state: 'OPEN', headRefName: branch, headRefOid: 'u1', isCrossRepository: false, closingIssuesReferences: [] }] })
  delegate(withPr.world, [12])
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).toEqual({ text: expect.stringContaining('has PR'), isError: true })
  expect(await isIntact(withPr)).toBe(true)
})

test('a unit merged into its parent is refused', async ($, on) => {
  const merged = await createScene(on, {}, repository({ refs: { main: 'u1', 'origin/main': 'm0', [branch]: 'u1' }, moved: [branch] }))
  delegate(merged.world, [12])
  expect(await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })).toEqual({ text: expect.stringContaining('merged into main'), isError: true })
})

test('/flow retire previews, then retires on the id it showed, and refuses a stale id', async ($, on) => {
  const scene = await createScene(on)
  const preview = (await runFlowCommand($, 'retire #12')).text ?? ''
  expect(preview).toContain('deletes none of its work')
  expect(preview).toContain(`- transcript ${transcripts}/${scene.session}.jsonl`)
  expect(preview).toContain('Run /flow retire 12 u1 to retire it.')
  expect(await isIntact(scene)).toBe(true)
  expect((await runFlowCommand($, 'retire 12 u2')).text).toContain('/flow retire refused: ')
  expect(await isIntact(scene)).toBe(true)
  expect((await runFlowCommand($, 'retire 12 u1')).text).toContain('Retired #12\'s unit')
  expect(await readRevision(scene.world, branch)).toBe('')
  expect(scene.checkout.worktrees?.[aside]).toBeDefined()
  expect(listDeletions(scene.world)).toEqual([])
  expect(scene.world.runs.some(run => run.startsWith('gh issue comment'))).toBe(false)
})

// contract: a /flow retire preview that cannot be made answers in the shared outcome words and changes nothing
test('/flow retire previews a unit it cannot plan as refused, changing nothing', async ($, on) => {
  const scene = await createScene(on)
  expect((await runFlowCommand($, 'retire #99')).text).toContain('/flow retire refused: ')
  expect(await isIntact(scene)).toBe(true)
})

test('/flow retire from another origin than the prompt is refused', async ($, on) => {
  const scene = await createScene(on)
  expect((await runFlowCommand($, 'retire 12 u1', { kind: 'plugin', name: 'working-agreement' })).text).toContain('is the user\'s')
  expect(await isIntact(scene)).toBe(true)
})

test('a session in the unit\'s own worktree cannot retire it', async ($, on) => {
  const scene = await createScene(on, { cwd: worktree })
  expect((await runFlowCommand($, 'retire 12')).text).toContain('never retires itself')
  expect(await isIntact(scene)).toBe(true)
})

// contract: a coordinator tick that runs between a retirement's steps, the unit's process already ended by the workspace close and its spawn record not yet removed, reports no death to the user
test('a tick between a retirement\'s steps sends the user no dead report', async ($, on) => {
  const unitProcess = { pid: 300, pidStart: '8000' }
  const held: { world?: World; reached?: () => void } = {}
  const reached = new Promise<void>(resolve => { held.reached = resolve })
  // why: herdr ends the agent first, and the workspace leaves its list only when the close returns.
  const herdrDelayMs = (args: string[]): number => {
    if (args[0] !== 'workspace' || args[1] !== 'close') return 0
    held.world?.files.delete(`/proc/${unitProcess.pid}/stat`)
    held.reached?.()
    return 1000
  }
  const { world, session } = await createScene(on, { herdrDelayMs })
  held.world = world
  delegate(world, [12])
  world.files.set(`${records}/host/${session}.json`, JSON.stringify({ ...coordinatorHost, ...unitProcess }))
  world.files.set(`/proc/${unitProcess.pid}/stat`, buildStat(unitProcess.pid, unitProcess.pidStart))
  const retiring = callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  await reached
  await reportStalledUnits(createTestPort(world))
  await world.clock.advance(1000)
  expect(await retiring).toEqual({ text: expect.stringContaining('Retired #12\'s unit'), isError: false })
  expect([...world.files.keys()].filter(path => path.startsWith(`${records}/mail/user/new/`))).toEqual([])
})
