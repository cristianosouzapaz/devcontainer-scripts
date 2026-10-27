import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { flowDefinitions, resolveUnitFlow } from '../../hooks/domain/flow-definitions'
import { composeInstruction } from '../../hooks/domain/instruction'
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
  return { flow, unit, git: null, states, current: states[currentIndex] ?? null, slice: null, verify: { fact: 'no verify command configured', isVerified: false, isReached: true }, checks: 'off', isConcluded: false, ...overrides }
}

const childFlow = resolveUnitFlow(flow, true)
const integration = { parent: 'par', state: 'pending' as const, command: 'git -C /par merge --no-ff a' }
/**
 * Places a child unit at Integrate, current or done.
 * @param isIntegrated - Whether the child is integrated, which leaves no current step.
 * @returns The position.
 */
const childAt = (isIntegrated: boolean): Position => {
  const states: StepState[] = childFlow.steps.map((step, index) => ({ step, isError: false, isWaitingApproval: false,
    state: index < childFlow.steps.length - 1 || isIntegrated ? 'done' : 'current', fact: step.id === 'integrate' ? isIntegrated ? 'in PR #9' : 'not merged into par' : undefined }))
  return positionOf({ flow: childFlow, states, current: isIntegrated ? null : states.at(-1)!,
    integration: isIntegrated ? { parent: 'par', state: 'integrated' as const, parentPullRequest: 9 } : integration })
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

test('a done step after the current step shows as pending, a skipped one stays skipped, and neither is counted', () => {
  const position = positionOf({ pullRequest: { number: 5, state: 'OPEN' } }, 3)
  const states = position.states.map((entry): StepState => entry.step.observe === 'pr.created' ? { ...entry, state: 'done', fact: '✓ PR #5' }
    : entry.step.observe === 'commit' ? { ...entry, state: 'skipped', reason: 'covered' } : entry)
  const real = structuredClone(states)
  const view = buildView(session(), { ...position, states }, 'connected')
  expect(view.progress).toBe(`3/${flow.steps.length}`)
  expect(view.steps.find(step => step.id === 'commit')).toMatchObject({ symbol: '↷', state: 'skipped', detail: 'covered' })
  expect(view.steps.at(-1)).toMatchObject({ symbol: '○', label: 'PR #5', state: 'pending', detail: undefined })
  expect(states).toEqual(real)
})

test('guidance reads the real states: a done human step after the current one is not handed over', () => {
  const steps = [flow.steps[2]!, { id: 'review', label: 'Review', skill: 'review', isHuman: true }, flow.steps.at(-1)!]
  const states: StepState[] = steps.map((step, index) => ({ step, isError: false, isWaitingApproval: false, state: (['current', 'done', 'pending'] as const)[index]! }))
  const position = positionOf({ flow: { ...flow, steps }, states, current: states[0]! })
  expect(buildView(session(), position, 'connected').steps[1]).toMatchObject({ symbol: '○', state: 'pending' })
  expect(composeInstruction(position, session())).not.toContain('/review')
})

test('every step done renders done, without a current step to project from', () => {
  const position = positionOf({ pullRequest: { number: 5, state: 'OPEN' } }, flow.steps.length)
  const view = buildView(session(), { ...position, current: null }, 'connected')
  expect(view.progress).toBe(`${flow.steps.length}/${flow.steps.length}`)
  expect(view.steps.every(step => step.symbol === '✓')).toBe(true)
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

test('a child before its merge shows Integrate current with its fact and the merge command as a note', () => {
  const view = buildView(session(), childAt(false), 'connected')
  expect(view.steps.at(-1)).toMatchObject({ label: 'Integrate', symbol: '▸', detail: 'not merged into par' })
  expect(view.notes).toContainEqual({ key: 'Merge', value: 'git -C /par merge --no-ff a', tone: 'text' })
  expect(view.footer).toBeNull()
})

test('an integrated child is finished: Integrate done with where it is delivered from, no merge note, and its flow line', () => {
  const position = childAt(true)
  const view = buildView(session({ issues: [1] }), position, 'connected')
  expect(view.steps.every(step => step.symbol === '✓')).toBe(true)
  expect(view.steps.at(-1)).toMatchObject({ label: 'Integrate', state: 'done', detail: 'in PR #9' })
  expect(view.notes.some(note => note.key === 'Merge')).toBe(false)
  expect(view.footer).toEqual({ action: 'start', isRunning: false })
  expect(composeInstruction(position, session({ issues: [1] }))).toBe('Fix #1 — integrated into par; delivered by the Close out on par.')
})

test('a child with every step done but not integrated is not finished', () => {
  const position = { ...childAt(true), integration }
  expect(buildView(session(), position, 'connected').footer).toBeNull()
  expect(composeInstruction(position, session())).toBe('Fix — all steps done.')
})
