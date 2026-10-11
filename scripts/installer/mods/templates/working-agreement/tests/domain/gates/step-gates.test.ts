import { expect, test } from 'claude-code/testing'

import { buildWriteCall } from '../../support/builders'
import { setPermissionMode, startSkill } from '../../support/helpers'
import { createWorld, root } from '../../support/world'
import type { Options } from '../../support/world'

/** A pre-unlock step that states a gate, with a world where it is the current step; `skill` is the skill the step runs, started once the world is up. */
interface GatedStepCase { flow: string; step: string; options: Options; skill?: string }

const input = { file_path: `${root}/src/a.ts`, content: '' }
const testInput = { file_path: `${root}/test/a.test.ts`, content: '' }

const gatedSteps: GatedStepCase[] = [
  { flow: 'Small feature', step: 'Grill', options: buildFeatureOptions([]) },
  { flow: 'Small feature', step: 'Spec', options: buildFeatureOptions([], ['grilling']), skill: 'to-spec' },
  { flow: 'Fix', step: 'Triage', options: buildBugOptions([]) },
  { flow: 'Fix', step: 'Diagnose', options: buildBugOptions(['ready-for-agent']) },
]

function buildFeatureOptions(labels: string[], skills: string[] = []): Options {
  return { session: { info: { 1: { title: 'feat', labels } } }, unit: { skills } }
}

function buildBugOptions(labels: string[], skills: string[] = []): Options {
  return { session: { flow: 'fix', info: { 1: { title: 'bug', labels } } }, unit: { skills }, issueLabels: { 1: labels } }
}

for (const { flow, step, options, skill } of gatedSteps) {
  test(`${flow} at ${step} asks in default mode and denies when it cannot ask`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, options)
    if (skill) await startSkill($, skill)
    await setPermissionMode($, 'default')
    expect((await $.tool.call({ tool: 'Write', ...input })).deny).toBeUndefined()
    expect((await $.tool.check({ tool: 'Write', input })).decision).toBe('ask')
    await setPermissionMode($, 'auto')
    expect((await $.tool.call({ tool: 'Write', ...input })).deny).toContain(`${step} not done`)
  })
}

test('Fix at Diagnose lets a test path through', async ($, on) => {
  createWorld(on, { branch: 'feat' }, buildBugOptions(['ready-for-agent']))
  await setPermissionMode($, 'default')
  expect((await $.tool.check({ tool: 'Write', input: testInput })).decision).not.toBe('ask')
})

test('the optional Tickets step never gates a write', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { ...buildFeatureOptions(['ready-for-agent'], ['grilling', 'to-spec']), issueLabels: { 1: ['ready-for-agent'] }, subIssues: { 1: 0 } })
  await setPermissionMode($, 'auto')
  expect((await $.tool.call({ tool: 'Write', ...input })).deny).toBeUndefined()
  expect((await $.tool.check({ tool: 'Write', input })).decision).not.toBe('ask')
})

for (const isDirty of [true, false]) {
  test(`Commit does not gate a write once Code is done (dirty tree: ${isDirty})`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1, isDirty }, { ...buildFeatureOptions(['ready-for-agent'], ['grilling', 'to-spec']), issueLabels: { 1: ['ready-for-agent'] } })
    await setPermissionMode($, 'auto')
    const verdict = (await $.tool.call(buildWriteCall('src/a.ts'))).deny
    expect(verdict ?? '').not.toContain('Commit not done')
    expect(verdict).toBeUndefined()
  })
}
