import { expect, test } from 'claude-code/testing'

import { bashCall, declareFlow, noFlow, writeCall } from './helpers'
import { world } from './world'

// At Code on a feature branch: with git answering, every write below is allowed.
const atCode = { unit: { skills: ['grilling', 'to-spec'], produced: ['to-spec'] } }
const write = writeCall('src/a.ts')

test('a repository write is denied when git cannot be run', async ($, on) => {
  world(on, { branch: 'feat' }, { ...atCode, failing: 'git' })
  expect((await $.tool.call(write)).deny).toContain('check failed')
  expect((await $.tool.call(bashCall('echo x > src/a.ts'))).deny).toContain('check failed')
})

test('the permission check denies a write when git cannot be run', async ($, on) => {
  world(on, { branch: 'feat' }, { ...atCode, failing: 'git' })
  expect((await $.tool.check({ tool: 'Write', input: write })).decision).toBe('deny')
})

test('declare_flow is denied when the session cannot be read', async ($, on) => {
  world(on, { branch: 'feat' }, { session: noFlow, isRepoBroken: true })
  expect((await declareFlow($, 'fix', [3])).deny).toContain('check failed')
})
