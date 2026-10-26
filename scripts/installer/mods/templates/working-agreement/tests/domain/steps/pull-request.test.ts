import { describeRequirement } from '../../../hooks/domain/requirements'
import { flowDefinitions } from '../../../hooks/domain/flow-definitions'
import { createEmptySession, createEmptyUnit } from '../../../hooks/domain/records'
import type { Position } from '../../../hooks/domain/step-states'
import { expect } from 'claude-code/testing'

import { test } from '../../support/kit'
import { buildPullRequest, fixed, diagnosisComment, noFlow, pushedCloseOut } from '../../support/builders'
import { declareFlow, endTurn, readFlowStatus, readPromptContext, readStepStates, startSkill } from '../../support/helpers'
import { createWorld, linearGraph } from '../../support/world'
import type { Options } from '../../support/world'

test('a pushed slice with an open PR closing every issue and green CI completes PR without running a skill', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, pushedCloseOut)
  expect(await readFlowStatus($)).toContain('✓ PR #5')
  expect(await readFlowStatus($)).toContain('Start new session: /clear')
})

test('a PR ahead of the slice end also contains it', async ($, on) => {
  const graph = linearGraph({ feat: 1, remote: 2 })
  createWorld(on, { branch: 'feat', graph }, { ...pushedCloseOut, prs: [buildPullRequest({ headRefOid: 'c2' })] })
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

for (const unpublished of [[], ['c1']]) {
  test(`an unpushed slice shows the push fact, including a compare 404 (${unpublished.length})`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ headRefOid: 'c0' })], unpublished })
    expect(await readFlowStatus($)).toContain("▸ Update PR #5 · PR does not contain the unit's last commit — push")
    expect(await readPromptContext($)).toContain('ask the user to push the branch to PR #5')
  })
}

test('a slice not pushed yet can become readable on the next GitHub refresh', async ($, on) => {
  const options: Options = { ...pushedCloseOut, unpublished: ['c1'] }
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
  expect(await readFlowStatus($)).toContain('— push')
  options.unpublished = []
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

test('a PR opened by a Bash call shows at the next pane judgement, before the cached candidates expire', async ($, on) => {
  const options: Options = { ...pushedCloseOut, prs: [] }
  options.afterTool = () => { options.prs = [buildPullRequest()] }
  const { views } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
  await endTurn($)
  expect(views.at(-1)?.steps.find(step => step.id === 'pr')?.detail).toBe('no PR')
  await $.tool.call({ tool: 'Bash', command: 'gh pr create' })
  await endTurn($)
  expect(views.at(-1)?.steps.find(step => step.id === 'pr')).toMatchObject({ state: 'done', label: 'PR #5' })
})

test('PR closure comes from closingIssuesReferences for every declared issue', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ closingIssuesReferences: [{ number: 1 }] })] })
  expect(await readFlowStatus($)).toContain('▸ Update PR #5 · PR does not close #2')
  await startSkill($, 'create-pr')
  expect(await readPromptContext($)).toContain('update PR #5 (body must carry Closes #1, Closes #2)')
})

for (const changes of [{ state: 'CLOSED' }, { isCrossRepository: true }, { headRefName: 'other' }]) {
  test(`a noncandidate is no PR: ${JSON.stringify(changes)}`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest(changes)] })
    expect(await readFlowStatus($)).toContain('▸ PR · no PR')
    expect(await readPromptContext($)).toContain('create-pr skill to open the PR')
  })
}

test('an open PR into a non-default base is the unit\'s PR and closes the issues its body names', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ baseRefName: 'next', closingIssuesReferences: [], body: 'Closes #1\nfixes: owner/repo#2' })] })
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

test('a PR into a non-default base whose body lacks an issue does not close it and is updated, not opened', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ baseRefName: 'next', closingIssuesReferences: [], body: 'Closes #1\nSee #2' })] })
  expect(await readFlowStatus($)).toContain('▸ Update PR #5 · PR does not close #2')
  await startSkill($, 'create-pr')
  expect(await readPromptContext($)).toContain('update PR #5 (body must carry Closes #1, Closes #2)')
})

test('on a PR into the default branch the body never widens GitHub\'s closing references', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ closingIssuesReferences: [{ number: 1 }], body: 'Closes #1\nCloses #2' })] })
  expect(await readFlowStatus($)).toContain('▸ Update PR #5 · PR does not close #2')
})

test('CI on a PR into a non-default base waits on that base\'s required checks', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({ baseRefName: 'next', body: 'Closes #1, closes #2' })] })
  await readPromptContext($)
  expect(world.runs).toContain('gh api --include repos/{owner}/{repo}/rules/branches/next')
  expect(world.runs).not.toContain('gh api --include repos/{owner}/{repo}/rules/branches/main')
})

test('several open PRs from the unit branch are refused by name instead of picking one', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest(), buildPullRequest({ number: 7, baseRefName: 'next' })] })
  const status = await readFlowStatus($)
  expect(status).toContain('#5')
  expect(status).toContain('#7')
  expect(status).not.toContain('✓ PR')
})

test('a capped candidate list is unchecked instead of selecting a PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prsHasNextPage: true })
  expect(await readFlowStatus($)).toContain('▸ PR · GitHub unreachable')
})

test('an incomplete closing-issues connection is unchecked instead of guessing the PR closures', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: [buildPullRequest({
    closingIssuesReferences: { nodes: [{ number: 1 }, { number: 2 }], pageInfo: { hasNextPage: true } },
  })] })
  expect(await readFlowStatus($)).toContain('▸ PR · GitHub unreachable')
})

test('a complete hundred-candidate connection can select a PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, prs: Array.from({ length: 100 }, (_, index) => buildPullRequest({ number: index + 1, state: index ? 'CLOSED' : 'OPEN' })) })
  expect(await readFlowStatus($)).toContain('✓ PR #1')
})

test('Trivial needs no closing issue and a draft PR is accepted', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: { flow: 'trivial', issues: [], info: {} }, prs: [buildPullRequest({ closingIssuesReferences: [], isDraft: true })] })
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

test('a current PR step without a skill reads Push to PR #<n>', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: { flow: 'trivial', issues: [], info: {} }, prs: [buildPullRequest({ closingIssuesReferences: [], headRefOid: 'c0' })], unpublished: [] })
  expect(await readFlowStatus($)).toContain('▸ Push to PR #5')
})

test('an empty slice never selects a merged PR', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: { flow: 'trivial', issues: [], info: {} }, unit: { base: 'c1', skips: [{ step: 'code', reason: 'covered' }, { step: 'verify', reason: 'covered' }, { step: 'commit', reason: 'covered' }] }, prs: [buildPullRequest({ state: 'MERGED' })] })
  expect(await readFlowStatus($)).toContain('PR · no PR')
  expect(await readFlowStatus($)).not.toContain('PR #5 · merged')
})

test('declaring with a PR available keeps its facts out of authoritative records', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, session: noFlow })
  const { sessions, files } = world
  expect((await declareFlow($, 'close-out', [1, 2])).deny).toBeUndefined()
  expect((await readStepStates(world)).PR).toBe('done')
  expect(JSON.stringify(sessions.get('sid'))).not.toContain('headRefOid')
  expect([...files.values()].some(text => text.includes('closingIssuesReferences'))).toBe(false)
})

test('a Fix PR requires its issue closures without a diagnosis comment link', async ($, on) => {
  const options: Options = {
    ...pushedCloseOut,
    session: { flow: 'fix', issues: [1, 2], info: {
      1: { title: 'bug', labels: ['ready-for-agent'], comments: [diagnosisComment] },
      2: { title: 'related', labels: ['ready-for-agent'], comments: [] },
    } },
    unit: { ...fixed, skips: [{ step: 'verify', reason: 'covered separately' }] },
    prs: [buildPullRequest({ closingIssuesReferences: [{ number: 1 }] })],
    issueLabels: { 1: ['ready-for-agent'], 2: ['ready-for-agent'] }, comments: { 1: [diagnosisComment], 2: [] },
  }
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
  expect(await readFlowStatus($)).toContain('PR does not close #2')
  expect(await readPromptContext($)).not.toContain('diagnosis comment link')
  options.prs = [buildPullRequest()]
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ PR #5')
  expect(await readFlowStatus($)).toContain('Start new session: /clear')
})

test('every PR next action records uncaptured context once, except a retry', () => {
  const flow = flowDefinitions.flows['close-out']!
  const pr = flow.steps.find(step => step.observe === 'pr.created')!
  const position: Position = { flow, unit: createEmptyUnit(), git: null, slice: null, states: [], current: null,
    verify: { fact: '', isVerified: false }, checks: 'off', isConcluded: false }
  const session = createEmptySession('sid')
  const clause = 'before the unit counts as finished, record on the issue or PR any session context no issue captured (a dead end explored, an approach ruled out)'
  for (const skill of [pr.skill, undefined]) {
    for (const pullRequest of [undefined, { number: 5, state: 'OPEN' as const }]) {
      for (const factCode of [undefined, 'push-required', 'github-unreachable', 'ci-unreadable'] as const) {
        const instruction = describeRequirement({ step: { ...pr, skill }, state: 'current', factCode, isError: false, isWaitingApproval: false }, session, { ...position, pullRequest })
        expect(instruction.split(clause).length - 1).toBe(factCode === 'github-unreachable' || factCode === 'ci-unreadable' ? 0 : 1)
      }
    }
  }
})
