import { expect, test } from 'claude-code/testing'
import { diagnoseRuns, diagnosisComment, noFlow, verifyFile } from '../support/builders'
import { endTurn, readCurrentStep } from '../support/helpers'
import { configBlob, createWorld } from '../support/world'
import type { Options } from '../support/world'

const newer = { url: 'https://github.com/o/r/issues/1#issuecomment-2', createdAt: new Date(5).toISOString() }
const awaitingApproval = (): Options => ({
  session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
  unit: { runs: [diagnoseRuns[0]!] }, comments: { 1: [newer, diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
})
const unapprovedVerify = { branch: 'feat', ahead: 8, isDirty: true, tree: 'one' }

test('Diagnose waiting for approval suggests approving the newest comment after the red', async ($, on) => {
  const { suggestions } = createWorld(on, { branch: 'fix' }, awaitingApproval())
  await endTurn($)
  expect(suggestions).toEqual([`/flow approve ${newer.url}`])
})

test('Verify with an unapproved config suggests approving it by its twelve-character id', async ($, on) => {
  const { suggestions } = createWorld(on, { ...unapprovedVerify }, { verifyFile })
  await endTurn($)
  expect(suggestions).toEqual([`/flow approve verify ${configBlob(verifyFile).slice(0, 12)}`])
})

test('a suggestion is not repeated while the step is unchanged', async ($, on) => {
  const { suggestions, clock } = createWorld(on, { ...unapprovedVerify }, { verifyFile })
  await endTurn($)
  await clock.advance(61000)
  await endTurn($)
  expect(suggestions).toHaveLength(1)
})

test('a suggestion the engine did not show is offered again at the next refresh', async ($, on) => {
  const options: Options = { verifyFile, isSuggestionShown: false }
  const { suggestions } = createWorld(on, { ...unapprovedVerify }, options)
  await endTurn($)
  await endTurn($)
  expect(suggestions).toHaveLength(2)
  options.isSuggestionShown = true
  await endTurn($)
  await endTurn($)
  expect(suggestions).toHaveLength(3)
})

test('the same command is offered again after the step stopped waiting on it', async ($, on) => {
  const options = awaitingApproval()
  const { suggestions, clock } = createWorld(on, { branch: 'fix' }, options)
  await endTurn($)
  options.comments = { 1: [] }
  await clock.advance(61000)
  await endTurn($)
  options.comments = { 1: [newer, diagnosisComment] }
  await clock.advance(61000)
  await endTurn($)
  expect(suggestions).toEqual([`/flow approve ${newer.url}`, `/flow approve ${newer.url}`])
})

test('a step that waits on no command suggests nothing', async ($, on) => {
  const { suggestions } = createWorld(on, { branch: 'feat', ahead: 8, isDirty: true, tree: 'one' }, { verifyFile, approvedConfig: verifyFile })
  await endTurn($)
  expect(await readCurrentStep($)).toBe('Verify')
  expect(suggestions).toEqual([])
})

test('no flow declared suggests nothing', async ($, on) => {
  const { suggestions } = createWorld(on, { ...unapprovedVerify }, { verifyFile, session: noFlow })
  await endTurn($)
  expect(suggestions).toEqual([])
})
