import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { buildWriteCall, noFlow, verifyFile } from '../support/builders'
import { readCurrentStep, runFlowCommand } from '../support/helpers'
import { completeDelivery } from '../support/delivery'
import { createWorld, linearGraph } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a user-declared Follow-up starts at Code and permits file writes', async ($, on) => {
  const git: Checkout = { branch: 'feat-1' }
  const options: Options = { session: noFlow, verifyFile, closingPrs: { 1: [{ number: 5, state: 'OPEN', headRefName: 'feat-1', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }] } }
  createWorld(on, git, options)
  await runFlowCommand($, 'follow-up #1')
  expect(await readCurrentStep($)).toBe('Code')

  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
})

test('a Follow-up unit runs from Code to a merged PR', async ($, on) => {
  const graph = linearGraph({ feat: 0 }, verifyFile, 1)
  const git: Checkout = { branch: 'feat', graph }
  const options: Options = { session: noFlow, verifyFile, closingPrs: { 1: [{ number: 5, state: 'OPEN', headRefName: 'feat', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }] } }
  const { clock, views } = createWorld(on, git, options)
  expect((await runFlowCommand($, 'follow-up #1')).text).toContain('current step: Code')
  git.isDirty = true
  git.changed = ['src/a.ts']
  git.tree = 'tree'
  expect(await readCurrentStep($)).toBe('Verify')
  await completeDelivery($, { git, options, clock, views })
})
