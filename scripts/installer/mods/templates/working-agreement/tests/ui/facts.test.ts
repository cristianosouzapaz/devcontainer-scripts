import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { facts } from '../../hooks/domain/facts'
import { flowDefinitions, resolveUnitFlow } from '../../hooks/domain/flow-definitions'
import { formatStepLabel } from '../../hooks/domain/step-states'
import type { PullRequest } from '../../hooks/domain/records'
import { factPrefixColumns, fitFact, maxFactLength, measureFactWidth } from '../../hooks/ui/pane-layout'
import { panePadding } from '../../hooks/ui/theme'

// A five-digit PR or issue number, and the longest exit code a process reports.
const worstNumber = 99999
const worstExit = -2147483648

/**
 * Renders a template with its worst-case value.
 * @param name - The template's name.
 * @param template - The fact, or the function that words it.
 * @returns The rendered fact.
 */
const render = (name: string, template: string | ((value: number) => string)): string =>
  typeof template === 'string' ? template : template(name === 'verifyFailedExit' ? worstExit : worstNumber)

test('the fact limit is the default dock body at 144 terminal columns less the padding and the widest step prefix', () => {
  // The engine docks at min(45%, 90, terminal − 70) columns, one of them its grip: 63 body columns at 144.
  expect(63 - 2 * panePadding.x - factPrefixColumns).toBe(maxFactLength)
  expect(factPrefixColumns).toBe(2 + 'PR #12345'.length + 3)
  expect(maxFactLength).toBe(45)
})

test('every fact template, rendered with worst-case values, fits the limit and follows the house style', () => {
  for (const [name, template] of Object.entries(facts)) {
    const text = render(name, template)
    expect({ name, length: text.length <= maxFactLength }).toEqual({ name, length: true })
    expect({ name, style: /^[a-z0-9#/]|^(CI|PR|GitHub)\b/.test(text) && !text.endsWith('.') }).toEqual({ name, style: true })
  }
})

test('every step label fits the prefix the limit reserves, whatever its PR', () => {
  const pullRequest = { number: worstNumber, state: 'OPEN' } as PullRequest
  const steps = Object.values(flowDefinitions.flows).flatMap(flow => [...flow.steps, ...resolveUnitFlow(flow, true).steps])
  for (const step of steps) {
    for (const label of [formatStepLabel(step, pullRequest), formatStepLabel(step, undefined)]) {
      expect({ label, fits: 2 + label.length + 3 <= factPrefixColumns }).toEqual({ label, fits: true })
    }
  }
})

test('a fact that fits is drawn whole, and a longer one is cut at a word boundary with an ellipsis', () => {
  expect(fitFact(facts.issueCommentsUnavailable, 26)).toBe('issue comments unavailable')
  expect(fitFact(facts.issueCommentsUnavailable, 25)).toBe('issue comments…')
  expect(fitFact(facts.issueCommentsUnavailable, 8)).toBe('issue…')
  expect(fitFact('averyveryverylongword', 8)).toBe('averyve…')
})

test('at a 35-column body every fact keeps its first words and stays inside the row, the same text each time', () => {
  for (const [name, template] of Object.entries(facts)) {
    const text = render(name, template)
    const width = measureFactWidth(35, 'PR #12345')
    const fitted = fitFact(text, width)
    expect({ name, fits: fitted.length <= width, isStable: fitFact(text, width) === fitted, head: text.startsWith(fitted.replace(/…$/, '')) })
      .toEqual({ name, fits: true, isStable: true, head: true })
  }
})

test('a pane too narrow for a step\'s prefix leaves its fact no columns rather than a negative width', () => {
  expect(measureFactWidth(4, 'Verify')).toBe(0)
})
