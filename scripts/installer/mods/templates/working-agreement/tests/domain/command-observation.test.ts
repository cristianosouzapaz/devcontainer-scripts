import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { ToolRun } from '../../hooks/core/command-observation'
import { buildBashCall, buildWriteCall, twoIssueCloseOut, verifyFile } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, readPromptContext, runFlowCommand, setPermissionMode, startSkill } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Checkout, Options } from '../support/world'

/** How a case runs its command: as a Bash call of its own, or launched in a herdr pane and read back with wait-output. */
type Via = 'direct' | 'herdr'

/** Switches the tool result the world returns from the next call on. */
type SetToolRun = (run: ToolRun) => void

/** A tool result source for a world, and the switch that changes what it returns. */
interface ToolRunChannel { source: () => ToolRun; setToolRun: SetToolRun }

/**
 * A command the steps observe: the world it runs in, what the test does first, the exit code whose effect is observed,
 * and a probe that tells whether the effect landed.
 */
interface ObservedCase {
  name: string
  command: string
  git: () => Checkout
  options: () => Options
  setup?: ($: Engine) => Promise<void>
  effectOn: 0 | 1
  isObserved: ($: Engine) => Promise<boolean>
}

/** A command run through `runCommandVia`: how it runs, the exit code it ends with, what a direct run prints, and a label that keeps its herdr marker id unique. */
interface ViaRun { via: Via; command: string; exitCode: 0 | 1; output: string; label: string }

/** A direct call whose git or PR operation only the engine's report shows, and the probe of its effect. */
interface ReportedOnlyCase { name: string; command: string; reported: ToolRun; isObserved: ($: Engine) => Promise<boolean> }

/** An issue gh lists, with its creation time relative to the launch. */
interface ListedIssue { number: number; title: string; offsetMs: number }

/** A herdr run of gh issue create whose issue cannot be told apart: the command, and the issues gh lists. */
interface UnmatchedIssueCase { name: string; command: string; listed: ListedIssue[] }

const quiet: ToolRun = { result: { stdout: '' } }
const closes = 'Closes #1\nCloses #2'

const cases: ObservedCase[] = [
  {
    name: 'the verify command',
    command: './test/run.sh',
    git: () => ({ branch: 'feat', isDirty: true }),
    options: () => ({ verifyFile }),
    effectOn: 0,
    isObserved: async $ => (await readCurrentStep($)) === 'Commit',
  },
  {
    name: 'a single test file',
    command: 'bats test/fix.bats',
    git: () => ({ branch: 'fix', hashes: { 'test/fix.bats': 'h1' } }),
    options: () => ({ session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } }, unit: { skills: ['diagnosing-bugs'], start: 'c0' }, verifyFile }),
    setup: async $ => { await $.tool.call(buildWriteCall('test/fix.bats')) },
    effectOn: 1,
    isObserved: async $ => (await readCurrentStep($)) === 'Code',
  },
  {
    name: 'gh pr create',
    command: 'gh pr create --title t --body "Closes #1"',
    git: () => ({ branch: 'feat', ahead: 1 }),
    options: () => ({ prs: [{ number: 5, state: 'OPEN', headRefName: 'feat', headRefOid: 'c1', body: 'Closes #1' }] }),
    effectOn: 0,
    isObserved: async $ => ((await declareFlow($, 'fix')).deny ?? '').includes('PR was already created'),
  },
  {
    name: 'gh pr edit',
    command: `gh pr edit 5 --body "${closes}"`,
    git: () => ({ branch: 'feat', ahead: 1 }),
    options: () => ({ ...twoIssueCloseOut, unit: { skills: ['generate-commit'], pr: { number: 5, state: 'OPEN' } }, prView: { body: closes, headRefOid: 'c1' } }),
    setup: async $ => { await startSkill($, 'create-pr') },
    effectOn: 0,
    isObserved: async $ => ((await readFlowStatus($)) ?? '').includes('Unit finished.'),
  },
]

// Commits, pushes and the PR's merge, close and review are the user's: the agent's own call is denied, run directly or in a
// herdr pane, so nothing runs to observe.
const userCommands = ['gh pr merge 5 --squash', 'gh pr close 5', 'gh pr review 5 --approve', 'git commit -m x', 'git -C /repo commit --amend', 'git push', 'git push --force origin feat', 'git pull', 'git merge main', 'git rebase main', 'git cherry-pick c1', 'git revert c1', 'git am patch', "sh -c 'git commit -m x'", 'sudo /usr/bin/git push']

const reportedOnlyCases: ReportedOnlyCase[] = [
  {
    name: 'a commit made by a script', command: './scripts/commit.sh',
    reported: { result: { stdout: '', gitOperation: { commit: { sha: 'c1', kind: 'committed' } } } },
    isObserved: async $ => ((await declareFlow($, 'fix')).deny ?? '').includes('already produced output'),
  },
  {
    name: 'a commit in a call that then fails', command: './scripts/commit.sh && false',
    reported: { isError: true, result: { stdout: '', gitOperation: { commit: { sha: 'c1', kind: 'committed' } } } },
    isObserved: async $ => ((await declareFlow($, 'fix')).deny ?? '').includes('already produced output'),
  },
  {
    name: 'a PR opened by a script, numbered by the report alone', command: './scripts/open-pr.sh',
    reported: { result: { stdout: '', gitOperation: { pr: { number: 7, action: 'created' } } } },
    isObserved: async $ => ((await readFlowStatus($)) ?? '').includes('PR #7'),
  },
]

// A Small feature declared without an issue, grilled, with /to-spec started: the issue it creates attaches to the unit.
const specifying: Options = { session: { issues: [], info: {} }, unit: { skills: ['grilling'] }, issueLabels: { 7: ['ready-for-agent'] } }
const createSpec = 'gh issue create --title "Spec title" --body-file spec.md'

const unmatchedIssueCases: UnmatchedIssueCase[] = [
  { name: 'no issue of that title', command: createSpec, listed: [{ number: 7, title: 'Another title', offsetMs: 1000 }] },
  { name: 'only an issue of that title created before the launch', command: createSpec, listed: [{ number: 7, title: 'Spec title', offsetMs: -600000 }] },
  { name: 'a title the shell expands', command: 'gh issue create --title "$TITLE" --body-file spec.md', listed: [{ number: 7, title: '$TITLE', offsetMs: 1000 }] },
]

// The tool result a world returns is read at each call, so the test switches it through the channel.
function createToolRunChannel(): ToolRunChannel {
  const current = { run: quiet }
  return { source: () => current.run, setToolRun: run => { current.run = run } }
}

// The wait-output answer whose matched line is a marker.
function buildMatchedRun(line: string): ToolRun {
  return { result: { stdout: JSON.stringify({ id: 'cli:pane:wait-output', result: { matched_line: line, type: 'output_matched' } }) } }
}

// A marker id and pane new to each launch: a reported id never counts again.
function buildMarkerId(label: string): string {
  return `co${label.replace(/[^a-z0-9]/gi, '')}`
}

// Launches a command in a herdr pane and returns the pane and the marker id.
async function launchInPane($: Engine, setToolRun: SetToolRun, command: string, label: string): Promise<{ pane: string; id: string }> {
  const id = buildMarkerId(label)
  const pane = `w${id}:1`
  setToolRun(quiet)
  await $.tool.call(buildBashCall(`herdr pane run ${pane} '${command}; echo "__EXIT_${id}=$?__"'`))
  return { pane, id }
}

// Calls wait-output on a pane with the answer given.
async function waitForOutput($: Engine, setToolRun: SetToolRun, pane: string, id: string, answer: ToolRun): Promise<void> {
  setToolRun(answer)
  await $.tool.call(buildBashCall(`herdr pane wait-output ${pane} --regex '__EXIT_${id}=[0-9]+__' --source recent-unwrapped --timeout 590000 --lines 80`))
  setToolRun(quiet)
}

// Runs a command directly or through a herdr pane, ending with the exit code given; a direct run prints the output given.
async function runCommandVia($: Engine, setToolRun: SetToolRun, run: ViaRun): Promise<void> {
  if (run.via === 'direct') {
    setToolRun(run.exitCode === 0 ? { result: { stdout: run.output } } : { isError: true, result: { stdout: run.output } })
    await $.tool.call(buildBashCall(run.command))
    setToolRun(quiet)
    return
  }
  const { pane, id } = await launchInPane($, setToolRun, run.command, run.label)
  await waitForOutput($, setToolRun, pane, id, buildMatchedRun(`__EXIT_${id}=${run.exitCode}__`))
}

for (const observed of cases) {
  for (const via of ['direct', 'herdr'] as const) {
    for (const exitCode of [0, 1] as const) {
      const isEffect = exitCode === observed.effectOn
      // A command maps to the same event and step outcome whether it runs directly or in a herdr pane
      test(`${observed.name} run ${via} with exit ${exitCode} ${isEffect ? 'is' : 'is not'} observed`, async ($, on) => {
        const channel = createToolRunChannel()
        createWorld(on, observed.git(), { ...observed.options(), toolRun: channel.source })
        await observed.setup?.($)
        expect(await observed.isObserved($)).toBe(false)
        const output = observed.name === 'gh pr create' ? 'https://github.com/o/r/pull/5\n' : ''
        await runCommandVia($, channel.setToolRun, { via, command: observed.command, exitCode, output, label: `${observed.name}${via}${exitCode}` })
        expect(await observed.isObserved($)).toBe(isEffect)
      })
    }
  }
}

test('a herdr verify run whose wait-output reports another marker is not observed', async ($, on) => {
  const channel = createToolRunChannel()
  createWorld(on, { branch: 'feat', isDirty: true }, { verifyFile, toolRun: channel.source })
  const { pane, id } = await launchInPane($, channel.setToolRun, './test/run.sh', 'stale')
  await waitForOutput($, channel.setToolRun, pane, id, buildMatchedRun('__EXIT_stale=0__'))
  expect(await readCurrentStep($)).not.toBe('Commit')
})

test('a herdr verify run stays in flight through a wait-output without its marker, and a later one reporting it is observed', async ($, on) => {
  const channel = createToolRunChannel()
  createWorld(on, { branch: 'feat', isDirty: true }, { verifyFile, toolRun: channel.source })
  const { pane, id } = await launchInPane($, channel.setToolRun, './test/run.sh', 'inflight')
  await waitForOutput($, channel.setToolRun, pane, id, { result: { stdout: 'timed out' } })
  expect(await readCurrentStep($)).not.toBe('Commit')
  await waitForOutput($, channel.setToolRun, pane, id, buildMatchedRun(`__EXIT_${id}=0__`))
  expect(await readCurrentStep($)).toBe('Commit')
})

test('a commit, a push, a PR merge, close or review, or another history-making git command is denied directly and through herdr, in every permission mode', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { verifyFile, toolRun: quiet })
  for (const mode of ['default', 'auto', 'bypassPermissions']) {
    await setPermissionMode($, mode)
    for (const command of userCommands) {
      expect((await $.tool.call(buildBashCall(command))).deny, `${mode}: ${command}`).toContain("is the user's step")
      expect((await $.tool.call(buildBashCall(`herdr pane run p1 '${command}'`))).deny, `${mode}: herdr ${command}`).toContain("is the user's step")
    }
  }
  await runFlowCommand($, 'override verify the user asked for it')
  expect((await $.tool.call(buildBashCall('git commit -m x'))).deny).toContain("is the user's step")
  expect((await declareFlow($, 'fix')).deny).toBeUndefined()
  for (const command of ['git status', 'git diff --stat', 'git log -1', 'git stash push -- src', 'git add -- src/a.ts', 'git fetch']) {
    expect((await $.tool.call(buildBashCall(command))).deny, command).toBeUndefined()
  }
})

test('a direct run of the reproduction test in flight shows Diagnose running', async ($, on) => {
  const seen = { status: '' }
  const git = { branch: 'fix', hashes: { 'test/fix.bats': 'h1' } }
  createWorld(on, git, {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } }, unit: { skills: ['diagnosing-bugs'], start: 'c0' }, verifyFile,
    toolRun: async () => {
      seen.status = (await readFlowStatus($)) ?? ''
      return quiet
    },
  })
  await $.tool.call(buildWriteCall('test/fix.bats'))
  await $.tool.call(buildBashCall('bats test/fix.bats'))
  expect(seen.status).toContain('▸ Diagnose — running')
  expect((await readFlowStatus($)) ?? '').not.toContain('running')
})

for (const { name, command, reported, isObserved } of reportedOnlyCases) {
  test(`${name} is observed from the engine's report`, async ($, on) => {
    const channel = createToolRunChannel()
    createWorld(on, { branch: 'feat', ahead: 1 }, { toolRun: channel.source })
    expect(await isObserved($)).toBe(false)
    channel.setToolRun(reported)
    await $.tool.call(buildBashCall(command))
    channel.setToolRun(quiet)
    expect(await isObserved($)).toBe(true)
  })
}

for (const via of ['direct', 'herdr'] as const) {
  test(`an issue gh issue create makes ${via} attaches to a unit declared without one`, async ($, on) => {
    const channel = createToolRunChannel()
    const options: Options = { ...specifying, toolRun: channel.source }
    const { clock } = createWorld(on, { branch: 'feat' }, options)
    await startSkill($, 'to-spec')
    options.ownIssues = [{ number: 7, title: 'Spec title', createdAt: new Date(clock.now() + 1000).toISOString() }]
    await runCommandVia($, channel.setToolRun, { via, command: createSpec, exitCode: 0, output: 'https://github.com/o/r/issues/7\n', label: `issue${via}` })
    expect(await readPromptContext($)).toContain('Small feature #7 — current step: Code')
  })
}

for (const { name, command, listed } of unmatchedIssueCases) {
  test(`a herdr gh issue create with ${name} attaches no issue`, async ($, on) => {
    const channel = createToolRunChannel()
    const options: Options = { ...specifying, toolRun: channel.source }
    const { clock } = createWorld(on, { branch: 'feat' }, options)
    await startSkill($, 'to-spec')
    options.ownIssues = listed.map(issue => ({ number: issue.number, title: issue.title, createdAt: new Date(clock.now() + issue.offsetMs).toISOString() }))
    await runCommandVia($, channel.setToolRun, { via: 'herdr', command, exitCode: 0, output: '', label: `unmatched${name}` })
    expect(await readPromptContext($)).not.toContain('#7')
  })
}
