import { expect, test } from 'claude-code/testing'

import { buildBashCall, buildWriteCall, noFlow } from '../support/builders'
import { declareFlow, readCurrentStep, readFlowStatus, startSkill } from '../support/helpers'
import { createWorld } from '../support/world'
import type { Options } from '../support/world'

test('a Large feature runs from Map to Tickets without a repository write, and Tickets completes the flow', async ($, on) => {
  const options: Options = {
    session: noFlow, issueLabels: { 7: ['wayfinder:map'] }, toolRun: { result: { stdout: 'https://github.com/o/r/issues/7\n' } },
  }
  createWorld(on, { branch: 'feat' }, options)
  await declareFlow($, 'large-feature')
  expect(await readCurrentStep($)).toBe('Map')

  await startSkill($, 'wayfinder')
  await $.tool.call(buildBashCall('gh issue create --title t --body b'))
  expect(await readCurrentStep($)).toBe('Tickets')
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeDefined()

  await startSkill($, 'to-tickets')
  expect(await readCurrentStep($)).toBe('Tickets')
  options.subIssues = { 7: 3 }
  await $.tool.call(buildBashCall('gh issue create --title ticket --body b'))
  const status = await readFlowStatus($)
  expect(status).toContain('2/2')
  expect(status).toContain('✓ Tickets')
  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeDefined()
})
