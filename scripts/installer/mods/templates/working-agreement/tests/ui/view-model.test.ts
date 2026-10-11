import { expect, test } from 'claude-code/testing'

import { flowDefinitions } from '../../hooks/domain/flow-definitions'
import type { Session, Unit } from '../../hooks/domain/records'
import type { Position, StepState } from '../../hooks/domain/step-states'
import { stepSymbol } from '../../hooks/ui/theme'
import { buildView } from '../../hooks/ui/view-model'

const unit: Unit = { skills: [], verify: null, overrides: [] }
const flow = flowDefinitions.flows['fix']!

const session = (overrides: Partial<Session> = {}): Session => ({
  flow: 'fix', issues: [], info: {}, prCreated: false, output: false, reclassifyOk: false,
  blocked: { edits: 0, shell: 0 }, gh: 'connected', isLong: false, isToasted: false, ...overrides,
})
const positionOf = (overrides: Partial<Position> = {}, currentIndex = 0): Position => {
  const states: StepState[] = flow.steps.map((step, index) => ({ step, state: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'pending', isStale: false }))
  return { flow, unit, git: null, states, current: states[currentIndex] ?? null, ownCommits: 0, isCodeChanged: false, verify: { command: undefined, isVerified: false, running: null }, anchored: null, red: 'none', testRun: null, checks: 'off', ...overrides }
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

test('the Branch row says how far ahead the branch is and whether the tree is uncommitted', () => {
  const git = { root: '/r', branch: 'feat', head: 'c2', base: 'main', ahead: 2, isDirty: true, isUpToDate: true }
  const view = buildView(session(), positionOf({ git }), 'connected')
  expect(view.meta).toEqual([{ key: 'Branch', value: 'feat · 2 ahead of main · uncommitted', tone: 'text' }])
})

test('blocked writes are counted in singular and plural', () => {
  const view = buildView(session({ blocked: { edits: 1, shell: 2 } }), positionOf(), 'connected')
  expect(view.notes).toEqual([{ key: 'Blocked', value: '1 edit, 2 shell writes', tone: 'error' }])
  const notesOf = (blocked: Session['blocked']) => buildView(session({ blocked }), positionOf(), 'connected').notes
  expect(notesOf({ edits: 1, shell: 0 })).toEqual([{ key: 'Blocked', value: '1 edit', tone: 'error' }])
  expect(notesOf({ edits: 2, shell: 0 })).toEqual([{ key: 'Blocked', value: '2 edits', tone: 'error' }])
})

test('a step carries the mark of its state', () => {
  const view = buildView(session(), positionOf({}, 1), 'connected')
  expect(view.steps.map(step => step.symbol).slice(0, 3)).toEqual([stepSymbol.done, stepSymbol.current, stepSymbol.pending])
})

test('the footer offers the handoff once the unit finished, and not before', () => {
  expect(buildView(session(), positionOf(), 'connected').footer).toBeNull()
  const done = positionOf({ unit: { ...unit, pr: { number: 5, state: 'OPEN' } } }, flow.steps.length)
  expect(buildView(session(), { ...done, current: null }, 'connected').footer).toEqual({ text: 'Unit finished.', isRunning: false })
})
