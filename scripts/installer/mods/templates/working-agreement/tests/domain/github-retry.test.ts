import { expect } from 'claude-code/testing'

import { noFlow } from '../support/builders'
import { callModTool, declareFlow, readFlowStatus } from '../support/helpers'
import { createIssueGithub, ticket } from '../support/issue-github'
import type { IssueGithub } from '../support/issue-github'
import { test } from '../support/kit'
import { createWorld } from '../support/world'
import type { Options, World } from '../support/world'

/** A gh answer as the test world takes it. */
type GhAnswer = ReturnType<NonNullable<Options['gh']>>

/** How a one-time write fails on its first attempt, and whether that attempt landed on GitHub. */
interface FirstFailure { answer: NonNullable<GhAnswer>; isLanded: boolean }

// why: gh's own words when the TCP dial to api.github.com times out: the request was never sent.
const dialTimeout = { exitCode: 1, stderr: 'Post "https://api.github.com/graphql": dial tcp 140.82.121.6:443: i/o timeout' }
// why: gh's own words when the connection drops after the request went out: GitHub may have acted on it.
const connectionReset = { exitCode: 1, stderr: 'Post "https://api.github.com/graphql": read tcp 10.0.0.2:50000->140.82.121.6:443: read: connection reset by peer' }
// why: gh's own words for a transient server error: GitHub may have acted on the request before failing.
const badGateway = { exitCode: 1, stderr: 'HTTP 502: Bad Gateway (https://api.github.com/graphql)' }

const permanentReads = [
  ['a not-found issue', { exitCode: 1, stderr: 'GraphQL: Could not resolve to an Issue with the number of 3. (repository.issue)' }, 'not found — check the number'],
  ['a rate limit', { exitCode: 1, stderr: 'gh: API rate limit exceeded for user ID 1. (HTTP 403)' }, 'rate limited'],
  ['a secondary rate limit', { exitCode: 1, stderr: 'HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' }, 'rate limited'],
  ['an authentication failure', { exitCode: 4, stderr: 'HTTP 401: Bad credentials (https://api.github.com/graphql)' }, 'Bad credentials'],
] as const

// why: a dial that fails on gh's second request still follows a first request that landed.
const firstFailures = [
  ['a 502', { answer: badGateway, isLanded: true }],
  ['a dropped connection', { answer: connectionReset, isLanded: true }],
  ['a failed dial', { answer: dialTimeout, isLanded: true }],
  ['a failed dial', { answer: dialTimeout, isLanded: false }],
] as const satisfies readonly (readonly [string, FirstFailure])[]

// why: GitHub may finish a write whose request went out after the read-back looked, so finding nothing proves nothing.
const sentFailures = [
  ['a 502', badGateway],
  ['a 504', { exitCode: 1, stderr: 'HTTP 504: Gateway Timeout (https://api.github.com/graphql)' }],
  ['a dropped connection', connectionReset],
] as const

/**
 * Tells an issue read apart from the other GraphQL reads that name an issue.
 * @param args - The gh arguments.
 * @returns Whether the call reads the issue itself.
 */
const isIssueRead = (args: string[]): boolean => args.join(' ').includes('issue(number:') && !args.join(' ').includes('closedByPullRequestsReferences')

/**
 * Counts the gh calls of one issue subcommand that reached the fake GitHub.
 * @param github - The fake GitHub.
 * @param subcommand - The subcommand, such as comment.
 * @returns How many reached it.
 */
const countCalls = (github: IssueGithub, subcommand: string): number => github.calls.filter(args => args[0] === 'issue' && args[1] === subcommand).length

/**
 * Builds a world whose first call of an issue subcommand fails, after landing on the fake GitHub when told to; the
 * newest-issues listing a read-back makes reads the fake's issues, stamped with the world's time when they landed.
 * @param on - The test's hook registration.
 * @param subcommand - The subcommand whose first call fails.
 * @param failure - How it fails, and whether it landed.
 * @param land - What of the failing call lands, such as a create without one of its assignees; all of it when left out.
 * @param answerFirst - Answers a gh call before the world does, such as a read that fails; the world answers it when this returns undefined.
 * @returns The world and its fake GitHub.
 */
function createFailingWorld(on: Parameters<typeof createWorld>[0], subcommand: string, failure: FirstFailure, land: (args: string[]) => string[] = args => args,
  answerFirst: (args: string[]) => GhAnswer = () => undefined): { world: World; github: IssueGithub } {
  const github = createIssueGithub()
  const drops = { left: 1 }
  const created: { url: string; createdAt: string }[] = []
  const world: World = createWorld(on, { branch: 'feat' }, { gh: args => {
    const first = answerFirst(args)
    if (first) return first
    if (args[1]?.startsWith('repos/{owner}/{repo}/issues?state=all')) return { stdout: created.map(each => JSON.stringify({ ...each, text: ticket.title, author: 'me' })).join('\n') }
    if (args[0] !== 'issue' || args[1] !== subcommand || drops.left-- <= 0) {
      const answer = github.gh(args)
      if (args[0] === 'issue' && args[1] === 'create' && answer?.stdout) created.push({ url: answer.stdout.trim(), createdAt: new Date(world.clock.now()).toISOString() })
      return answer
    }
    if (!failure.isLanded) return failure.answer
    const answer = github.gh(land(args))
    // why: the failed attempt is not counted, so the count is the resends alone.
    github.calls.pop()
    if (subcommand === 'create' && answer?.stdout) created.push({ url: answer.stdout.trim(), createdAt: new Date(world.clock.now()).toISOString() })
    github.comments.forEach(comment => { comment.createdAt = new Date(world.clock.now()).toISOString() })
    return failure.answer
  } })
  return { world, github }
}

// contract: an issue read whose connection drops once at connect time is retried, the declaration succeeds, and /flow status counts the retry
test('an issue read dropped once at connect time is retried, the declaration succeeds and the status counts it', async ($, on) => {
  const drops = { left: 1 }
  createWorld(on, { branch: 'feat' }, { session: noFlow, gh: args => isIssueRead(args) && drops.left-- > 0 ? dialTimeout : undefined })
  expect((await declareFlow($, 'fix', [3])).deny).toBeUndefined()
  expect(await readFlowStatus($)).toMatch(/Retries\s+1 GitHub call retried/)
})

// contract: a GitHub probe dropped once at connect time is retried before its result is cached as unreachable
test('a probe dropped once at connect time is retried before it is cached as unreachable', async ($, on) => {
  const drops = { left: 1 }
  createWorld(on, { branch: 'feat' }, { session: noFlow, gh: args => args.join(' ').startsWith('api user') && drops.left-- > 0 ? dialTimeout : undefined })
  expect((await declareFlow($, 'fix', [3])).deny).toBeUndefined()
})

// contract: an issue read that keeps failing on the network names GitHub unreachable, never a wrong issue number
test('an issue read that keeps timing out reports GitHub unreachable, not a wrong issue number', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow, gh: args => isIssueRead(args) ? dialTimeout : undefined })
  const deny = (await declareFlow($, 'fix', [3])).deny
  expect(deny).toContain('GitHub unreachable')
  expect(deny).not.toContain('check the number')
})

for (const [name, answer, message] of permanentReads) {
  // contract: a permanent GitHub answer to an issue read fails at once, naming its real cause
  test(`${name} fails the issue read at once, naming its cause`, async ($, on) => {
    const reads = { count: 0 }
    createWorld(on, { branch: 'feat' }, { session: noFlow, gh: args => isIssueRead(args) && ++reads.count ? answer : undefined })
    expect((await declareFlow($, 'fix', [3])).deny).toContain(message)
    expect(reads.count).toBe(1)
  })
}

for (const [name, failure] of firstFailures) {
  const outcome = failure.isLanded ? 'is read back and never sent again' : 'is ruled out by its read-back and sent once more'
  // contract: a one-time write that fails transiently is read back: one that landed is never sent again, one never sent and ruled out is sent once more
  test(`a comment after ${name} that ${failure.isLanded ? 'landed' : 'did not land'} ${outcome}`, async ($, on) => {
    const { github } = createFailingWorld(on, 'comment', failure)
    expect((await callModTool($, 'issue_comment', { number: 7, body: 'Resolved.' })).text).toContain('Commented https://github.com/o/r/issues/7#issuecomment-1')
    expect(github.comments).toHaveLength(1)
    expect(countCalls(github, 'comment')).toBe(failure.isLanded ? 0 : 1)
  })

  // contract: a one-time write that fails transiently is read back: one that landed is never sent again, and is done when every requested field reads back, one never sent and ruled out is sent once more
  test(`an issue after ${name} that ${failure.isLanded ? 'landed' : 'did not land'} ${outcome}`, async ($, on) => {
    const { github } = createFailingWorld(on, 'create', failure)
    const outcome = (await callModTool($, 'issue_create', ticket)).text
    expect(outcome).toContain('Created https://github.com/o/r/issues/101')
    expect(outcome).not.toContain('stopped')
    if (failure.isLanded) expect(outcome).toContain('its labels, assignees, parent and blockers read back, its body is not read back, and gh issue create failed: ')
    expect(github.issues.has(102)).toBe(false)
    expect(countCalls(github, 'create')).toBe(failure.isLanded ? 0 : 1)
  })
}

// contract: a create found after a transient failure answers stopped when a requested field no read-back shows, such as its project, naming it and gh's error
test('an issue found after a transient failure answers stopped when its project is not read back', async ($, on) => {
  createFailingWorld(on, 'create', { answer: connectionReset, isLanded: true })
  const outcome = (await callModTool($, 'issue_create', { ...ticket, project: 'Board' })).text
  expect(outcome).toContain('issue_create stopped: Created https://github.com/o/r/issues/101; project not read back; ')
  expect(outcome).toContain('connection reset by peer')
})

// contract: a create whose gh command fails for good after the issue landed is read back: every requested field read back is done, one that did not land answers stopped naming it and gh's error
test('an issue whose create fails for good after it landed is read back, and stopped only for a field that did not land', async ($, on) => {
  const failure = { exitCode: 1, stderr: 'GraphQL: Something went wrong while executing your query. (addBlockedBy)' }
  const { github } = createFailingWorld(on, 'create', { answer: failure, isLanded: true })
  const done = await callModTool($, 'issue_create', ticket)
  expect(done.text).toContain('Created https://github.com/o/r/issues/101; its labels, assignees, parent and blockers read back, its body is not read back')
  expect(done.text).toContain('(addBlockedBy)')
  expect(done.text).not.toContain('stopped')
  expect(countCalls(github, 'create')).toBe(0)
})

// contract: a create found after gh failed whose requested assignee did not land answers stopped naming it, though another assignee did
test('an issue found after gh failed answers stopped when one of its assignees did not land', async ($, on) => {
  const land = (args: string[]): string[] => args.filter((arg, index) => !(arg === '--assignee' && args[index + 1] === 'bob') && !(arg === 'bob' && args[index - 1] === '--assignee'))
  createFailingWorld(on, 'create', { answer: connectionReset, isLanded: true }, land)
  const outcome = (await callModTool($, 'issue_create', { ...ticket, assignees: ['alice', 'bob'] })).text
  expect(outcome).toContain('issue_create stopped: Created https://github.com/o/r/issues/101; assignee bob not applied; ')
  expect(outcome).toContain('connection reset by peer')
})

// contract: an assignee is matched regardless of case, as GitHub reads a login back in the account's own spelling
test('an issue found after gh failed is done when its assignee reads back in another case', async ($, on) => {
  const land = (args: string[]): string[] => args.map(arg => arg === 'Alice' ? 'alice' : arg)
  createFailingWorld(on, 'create', { answer: connectionReset, isLanded: true }, land)
  const outcome = (await callModTool($, 'issue_create', { ...ticket, assignees: ['Alice'] })).text
  expect(outcome).toContain('Created https://github.com/o/r/issues/101; its labels, assignees, parent and blockers read back')
  expect(outcome).not.toContain('not applied')
})

// contract: a create found after gh failed whose @me cannot be resolved because the login read fails answers stopped, naming @me as not read back
test('an issue found after gh failed answers stopped when its @me cannot be read back', async ($, on) => {
  // why: the read-back finds the issue by the login's first read after the create landed, so only a later read fails.
  const logins = { isLanded: false, reads: 0 }
  const land = (args: string[]): string[] => {
    logins.isLanded = true
    return args
  }
  const answerFirst = (args: string[]): GhAnswer => logins.isLanded && args.join(' ').startsWith('api user') && ++logins.reads > 1
    ? { exitCode: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/user)' } : undefined
  createFailingWorld(on, 'create', { answer: connectionReset, isLanded: true }, land, answerFirst)
  const outcome = (await callModTool($, 'issue_create', ticket)).text
  expect(outcome).toContain('issue_create stopped: Created https://github.com/o/r/issues/101; assignee @me not read back; ')
})

// contract: a create whose gh command fails for good and whose read-back finds nothing is refused with gh's error
test('an issue whose create fails for good and did not land is refused with the error gh gave', async ($, on) => {
  const failure = { exitCode: 1, stderr: 'GraphQL: Something went wrong while executing your query. (createIssue)' }
  createFailingWorld(on, 'create', { answer: failure, isLanded: false })
  const outcome = await callModTool($, 'issue_create', ticket)
  expect(outcome.text).toContain('issue_create refused: ')
  expect(outcome.text).toContain('(createIssue)')
})

for (const [name, answer] of sentFailures) {
  // contract: a one-time write whose request went out is never sent again when its read-back finds nothing, and is reported as possibly written
  test(`a comment after ${name} that the read-back does not find is reported as possibly written, not sent again`, async ($, on) => {
    const { github } = createFailingWorld(on, 'comment', { answer, isLanded: false })
    expect((await callModTool($, 'issue_comment', { number: 7, body: 'Resolved.' })).text).toContain('may have been written')
    expect(countCalls(github, 'comment')).toBe(0)
  })

  // contract: a one-time write whose request went out is never sent again when its read-back finds nothing, and is reported as possibly written
  test(`an issue after ${name} that the read-back does not find is reported as possibly written, not created again`, async ($, on) => {
    const { github } = createFailingWorld(on, 'create', { answer, isLanded: false })
    expect((await callModTool($, 'issue_create', ticket)).text).toContain('may have been written')
    expect(countCalls(github, 'create')).toBe(0)
  })
}

// contract: a one-time write whose request never leaves is sent at most twice and reported as possibly written
test('a comment whose request never leaves is sent at most twice and reported as possibly written', async ($, on) => {
  const github = createIssueGithub()
  const posts = { count: 0 }
  createWorld(on, { branch: 'feat' }, { gh: args => args[0] === 'issue' && args[1] === 'comment' && ++posts.count ? dialTimeout : github.gh(args) })
  expect((await callModTool($, 'issue_comment', { number: 7, body: 'Resolved.' })).text).toContain('may have been written')
  expect(posts.count).toBe(2)
})

// contract: a one-time write whose read-back fails is reported as possibly written and never sent again
test('a comment whose read-back fails is reported as possibly written and not sent again', async ($, on) => {
  const github = createIssueGithub()
  const posts = { count: 0 }
  createWorld(on, { branch: 'feat' }, { gh: args => {
    if (args[0] === 'issue' && args[1] === 'comment' && ++posts.count) return badGateway
    return /^api repos\/\{owner\}\/\{repo\}\/issues\/\d+\/comments/.test(args.join(' ')) ? { exitCode: 1, stderr: 'HTTP 403: Resource not accessible by integration' } : github.gh(args)
  } })
  expect((await callModTool($, 'issue_comment', { number: 7, body: 'Resolved.' })).text).toContain('may have been written')
  expect(posts.count).toBe(1)
})

// contract: a close that posts a comment is never sent again after a transient failure, and is reported as possibly written
test('a close with a comment that times out is reported as possibly written and not sent again', async ($, on) => {
  const github = createIssueGithub()
  const closes = { count: 0 }
  createWorld(on, { branch: 'feat' }, { gh: args => args[0] === 'issue' && args[1] === 'close' && ++closes.count ? connectionReset : github.gh(args) })
  expect((await callModTool($, 'issue_close', { number: 7, reason: 'completed', comment: 'Done.' })).text).toContain('may have been written')
  expect(closes.count).toBe(1)
})
