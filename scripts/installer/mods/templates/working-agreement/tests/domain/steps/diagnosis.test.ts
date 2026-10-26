import { expect } from 'claude-code/testing'
import { test } from '../../support/kit'
import type { IssueInfo, RunRecord } from '../../../types'
import { findFixGreen, judgeDiagnose } from '../../../hooks/domain/step-states'
import { describeDiagnoseNeed } from '../../../hooks/domain/instruction'
import { diagnosed, diagnoseRuns, diagnosisComment } from '../../support/builders'

const red = diagnoseRuns[0]!
const green = diagnoseRuns[1]!
const info = { 1: { title: 'bug', labels: [], comments: [diagnosisComment] } }

for (const [runs, fact, need] of [
  [[], 'no red run', 'red'],
  [[green], 'no red run', 'red'],
] as [RunRecord[], string, 'red'][]) {
  test(`Diagnose needs a failing run first: ${JSON.stringify(runs)}`, () => {
    expect(judgeDiagnose({ runs }, [1], info)).toEqual({ done: false, fact, need })
  })
}

test('Diagnose is done by a red, a later comment and its approval, with no green and no code change', () => {
  const approved = { runs: [red], approval: diagnosisComment.url }
  expect(judgeDiagnose(approved, [1], info)).toEqual({ done: true, approvedAt: Date.parse(diagnosisComment.createdAt) })
  expect(judgeDiagnose({ runs: [{ ...red, outcome: { kind: 'timeout', minutes: 1 } }], approval: approved.approval }, [1], info).done).toBe(true)
})

test('a red recorded after the approval does not undo Diagnose, because the earliest red is the reference', () => {
  const later = { ...red, runId: 'later', tree: 'attempt', at: 50 }
  expect(judgeDiagnose({ runs: [later, red], approval: diagnosisComment.url }, [1], info).done).toBe(true)
})

test('Diagnose waits for a comment strictly after the earliest red, then approval naming that comment', () => {
  const second = { ...red, runId: 'second', at: 5 }
  for (const at of [0.5, 1]) expect(judgeDiagnose({ runs: [red, second] }, [1], {
    1: { ...info[1], comments: [{ ...diagnosisComment, createdAt: new Date(at).toISOString() }] },
  }).fact).toBe('no comment after the red')
  expect(judgeDiagnose({ runs: [red] }, [1], info)).toMatchObject({ fact: 'waiting for /flow approve <url>', need: 'approval', isWaitingApproval: true })
  expect(judgeDiagnose({ runs: [red], approval: 'other' }, [1], info).done).toBe(false)
})

test('findFixGreen needs a pass after the bound with an earlier red of the same argv on another tree', () => {
  const latest = { ...green, runId: 'latest', at: 4 }
  expect(findFixGreen([latest, red, green, { ...green, argv: ['unrelated'], runId: 'unpaired', at: 5 }], 0)).toEqual(latest)
  expect(findFixGreen([red, green, latest], 2)).toEqual(latest)
  expect(findFixGreen([red, green], 2)).toBeUndefined()
  expect(findFixGreen([red, { ...green, tree: red.tree }], 0)).toBeUndefined()
  expect(findFixGreen([red, { ...green, argv: ['other'] }], 0)).toBeUndefined()
  expect(findFixGreen([{ ...red, at: green.at }, green], 0)).toBeUndefined()
  expect(findFixGreen([{ ...red, outcome: { kind: 'timeout', minutes: 1 } }, green], 0)).toEqual(green)
})

test('a pinned red keeps Diagnose done whatever the retained runs hold, while the approved comment exists', () => {
  const { outcome: _outcome, ...approvedRed } = red
  for (const runs of [[], [green], [{ ...red, runId: 'later', at: 50 }]]) {
    expect(judgeDiagnose({ runs, approval: diagnosisComment.url, approvedRed }, [1], info)).toEqual({ done: true, approvedAt: Date.parse(diagnosisComment.createdAt) })
  }
  expect(judgeDiagnose({ runs: [], approval: diagnosisComment.url, approvedRed }, [1], { 1: { ...info[1], comments: [] } }).fact).toBe('approved comment deleted')
})

test('a pinned red takes only its own argv passing on another tree after the bound as the fix green', () => {
  const { outcome: _outcome, ...approvedRed } = red
  const regressionRed = { ...red, argv: ['./regression'], runId: 'regression-red', at: 4 }
  const regressionGreen = { ...green, argv: ['./regression'], runId: 'regression-green', at: 5 }
  const fix = { ...green, runId: 'fix', at: 6 }
  expect(findFixGreen([regressionGreen, regressionRed], 3, approvedRed)).toBeUndefined()
  expect(findFixGreen([regressionGreen, fix, regressionRed], 3, approvedRed)).toEqual(fix)
  expect(findFixGreen([{ ...fix, tree: red.tree }], 3, approvedRed)).toBeUndefined()
  expect(findFixGreen([fix], 7, approvedRed)).toBeUndefined()
  expect(findFixGreen([regressionGreen, regressionRed], 3)).toEqual(regressionGreen)
})

test('a deleted approved comment reopens Diagnose, while a newer comment does not', () => {
  const approved = { runs: [red], approval: diagnosisComment.url }
  expect(judgeDiagnose(approved, [1], { 1: { ...info[1], comments: [] } }).fact).toBe('approved comment deleted')
  const newer = { ...diagnosisComment, url: 'https://github.com/o/r/issues/1#issuecomment-2', createdAt: new Date(10).toISOString() }
  expect(judgeDiagnose(approved, [1], { 1: { ...info[1], comments: [newer] } }).fact).toBe('approved comment deleted')
  expect(judgeDiagnose(approved, [1], { 1: { ...info[1], comments: [diagnosisComment, newer] } }).done).toBe(true)
})

test('Diagnose displays unavailable issue and comment facts, including a comments read error', () => {
  expect(judgeDiagnose(diagnosed, [], {}).fact).toBe('issue not yet created')
  expect(judgeDiagnose(diagnosed, [1], {}).fact).toBe('issue facts unavailable')
  expect(judgeDiagnose(diagnosed, [1], { 1: { error: 'issue missing' } }).fact).toBe('issue missing')
  expect(judgeDiagnose(diagnosed, [1], { 1: { title: 'bug', labels: [] } }).fact).toBe('issue comments unavailable')
  expect(judgeDiagnose(diagnosed, [1], { 1: { ...info[1], comments: { error: 'comments unreadable' } } }).fact).toBe('comments unreadable')
  expect(judgeDiagnose(diagnosed, [], {})).toMatchObject({ need: 'issue' })
  const unreadableIssues: Record<string, IssueInfo>[] = [{}, { 1: { error: 'issue missing' } }, { 1: { title: 'bug', labels: [] } }, { 1: { ...info[1], comments: { error: 'comments unreadable' } } }]
  for (const unreadable of unreadableIssues) {
    expect(judgeDiagnose(diagnosed, [1], unreadable)).toMatchObject({ need: 'comments' })
  }
})

test('Diagnose agent sentences follow the requirement, independently of pane wording', () => {
  const noComment = { 1: { ...info[1], comments: [] } }
  const cases = [
    [judgeDiagnose({ runs: [] }, [1], info), 'Diagnose next needs a failing red run through the run tool'],
    [judgeDiagnose(diagnosed, [], {}), 'Diagnose next needs the issue to exist, for the diagnosis comment'],
    [judgeDiagnose(diagnosed, [1], {}), 'Diagnose cannot read the comments on #1 yet; retry, and if it keeps failing, stop and tell the user'],
    [judgeDiagnose({ runs: [red] }, [1], noComment), "Diagnose next needs a diagnosis comment on #1 after the red run, then the user's /flow approve <comment URL>"],
    [judgeDiagnose(diagnosed, [1], noComment), "Diagnose next needs a diagnosis comment on #1 after the red run, then the user's /flow approve <comment URL>"],
    [judgeDiagnose({ runs: [red] }, [1], info), "Diagnose next needs the user's /flow approve <comment URL> naming the diagnosis comment after the red run"],
    [judgeDiagnose(diagnosed, [1], info), 'Diagnose is done'],
  ] as const
  for (const [judgement, sentence] of cases) {
    expect(describeDiagnoseNeed(judgement.done ? undefined : judgement.need, [1])).toBe(sentence)
  }
  const missing = judgeDiagnose({ runs: [red] }, [12, 13], { 12: { ...info[1], comments: [] }, 13: { ...info[1], comments: [] } })
  expect(missing).toMatchObject({ need: 'comment', fact: 'no comment after the red' })
  expect(describeDiagnoseNeed(missing.done ? undefined : missing.need, [12, 13])).toBe("Diagnose next needs a diagnosis comment on #12 or #13 after the red run, then the user's /flow approve <comment URL>")
})
