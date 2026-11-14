import { expect } from 'claude-code/testing'

import { flowDefinitions } from '../../hooks/domain/flow-definitions'
import { composeStart } from '../../hooks/domain/instruction'
import type { Session, Unit } from '../../hooks/domain/records'
import type { Position, StepState } from '../../hooks/domain/step-states'
import { test } from '../support/kit'

const unit: Unit = { skills: [], verifyRuns: [], runs: [] }
const flow = flowDefinitions.flows['fix']!
const session: Session = { v: 1, sessionId: 'sid', unit: null, units: [], flow: 'fix', issues: [], info: {}, blocked: { edits: 0 }, gh: 'connected', isLong: false }
const slice = { base: 'a', end: 'b', tree: 'b', baseTree: 'a', commits: 1, isClean: true, isFrozen: false, isRewritten: false, isShared: false }

/**
 * Places the unit at its first step, with what a case changes.
 * @param overrides - What the case changes.
 * @returns The position.
 */
const positionOf = (overrides: Partial<Position> = {}): Position => {
  const states: StepState[] = flow.steps.map((step, index) => ({ step, isError: false, isWaitingApproval: false, state: index === 0 ? 'current' : 'pending' }))
  return { flow, unit, git: null, states, current: states[0] ?? null, slice: null, verify: { fact: 'no verify command configured', isVerified: false, isReached: true }, checks: 'off', isConcluded: false, ...overrides }
}

// contract: a start that cannot be composed says why, and whether that ends the start or only holds it until the step is known again
test('a start refused for a rewritten history or an unknown integration end holds, and one for a concluded unit or no current step ends, each with its own reason', () => {
  const cases = {
    rewritten: composeStart(positionOf({ slice: { ...slice, isRewritten: true } }), session, 'Lead.'),
    unknownEnd: composeStart(positionOf({ integration: { parent: 'par', state: 'unknown-end' } as Position['integration'] }), session, 'Lead.'),
    concluded: composeStart(positionOf({ isConcluded: true }), session, 'Lead.'),
    noStep: composeStart(positionOf({ current: null }), session, 'Lead.'),
  }
  const summary = Object.fromEntries(Object.entries(cases).map(([name, result]) => [name, result.kind === 'refused' ? { isFinal: result.isFinal, reason: result.reason } : result.kind]))
  expect(summary).toEqual({
    rewritten: { isFinal: false, reason: 'the branch history it was declared on was rewritten, so which step is current is not known yet' },
    unknownEnd: { isFinal: false, reason: 'whether its integration ended is not known yet, so which step is current is not known' },
    concluded: { isFinal: true, reason: 'the unit concluded before its turn came' },
    noStep: { isFinal: true, reason: 'the unit had no current step left to start when its turn came' },
  })
  expect(composeStart(positionOf(), session, 'Lead.').kind).toBe('prompt')
})
