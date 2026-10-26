import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { listPullRequests, readClosingPullRequests, readIssue } from '../../hooks/lib/github'
import type { ProcessPort } from '../../hooks/lib/process'
import { buildPullRequest } from '../support/builders'
import { createWorld } from '../support/world'

const responses = (on: On) => (body: unknown, exitCode = 0): ProcessPort =>
  createWorld(on, { branch: 'feature' }, { ghResponse: { body, exitCode }, session: { flow: null } }).boundaries.processes

for (const [name, read] of [
  ['issue', (port: ProcessPort) => readIssue(port, 1)],
  ['candidate PRs', (port: ProcessPort) => listPullRequests(port, 'feature')],
  ['closing PRs', (port: ProcessPort) => readClosingPullRequests(port, 1)],
] as const) {
  test(`GraphQL errors make ${name} unreadable even with partial data`, async (_$, on) => {
    const response = responses(on)
    expect(await read(response({ errors: [{ message: 'partial result' }], data: { repository: {} } }))).toEqual({ isOk: false, error: 'unreadable gh output' })
  })
}

for (const state of ['OPEN', 'CLOSED']) {
  test(`GraphQL issue reads preserve ${state} and label names`, async (_$, on) => {
    const response = responses(on)
    expect(await readIssue(response({ data: { repository: { issue: { state, title: 'An issue', labels: { nodes: [{ name: 'ready-for-agent' }] } } } } }), 1))
      .toEqual({ isOk: true, value: { state, title: 'An issue', labels: ['ready-for-agent'] } })
  })
}

test('a missing GraphQL issue is unreadable; a nonzero exit retains not found', async (_$, on) => {
  const response = responses(on)
  expect(await readIssue(response({ data: { repository: { issue: null } } }), 1)).toEqual({ isOk: false, error: 'unreadable gh output' })
  expect(await readIssue(response({}, 1), 1)).toEqual({ isOk: false, error: 'not found' })
})

test('the candidate head travels as a variable, including quotes in ref names, and every base is listed', async (_$, on) => {
  const head = 'feature/"quoted"'
  const base = 'release/"stable"'
  const { boundaries } = createWorld(on, { branch: head }, { prs: [buildPullRequest({ headRefName: head, baseRefName: base }), buildPullRequest({ number: 6, url: 'https://github.test/pull/6', headRefName: head })] })
  expect(await listPullRequests(boundaries.processes, head)).toEqual({
    isOk: true, value: [{ number: 5, state: 'OPEN', url: 'https://github.test/pull/5', headRefOid: 'c1', baseRefName: base, closingIssuesReferences: [1, 2] },
      { number: 6, state: 'OPEN', url: 'https://github.test/pull/6', headRefOid: 'c1', baseRefName: 'main', closingIssuesReferences: [1, 2] }],
  })
})

for (const [base, closing] of [['main', [1]], ['next', [1, 2, 3]]] as const) {
  test(`a candidate into ${base} closes ${closing.join(', ')}: body keywords count only off the repository's default branch`, async (_$, on) => {
    const { boundaries } = createWorld(on, { branch: 'feature' }, { prs: [buildPullRequest({ baseRefName: base, closingIssuesReferences: [{ number: 1 }], body: 'Fixes #2\nResolves owner/repo#3\nCloses another/repo#4' })] })
    const read = await listPullRequests(boundaries.processes, 'feature')
    expect(read.isOk && read.value[0]?.closingIssuesReferences).toEqual([...closing])
  })
}

for (const connection of ['candidates', 'closing issues']) {
  test(`a missing ${connection} pagination flag never guesses completeness`, async (_$, on) => {
    const response = responses(on)
    const closing = { nodes: [{ number: 1 }], pageInfo: connection === 'closing issues' ? {} : { hasNextPage: false } }
    const nodes = [{ ...buildPullRequest(), closingIssuesReferences: closing }]
    const body = { data: { repository: { nameWithOwner: 'owner/repo', defaultBranchRef: { name: 'main' }, pullRequests: { nodes, pageInfo: connection === 'candidates' ? {} : { hasNextPage: false } } } } }
    expect(await listPullRequests(response(body), 'feature')).toEqual({ isOk: false, error: 'PR candidate list incomplete or unreadable' })
  })
}

test('closing PRs are filtered against the repository returned by the same GraphQL read', async (_$, on) => {
  const response = responses(on)
  const pr = { number: 5, state: 'MERGED', headRefName: 'feature', isCrossRepository: false, baseRepository: { nameWithOwner: 'different/project' } }
  const body = { data: { repository: { nameWithOwner: 'different/project', defaultBranchRef: { name: 'main' }, issue: { closedByPullRequestsReferences: {
    nodes: [pr, { ...pr, number: 6, baseRepository: { nameWithOwner: 'owner/repo' } }, { ...pr, number: 7, state: 'CLOSED' }, { ...pr, number: 8, isCrossRepository: true }],
    pageInfo: { hasNextPage: false },
  }, timelineItems: { nodes: [{ source: { __typename: 'Issue' } }], pageInfo: { hasNextPage: false } } } } } }
  expect(await readClosingPullRequests(response(body), 1)).toEqual({ isOk: true, value: [{ number: 5, state: 'MERGED', headRefName: 'feature' }] })
})
