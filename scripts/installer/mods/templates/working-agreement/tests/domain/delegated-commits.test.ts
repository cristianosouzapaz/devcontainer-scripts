import { expect } from 'claude-code/testing'

import { readUnitSlice } from '../../hooks/core/unit-slice'
import { findDeniedWord, listScriptCandidates } from '../../hooks/domain/bash-guards'
import { composeSignScript, describeSigning, groupChains, nameSignScript } from '../../hooks/domain/delegated-commits'
import { hashObject } from '../../hooks/lib/git'
import type { SigningBranch, SigningChain, SigningPlan } from '../../hooks/domain/delegated-commits'
import { coordinator, guarded, noFlow } from '../support/builders'
import { callModTool, declareFlow, readFlowStatus, runFlowCommand } from '../support/helpers'
import { answerParents } from '../support/issue-github'
import { test } from '../support/kit'
import { readDelegated } from '../support/parallel-worktrees'
import { buildScope, configBlob, createTestPort, createWorld, delegatedFile, hashIdentity, markSpawned, records, root, scopeFile } from '../support/world'
import type { Checkout, Graph, Options, World } from '../support/world'

/** Holds the history change the next opaque Bash call makes. */
interface PendingChange { change?: (git: Graph) => Graph }

/** A delegation test's world, its live checkout and the change slot the next Bash call applies. */
interface Arranged { world: World; checkout: Checkout; pending: PendingChange }


/** An approved Verify config whose runners are a project script and a tool, as any project may name its own. */
const runnerConfig = '{"always":[["scripts/check.sh"]],"rules":[{"paths":["src/**"],"run":["tools/suite","unit"]}]}'

/** Skill directories reached through symlinks: one into the repository, as `.claude/skills/<name>` points at `.agents/skills/<name>`, one out of it. */
const skillLinks = { [`${root}/.claude/skills/ds`]: `${root}/.agents/skills/ds`, [`${root}/.claude/skills/out`]: '/tmp/s' }

/**
 * Builds a repository whose unit branch `feat` and side branch `other` start at the default branch, with the git alias `pu`.
 * @returns The history.
 */
const graph = (): Graph => ({
  commits: { a: { parents: [], files: { f: 'a' } } }, refs: { main: 'a', 'origin/main': 'a', feat: 'a', other: 'a' }, aliases: { pu: 'push' },
})

/**
 * Adds a commit on a branch without altering the input graph.
 * @param git - The history before the commit.
 * @param branch - The branch the commit lands on.
 * @param isSigned - Whether the commit carries a signature.
 * @returns The history with the branch advanced to `b`.
 */
const commitOn = (git: Graph, branch: string, isSigned = false): Graph => ({
  ...git, commits: { ...git.commits, b: { parents: [git.refs[branch] ?? ''], files: { f: 'b' }, isSigned } }, refs: { ...git.refs, [branch]: 'b' },
})

/**
 * Arranges a unit session on `feat` for issue 3, delegated by the coordinator `coord` unless told otherwise.
 * @param on - The hook registrar.
 * @param isDelegated - Whether a scope delegates issue 3.
 * @param options - Further world options.
 * @returns The world, the live checkout and the change slot the next Bash call applies.
 */
function arrange(on: Parameters<typeof createWorld>[0], isDelegated = true, options: Options = {}): Arranged {
  const checkout: Checkout = { branch: 'feat', graph: graph() }
  const pending: PendingChange = {}
  const world = createWorld(on, checkout, { session: noFlow, ...options, afterTool: () => {
    if (pending.change) checkout.graph = pending.change(checkout.graph!)
    delete pending.change
  } })
  markSpawned(world, [3])
  if (isDelegated) world.files.set(scopeFile('coord'), buildScope('coord', [3]))
  return { world, checkout, pending }
}

test('a delegated unit\'s unsigned commit on its own branch is recorded as delegated, not as a violation', async ($, on) => {
  const { world, pending } = arrange(on)
  await declareFlow($, 'fix', [3])
  pending.change = git => commitOn(git, 'feat')
  const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
  expect(result.context?.join('') ?? '').not.toContain('a commit appeared')
  expect(world.sessions.get('sid')?.violations ?? []).toEqual([])
  expect(readDelegated(world)).toEqual([expect.objectContaining({ v: 1, sha: 'b', branch: 'feat' })])
})

for (const [name, isDelegated, branch, isSigned] of [
  ['a commit on another branch', true, 'other', false],
  ['a signed commit', true, 'feat', true],
  ['a commit without delegation', false, 'feat', false],
] as const) {
  test(`${name} stays a violation`, async ($, on) => {
    const { world, pending } = arrange(on, isDelegated)
    await declareFlow($, 'fix', [3])
    pending.change = git => commitOn(git, branch, isSigned)
    const result = await $.tool.call({ tool: 'Bash', command: 'opaque' })
    expect(result.context?.join('')).toContain('a commit appeared')
    expect(world.sessions.get('sid')?.violations?.[0]?.kind).toBe('commit')
    expect(readDelegated(world)).toEqual([])
  })
}

for (const command of ['git push origin feat', 'git rebase main', 'git branch -D other', 'gh pr create --fill', 'gh api repos/o/r/pulls -f title=x', 'gh api repos/o/r/pulls -ftitle=x', 'git pu']) {
  test(`a delegated unit's ${command} is refused before it runs`, async ($, on) => {
    arrange(on)
    await declareFlow($, 'fix', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('Under delegation this command is refused')
  })
}

for (const command of ['claude plugin test .', 'cd /repo && ./scripts/check.sh', 'scripts/check.sh --fast', 'bash scripts/check.sh', 'tools/suite unit',
  '/repo/tools/suite', 'bats tests/unit', 'npx bats x.bats']) {
  test(`a delegated unit's ${command} is refused for the run and verify tools`, async ($, on) => {
    arrange(on, true, { verifyFile: runnerConfig, approvedConfig: runnerConfig })
    await declareFlow($, 'small-feature', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('the run tool')
  })
}

test('a script no approved Verify config runs is no heavy test run', async ($, on) => {
  arrange(on, true, { verifyFile: runnerConfig, approvedConfig: runnerConfig })
  await declareFlow($, 'small-feature', [3])
  expect((await $.tool.call({ tool: 'Bash', command: 'scripts/free.sh' })).deny).toBeUndefined()
})

test('a runner the unit removed from its tree\'s config is still refused while the approved config runs it', async ($, on) => {
  const { checkout } = arrange(on, true, { verifyFile: '{"always":[["scripts/check.sh"]]}', approvedConfig: runnerConfig })
  checkout.graph = { ...checkout.graph!, blobs: { [configBlob(runnerConfig)]: runnerConfig } }
  await declareFlow($, 'small-feature', [3])
  expect((await $.tool.call({ tool: 'Bash', command: 'tools/suite unit' })).deny).toContain('the run tool')
})

test('when the approved config cannot be read, a runner of the tree\'s config is refused too', async ($, on) => {
  const tree = '{"always":[["scripts/other.sh"]]}'
  const { world } = arrange(on, true, { verifyFile: tree, approvedConfig: runnerConfig })
  world.files.set(`${root}/.claude/working-agreement.json`, tree)
  await declareFlow($, 'small-feature', [3])
  expect((await $.tool.call({ tool: 'Bash', command: 'scripts/other.sh' })).deny).toContain('the run tool')
})

for (const [command, isDelegated] of [['claude plugin test .', false], ['grep -rn bats test', true], ['cat scripts/check.sh', true]] as const) {
  test(`${command} is no test run ${isDelegated ? 'under' : 'without'} delegation`, async ($, on) => {
    arrange(on, isDelegated)
    await declareFlow($, 'small-feature', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  })
}

for (const command of ['bash /tmp/s/commit.sh', 'python3 -u /tmp/s/commit.py', 'source /tmp/s/commit.sh', '. /tmp/s/commit.sh', 'node /tmp/s/commit.js']) {
  test(`a delegated unit's ${command} running an untracked script is refused before it runs`, async ($, on) => {
    const { world } = arrange(on)
    for (const name of ['commit.sh', 'commit.py', 'commit.js']) world.files.set(`/tmp/s/${name}`, 'git push origin feat\n')
    await declareFlow($, 'fix', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('untracked script')
  })
}

// contract: a tracked script reached through a symlinked directory runs under delegation
test('a delegated unit runs a tracked script reached through a symlinked directory', async ($, on) => {
  const { world, checkout } = arrange(on, true, { symlinks: skillLinks })
  world.files.set(`${root}/.agents/skills/ds/scripts/check.py`, 'print(1)\n')
  await declareFlow($, 'fix', [3])
  // why: the index decides what ls-files counts as tracked, so a staged file stands in for a committed one.
  checkout.staged = { '.agents/skills/ds/scripts/check.py': 'print(1)\n' }
  expect((await $.tool.call({ tool: 'Bash', command: 'python3 .claude/skills/ds/scripts/check.py' })).deny).toBeUndefined()
})

for (const command of ['python3 .claude/skills/ds/scripts/new.py', 'bash .claude/skills/out/commit.sh']) {
  // contract: an untracked script behind a symlink, or a symlink that leaves the repository, is still refused under delegation
  test(`a delegated unit's ${command} behind a symlink is still refused as untracked`, async ($, on) => {
    const { world } = arrange(on, true, { symlinks: skillLinks })
    world.files.set(`${root}/.agents/skills/ds/scripts/new.py`, 'print(1)\n')
    world.files.set('/tmp/s/commit.sh', 'echo hi\n')
    await declareFlow($, 'fix', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('untracked script')
  })
}

for (const [command, isDelegated] of [['bash f', true], ['python3 -m pytest', true], ['bash /tmp/s/commit.sh', false]] as const) {
  test(`${command} runs ${isDelegated ? 'under' : 'without'} delegation`, async ($, on) => {
    const { world } = arrange(on, isDelegated)
    world.files.set('/tmp/s/commit.sh', 'git push origin feat\n')
    world.files.set('/repo/f', 'a')
    await declareFlow($, 'fix', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  })
}

for (const command of ['git commit -F msg', 'git -c commit.gpgsign=false commit -F msg', 'git -C . commit -m x']) {
  test(`a delegated unit's ${command} is refused for the commit tool`, async ($, on) => {
    arrange(on)
    await declareFlow($, 'fix', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('commit tool')
  })
}

test('a delegated unit\'s commit tool commits its staged work unsigned on its own branch and records it as delegated', async ($, on) => {
  const { world, checkout } = arrange(on)
  await declareFlow($, 'small-feature', [3])
  checkout.staged = { f: 'b' }
  const result = await callModTool($, 'commit', { message: 'fix: change' })
  expect(result.isError).toBe(false)
  expect(checkout.graph?.refs.feat).toBe('commit-a')
  expect(readDelegated(world)).toEqual([expect.objectContaining({ v: 1, sha: 'commit-a', branch: 'feat' })])
  expect(world.sessions.get('sid')?.violations ?? []).toEqual([])
})

// contract: a commit the tool records is logged as one delegated-commit event, though the call's own window sees the same commit
test('a delegated unit\'s commit through the tool is logged once', async ($, on) => {
  const { world, checkout } = arrange(on)
  await declareFlow($, 'small-feature', [3])
  checkout.staged = { f: 'b' }
  expect(await callModTool($, 'commit', { message: 'fix: change' })).toMatchObject({ isError: false })
  await world.clock.settle()
  const log = world.files.get(`${records}/log/${await hashIdentity('feat', [3])}.jsonl`) ?? ''
  expect(log.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.event === 'delegated-commit'))
    .toEqual([expect.objectContaining({ shas: 'commit-a' })])
})

// contract: a commit through the commit tool after a passing Verify sends the unit back to Code, never sets Verify aside
test('a delegated unit\'s commit through the tool after Verify still reads changed after Verify on Code', async ($, on) => {
  const config = '{"always":[["check"]]}'
  const { checkout } = arrange(on, true, { verifyFile: config, approvedConfig: config })
  // why: the config is committed, so each commit leaves the slice clean, as a set-aside needs.
  const blob = configBlob(config)
  checkout.graph = { ...checkout.graph!, commits: { a: { parents: [], files: { f: 'a', '.claude/working-agreement.json': blob } } }, blobs: { [blob]: config } }
  await declareFlow($, 'small-feature', [3])
  await runFlowCommand($, 'skip grill settled on the issue')
  await runFlowCommand($, 'skip spec settled on the issue')
  checkout.staged = { f: 'b' }
  expect(await callModTool($, 'commit', { message: 'feat: first' })).toMatchObject({ isError: false })
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Verify passed')
  checkout.staged = { f: 'c' }
  expect(await callModTool($, 'commit', { message: 'feat: second' })).toMatchObject({ isError: false })
  const status = await readFlowStatus($)
  expect(status).toContain('▸ Code · changed after Verify')
  expect(status).not.toContain('committed outside Verify')
  // why: the user's re-sign gives the tool's commit a new id; its change still marks it as made through the tool.
  const graph = checkout.graph!
  const tip = graph.commits[graph.refs.feat!]!
  checkout.graph = { ...graph, commits: { ...graph.commits, resigned: { ...tip, isSigned: true } }, refs: { ...graph.refs, feat: 'resigned' } }
  const resigned = await readFlowStatus($)
  expect(resigned).toContain('▸ Code · changed after Verify')
  expect(resigned).not.toContain('committed outside Verify')
})

// contract: a unit spawned for a delegated group that declares the group and its native sub-issues is delegated, so its commit tool commits
test('a unit that declares its delegated group and the group\'s sub-issues commits through the tool', async ($, on) => {
  const { world, checkout } = arrange(on, true, { gh: answerParents({ 31: 3 }) })
  await declareFlow($, 'small-feature', [3, 31])
  checkout.staged = { f: 'b' }
  expect(await callModTool($, 'commit', { message: 'fix: change' })).toMatchObject({ isError: false })
  expect(readDelegated(world)).toEqual([expect.objectContaining({ v: 1, sha: 'commit-a', branch: 'feat' })])
})

// contract: a sub-issue's native parent, once read, keeps the unit delegated through a later GitHub outage
test('a unit that declares its group\'s sub-issues keeps committing through a GitHub outage after the parent was read', async ($, on) => {
  const github = { isDown: false }
  const parents = answerParents({ 31: 3 })
  const { world, checkout } = arrange(on, true, { gh: args => github.isDown ? { exitCode: 1, stderr: 'offline' } : parents(args) })
  await declareFlow($, 'small-feature', [3, 31])
  checkout.staged = { f: 'b' }
  expect(await callModTool($, 'commit', { message: 'fix: change' })).toMatchObject({ isError: false })
  github.isDown = true
  checkout.staged = { f: 'c' }
  expect(await callModTool($, 'commit', { message: 'fix: more' })).toMatchObject({ isError: false })
  expect(readDelegated(world)).toHaveLength(2)
})

for (const [name, gh] of [['whose native parent is outside the scope', answerParents({ 31: 9 })], ['whose native parent cannot be read', () => ({ exitCode: 1, stderr: 'offline' })]] as const) {
  // contract: a declared issue the scope neither names nor holds as a native parent, or whose parent cannot be read, keeps the unit undelegated
  test(`a unit that declares an issue ${name} is refused the commit tool`, async ($, on) => {
    const { world, checkout } = arrange(on, true, { gh })
    await declareFlow($, 'small-feature', [3, 31])
    checkout.staged = { f: 'b' }
    expect(await callModTool($, 'commit', { message: 'fix: change' })).toEqual({ text: expect.stringContaining('only a delegated unit commits through this tool'), isError: true })
    expect(readDelegated(world)).toEqual([])
  })
}

for (const [name, isDelegated, branch] of [['without delegation', false, 'feat'], ['on another branch', true, 'other']] as const) {
  test(`the commit tool is refused ${name}`, async ($, on) => {
    const { world, checkout } = arrange(on, isDelegated)
    await declareFlow($, 'fix', [3])
    checkout.branch = branch
    checkout.staged = { f: 'b' }
    expect((await callModTool($, 'commit', { message: 'fix: change' })).isError).toBe(true)
    expect(checkout.graph?.refs[branch]).toBe('a')
    expect(readDelegated(world)).toEqual([])
  })
}

for (const [command, isDelegated] of [['gh pr view 3', true], ['gh pr diff 3', true], ['gh api -X GET repos/o/r/pulls -f state=open', true], ['git merge-base main feat', true], ['git push origin feat', false]] as const) {
  test(`${command} runs ${isDelegated ? 'under' : 'without'} delegation`, async ($, on) => {
    arrange(on, isDelegated)
    await declareFlow($, 'fix', [3])
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toBeUndefined()
  })
}

test('the word guard refuses git when the aliases are unreadable', () => {
  expect(findDeniedWord('git status', null)).toBeDefined()
  expect(findDeniedWord('ls st', ['st'])).toBeUndefined()
  expect(findDeniedWord('GIT_DIR=/x git log', [])).toBe('`GIT_DIR`')
  expect(findDeniedWord('bash -c "git log"', [])).toBe('`bash -c`')
})

test('a script candidate is an interpreter\'s operand within its own simple command, and `.` sources only where a command starts', () => {
  expect(listScriptCandidates('bash -x a.sh b; cat c')).toEqual([['a.sh', 'b']])
  expect(listScriptCandidates('node --version && cat /tmp/x')).toEqual([[]])
  expect(listScriptCandidates('find . -name x.sh')).toEqual([])
  expect(listScriptCandidates('cd /r && . ./env.sh')).toEqual([['./env.sh']])
  expect(listScriptCandidates('/usr/bin/env python3 < /tmp/x.py')).toEqual([['/tmp/x.py']])
})

test('the chains group every merged child under its head and leave an unmerged child a chain of its own', () => {
  const branch = (name: string, parent: string | null, isMerged = false, root: string | null = null): SigningBranch => ({ branch: name, root, parent, isMerged })
  const chains = groupChains([branch('child', 'feat'), branch('done', 'feat', true, '/done'), branch('feat', null, false, '/feat')])
  expect(chains.map(({ head, children }) => [head.branch, children.map(child => child.branch)])).toEqual([['child', []], ['feat', ['done']]])
})

test('the sign script is named by the issue of a single chain, by the branch without an issue number, and all for several chains', () => {
  expect(nameSignScript(['chore/518-integrate-the-round'])).toBe('518.sh')
  expect(nameSignScript(['hotfix/login'])).toBe('hotfix-login.sh')
  expect(nameSignScript(['chore/518-a', 'feat/527-b'])).toBe('all.sh')
})

test('the sign script quotes every name and holds the phases the user reviews', () => {
  const script = composeSignScript([{ branch: 'feat/1-it\'s', root: '/my repo', children: ['kid'] }], 'main')
  expect(script).toContain('"$@" \'/my repo\' \'origin/main\' \'feat/1-it\'\\\'\'s\' \'kid\'')
  for (const phase of ['Phase 1, pre-check', 'Phase 2, verify capability', 'Phase 3, re-create', 'Phase 4, checks', 'Phase 5, move refs', '--dry-run']) expect(script).toContain(phase)
})

/**
 * Builds a chain for the summary.
 * @param branch - The head.
 * @param patch - The fields to change.
 * @returns The chain.
 */
const chain = (branch: string, patch: Partial<SigningChain> = {}): SigningChain => ({ branch, root: `/${branch.split('/')[1]}`, commits: 5, unsigned: 4, children: [], strays: [], ...patch })

test('the summary of one chain labels the commits, child refs, checks and pre-check, then the steps', () => {
  const plan: SigningPlan = { base: 'main', verify: 'off (no allowedSignersFile)', path: '/r/.git/working-agreement/sign/518.sh', chains: [chain('chore/518-round', { children: ['feat/402-a', 'feat/501-b'] })] }
  expect(describeSigning(plan)).toBe([
    '', '',
    'To sign  chore/518-round',
    '  Commits      5 above origin/main (4 unsigned, 1 signed)',
    '  Child refs   2 move with it (#402 #501)',
    '  Checks       tree unchanged · every commit signed · verify: off (no allowedSignersFile)',
    '  Pre-check    ✔ every child is inside the head',
    '', 'Run',
    '  1. bash /r/.git/working-agreement/sign/518.sh --dry-run    # lists, moves nothing',
    '  2. bash /r/.git/working-agreement/sign/518.sh',
    '  3. git -C /518-round push -u origin chore/518-round',
  ].join('\n'))
})

test('the summary of several chains is a table with a row per chain, one script and the pushes in order', () => {
  const plan: SigningPlan = { base: 'main', verify: 'on', path: '/r/.git/working-agreement/sign/all.sh', chains: [chain('chore/518-a', { children: ['kid'] }), chain('feat/527-b', { strays: [{ branch: 'feat/9-x', commits: ['abc1234'] }] })] }
  const text = describeSigning(plan)
  expect(text).toContain('To sign  2 chains above origin/main')
  expect(text).toMatch(/\n {2}chore\/518-a +5 +4 +1 +✔ every child is inside the head\n/)
  expect(text).toMatch(/\n {2}feat\/527-b +5 +4 +0 +✘ #9 has abc1234 outside the head/)
  expect(text.split('\n').filter(line => /^ {2}\d\. /.test(line))).toEqual([
    '  1. bash /r/.git/working-agreement/sign/all.sh --dry-run    # lists, moves nothing', '  2. bash /r/.git/working-agreement/sign/all.sh',
    '  3. git -C /518-a push -u origin chore/518-a', '  4. git -C /527-b push -u origin feat/527-b',
  ])
})

test('nothing is said when no chain is left to sign', () => {
  expect(describeSigning(null)).toBe('')
})

test('/flow delegate stop gives the re-sign and push commands per branch chain', async ($, on) => {
  const git: Graph = {
    commits: { a: { parents: [], files: { f: 'a' } }, b: { parents: ['a'], files: { f: 'b' } }, c: { parents: ['b'], files: { f: 'c' } } },
    refs: { main: 'a', 'origin/main': 'a', feat: 'b', child: 'c' }, created: { child: 'feat' },
  }
  const world = createWorld(on, { branch: 'main', graph: git, worktrees: { '/repo': { branch: 'main' }, '/feat': { branch: 'feat' } } }, { session: coordinator })
  world.files.set(scopeFile('sid'), buildScope('sid', [3]))
  world.files.set(delegatedFile('k1'), JSON.stringify({ v: 1, key: 'k1', sha: 'b', branch: 'feat' }))
  world.files.set(delegatedFile('k2'), JSON.stringify({ v: 1, key: 'k2', sha: 'c', branch: 'child' }))
  const text = (await runFlowCommand($, 'delegate stop')).text ?? ''
  expect(text).toContain('Delegation stopped\n  Scope        #3 → yours again\n  Ruleset      signed commits required')
  expect(text).toContain('To sign  2 chains above origin/main')
  expect(text.split('\n').filter(line => /^ {2}\d\. /.test(line)).map(line => line.trim())).toEqual([
    '1. bash /repo.git/working-agreement/sign/all.sh --dry-run    # lists, moves nothing', '2. bash /repo.git/working-agreement/sign/all.sh',
    '3. git push -u origin child', '4. git -C /feat push -u origin feat',
  ])
  expect(world.files.get('/repo.git/working-agreement/sign/all.sh')).toContain('\'/feat\' \'origin/main\' \'feat\'')
})

for (const [name, options, isUnguarded] of [
  ['without', {}, true],
  ['with', guarded(), false],
] as [string, Options, boolean][]) {
  test(`/flow delegate ${name} a signed-commit ruleset ${isUnguarded ? 'shows' : 'does not show'} its absence`, async ($, on) => {
    const world = createWorld(on, { branch: 'feat' }, { session: coordinator, ...options })
    await runFlowCommand($, 'delegate #3')
    const row = world.views.at(-1)?.meta.find(entry => entry.key === 'Delegating')
    expect(row?.value).toBe(isUnguarded ? '#3 · no signed-commit ruleset' : '#3')
  })
}

test('a base naming a delegated commit follows the signing rebase instead of reading as rewritten', async (_$, on) => {
  const checkout: Checkout = { branch: 'feat', graph: {
    commits: {
      a: { parents: [], files: { f: 'a' } }, b: { parents: ['a'], files: { f: 'b' } },
      signed: { parents: ['a'], files: { f: 'b' }, isSigned: true }, c: { parents: ['signed'], files: { f: 'c' }, isSigned: true },
    },
    refs: { main: 'a', 'origin/main': 'a', feat: 'c' },
  } }
  const world = createWorld(on, checkout, { session: noFlow })
  const port = createTestPort(world)
  const diff = await port.processes.run(['git', 'diff-tree', '-r', '--no-commit-id', '-m', 'b'], { timeoutMs: 5000 })
  const key = (await hashObject(port.processes, diff.stdout.trim())).stdout.trim()
  world.files.set(delegatedFile(key), JSON.stringify({ v: 1, key, sha: 'b', branch: 'parent' }))
  const identity = { branch: 'feat', issues: [3] }
  const git = { root: '/repo', branch: 'feat', head: 'c', base: 'main', isUpToDate: true }
  const unit = { base: 'b', skills: [], verifyRuns: [], runs: [] }
  expect(await readUnitSlice(port, identity, unit, git, false)).toEqual(expect.objectContaining({ base: 'signed', isRewritten: false, commits: 1 }))
  world.files.delete(delegatedFile(key))
  expect((await readUnitSlice(port, identity, unit, git, false))?.isRewritten).toBe(true)
})
