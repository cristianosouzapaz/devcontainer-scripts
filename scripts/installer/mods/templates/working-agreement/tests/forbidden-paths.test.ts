import { expect, test } from 'claude-code/testing'

import { bashCall, noFlow, writeCall } from './helpers'
import { root, world } from './world'

test('an ephemeral planning file is denied even at Code on a feature branch', async ($, on) => {
  world(on, { branch: 'feat' })
  for (const path of ['PLAN.md', 'src/TODO.md', 'plans/a.md', 'docs/plans/a.md', 'x.plan.md']) {
    expect((await $.tool.call(writeCall(path))).deny, path).toContain('ephemeral planning file')
  }
  expect((await $.tool.call(writeCall('docs/plan.md'))).deny).toBeUndefined()
})

test('a generated or vendored path is denied even at Code on a feature branch', async ($, on) => {
  world(on, { branch: 'feat' })
  for (const path of ['node_modules/x/index.js', 'web/dist/a.js', 'build/a.o', 'vendor/a.php', '.venv/bin/x']) {
    expect((await $.tool.call(writeCall(path))).deny, path).toContain('generated or vendored')
  }
})

// Where the flow's own rules would deny a write anyway, the forbidden-path rule must still be the one that answers.
for (const flow of ['large-feature', 'fix', 'close-out', 'trivial', 'follow-up-open', 'follow-up-merged']) {
  test(`ephemeral and generated paths are denied in ${flow}`, async ($, on) => {
    world(on, { branch: 'feat' }, { session: { flow, followUp: 1 } })
    expect((await $.tool.call(writeCall('PLAN.md'))).deny).toContain('ephemeral planning file')
    expect((await $.tool.call(writeCall('node_modules/x/index.js'))).deny).toContain('generated or vendored')
  })
}

test('a repository write with no flow declared is denied, the main agent\'s or a subagent\'s; reads and outside writes are not', async ($, on) => {
  world(on, { branch: 'feat' }, { session: noFlow })
  const bySubagent = { ...writeCall('src/a.ts'), agentId: 'agent-1' }
  expect((await $.tool.call(writeCall('src/a.ts'))).deny).toContain('no flow declared')
  expect((await $.tool.call(bySubagent)).deny).toContain('no flow declared')
  for (const command of ['echo x > src/a.ts', 'sed -i s/a/b/ src/a.ts']) {
    expect((await $.tool.call(bashCall(command))).deny, command).toContain('no flow declared')
  }
  for (const command of ['echo "a > b"', 'cp x $VAR/y']) {
    expect((await $.tool.call(bashCall(command))).deny, command).toBeUndefined()
  }
  expect((await $.tool.call({ tool: 'Read', file_path: `${root}/src/a.ts` })).deny).toBeUndefined()
  expect((await $.tool.call(writeCall('/tmp/notes.md'))).deny).toBeUndefined()
})

test('Large feature denies every repository write', async ($, on) => {
  world(on, { branch: 'feat' }, { session: { flow: 'large-feature' }, unit: { skills: ['wayfinder', 'to-tickets'], produced: ['wayfinder'] } })
  expect((await $.tool.call(writeCall('src/a.ts'))).deny).toContain('never writes to the repository')
})

test('a session holding a flow this version no longer defines counts as no flow declared', async ($, on) => {
  world(on, { branch: 'feat' }, { session: { flow: 'retired' } })
  expect((await $.tool.call(writeCall('src/a.ts'))).deny).toContain('no flow declared')
})
