import { expect, test } from 'claude-code/testing'

import { buildBashCall, buildWriteCall, noFlow, verifyFile } from '../../support/builders'
import { declareFlow, readFlowStatus, readPromptContext, runFlowCommand } from '../../support/helpers'
import { createWorld } from '../../support/world'

test('commits made before the unit was declared do not tick its steps', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 8 }, { session: noFlow })
  await runFlowCommand($, 'trivial')
  expect(await readPromptContext($)).toContain('current step: Code')
})

test('a commit made after the declaration ticks Commit, even unseen by the session', async ($, on) => {
  const git = { branch: 'feat', ahead: 8 }
  createWorld(on, git, { session: noFlow })
  await runFlowCommand($, 'trivial')
  git.ahead = 9
  expect(await readPromptContext($)).toContain('current step: PR')
})

test('a unit declared again in a later session still sees its own earlier commits', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 9, hashes: { 'test/fix.bats': 'h1' } }, {
    session: noFlow, unit: { start: 'c8', skills: ['diagnosing-bugs', 'generate-commit'], testFiles: ['test/fix.bats'], red: { fingerprints: { 'test/fix.bats': 'h1' } } },
    issueLabels: { 1: ['ready-for-agent'] },
  })
  await declareFlow($, 'fix', [1])
  expect(await readPromptContext($)).toContain('current step: PR')
})

test('at Commit the agent hands the commit to the user, with or without generate-commit', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 8, isDirty: true }, { session: noFlow })
  await runFlowCommand($, 'trivial')
  expect(await readPromptContext($)).toContain('stop and give the user the git add, git commit and git push commands to run (never commit or push yourself)')
})

test('at Commit after generate-commit the agent asks the user to run the commands it produced', async ($, on) => {
  createWorld(on, { branch: 'feat', isDirty: true }, { verifyFile, unit: { skills: ['generate-commit'] } })
  await $.tool.call(buildBashCall('./test/run.sh'))
  expect(await readPromptContext($)).toContain('stop and ask the user to run the commit commands generate-commit produced, then push the branch (never commit or push yourself')
})

test('Commit shows stale when the tree turns dirty after the unit committed', async ($, on) => {
  const git = { branch: 'feat', ahead: 8, isDirty: false }
  createWorld(on, git, { session: noFlow })
  await runFlowCommand($, 'trivial')
  git.ahead = 9
  expect(await readFlowStatus($)).not.toContain('stale')
  await $.tool.call(buildWriteCall('src/a.ts'))
  git.isDirty = true
  expect(await readFlowStatus($)).toMatch(/Commit {2}stale/)
})

test('a Commit never committed, with a dirty tree, is not stale', async ($, on) => {
  createWorld(on, { branch: 'feat', ahead: 8, isDirty: true }, { session: noFlow })
  await runFlowCommand($, 'trivial')
  expect(await readFlowStatus($)).not.toContain('stale')
})
