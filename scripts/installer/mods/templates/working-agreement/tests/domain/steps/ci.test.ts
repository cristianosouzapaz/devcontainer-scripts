import { expect } from 'claude-code/testing'

import { test } from '../../support/kit'
import { pushedCloseOut } from '../../support/builders'
import { readFlowStatus, readPromptContext } from '../../support/helpers'
import { common, createWorld, linearGraph, root } from '../../support/world'
import type { Gate, Options } from '../../support/world'

interface CiCase { name: string; extra: Options; fact: string; isDone: boolean }

const cases: CiCase[] = [
  ...['success', 'neutral', 'skipped'].map(conclusion => ({ name: conclusion, extra: { checkRuns: { c1: [{ name: 'test', status: 'completed', conclusion }] } }, fact: '✓ PR #5', isDone: true })),
  ...['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure', null].map(conclusion => ({ name: `completed ${conclusion}`, extra: { checkRuns: { c1: [{ name: 'test', status: 'completed', conclusion }] } }, fact: 'CI failing: test', isDone: false })),
  ...['queued', 'in_progress', 'waiting', 'pending', 'requested'].map(status => ({ name: status, extra: { checkRuns: { c1: [{ name: 'test', status, conclusion: null }] } }, fact: 'CI pending: test', isDone: false })),
  ...['success', 'pending', 'error', 'failure'].map(state => ({ name: `status ${state}`, extra: { statuses: { c1: [{ context: 'external', state }] } }, fact: state === 'success' ? '✓ PR #5' : state === 'pending' ? 'CI pending: external' : 'CI failing: external', isDone: state === 'success' })),
  { name: 'zero checks and zero statuses', extra: {}, fact: '✓ PR #5', isDone: true },
  { name: 'zero checks with an incomplete Actions run', extra: { workflowRuns: { c1: [{ name: 'CI', path: '.github/workflows/ci.yml', status: 'queued' }] } }, fact: 'CI pending: CI', isDone: false },
  { name: 'zero checks with an incomplete unnamed Actions run', extra: { workflowRuns: { c1: [{ name: null, path: '.github/workflows/ci.yml', status: 'queued' }] } }, fact: 'CI pending: .github/workflows/ci.yml', isDone: false },
  { name: 'zero checks with only completed Actions runs', extra: { workflowRuns: { c1: [{ name: 'CI', path: '.github/workflows/ci.yml', status: 'completed' }] } }, fact: '✓ PR #5', isDone: true },
  { name: 'zero checks with Actions runs unreadable', extra: { failing: 'gh api --paginate repos/{owner}/{repo}/actions/runs' }, fact: 'CI unreadable', isDone: false },
  { name: 'rules forbidden', extra: { rulesError: 403 }, fact: '✓ PR #5', isDone: true },
  { name: 'rules not found', extra: { rulesError: 404 }, fact: '✓ PR #5', isDone: true },
  { name: 'other rules failure', extra: { rulesError: 500 }, fact: 'CI unreadable', isDone: false },
  { name: 'check runs unreadable', extra: { failing: 'gh api --paginate repos/{owner}/{repo}/commits/c1/check-runs' }, fact: 'CI unreadable', isDone: false },
  { name: 'statuses unreadable', extra: { failing: 'gh api --paginate repos/{owner}/{repo}/commits/c1/status' }, fact: 'CI unreadable', isDone: false },
  { name: 'required context missing', extra: { rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'required' }] } }] }, fact: 'required check required missing', isDone: false },
  { name: 'required context passes', extra: { rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'required' }] } }], statuses: { c1: [{ context: 'required', state: 'success' }] } }, fact: '✓ PR #5', isDone: true },
  { name: 'required context matching is exact', extra: { rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Test' }] } }], statuses: { c1: [{ context: 'test', state: 'success' }] } }, fact: 'required check Test missing', isDone: false },
  { name: 'failure wins over pending', extra: { statuses: { c1: [{ context: 'waiting', state: 'pending' }, { context: 'broken', state: 'error' }] } }, fact: 'CI failing: broken', isDone: false },
]

for (const row of cases) {
  test(`CI on the slice end: ${row.name}`, async ($, on) => {
    createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, ...row.extra })
    const status = await readFlowStatus($)
    expect(status).toContain(row.fact)
    expect((status ?? '').includes('Start new session: /clear')).toBe(row.isDone)
    if (!row.isDone) expect(await readPromptContext($)).toContain(row.fact)
  })
}

test('CI is read on the slice end even when the PR head is ahead', async ($, on) => {
  const graph = linearGraph({ feat: 1, remote: 2 })
  createWorld(on, { branch: 'feat', graph }, { ...pushedCloseOut, prs: [{ ...pushedCloseOut.prs?.[0], headRefOid: 'c2' }],
    statuses: { c1: [{ context: 'slice', state: 'failure' }], c2: [{ context: 'head', state: 'success' }] } })
  expect(await readFlowStatus($)).toContain('CI failing: slice')
})

test('CI refresh recovers from an unreadable report and can turn red after green', async ($, on) => {
  const options: Options = { ...pushedCloseOut, rulesError: 500 }
  const { clock } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
  expect(await readFlowStatus($)).toContain('CI unreadable')
  options.rulesError = undefined
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('Start new session: /clear')
  options.statuses = { c1: [{ context: 'test', state: 'error' }] }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('CI failing: test')
})

for (const before of ['pending', 'success']) {
  test(`a ${before} CI that fails on GitHub alone ${before === 'pending' ? 'shows at' : 'keeps its cached read through'} the next tick`, async ($, on) => {
    const options: Options = { ...pushedCloseOut, statuses: { c1: [{ context: 'test', state: before }] } }
    const { clock, views } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
    await $.session.start({ cwd: root, surface: null, isInteractive: false })
    // A ref change reads GitHub past the cache between two ticks, so the next tick finds that read under a minute old.
    await clock.advance(1000)
    await $.classic.FileChanged({ file_path: `${common}/HEAD`, event: 'change' })
    await clock.settle()
    options.statuses = { c1: [{ context: 'test', state: 'failure' }] }
    await clock.advance(59000)
    expect(views.at(-1)?.steps.find(step => step.id === 'pr')?.fullDetail === 'CI failing: test').toBe(before === 'pending')
  })
}

test('a ref change returns before its slow GitHub read ends, and the pane repaints once the read does', async ($, on) => {
  const gate: Gate = {}
  const options: Options = { ...pushedCloseOut, statuses: { c1: [{ context: 'test', state: 'pending' }] } }
  const { clock, views } = createWorld(on, { branch: 'feat', ahead: 1 }, options)
  await readFlowStatus($)
  options.rulesGate = new Promise<void>(resolve => { gate.open = resolve })
  options.statuses = { c1: [{ context: 'test', state: 'failure' }] }
  const handled = { isDone: false }
  const changed = $.classic.FileChanged({ file_path: `${common}/HEAD`, event: 'change' }).then(() => { handled.isDone = true })
  await clock.settle()
  expect(handled.isDone).toBe(true)
  expect(views.at(-1)?.steps.find(step => step.id === 'pr')?.fullDetail).not.toBe('CI failing: test')
  gate.open?.()
  await changed
  await clock.settle()
  expect(views.at(-1)?.steps.find(step => step.id === 'pr')?.fullDetail).toBe('CI failing: test')
})
