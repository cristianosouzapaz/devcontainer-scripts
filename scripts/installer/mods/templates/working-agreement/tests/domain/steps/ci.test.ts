import { expect, test } from 'claude-code/testing'

import { buildBashCall, twoIssueCloseOut } from '../../support/builders'
import { readFlowStatus, readPromptContext } from '../../support/helpers'
import { createWorld, root } from '../../support/world'
import type { Options } from '../../support/world'

/** A CI state that is not green: the checks gh reports (none when it reports no check) and the words the instruction carries. */
interface NotGreenCi { name: string; checks: string[] | undefined; words: string }

/** A way `gh pr checks` gives no report, as the world arranges it. */
interface UnreadableChecks { name: string; extra: Options }

/** A repository whose workflow set never makes CI run on a pull request. */
interface PullRequestFreeRepository { name: string; workflow: Options['workflow'] }

/** A way the workflow search errs, as the world arranges it. */
interface WorkflowSearchFailure { name: string; workflowSearch: Options['workflowSearch'] }

/** A workflow file's text and whether its `on:` key makes it run on pull requests, as the case title reads. */
interface WorkflowText { name: string; text: string }

// The CI states that are not green, each with the words its instruction carries.
const notGreen: NotGreenCi[] = [
  { name: 'a failing check', checks: ['pass', 'fail'], words: 'CI is failing on PR #5' },
  { name: 'a cancelled check', checks: ['pass', 'cancel'], words: 'CI is failing on PR #5' },
  { name: 'a pending check', checks: ['pass', 'pending'], words: 'gh pr checks #5 --watch' },
  { name: 'no reported check', checks: undefined, words: 'CI has reported no checks on PR #5 yet' },
]

// gh exits non-zero for failing and pending checks too, so only a report it cannot give reads as unknown.
const unreadableChecks: UnreadableChecks[] = [
  { name: 'cannot run', extra: { failing: 'gh pr checks' } },
  { name: 'answers without a report', extra: { isLoggedOut: true } },
]

const pullRequestFreeRepositories: PullRequestFreeRepository[] = [
  { name: 'without a workflow', workflow: undefined },
  { name: 'whose workflow never runs on pull requests', workflow: 'push' },
]

// A workflow search that errs is not "no CI": the gate fails closed and the PR step stays current.
const workflowSearchFailures: WorkflowSearchFailure[] = [
  { name: 'exits with an error', workflowSearch: 'fails' },
  { name: 'cannot run', workflowSearch: 'cannot-run' },
]

// Only the `on:` key of a workflow decides: a mention elsewhere is no pull-request trigger.
const notTriggers: WorkflowText[] = [
  { name: 'a comment', text: 'on: push\n# runs on pull_request too\n' },
  { name: 'an expression in a job step', text: 'on: push\njobs:\n  a:\n    steps:\n      - run: echo ${{ github.event.pull_request.number }}\n' },
  { name: 'the pull_request_review event', text: 'on: pull_request_review\n' },
]

const triggers: WorkflowText[] = [
  { name: 'an inline event', text: 'on: pull_request\n' },
  { name: 'an inline event list', text: 'on: [push, pull_request]\n' },
  { name: 'an inline event list over several lines', text: 'on: [push,\n  pull_request]\njobs:\n  a:\n' },
  { name: 'a block key', text: 'on:\n  pull_request_target:\n    types: [opened]\n' },
  { name: 'a block list item', text: 'on:\n  - push\n  - pull_request\n' },
  { name: 'a quoted on key', text: '"on":\n  pull_request:\n' },
]

// The workflows are found whatever folder of the repository the session runs in.
const subfolder = `${root}/src/app`

// A Close out whose PR #5 already holds HEAD: only CI can hold the PR step back.
function buildPushedOptions(extra: Options = {}): Options {
  return {
    ...twoIssueCloseOut,
    unit: { skills: ['generate-commit', 'create-pr'], pr: { number: 5, state: 'OPEN' }, prHead: 'c1' },
    workflow: 'pull_request',
    ...extra,
  }
}

test('a PR whose checks all pass finishes the unit', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, buildPushedOptions({ checks: ['pass', 'skipping'] }))
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

for (const { name, checks, words } of notGreen) {
  test(`${name} keeps the PR step current and tells the agent to wait for CI`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, buildPushedOptions({ checks }))
    const status = await readFlowStatus($)
    expect(status).not.toContain('Unit finished.')
    expect(status).toContain('waiting for CI')
    expect(await readPromptContext($)).toContain(words)
  })
}

for (const { name, extra } of unreadableChecks) {
  test(`when gh pr checks ${name}, the PR step waits on unknown CI and the agent is told to retry`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, buildPushedOptions({ checks: ['pass'], ...extra }))
    const status = await readFlowStatus($)
    expect(status).not.toContain('Unit finished.')
    expect(status).toContain('waiting for CI (unknown)')
    expect(await readPromptContext($)).toContain('CI could not be read for PR #5')
  })
}

test('an unreadable check report is read again at the next refresh, not kept', async ($, on) => {
  const options = buildPushedOptions({ checks: ['pass'], failing: 'gh pr checks' })
  createWorld(on, { branch: 'feat', ahead: 1 }, options)
  expect(await readFlowStatus($)).toContain('waiting for CI (unknown)')
  options.failing = undefined
  expect(await readFlowStatus($)).toContain('Unit finished.')
})

// Merging is the user's: CI decides the PR step, never whether the agent may merge.
test('gh pr merge is the user\'s step whatever CI reports', async ($, on) => {
  const options = buildPushedOptions({ checks: ['pass'] })
  createWorld(on, { branch: 'feat', ahead: 1 }, options)
  expect((await $.tool.call(buildBashCall('gh pr merge 5 --squash'))).deny).toContain("gh pr merge is the user's step")
  options.checks = ['fail']
  expect((await $.tool.call(buildBashCall('gh pr merge 5 --squash'))).deny).toContain("gh pr merge is the user's step")
})

for (const { name, workflow } of pullRequestFreeRepositories) {
  test(`in a repository ${name}, failing checks do not hold the PR step`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, buildPushedOptions({ workflow, checks: ['fail'] }))
    expect(await readFlowStatus($)).toContain('Unit finished.')
  })
}

test('a failing check keeps the PR step current when the session runs in a subfolder of the repository', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, buildPushedOptions({ checks: ['fail'], cwd: subfolder }))
  const status = await readFlowStatus($)
  expect(status).not.toContain('Unit finished.')
  expect(status).toContain('waiting for CI')
})

for (const { name, workflow } of pullRequestFreeRepositories) {
  test(`in a repository ${name}, a session in a subfolder still sees no CI`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, buildPushedOptions({ workflow, checks: ['fail'], cwd: subfolder }))
    expect(await readFlowStatus($)).toContain('Unit finished.')
  })
}

for (const { name, workflowSearch } of workflowSearchFailures) {
  test(`when the workflow search ${name}, the PR step waits and the agent is told to retry`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, buildPushedOptions({ workflowSearch, checks: ['pass'] }))
    const status = await readFlowStatus($)
    expect(status).not.toContain('Unit finished.')
    expect(status).toContain('waiting for CI (unknown)')
    const prompt = await readPromptContext($)
    expect(prompt).toContain('CI could not be read')
    expect(prompt).toContain('retry')
    expect((await $.tool.call(buildBashCall('gh pr merge 5 --squash'))).deny).toContain("gh pr merge is the user's step")
  })
}

for (const { name, text } of notTriggers) {
  test(`${name} does not make a workflow run on pull requests`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, buildPushedOptions({ workflows: { 'ci.yml': text }, checks: ['fail'] }))
    expect(await readFlowStatus($)).toContain('Unit finished.')
  })
}

for (const { name, text } of triggers) {
  test(`${name} makes a workflow run on pull requests`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, buildPushedOptions({ workflows: { 'other.yml': 'on: push\n', 'ci.yml': text }, checks: ['fail'] }))
    const status = await readFlowStatus($)
    expect(status).not.toContain('Unit finished.')
    expect(status).toContain('waiting for CI')
  })
}
