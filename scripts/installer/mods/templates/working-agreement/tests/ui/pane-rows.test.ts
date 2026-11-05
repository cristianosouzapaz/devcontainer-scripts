import { expect } from 'claude-code/testing'

import { coordinator, noFlow } from '../support/builders'
import { declareFlow, mountPane, readFlowStatus, readKeyLabels, runFlowCommand, startSkill, textOf } from '../support/helpers'
import { test } from '../support/kit'
import { keyLabels, keyWidth } from '../../hooks/ui/theme'
import { createWorld, scopeFile, seedDelegation } from '../support/world'

const delegated = [410, 459, 463, 464, ...Array.from({ length: 494 - 467 + 1 }, (_, index) => 467 + index)]
const finding = { issue: 410, field: 'body', expected: 'the sections of one kind (spec, ticket, bug)', actual: 'sections Problem' }
const watching = { ...coordinator, audit: { since: 0, issues: [410], result: { state: 'violations' as const, findings: [finding] } } }

/**
 * Reads a keyed row of `/flow status` with the lines its value wraps onto.
 * @param status - The status text.
 * @param key - The row's label.
 * @returns The row's first line and every indented line under it.
 */
function readKeyedRow(status: string, key: string): string[] {
  const lines = status.split('\n')
  const first = lines.findIndex(line => line.startsWith(`${key} `))
  if (first < 0) return []
  const rest = lines.slice(first + 1)
  const end = rest.findIndex(line => !line.startsWith(' '))
  return [lines[first] ?? '', ...rest.slice(0, end < 0 ? rest.length : end)]
}

test('the coordinator\'s pane collapses consecutive issues into a range and gives triage its own row, wrapped under the value column', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: watching })
  world.files.set(scopeFile('sid'), JSON.stringify({ v: 1, sessionId: 'sid', issues: delegated, coversCreated: false, triage: [410, 464] }))
  expect((await readFlowStatus($)) ?? '').toContain('\nDelegating  #410 #459 ')
  const ui = await mountPane($, { columns: 34 })
  const lines = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  for (const line of ['Delegating', '#410 #459 #463', '#464 #467–#494', 'Triage', '#410 #464']) expect(lines, line).toContain(line)
  await ui.unmount()
})

test('a pane audit row keeps a space after its label and wraps its value under the value column, never splitting a word', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: watching })
  await readFlowStatus($)
  const ui = await mountPane($, { columns: 34 })
  const lines = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  const key = (await ui.findAll({ type: 'Box' })).find(box => box.props['flexShrink'] === 0 && textOf(box) === 'Issue #410')
  expect(Number(key?.props['width'])).toBeGreaterThan('Issue #410'.length)
  for (const line of ['body: expected the', 'sections of one', 'kind (spec,', 'ticket, bug), has', 'sections Problem']) expect(lines, line).toContain(line)
  await ui.unmount()
})

test('a delegated unit\'s Delegation row names only the delegation\'s state and the steps it took', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: { flow: 'small-feature', issues: [1], info: { 1: { title: 'a', labels: ['ready-for-agent'] } } } })
  seedDelegation(world, 'coord', [1])
  await startSkill($, 'to-spec')
  expect(readKeyedRow((await readFlowStatus($)) ?? '', 'Delegation')).toEqual(['Delegation  on · took /to-spec'])
  world.files.delete(scopeFile('coord'))
  await runFlowCommand($, 'status')
  expect(world.views.at(-1)?.meta).toContainEqual({ key: 'Delegation', value: 'stopped · took /to-spec', tone: 'text' })
})

test('an undelegated unit shows no Delegation row', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow })
  await declareFlow($, 'fix', [3])
  expect(world.views.at(-1)?.meta.map(row => row.key)).not.toContain('Delegation')
})

// Issue numbers above 9999 are not covered: `Issue #<n>` with a five-digit number is as long as keyWidth.
test('every label a keyed row can carry, and the longest issue label, is shorter than the key column', () => {
  expect([...keyLabels, 'Issue #9999'].filter(label => label.length >= keyWidth)).toEqual([])
})

test('every label the pane and /flow status draw is shorter than the key column, so a space always follows it', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: { ...watching, audit: { since: 0, issues: [410], result: { state: 'pending' as const, reason: 'cannot list the issues opened this session' } }, handoff: { state: 'failed' as const, reason: 'no room' } } })
  const status = (await readFlowStatus($)) ?? ''
  const ui = await mountPane($)
  const labels = await readKeyLabels(ui)
  expect(labels).toContain('Issue audit')
  expect(labels.filter(label => label.length >= keyWidth)).toEqual([])
  for (const label of labels) expect(status.split('\n').filter(line => line.startsWith(label)).every(line => line[label.length] === ' ' || line[label.length] === undefined), label).toBe(true)
  await ui.unmount()
})
