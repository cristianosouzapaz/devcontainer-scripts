import { expect, test } from 'claude-code/testing'

import { writeCall } from './helpers'
import { world } from './world'

// A Fix session on #1 whose unit has already run diagnosing-bugs.
const diagnosed = { session: { flow: 'fix', info: { 1: { title: 'bug', labels: [] } } }, unit: { skills: ['diagnosing-bugs'] } }

test('Diagnose gates source writes until a test file is written', async ($, on) => {
  world(on, { branch: 'fix' }, diagnosed)
  expect((await $.tool.call(writeCall('src/fix.sh'))).deny).toBeDefined()
  expect((await $.tool.call(writeCall('test/fix.bats'))).deny).toBeUndefined()
  expect((await $.tool.call(writeCall('src/fix.sh'))).deny).toBeUndefined()
})
