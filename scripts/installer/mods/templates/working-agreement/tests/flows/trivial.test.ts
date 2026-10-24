import { expect, test } from 'claude-code/testing'

import { renderStatusText } from '../../hooks/ui/status-text'
import { buildPullRequest, buildWriteCall, noFlow, verifyFile } from '../support/builders'
import { endTurn, readCurrentStep, runFlowCommand } from '../support/helpers'
import { completeDelivery } from '../support/delivery'
import { conformanceGraph } from '../support/graph-fixture'
import { common, createWorld, linearGraph, root } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a Trivial change starts at Code and permits file writes', async ($, on) => {
  const git: Checkout = { branch: 'feat' }
  const options: Options = { session: noFlow, verifyFile }
  createWorld(on, git, options)
  await runFlowCommand($, 'trivial')
  expect(await readCurrentStep($)).toBe('Code')

  expect((await $.tool.call(buildWriteCall('src/a.ts'))).deny).toBeUndefined()
})

test('a Trivial change unit runs from Code to a merged PR', async ($, on) => {
  const graph = linearGraph({ feat: 0 }, verifyFile, 1)
  const git: Checkout = { branch: 'feat', graph }
  const options: Options = { session: noFlow, verifyFile }
  const { clock, views } = createWorld(on, git, options)
  expect((await runFlowCommand($, 'trivial')).text).toContain('current step: Code')
  git.isDirty = true
  git.changed = ['src/a.ts']
  git.tree = 'tree'
  expect(await readCurrentStep($)).toBe('Verify')
  await completeDelivery($, { git, options, clock, views }, { closingIssuesReferences: [] })
})

test('a tick with a fresh candidate cache and no slice does not reread pull requests', async ($, on) => {
  const checkout: Checkout = { branch: 'feat', graph: structuredClone(conformanceGraph) }
  const world = createWorld(on, checkout, {
    session: { flow: 'trivial', issues: [], info: {} },
    unit: { base: 'm1' },
    prs: [buildPullRequest({ closingIssuesReferences: [], headRefName: 'feat', headRefOid: 'f1' })],
  })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await world.clock.advance(1)
  await runFlowCommand($, 'status')
  const candidateReads = () => world.runs.filter(run => run.includes('pullRequests(headRefName:')).length
  const before = candidateReads()
  checkout.branch = 'main'
  delete checkout.graph!.refs.feat

  await world.clock.advance(59999)

  expect(candidateReads()).toBe(before)
})

test('a squash merge ref change publishes only the fresh conclusion after deleting the unit branch', async ($, on) => {
  const checkout: Checkout = { branch: 'feat', graph: structuredClone(conformanceGraph) }
  const options: Options = {
    session: { flow: 'trivial', issues: [], info: {} },
    unit: { base: 'm1' },
    prs: [buildPullRequest({ closingIssuesReferences: [], headRefName: 'feat', headRefOid: 'f1' })],
  }
  const { clock, views } = createWorld(on, checkout, options)
  await runFlowCommand($, 'status')
  const before = views.length

  options.prs = [buildPullRequest({ closingIssuesReferences: [], headRefName: 'feat', headRefOid: 'f1', state: 'MERGED' })]
  checkout.branch = 'main'
  checkout.graph!.refs.main = 's1'
  checkout.graph!.refs['origin/main'] = 's1'
  delete checkout.graph!.refs.feat
  await $.classic.FileChanged({ file_path: `${common}/HEAD`, event: 'change' })
  await clock.settle()

  const written = views.slice(before)
  expect(written.length).toBeGreaterThan(0)
  expect(written.every(view => view !== null && !renderStatusText(view).includes('slice unavailable')
    && !renderStatusText(view).includes("Checkout main, not this unit's branch"))).toBe(true)
  expect(written.every(view => view !== null && renderStatusText(view).includes('✓ PR #5 · merged'))).toBe(true)
})

test('a merge ref change queues a fresh conclusion behind an older read without publishing the older view', async ($, on) => {
  const gate: { open?: () => void } = {}
  const checkout: Checkout = { branch: 'feat', graph: structuredClone(conformanceGraph) }
  const options: Options = {
    session: { flow: 'trivial', issues: [], info: {} },
    unit: { base: 'm1' },
    prs: [buildPullRequest({ closingIssuesReferences: [], headRefName: 'feat', headRefOid: 'f1' })],
  }
  const { clock, views } = createWorld(on, checkout, options)
  await runFlowCommand($, 'status')
  options.statusGate = new Promise<void>(resolve => { gate.open = resolve })
  const older = endTurn($)
  await clock.settle()
  const before = views.length

  options.prs = [buildPullRequest({ closingIssuesReferences: [], headRefName: 'feat', headRefOid: 'f1', state: 'MERGED' })]
  checkout.branch = 'main'
  checkout.graph!.refs.main = 's1'
  checkout.graph!.refs['origin/main'] = 's1'
  delete checkout.graph!.refs.feat
  const changed = $.classic.FileChanged({ file_path: `${common}/HEAD`, event: 'change' })
  await clock.settle()
  gate.open?.()
  await Promise.all([older, changed])

  const written = views.slice(before)
  expect(written.length).toBeGreaterThan(0)
  expect(written.every(view => view !== null && renderStatusText(view).includes('✓ PR #5 · merged'))).toBe(true)
})

test('a pushed commit ref change never publishes GitHub unreachable for an uncached comparison', async ($, on) => {
  const checkout: Checkout = { branch: 'feat', graph: linearGraph({ feat: 0 }) }
  const options: Options = {
    session: { flow: 'trivial', issues: [], info: {} },
    unit: { base: 'c0', skips: [{ step: 'verify', reason: 'covered separately' }] },
    prs: [buildPullRequest({ closingIssuesReferences: [], headRefName: 'feat', headRefOid: 'c0' })],
  }
  const { clock, views } = createWorld(on, checkout, options)
  await runFlowCommand($, 'status')
  const before = views.length

  checkout.graph = linearGraph({ feat: 1 })
  options.prs = [buildPullRequest({ closingIssuesReferences: [], headRefName: 'feat', headRefOid: 'c1' })]
  await $.classic.FileChanged({ file_path: `${common}/refs/heads/feat`, event: 'change' })
  await clock.settle()

  const written = views.slice(before)
  expect(written.length).toBeGreaterThan(0)
  expect(written.every(view => view !== null && renderStatusText(view).includes('PR #5'))).toBe(true)
  expect(written.every(view => view !== null && !renderStatusText(view).includes('GitHub unreachable'))).toBe(true)
})

test('a ref change reports GitHub unreachable when the fresh candidate read really fails', async ($, on) => {
  const options: Options = {
    session: { flow: 'trivial', issues: [], info: {} },
    unit: { base: 'c0', skips: [{ step: 'verify', reason: 'covered separately' }] },
    prs: [buildPullRequest({ closingIssuesReferences: [], headRefName: 'feat', headRefOid: 'c1' })],
    prsHasNextPage: true,
  }
  const { clock, views } = createWorld(on, { branch: 'feat', graph: linearGraph({ feat: 1 }) }, options)
  await $.classic.FileChanged({ file_path: `${common}/refs/heads/feat`, event: 'change' })
  await clock.settle()

  expect(renderStatusText(views.at(-1)!)).toContain('GitHub unreachable')
})
