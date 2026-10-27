import { expect } from 'claude-code/testing'
import { test } from '../support/kit'
import { flowDefinitions } from '../../hooks/domain/flow-definitions'
import { createEmptySession, createEmptyUnit } from '../../hooks/domain/records'
import { describeRequirement } from '../../hooks/domain/requirements'
import { resolveStepStates } from '../../hooks/domain/step-states'
import type { Evidence, Position } from '../../hooks/domain/step-states'

test('fact codes keep next actions stable when the displayed facts are reworded', () => {
  const flow = flowDefinitions.flows['close-out']!
  const session = { ...createEmptySession('sid'), flow: 'close-out', issues: [1], unit: { branch: 'feature', issues: [1] } }
  const unit = createEmptyUnit()
  const evidence: Evidence = {
    git: null, slice: null, verify: { isVerified: false, isReached: true, fact: 'reworded config fact', factCode: 'verify-config-missing' },
    checks: 'off', isConcluded: false, pullRequest: { number: 5, state: 'OPEN' },
  }
  for (const code of ['github-unreachable', 'ci-unreadable', 'push-required'] as const) {
    const changed = { ...evidence, prFact: 'reworded delivery fact', prFactCode: code }
    const states = resolveStepStates(flow, session, unit, changed)
    const position: Position = { ...changed, flow, unit, states, current: null }
    const pr = states.find(state => state.step.observe === 'pr.created')!
    expect(describeRequirement(pr, session, position)).toBe(code === 'push-required'
      ? 'stop and ask the user to push the branch to PR #5; before the unit counts as finished, record on the issue or PR any session context no issue captured (a dead end explored, an approach ruled out)' : 'retry; if it keeps failing, stop and tell the user')
    const verify = states.find(state => state.step.observe === 'verify.passed')!
    expect(describeRequirement(verify, session, position)).toContain('propose the minimum .claude/working-agreement.json')
  }
})
