import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { listPullRequests, readClosingPullRequests, readIssue } from '../../hooks/lib/github'
import type { ProcessPort } from '../../hooks/lib/process'
import { buildPullRequest } from '../support/builders'
import { createWorld } from '../support/world'

const responses = (on: On) => (body: unknown, exitCode = 0): ProcessPort =>
  createWorld(on, { branch: 'feature' }, { ghResponse: { body, exitCode }, session: { flow: null } }).boundaries.processes

for (const [name, read] of [
  ['issue', (port: ProcessPort) => readIssue(port, 1)],
  ['candidate PRs', (port: ProcessPort) => listPullRequests(port, 'feature', 'main')],
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

test('candidate branches travel as variables, including quotes in ref names', async (_$, on) => {
  const head = 'feature/"quoted"'
  const base = 'release/"stable"'
  const { boundaries } = createWorld(on, { branch: head }, { prs: [buildPullRequest({ headRefName: head, baseRefName: base })] })
  expect(await listPullRequests(boundaries.processes, head, base)).toEqual({
    isOk: true, value: [{ number: 5, state: 'OPEN', url: 'https://github.test/pull/5', headRefOid: 'c1', closingIssuesReferences: [1, 2] }],
  })
})

for (const connection of ['candidates', 'closing issues']) {
  test(`a missing ${connection} pagination flag never guesses completeness`, async (_$, on) => {
    const response = responses(on)
    const closing = { nodes: [{ number: 1 }], pageInfo: connection === 'closing issues' ? {} : { hasNextPage: false } }
    const nodes = [{ ...buildPullRequest(), closingIssuesReferences: closing }]
    const body = { data: { repository: { pullRequests: { nodes, pageInfo: connection === 'candidates' ? {} : { hasNextPage: false } } } } }
    expect(await listPullRequests(response(body), 'feature', 'main')).toEqual({ isOk: false, error: 'PR candidate list incomplete or unreadable' })
  })
}

test('closing PRs are filtered against the repository returned by the same GraphQL read', async (_$, on) => {
  const response = responses(on)
  const pr = { number: 5, state: 'MERGED', headRefName: 'feature', isCrossRepository: false, baseRepository: { nameWithOwner: 'different/project' } }
  const body = { data: { repository: { nameWithOwner: 'different/project', issue: { closedByPullRequestsReferences: {
    nodes: [pr, { ...pr, number: 6, baseRepository: { nameWithOwner: 'owner/repo' } }, { ...pr, number: 7, state: 'CLOSED' }, { ...pr, number: 8, isCrossRepository: true }],
    pageInfo: { hasNextPage: false },
  } } } } }
  expect(await readClosingPullRequests(response(body), 1)).toEqual({ isOk: true, value: [{ number: 5, state: 'MERGED', headRefName: 'feature' }] })
})
