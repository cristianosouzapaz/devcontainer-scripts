import { expect, test } from 'claude-code/testing'

import { declareFlow, flow, noFlow, promptContext } from './helpers'
import { world } from './world'

test('commits made before the unit was declared do not tick its steps', async ($, on) => {
  world(on, { branch: 'feat', ahead: 8 }, { session: noFlow })
  await flow($, 'trivial')
  expect(await promptContext($)).toContain('current step: Change')
})

test('a commit made after the declaration ticks Commit, even unseen by the session', async ($, on) => {
  const git = { branch: 'feat', ahead: 8 }
  world(on, git, { session: noFlow })
  await flow($, 'trivial')
  git.ahead = 9
  expect(await promptContext($)).toContain('current step: PR')
})

test('a unit declared again in a later session still sees its own earlier commits', async ($, on) => {
  world(on, { branch: 'feat', ahead: 9, hashes: { 'test/fix.bats': 'h1' } }, {
    session: noFlow, unit: { start: 'c8', skills: ['diagnosing-bugs', 'generate-commit'], testFiles: ['test/fix.bats'], red: { fingerprints: { 'test/fix.bats': 'h1' } } },
  })
  await declareFlow($, 'fix', [1])
  expect(await promptContext($)).toContain('current step: PR')
})
