import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

import { deriveSessionId } from '../../hooks/core/spawn'
import { coordinator } from '../support/builders'
import { callModTool, inside, readRevision, runFlowCommand } from '../support/helpers'
import { defaultIssueLabels } from '../support/issue-github'
import { test } from '../support/kit'
import { buildScope, common, createWorld, declarationFile, hashIdentity, markSpawned, records, scopeFile } from '../support/world'
import type { Checkout, Graph, Options, World } from '../support/world'

/** A herdr workspace the fake server holds: its label, checkout and whether an agent runs in its pane. */
interface Workspace { id: string; label: string; path: string; hasAgent?: boolean }

/** A retirement scene: its world, its repository and the unit's session id. */
interface Scene { world: World; checkout: Checkout; session: string }

const branch = 'feat/12-redo-the-unit'
const worktree = `/wt/${branch}`
const claudeDir = '/claude'
const transcripts = `${claudeDir}/projects/-wt-feat-12-redo-the-unit`

/**
 * Answers herdr like a live server: it opens and removes labelled worktree workspaces, and a removal drops the git worktree too.
 * @param workspaces - The open workspaces.
 * @param checkout - The repository, whose worktrees a removal changes.
 * @returns The world's herdr reply.
 */
const herdrServer = (workspaces: Workspace[], checkout: Checkout): Options['herdrReply'] => args => {
  const [noun, verb] = args
  const option = (name: string): string => args[args.indexOf(name) + 1] ?? ''
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
  return '{}'
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
 * Builds main on m0 and #12's unit branch one commit past it, checked out in its own worktree with an untracked file.
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
 * Creates a coordinator inside herdr with #12's spawned unit: its workspace, session mirror, declaration, spawn record and transcript.
 * @param on - The test's hook registration.
 * @param options - Options replacing the coordinator defaults.
 * @param checkout - The repository.
 * @returns The scene.
 */
async function createScene(on: On, options: Options = {}, checkout = repository()): Promise<Scene> {
  const workspaces = [{ id: 'w1', label: 'wa-spawn:12', path: worktree, hasAgent: true }]
  const world = createWorld(on, checkout, { session: coordinator, herdrEnv: { ...inside, CLAUDE_CONFIG_DIR: claudeDir },
    herdrReply: herdrServer(workspaces, checkout), gh: github, ...options })
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

test('a delegating coordinator retires an in-scope unit: archive first, a delegated decision, everything removed, and a fresh spawn after', async ($, on) => {
  const scene = await createScene(on)
  const { world, session } = scene
  delegate(world, [12])
  const outcome = await callModTool($, 'retire_unit', { number: 12, reason: 'cut from the wrong base' })
  expect(outcome).toEqual({ text: expect.stringContaining('Retired #12\'s unit'), isError: false })
  const ref = outcome.text.match(/refs\/retired\/12\/\S+?(?=[ ;])/)?.[0] ?? ''
  expect(await readRevision(world, ref)).toBe('u1')
  const patch = [...world.files.keys()].find(path => path.startsWith(`${records}/retired/12-`) && path.endsWith('.patch')) ?? ''
  expect(world.files.get(patch)).toContain('src/new.ts')
  expect(outcome.text).toContain(`restore with: git worktree add ${worktree} -b ${branch} ${ref} && git -C ${worktree} apply --index ${patch}`)
  const comment = world.runs.find(run => run.startsWith('gh issue comment 12 --body ## Delegated decision')) ?? ''
  expect(comment).toContain('### Reason\ncut from the wrong base')
  expect(comment).toContain(ref)
  expect(world.runs).toContain('herdr worktree remove --workspace w1 --force')
  expect(await readRevision(world, branch)).toBe('')
  for (const path of ['spawn/12.json', `s/${session}.json`, `u/${await hashIdentity(branch, [12])}.json`]) expect(world.files.has(`${records}/${path}`)).toBe(false)
  expect(world.files.has(`${transcripts}/${session}.jsonl`)).toBe(false)
  await world.clock.advance(1)
  expect(world.files.get(`${records}/log/${await hashIdentity(branch, [12])}.jsonl`)).toContain('"event":"retired"')
  const spawned = await callModTool($, 'spawn', { number: 12 })
  expect(spawned).toEqual({ text: expect.stringContaining('started'), isError: false })
  expect(world.runs.find(run => run.startsWith('herdr agent start issue-12'))).toContain(`--session-id ${session}`)
})

test('/flow report lists a retired unit with its restore command', async ($, on) => {
  const { world } = await createScene(on)
  delegate(world, [12])
  await callModTool($, 'retire_unit', { number: 12, reason: 'redo' })
  expect((await runFlowCommand($, 'report')).text).toMatch(/Retired +refs\/retired\/12\/\S+ · restore: git worktree add /)
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
  expect(preview).toContain('archives, before removing anything')
  expect(preview).toContain(`- transcript ${transcripts}/${scene.session}.jsonl`)
  expect(preview).toContain('Run /flow retire 12 u1 to retire it.')
  expect(await isIntact(scene)).toBe(true)
  expect((await runFlowCommand($, 'retire 12 u2')).text).toContain('Not retired')
  expect(await isIntact(scene)).toBe(true)
  expect((await runFlowCommand($, 'retire 12 u1')).text).toContain('Retired #12\'s unit')
  expect(await readRevision(scene.world, branch)).toBe('')
  expect(scene.world.runs.some(run => run.startsWith('gh issue comment'))).toBe(false)
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
