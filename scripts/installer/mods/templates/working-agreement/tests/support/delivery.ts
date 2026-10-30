import { expect } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { buildPullRequest } from './builders'
import { approveVerify, readCurrentStep, readFlowStatus, readPaneCurrentStep } from './helpers'
import type { Checkout, Options, World } from './world'

interface DeliveryFixture {
  git: Checkout
  options: Options
  clock: MockClock
  views: World['views']
}

/**
 * Drives approved verification through an open, green PR and its merged conclusion.
 * @param $ - The test engine.
 * @param fixture - The checkout and GitHub responses to mutate, clock and published pane views.
 * @param prFields - Fields that vary from the default PR closing the declared issues.
 * @returns Once every delivery transition and the merged conclusion are asserted.
 */
export async function completeDelivery($: Engine, fixture: DeliveryFixture, prFields: Parameters<typeof buildPullRequest>[0] = {}): Promise<void> {
  await approveVerify($)
  expect((await $.tool.call({ tool: 'mcp__working-agreement__verify' })).result).toContain('Verify passed')
  expect(readPaneCurrentStep(fixture.views)).toBe('Commit')
  const committed = { ...fixture.git.graph!, refs: { ...fixture.git.graph!.refs, feat: 'c1' } }
  Object.assign(fixture.git, { graph: committed, dirty: {}, isDirty: false, changed: [], tree: undefined })
  expect(await readCurrentStep($)).toBe('PR')
  Object.assign(fixture.options, { prs: [buildPullRequest(prFields)], statuses: { c1: [{ context: 'test', state: 'success' }] } })
  await fixture.clock.advance(61000)
  expect(await readCurrentStep($)).toBeUndefined()
  Object.assign(fixture.git, { graph: { ...committed, refs: { ...committed.refs, main: 'c1', 'origin/main': 'c1' } } })
  Object.assign(fixture.options, { prs: [buildPullRequest({ ...prFields, state: 'MERGED' })] })
  const merged = await readFlowStatus($)
  expect(merged).toContain('✓ PR #5 · merged')
  expect(merged).toContain('Start new session: /clear')
}
