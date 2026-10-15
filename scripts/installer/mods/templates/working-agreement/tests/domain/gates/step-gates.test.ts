import { expect, test } from 'claude-code/testing'

import { buildBashCall, buildWriteCall } from '../../support/builders'
import { readPromptContext, setPermissionMode, startSkill } from '../../support/helpers'
import { createWorld, root } from '../../support/world'
import type { Options } from '../../support/world'

/**
 * A pre-unlock step that states a gate, with a world where it is the current step; `skill` is the skill the step runs, started once the world is up,
 * and `isDenied` marks a step that denies a write even where an ask could be answered (Diagnose, whose main checkout is read-only).
 */
interface GatedStepCase { flow: string; step: string; options: Options; skill?: string; isDenied?: boolean }

const input = { file_path: `${root}/src/a.ts`, content: '' }

const gatedSteps: GatedStepCase[] = [
  { flow: 'Small feature', step: 'Grill', options: buildFeatureOptions([]) },
  { flow: 'Small feature', step: 'Spec', options: buildFeatureOptions([], ['grilling']), skill: 'to-spec' },
  { flow: 'Fix', step: 'Triage', options: buildBugOptions([]) },
  { flow: 'Fix', step: 'Diagnose', options: buildBugOptions(['ready-for-agent']), isDenied: true },
]

function buildFeatureOptions(labels: string[], skills: string[] = []): Options {
  return { session: { info: { 1: { title: 'feat', labels } } }, unit: { skills } }
}

function buildBugOptions(labels: string[], skills: string[] = []): Options {
  return { session: { flow: 'fix', info: { 1: { title: 'bug', labels } } }, unit: { skills }, issueLabels: { 1: labels } }
}

for (const { flow, step, options, skill, isDenied } of gatedSteps) {
  test(`${flow} at ${step} tells the agent, in its instruction and in the deny, to change files only through Edit or Write`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, options)
    if (skill) await startSkill($, skill)
    await setPermissionMode($, 'auto')
    expect(await readPromptContext($)).toContain('only through Edit or Write')
    expect((await $.tool.call(buildBashCall("python3 -c 'pass'"))).deny).toContain('never work around a blocked write')
  })

  test(`${flow} at ${step} ${isDenied ? 'denies in default mode' : 'asks in default mode'} and denies when it cannot ask`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, options)
    if (skill) await startSkill($, skill)
    await setPermissionMode($, 'default')
    if (isDenied) expect((await $.tool.call({ tool: 'Write', ...input })).deny).toContain(`${step} not done`)
    else {
      expect((await $.tool.call({ tool: 'Write', ...input })).deny).toBeUndefined()
      expect((await $.tool.check({ tool: 'Write', input })).decision).toBe('ask')
    }
    await setPermissionMode($, 'auto')
    expect((await $.tool.call({ tool: 'Write', ...input })).deny).toContain(`${step} not done`)
  })
}

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
