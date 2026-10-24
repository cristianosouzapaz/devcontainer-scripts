import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import { buildWriteCall, pushedCloseOut } from '../../support/builders'
import { readFlowStatus, readPromptContext, startSkill } from '../../support/helpers'
import { createWorld } from '../../support/world'
import type { Checkout, Options } from '../../support/world'

/** How a row's test moves the world: to where the step's evidence holds, then to where it lapses, for a step whose evidence can lapse. */
interface Moves { establish: () => Promise<void>; lapse?: () => Promise<void> }

/**
 * One row of the step-state contract: the step as the pane names it, what makes it done and what makes it fall back (null for a step
 * nothing makes fall back), the world it starts in, with the step current, and the step the instruction calls current once it is done
 * (none when the flow is finished).
 */
interface ContractRow { step: string; doneStep?: string; doneWhen: string; fallsBackWhen: string | null; failureFact?: string; next: string | null; start: ($: Engine, on: On) => Moves | Promise<Moves> }

const refreshMs = 61000
const rows: ContractRow[] = [
  {
    step: 'Grill', doneWhen: 'the declared issue carries ready-for-agent', fallsBackWhen: 'the label is removed', next: 'Code',
    start: (_$, on) => {
      const options: Options = { session: { info: { 1: { title: 'feat', labels: [] } } }, unit: { skills: ['grilling', 'to-spec'] }, issueLabels: { 1: [] } }
      const { clock } = createWorld(on, { branch: 'feat' }, options)
      return {
        establish: async () => { options.issueLabels = { 1: ['ready-for-agent'] }; await advanceRefresh(clock) },
        lapse: async () => { options.issueLabels = { 1: [] }; await advanceRefresh(clock) },
      }
    },
  },
  {
    step: 'Triage', doneWhen: 'the declared issue carries ready-for-agent', fallsBackWhen: 'the label is removed', next: 'Diagnose',
    start: (_$, on) => {
      const options: Options = { session: { flow: 'fix', info: { 1: { title: 'bug', labels: [] } } }, issueLabels: { 1: [] } }
      const { clock } = createWorld(on, { branch: 'fix' }, options)
      return {
        establish: async () => { options.issueLabels = { 1: ['ready-for-agent'] }; await advanceRefresh(clock) },
        lapse: async () => { options.issueLabels = { 1: [] }; await advanceRefresh(clock) },
      }
    },
  },
  {
    step: 'Map', doneWhen: 'the issue is mapped and its wayfinder sub-issues are closed', fallsBackWhen: 'the label is removed', next: 'Tickets',
    start: (_$, on) => {
      const options: Options = { session: { flow: 'large-feature', info: { 1: { title: 'map', labels: [] } } }, issueLabels: { 1: [] }, subIssues: { 1: [{ state: 'closed', labels: ['wayfinder:map'] }] } }
      const { clock } = createWorld(on, { branch: 'feat' }, options)
      return {
        establish: async () => { options.issueLabels = { 1: ['wayfinder:map'] }; await advanceRefresh(clock) },
        lapse: async () => { options.issueLabels = { 1: [] }; await advanceRefresh(clock) },
      }
    },
  },
  {
    step: 'Tickets', doneWhen: 'the declared issue has a ready-for-agent sub-issue', fallsBackWhen: 'the sub-issue is removed', next: null,
    start: async ($, on) => {
      const options: Options = { session: { flow: 'large-feature', info: { 1: { title: 'map', labels: ['wayfinder:map'], subIssues: [{ state: 'closed', labels: ['wayfinder:research'] }] } } }, issueLabels: { 1: ['wayfinder:map'] }, subIssues: { 1: [{ state: 'closed', labels: ['wayfinder:research'] }] } }
      const { clock } = createWorld(on, { branch: 'feat' }, options)
      // Starting the skill alone never completes the step.
      await startSkill($, 'to-tickets')
      return {
        establish: async () => { options.subIssues = { 1: [{ state: 'closed', labels: ['wayfinder:research'] }, { state: 'open', labels: ['ready-for-agent'] }] }; await advanceRefresh(clock) },
        lapse: async () => { options.subIssues = { 1: [{ state: 'closed', labels: ['wayfinder:research'] }] }; await advanceRefresh(clock) },
      }
    },
  },
  {
    step: 'Commit', doneWhen: 'the work is committed and the tree is clean', fallsBackWhen: 'new uncommitted changes appear', next: 'PR',
    start: ($, on) => {
      const git: Checkout = { branch: 'feat', isDirty: true }
      createWorld(on, git, { unit: { skips: [{ step: 'verify', reason: 'covered separately' }] } })
      return { establish: async () => { git.ahead = 1; git.isDirty = false }, lapse: async () => { await $.tool.call(buildWriteCall('src/a.ts')); git.isDirty = true } }
    },
  },
  {
    step: 'Update PR #5', doneStep: 'PR #5', doneWhen: 'CI is green', fallsBackWhen: 'CI turns red', failureFact: 'CI failing: test', next: null,
    start: (_$, on) => {
      const options: Options = { ...pushedCloseOut, statuses: { c1: [{ context: 'test', state: 'pending' }] } }
      const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
      return {
        establish: async () => { options.statuses = { c1: [{ context: 'test', state: 'success' }] }; await advanceRefresh(clock) },
        lapse: async () => { options.statuses = { c1: [{ context: 'test', state: 'failure' }] }; await advanceRefresh(clock) },
      }
    },
  },
]

function advanceRefresh(clock: MockClock): Promise<void> {
  return clock.advance(refreshMs)
}

// The pane, /flow status and the prompt instruction must agree on the step.
async function expectDone($: Engine, row: ContractRow): Promise<void> {
  expect(await readFlowStatus($)).toContain(`✓ ${row.doneStep ?? row.step}`)
  const context = await readPromptContext($)
  if (row.next) expect(context).toContain(`current step: ${row.next}`)
  else expect(context).not.toContain('current step')
}

async function expectCurrent($: Engine, row: ContractRow, failureFact?: string): Promise<void> {
  expect(await readFlowStatus($)).toContain(failureFact ? `✗ ${row.step} · ${failureFact}` : `▸ ${row.step}`)
  expect(await readPromptContext($)).toContain(`current step: ${row.step}.${failureFact ? ` ${failureFact}` : ''}`)
}

for (const row of rows) {
  test(`${row.step} is done once ${row.doneWhen}`, async ($, on) => {
    const moves = await row.start($, on)
    await expectCurrent($, row)
    await moves.establish()
    await expectDone($, row)
  })

  if (row.fallsBackWhen) test(`${row.step} falls back when ${row.fallsBackWhen}`, async ($, on) => {
    const moves = await row.start($, on)
    await moves.establish()
    await expectDone($, row)
    await moves.lapse?.()
    await expectCurrent($, row, row.failureFact)
  })
}

test('Code is done when a unit outside Fix changes only test files', async ($, on) => {
  createWorld(on, { branch: 'feat', changed: ['test/a.bats', 'src/a.test.ts'] }, {})
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readPromptContext($)).toContain('current step: Verify')
})
