import { expect, test } from 'claude-code/testing'

import { flowDefinitions } from '../../hooks/domain/flow-definitions'
import type { Session, Unit } from '../../hooks/domain/records'
import type { Position, StepState } from '../../hooks/domain/step-states'
import { stepSymbol } from '../../hooks/ui/theme'
import { buildView } from '../../hooks/ui/view-model'

const unit: Unit = { skills: [], verifyRuns: [], runs: [] }
const flow = flowDefinitions.flows['fix']!

const session = (overrides: Partial<Session> = {}): Session => ({
  v: 1, sessionId: 'sid', unit: null, units: [], flow: 'fix', issues: [], info: {},
  blocked: { edits: 0 }, gh: 'connected', isLong: false, ...overrides,
})
const positionOf = (overrides: Partial<Position> = {}, currentIndex = 0): Position => {
  const states: StepState[] = flow.steps.map((step, index) => ({ step, isError: false, isWaitingApproval: false, state: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'pending' }))
  return { flow, unit, git: null, states, current: states[currentIndex] ?? null, slice: null, verify: { fact: 'no verify command configured', isVerified: false }, checks: 'off', isConcluded: false, ...overrides }
}

test('the progress counts the steps settled out of all of them', () => {
  expect(buildView(session(), positionOf({}, 2), 'connected').progress).toBe(`2/${flow.steps.length}`)
})

test('an issue is listed with its title, and the labels of all issues once each', () => {
  const view = buildView(session({
    issues: [1, 2], info: { 1: { title: 'one', labels: ['bug', 'ready'] }, 2: { title: 'two', labels: ['bug'] } },
  }), positionOf(), 'connected')
  expect(view.issues).toEqual([{ number: 1, title: 'one' }, { number: 2, title: 'two' }])
  expect(view.labels).toEqual(['bug', 'ready'])
})

test('a flow that produces its issue says so until it exists', () => {
  const produced = { ...flow, issue: 'produced' as const }
  expect(buildView(session(), positionOf({ flow: produced }), 'connected').pending).toBe('issue not yet created')
  expect(buildView(session({ issues: [1] }), positionOf({ flow: produced }), 'connected').pending).toBeNull()
})

test('the Branch row names the branch without a commit count', () => {
  const git = { root: '/r', branch: 'feat', head: 'c2', base: 'main', ahead: 2, isDirty: true, isUpToDate: true }
  const view = buildView(session(), positionOf({ git }), 'connected')
  expect(view.meta).toEqual([{ key: 'Branch', value: 'feat', tone: 'text' }])
})

test('the checkout indicator is a warning note rather than branch metadata', () => {
  const git = { root: '/r', branch: 'other', head: 'c2', base: 'main', isUpToDate: true }
  const view = buildView(session({ unit: { branch: 'feat', issues: [] } }), positionOf({ git }), 'connected')
  expect(view.meta).toEqual([{ key: 'Branch', value: 'feat', tone: 'text' }])
  expect(view.notes).toEqual([{ key: 'Checkout', value: "other, not this unit's branch", tone: 'warn' }])
})

test('blocked writes are counted in singular and plural', () => {
  const notesOf = (blocked: Session['blocked']) => buildView(session({ blocked }), positionOf(), 'connected').notes
  expect(notesOf({ edits: 1 })).toEqual([{ key: 'Blocked', value: '1 edit', tone: 'error' }])
  expect(notesOf({ edits: 2 })).toEqual([{ key: 'Blocked', value: '2 edits', tone: 'error' }])
})

test('a step carries the mark of its state', () => {
  const view = buildView(session(), positionOf({}, 1), 'connected')
  expect(view.steps.map(step => step.symbol).slice(0, 3)).toEqual([stepSymbol.done, stepSymbol.current, stepSymbol.pending])
})

test('the footer offers a fresh session once the unit finished, and not before', () => {
  expect(buildView(session(), positionOf(), 'connected').footer).toBeNull()
  const done = positionOf({ pullRequest: { number: 5, state: 'OPEN' } }, flow.steps.length)
  expect(buildView(session(), { ...done, current: null }, 'connected').footer).toEqual({ action: 'start', isRunning: false })
})

test('done steps omit their facts with an open PR', () => {
  const position = positionOf({ pullRequest: { number: 5, state: 'OPEN' } })
  const states = position.states.map(entry => ({ ...entry, state: 'done' as const, fact: entry.step.observe === 'verify.passed' ? 'passed' : entry.step.observe === 'pr.created' ? 'merged #5' : undefined }))
  const view = buildView(session(), { ...position, states, current: null }, 'connected')
  expect(view.steps.find(step => step.label === 'Verify')?.detail).toBeUndefined()
  expect(view.steps.find(step => step.label === 'PR #5')).toMatchObject({ symbol: '✓', state: 'done', detail: undefined })
})

for (const handoff of [undefined, { state: 'failed', reason: 'failed' }, { state: 'running' }] as const) {
  test(`finished and long footer chooses the action with ${handoff?.state ?? 'no handoff'}`, () => {
    const done = positionOf({ pullRequest: { number: 5, state: 'OPEN' } }, flow.steps.length)
    expect(buildView(session({ isLong: true, handoff }), done, 'connected').footer).toEqual({
      action: handoff?.state === 'running' ? 'continue' : 'start', isRunning: handoff?.state === 'running',
    })
  })
}

test('long sessions and failed handoffs offer continuation before the unit finishes', () => {
  for (const state of [session({ isLong: true }), session({ handoff: { state: 'failed', reason: 'failed' } })]) {
    expect(buildView(state, positionOf(), 'connected').footer).toEqual({ action: 'continue', isRunning: false })
  }
})

test('rewritten units never offer a fresh session for finished steps', () => {
  const done = positionOf({ slice: { base: 'a', end: 'b', tree: 'b', baseTree: 'a', commits: 1, isClean: true, isFrozen: false, isRewritten: true, isShared: false } }, flow.steps.length)
  expect(buildView(session(), done, 'connected').footer).toBeNull()
})
