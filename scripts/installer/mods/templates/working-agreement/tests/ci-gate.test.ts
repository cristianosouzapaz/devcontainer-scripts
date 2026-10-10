import { expect, test } from 'claude-code/testing'

import { bashCall, flowStatus, promptContext, twoIssueCloseOut } from './helpers'
import { root, world } from './world'
import type { Options } from './world'

// A Close out whose PR #5 already holds HEAD: only CI can hold the PR step back.
const pushed = (extra: Options = {}): Options => ({
  ...twoIssueCloseOut,
  unit: { skills: ['generate-commit', 'create-pr'], pr: { number: 5, state: 'OPEN' }, prHead: 'c1' },
  workflow: 'pull_request',
  ...extra,
})
// The CI states that are not green, each with the words its instruction carries.
const notGreen: [string, string[] | undefined, string][] = [
  ['a failing check', ['pass', 'fail'], 'CI is failing on PR #5'],
  ['a cancelled check', ['pass', 'cancel'], 'CI is failing on PR #5'],
  ['a pending check', ['pass', 'pending'], 'gh pr checks #5 --watch'],
  ['no reported check', undefined, 'CI has reported no checks on PR #5 yet'],
]

test('a PR whose checks all pass finishes the unit', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, pushed({ checks: ['pass', 'skipping'] }))
  expect(await flowStatus($)).toContain('Unit finished.')
})

for (const [name, checks, words] of notGreen) {
  test(`${name} keeps the PR step current and tells the agent to wait for CI`, async ($, on) => {
    world(on, { branch: 'feat', ahead: 1 }, pushed({ checks }))
    const status = await flowStatus($)
    expect(status).not.toContain('Unit finished.')
    expect(status).toContain('waiting for CI')
    expect(await promptContext($)).toContain(words)
  })

  test(`gh pr merge with ${name} is denied`, async ($, on) => {
    world(on, { branch: 'feat', ahead: 1 }, pushed({ checks }))
    expect((await $.tool.call(bashCall('gh pr merge 5 --squash'))).deny).toContain('PR #5')
  })
}

test('gh pr merge with every check passing is allowed', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, pushed({ checks: ['pass'] }))
  expect((await $.tool.call(bashCall('gh pr merge 5 --squash'))).deny).toBeUndefined()
})

for (const [name, workflow] of [['without a workflow', undefined], ['whose workflow never runs on pull requests', 'push']] as const) {
  test(`in a repository ${name}, failing checks neither hold the PR step nor deny gh pr merge`, async ($, on) => {
    world(on, { branch: 'feat', ahead: 1 }, pushed({ workflow, checks: ['fail'] }))
    expect(await flowStatus($)).toContain('Unit finished.')
    expect((await $.tool.call(bashCall('gh pr merge 5 --squash'))).deny).toBeUndefined()
  })
}

// The workflows are found whatever folder of the repository the session runs in.
const subfolder = `${root}/src/app`

test('a failing check keeps the PR step current when the session runs in a subfolder of the repository', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, pushed({ checks: ['fail'], cwd: subfolder }))
  const status = await flowStatus($)
  expect(status).not.toContain('Unit finished.')
  expect(status).toContain('waiting for CI')
})

test('gh pr merge with a failing check is denied when the session runs in a subfolder of the repository', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, pushed({ checks: ['fail'], cwd: subfolder }))
  expect((await $.tool.call(bashCall('gh pr merge 5 --squash'))).deny).toContain('PR #5')
})

for (const [name, workflow] of [['without a workflow', undefined], ['whose workflow never runs on pull requests', 'push']] as const) {
  test(`in a repository ${name}, a session in a subfolder still sees no CI`, async ($, on) => {
    world(on, { branch: 'feat', ahead: 1 }, pushed({ workflow, checks: ['fail'], cwd: subfolder }))
    expect(await flowStatus($)).toContain('Unit finished.')
    expect((await $.tool.call(bashCall('gh pr merge 5 --squash'))).deny).toBeUndefined()
  })
}

test('gh pr merge naming a branch reads that branch\'s checks', async ($, on) => {
  world(on, { branch: 'feat', ahead: 1 }, pushed({ checks: ['fail'] }))
  expect((await $.tool.call(bashCall('gh pr merge --subject "s" other-branch --squash'))).deny).toContain('PR other-branch')
})
