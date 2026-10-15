import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import type { ToolRun } from '../../../hooks/core/command-observation'
import { buildBashCall, buildDiagnosis, buildWriteCall, twoIssueCloseOut, verifyFile } from '../../support/builders'
import { postComment, readFlowStatus, readPromptContext, runFlowCommand, startSkill } from '../../support/helpers'
import { createWorld, root } from '../../support/world'
import type { Checkout, IssueComment, Options } from '../../support/world'

/** How a row's test moves the world: to where the step's evidence holds, then to where it lapses, for a step whose evidence can lapse. */
interface Moves { establish: () => Promise<void>; lapse?: () => Promise<void> }

/**
 * One row of the step-state contract: the step as the pane names it, what makes it done and what makes it fall back (null for a step
 * nothing makes fall back), the world it starts in, with the step current, and the step the instruction calls current once it is done
 * (none when the flow is finished).
 */
interface ContractRow { step: string; doneWhen: string; fallsBackWhen: string | null; next: string | null; start: ($: Engine, on: On) => Moves | Promise<Moves> }

const refreshMs = 61000
const closes = 'Closes #1\nCloses #2'
// A Fix whose Diagnose went green on test/fix.bats alone.
const greenUnit = { start: 'c0', red: { command: 'bats test/fix.bats', fingerprints: { 'test/fix.bats': 'h1' } }, green: 'bats test/fix.bats', diagnosis: 'https://github.com/o/r/issues/1#issuecomment-1', approval: 'https://github.com/o/r/issues/1#issuecomment-1' }

const codeRow: ContractRow = {
  step: 'Code', doneWhen: 'a change is handed to Verify', fallsBackWhen: 'the tree moves past the verified run', next: 'Commit',
  start: ($, on) => {
    const git: Checkout = { branch: 'feat', changed: [], tree: 'one' }
    createWorld(on, git, { verifyFile, unit: { start: 'c0' } })
    return {
      establish: async () => { Object.assign(git, { changed: ['src/a.ts'], isDirty: true, tree: 'two' }); await $.tool.call(buildBashCall('./test/run.sh')) },
      lapse: async () => { git.tree = 'three' },
    }
  },
}

const rows: ContractRow[] = [
  {
    step: 'Spec', doneWhen: 'the declared issue carries ready-for-agent', fallsBackWhen: 'the label is removed', next: 'Code',
    start: (_$, on) => {
      const options: Options = { session: { info: { 1: { title: 'feat', labels: [] } } }, unit: { skills: ['grilling', 'to-spec'], start: 'c0' }, issueLabels: { 1: [] } }
      const { clock } = createWorld(on, { branch: 'feat' }, options)
      return {
        establish: async () => { options.issueLabels = { 1: ['ready-for-agent'] }; await advanceRefresh(clock) },
        lapse: async () => { options.issueLabels = { 1: [] }; await advanceRefresh(clock) },
      }
    },
  },
  {
    step: 'Triage', doneWhen: 'the declared issue carries a triage label', fallsBackWhen: 'the label is removed', next: 'Diagnose',
    start: (_$, on) => {
      const options: Options = { session: { flow: 'fix', info: { 1: { title: 'bug', labels: [] } } }, unit: { start: 'c0' }, issueLabels: { 1: [] } }
      const { clock } = createWorld(on, { branch: 'fix' }, options)
      return {
        establish: async () => { options.issueLabels = { 1: ['needs-info'] }; await advanceRefresh(clock) },
        lapse: async () => { options.issueLabels = { 1: [] }; await advanceRefresh(clock) },
      }
    },
  },
  {
    step: 'Map', doneWhen: 'the declared issue carries wayfinder:map', fallsBackWhen: 'the label is removed', next: 'Tickets',
    start: (_$, on) => {
      const options: Options = { session: { flow: 'large-feature', info: { 1: { title: 'map', labels: [] } } }, issueLabels: { 1: [] } }
      const { clock } = createWorld(on, { branch: 'feat' }, options)
      return {
        establish: async () => { options.issueLabels = { 1: ['wayfinder:map'] }; await advanceRefresh(clock) },
        lapse: async () => { options.issueLabels = { 1: [] }; await advanceRefresh(clock) },
      }
    },
  },
  {
    step: 'Tickets', doneWhen: 'the declared issue has sub-issues', fallsBackWhen: 'the sub-issues are gone', next: null,
    start: async ($, on) => {
      const options: Options = { session: { flow: 'large-feature', info: { 1: { title: 'map', labels: ['wayfinder:map'] } } }, issueLabels: { 1: ['wayfinder:map'] } }
      const { clock } = createWorld(on, { branch: 'feat' }, options)
      // Starting the skill alone never completes the step.
      await startSkill($, 'to-tickets')
      return {
        establish: async () => { options.subIssues = { 1: 2 }; await advanceRefresh(clock) },
        lapse: async () => { options.subIssues = { 1: 0 }; await advanceRefresh(clock) },
      }
    },
  },
  codeRow,
  {
    // Committed work keeps Code done, so a new commit of this session's leaves Verify, not Code, current.
    step: 'Verify', doneWhen: 'a passing run matches the current tree', fallsBackWhen: 'the tree changes', next: 'PR',
    start: ($, on) => {
      const git: Checkout = { branch: 'feat', ahead: 1, tree: 'one', commitTrees: { c1: 'one', c2: 'two' } }
      createWorld(on, git, { verifyFile, unit: { start: 'c0' } })
      return {
        establish: async () => { await $.tool.call(buildBashCall('./test/run.sh')) },
        lapse: async () => { await $.tool.call(buildWriteCall('src/a.ts')); Object.assign(git, { ahead: 2, tree: 'two' }) },
      }
    },
  },
  {
    step: 'Diagnose', doneWhen: 'a command that failed in the worktree passed there and the user approved the diagnosis comment', fallsBackWhen: null, next: 'Code',
    start: async ($, on) => {
      const toolRun: ToolRun = { result: { stdout: '' } }
      const worktree = { name: 'diagnose-1', base: 'c0', changed: ['test/fix.bats'], hashes: { 'test/fix.bats': 'h1' } }
      const comments: Record<number, IssueComment[]> = {}
      createWorld(on, { branch: 'fix' }, { session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } }, unit: { start: 'c0' }, issueLabels: { 1: ['ready-for-agent'] }, worktree, cwd: root, toolRun, issueComments: comments })
      await $.tool.call({ tool: 'EnterWorktree', name: 'diagnose-1' })
      const runRedThenGreen = async () => {
        toolRun.isError = true
        await $.tool.call(buildBashCall('bats test/fix.bats'))
        delete toolRun.isError
        await $.tool.call(buildBashCall('bats test/fix.bats'))
        await postComment($, comments, buildDiagnosis('bats test/fix.bats'))
        await runFlowCommand($, 'approve diagnose')
      }
      return { establish: runRedThenGreen }
    },
  },
  {
    step: 'Commit', doneWhen: 'the work is committed and the tree is clean', fallsBackWhen: 'new uncommitted changes appear', next: 'PR',
    start: ($, on) => {
      const git: Checkout = { branch: 'feat', isDirty: true }
      createWorld(on, git, { unit: { start: 'c0' } })
      return { establish: async () => { git.ahead = 1; git.isDirty = false }, lapse: async () => { await $.tool.call(buildWriteCall('src/a.ts')); git.isDirty = true } }
    },
  },
  {
    step: 'Update PR #5', doneWhen: 'the PR head matches HEAD', fallsBackWhen: 'a new commit lands', next: null,
    start: async ($, on) => {
      const git: Checkout = { branch: 'feat', ahead: 1 }
      createWorld(on, git, { ...twoIssueCloseOut, unit: { pr: { number: 5, state: 'OPEN' } }, prView: { body: closes, headRefOid: 'c1' } })
      await startSkill($, 'create-pr')
      return { establish: async () => { await $.tool.call(buildBashCall(`gh pr edit 5 --body "${closes}"`)) }, lapse: async () => { await $.tool.call(buildWriteCall('src/a.ts')); git.ahead = 2 } }
    },
  },
  {
    step: 'Update PR #5', doneWhen: 'CI is green', fallsBackWhen: 'CI turns red', next: null,
    start: (_$, on) => {
      const options: Options = { ...twoIssueCloseOut, unit: { pr: { number: 5, state: 'OPEN' }, prHead: 'c1' }, workflow: 'pull_request', checks: ['pending'] }
      const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
      return {
        establish: async () => { options.checks = ['pass']; await advanceRefresh(clock) },
        lapse: async () => { options.checks = ['fail']; await advanceRefresh(clock) },
      }
    },
  },
]

function advanceRefresh(clock: MockClock): Promise<void> {
  return clock.advance(refreshMs)
}

// The pane, /flow status and the prompt instruction must agree on the step.
async function expectDone($: Engine, row: ContractRow): Promise<void> {
  expect(await readFlowStatus($)).toContain(`✓ ${row.step}`)
  const context = await readPromptContext($)
  if (row.next) expect(context).toContain(`current step: ${row.next}`)
  else expect(context).not.toContain('current step')
}

async function expectCurrent($: Engine, row: ContractRow): Promise<void> {
  expect(await readFlowStatus($)).toContain(`▸ ${row.step}`)
  expect(await readPromptContext($)).toContain(`current step: ${row.step}.`)
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
    await expectCurrent($, row)
  })
}

test('Code is done when a unit outside Fix changes only test files', async ($, on) => {
  createWorld(on, { branch: 'feat', changed: ['test/a.bats', 'src/a.test.ts'] }, { unit: { start: 'c0' } })
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readPromptContext($)).toContain('current step: Commit')
})

test('Code is done in a Fix when only the red files changed and they are transferred', async ($, on) => {
  createWorld(on, { branch: 'fix', changed: ['test/fix.bats'], hashes: { 'test/fix.bats': 'h1' } }, { session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } }, unit: greenUnit })
  expect(await readFlowStatus($)).toContain('✓ Code')
})

test('Code is done in a Fix with Diagnose overridden when only the red files changed', async ($, on) => {
  createWorld(on, { branch: 'fix', changed: ['test/fix.bats'], hashes: { 'test/fix.bats': 'h1' } }, {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
    unit: { ...greenUnit, overrides: [{ step: 'diagnose', reason: 'no loop could be built' }] },
  })
  expect(await readFlowStatus($)).toContain('✓ Code')
  expect(await readPromptContext($)).toContain('current step: Commit')
})
