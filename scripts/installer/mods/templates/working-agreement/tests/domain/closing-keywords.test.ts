import { expect, test } from 'claude-code/testing'

import { parseClosingIssues } from '../../hooks/lib/closing-keywords'

const repository = 'Owner/Repo'

test('every GitHub closing keyword closes an issue, in any case and with an optional colon', () => {
  const keywords = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved']
  keywords.forEach((keyword, index) => {
    expect(parseClosingIssues(`${keyword} #${index + 1}`, repository), keyword).toEqual([index + 1])
    expect(parseClosingIssues(`${keyword.toUpperCase()}: #${index + 1}`, repository), `${keyword}:`).toEqual([index + 1])
  })
})

test('a reference closes as #n, owner/repo#n or the issue URL, only in the same repository', () => {
  const body = 'Closes #1\nfixes owner/repo#2\nResolves https://github.com/OWNER/REPO/issues/3\ncloses other/repo#4\nfixes https://github.com/other/repo/issues/5'
  expect(parseClosingIssues(body, repository)).toEqual([1, 2, 3])
})

test('text that is not a keyword followed by one issue closes nothing', () => {
  for (const body of ['See #1', 'Closes#1', 'hotfix #1', 'prefixed #1', 'closes #1abc', 'closes #0', 'closing #1', 'closes issue #1', 'fix-up #1']) {
    expect(parseClosingIssues(body, repository), body).toEqual([])
  }
})

test('only the first issue after a keyword closes, and duplicates collapse', () => {
  expect(parseClosingIssues('Closes #3, #4\ncloses #3\nCloses #1', repository)).toEqual([1, 3])
})
