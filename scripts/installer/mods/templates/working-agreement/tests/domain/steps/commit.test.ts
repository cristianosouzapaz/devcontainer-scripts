import { expect, test } from 'claude-code/testing'

import { buildPullRequest, buildWriteCall, noFlow, fixed, diagnosisComment } from '../../support/builders'
import { declareFlow, readFlowStatus, readPromptContext, runFlowCommand } from '../../support/helpers'
import { common, createWorld, linearGraph } from '../../support/world'

test('a commit made after the declaration ticks Commit, even unseen by the session', async ($, on) => {
  const git = { branch: 'feat', ahead: 8 }
  createWorld(on, git, { session: noFlow })
  await runFlowCommand($, 'trivial')
  await runFlowCommand($, 'skip verify covered separately')
  git.ahead = 9
  expect(await readPromptContext($)).toContain('current step: PR')
})

test('a unit declared again in a later session still sees its own earlier commits', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 9 }, {
    session: noFlow,
    unit: { skills: ['diagnosing-bugs', 'generate-commit'], ...fixed },
    issueLabels: { 1: ['ready-for-agent'] }, comments: { 1: [diagnosisComment] },
  })
  await declareFlow($, 'fix', [1])
  await runFlowCommand($, 'skip verify covered separately')
  expect(await readPromptContext($)).toContain('current step: PR')
})

test('at Commit the agent hands the commit to the user, with or without generate-commit', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 8, isDirty: true }, { session: noFlow })
  await runFlowCommand($, 'trivial')
  await runFlowCommand($, 'skip verify covered separately')
  expect(await readPromptContext($)).toContain('stop and give the user the git add, git commit and git push commands to run (never commit or push yourself)')
})

test('Commit requires a merge only when another unit shares the branch', async ($, on) => {
  const { files, sessions } = createWorld(on, { branch: 'feat', ahead: 8, isDirty: true }, { session: noFlow })
  await runFlowCommand($, 'trivial')
  await runFlowCommand($, 'skip verify covered separately')
  expect(await readPromptContext($)).not.toContain('bring the default branch in with a merge')
  const session = sessions.get('sid')!
  const second = { identity: { branch: 'feat', issues: [2] }, skills: [], verifyRuns: [], runs: [] }
  files.set(`${common}/working-agreement/s/other.json`, JSON.stringify({ ...session, sessionId: 'other', unit: second.identity, units: [second] }))
  expect(await readPromptContext($)).toContain('bring the default branch in with a merge, never a rebase')
})

test('on a shared branch whose PR targets a non-default base, Commit asks to merge that base in', async ($, on) => {
  const graph = linearGraph({ feat: 8 })
  const { files, sessions } = createWorld(on, { branch: 'feat', graph: { ...graph, refs: { ...graph.refs, next: 'c0', 'origin/next': 'c0' } }, isDirty: true },
    { session: noFlow, prs: [buildPullRequest({ baseRefName: 'next', headRefOid: 'c8' })] })
  await runFlowCommand($, 'trivial')
  await runFlowCommand($, 'skip verify covered separately')
  const session = sessions.get('sid')!
  const second = { identity: { branch: 'feat', issues: [2] }, skills: [], verifyRuns: [], runs: [] }
  files.set(`${common}/working-agreement/s/other.json`, JSON.stringify({ ...session, sessionId: 'other', unit: second.identity, units: [second] }))
  expect(await readPromptContext($)).toContain('bring next in with a merge, never a rebase')
})

test('Commit reports uncommitted changes after a new edit', async ($, on) => {
  const git = { branch: 'feat', ahead: 8, isDirty: false }
  createWorld(on, git, { session: noFlow })
  await runFlowCommand($, 'trivial')
  await runFlowCommand($, 'skip verify covered separately')
  git.ahead = 9
  await $.tool.call(buildWriteCall('src/a.ts'))
  git.isDirty = true
  expect(await readFlowStatus($)).toContain('▸ Commit · uncommitted changes')
})
