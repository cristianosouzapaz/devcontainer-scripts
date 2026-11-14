import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { coordinator } from '../support/builders'
import { callModTool, endTurn, readFlowStatus, runFlowCommand } from '../support/helpers'
import { createIssueGithub, defaultIssueLabels, ticket, triageLabels, values } from '../support/issue-github'
import type { IssueGithub } from '../support/issue-github'
import { test } from '../support/kit'
import { createWorld, root } from '../support/world'

const triage = triageLabels
const typed = { types: ['feat', 'fix'], priorities: ['high', 'low'] }
const typedLabels = [...triage, 'type::feat', 'type::fix', 'priority::high', 'priority::low']
const graphqlFailure = { exitCode: 1, stderr: 'GraphQL: Something went wrong while executing your query.\nwhile adding labels (addLabelsToLabelable)\n' }
const completeLabels = ['ready-for-agent', 'type::fix', 'priority::high']

/**
 * Starts a world on a feature branch with this GitHub and, when given, this config, approved unless told otherwise.
 * @param on - The test's hook registration.
 * @param github - The fake GitHub.
 * @param config - The config file's content, or undefined for none.
 * @param isApproved - Whether the user approved the config.
 * @returns The world.
 */
function createIssueWorld(on: Parameters<typeof createWorld>[0], github: IssueGithub, config?: object, isApproved = true): ReturnType<typeof createWorld> {
  const text = config && JSON.stringify(config)
  const world = createWorld(on, { branch: 'feat' }, { gh: github.gh, ...(text && isApproved ? { approvedConfig: text } : {}) })
  if (text) world.files.set(`${root}/.claude/working-agreement.json`, text)
  return world
}

/**
 * Runs a Bash command and reads its deny.
 * @param $ - The test's engine.
 * @param command - The command.
 * @returns Its deny, if any.
 */
async function readBashDeny($: Engine, command: string): Promise<string | undefined> {
  return (await $.tool.call({ tool: 'Bash', command })).deny
}

/**
 * Lists the gh calls that write.
 * @param github - The fake GitHub.
 * @returns The write calls' first two words.
 */
const writes = (github: IssueGithub): string[] => github.calls.filter(args => ['issue', 'label'].includes(args[0] ?? '')).map(args => args.slice(0, 2).join(' '))

test('issue_create writes a complete ticket and confirms it by reading it back', async ($, on) => {
  const github = createIssueGithub()
  createIssueWorld(on, github)
  const outcome = await callModTool($, 'issue_create', ticket)
  expect(outcome.isError).toBe(false)
  expect(outcome.text).toContain('Created https://github.com/o/r/issues/101')
  expect(github.issues.get(101)).toEqual({ labels: ['ready-for-agent', 'type::feat', 'priority::medium'], assignees: ['me'], parent: 419, blockedBy: [445], state: 'OPEN', stateReason: null })
  const created = github.calls.find(args => args[1] === 'create') ?? []
  expect(values(created, '--body')[0]).toContain('## What to build\n\nThe tools.')
  expect(created).not.toContain('--milestone')
  expect(created).not.toContain('--type')
})

for (const [name, fields, fragment] of [
  ['a title that is not Conventional-Commit style', { title: 'Issue tools' }, '^[a-z]+'],
  ['a body without the kind\'s sections', { sections: { Parent: '#419' } }, 'missing: What to build, Acceptance criteria, Blocked by'],
  ['an unknown kind', { kind: 'epic' }, 'kind must be one of: spec, ticket, bug, decision'],
  ['an empty assignee list', { assignees: [] }, 'assignee'],
  ['a triage label passed as a plain label', { labels: ['needs-info'] }, 'through triage'],
] as const) {
  test(`issue_create refuses ${name} before writing`, async ($, on) => {
    const github = createIssueGithub()
    createIssueWorld(on, github)
    const outcome = await callModTool($, 'issue_create', { ...ticket, ...fields })
    expect(outcome.isError || outcome.deny !== undefined).toBe(true)
    expect(outcome.deny ?? outcome.text).toContain(fragment)
    expect(writes(github)).toEqual([])
  })
}

test('a wayfinder decision issue is exempt from the title pattern', async ($, on) => {
  const github = createIssueGithub({ labels: [...defaultIssueLabels, 'wayfinder:research'] })
  createIssueWorld(on, github)
  const outcome = await callModTool($, 'issue_create', { title: 'Which store keeps the queue?', kind: 'decision', sections: { Question: 'Which?' }, triage: 'ready-for-agent',
    type: 'docs', priority: 'low', labels: ['wayfinder:research'] })
  expect(outcome.isError).toBe(false)
  expect(github.issues.get(101)?.labels).toEqual(['ready-for-agent', 'type::docs', 'priority::low', 'wayfinder:research'])
})

test('configured type and priority labels are each required exactly once', async ($, on) => {
  const github = createIssueGithub({ labels: typedLabels })
  createIssueWorld(on, github, { issues: typed })
  const { type, priority, ...untyped } = ticket
  expect((await callModTool($, 'issue_create', untyped)).text).toContain('Exactly one type label')
  expect((await callModTool($, 'issue_create', { ...untyped, type: 'feat' })).text).toContain('Exactly one priority label')
  expect((await callModTool($, 'issue_create', { ...ticket, type: 'chore', priority: 'high' })).text).toContain('type must be one of: type::feat, type::fix')
  expect((await callModTool($, 'issue_create', { ...ticket, type: 'feat', priority: 'high' })).isError).toBe(false)
  expect(github.issues.get(101)?.labels).toEqual(['ready-for-agent', 'type::feat', 'priority::high'])
})

test('without a config, the default type and priority labels are required and their absence names /flow setup-labels', async ($, on) => {
  const github = createIssueGithub({ labels: triage })
  createIssueWorld(on, github)
  const { type, ...untyped } = ticket
  expect((await callModTool($, 'issue_create', untyped)).text).toContain('/flow setup-labels')
  expect((await callModTool($, 'issue_edit', { number: 7, triage: 'ready-for-human' })).text).toContain('/flow setup-labels')
  expect(writes(github)).toEqual([])
})

test('an unapproved config is ignored: an agent cannot relax the rules by editing it', async ($, on) => {
  const github = createIssueGithub()
  createIssueWorld(on, github, { issues: { types: [], priorities: [] } }, false)
  const { type, priority, ...untyped } = ticket
  expect((await callModTool($, 'issue_create', untyped)).text).toContain('Exactly one type label')
  expect(await readFlowStatus($)).toContain('not approved · issue writes use the built-in defaults')
})

test('a configured label missing from the repository is refused, naming /flow setup-labels', async ($, on) => {
  const github = createIssueGithub({ labels: triage })
  createIssueWorld(on, github, { issues: typed })
  const outcome = await callModTool($, 'issue_create', { ...ticket, type: 'feat', priority: 'high' })
  expect(outcome.text).toContain('type::feat, type::fix')
  expect(outcome.text).toContain('/flow setup-labels')
  expect(writes(github)).toEqual([])
})

test('the native issue type, milestone and project are applied only when configured or reported', async ($, on) => {
  const github = createIssueGithub({ labels: typedLabels, issueTypes: ['Feature', 'Bug'] })
  createIssueWorld(on, github, { issues: { ...typed, milestone: 'v5', project: 'Roadmap', nativeTypes: { feat: 'Feature' } } })
  expect((await callModTool($, 'issue_create', { ...ticket, priority: 'low' })).isError).toBe(false)
  const created = github.calls.find(args => args[1] === 'create') ?? []
  expect([values(created, '--type'), values(created, '--milestone'), values(created, '--project')]).toEqual([['Feature'], ['v5'], ['Roadmap']])
})

test('a parent that does not read back is reported as a failure', async ($, on) => {
  const github = createIssueGithub({ isParentDropped: true })
  createIssueWorld(on, github)
  const outcome = await callModTool($, 'issue_create', ticket)
  expect(outcome.isError).toBe(true)
  expect(outcome.text).toContain('parent is unset, not #419')
})

test('a failed GitHub read refuses the write', async ($, on) => {
  const github = createIssueGithub({ isLabelReadFailing: true })
  createIssueWorld(on, github)
  const outcome = await callModTool($, 'issue_create', ticket)
  expect(outcome.isError).toBe(true)
  expect(outcome.text).toContain('cannot read the repository labels: GitHub unreachable after 3 attempts: HTTP 502')
  expect(writes(github)).toEqual([])
})

test('an issues config with an unknown field is refused', async ($, on) => {
  const github = createIssueGithub()
  createIssueWorld(on, github, { issues: { colour: 'red' } })
  expect((await callModTool($, 'issue_create', ticket)).text).toContain('issues.colour: unknown field')
})

test('a type or priority label the config does not declare is refused', async ($, on) => {
  const github = createIssueGithub()
  createIssueWorld(on, github, { issues: { ...typed, labels: { 'type::feet': { color: '2da160' } } } })
  expect((await callModTool($, 'issue_create', ticket)).text).toContain('issues.labels.type::feet: not declared in issues.types or issues.priorities')
})

test('issue_edit swaps the triage label and keeps the issue complete', async ($, on) => {
  const github = createIssueGithub()
  createIssueWorld(on, github)
  expect((await callModTool($, 'issue_edit', { number: 7, triage: 'ready-for-human', type: 'fix', priority: 'high' })).text).toContain('Edited #7')
  expect(github.issues.get(7)?.labels).toEqual(['ready-for-human', 'type::fix', 'priority::high'])
  expect((await callModTool($, 'issue_edit', { number: 7, title: 'no pattern' })).text).toContain('title must match')
})

test('issue_edit reopens a closed issue when no other field changes', async ($, on) => {
  const github = createIssueGithub({ issues: { 7: { labels: ['ready-for-agent', 'type::fix', 'priority::high'], state: 'CLOSED', stateReason: 'COMPLETED' } } })
  createIssueWorld(on, github)
  const outcome = await callModTool($, 'issue_edit', { number: 7, state: 'open' })
  expect(outcome.text).toContain('Edited #7')
  expect(outcome.isError).toBe(false)
  expect(github.issues.get(7)?.state).toBe('OPEN')
  expect(writes(github)).toEqual(['issue reopen'])
})

test('issues created or edited through the tools are re-read by the audit at turn end', async ($, on) => {
  const github = createIssueGithub()
  createIssueWorld(on, github)
  await callModTool($, 'issue_create', ticket)
  await callModTool($, 'issue_edit', { number: 7, triage: 'ready-for-human', type: 'fix', priority: 'high' })
  await callModTool($, 'issue_close', { number: 7, reason: 'completed' })
  await endTurn($)
  expect(github.calls.flatMap(args => /^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)$/.exec(args[1] ?? '')?.[1] ?? []).sort()).toEqual(['101', '7'])
})

test('issue_close records the state reason and issue_comment returns the comment URL', async ($, on) => {
  const github = createIssueGithub()
  createIssueWorld(on, github)
  expect((await callModTool($, 'issue_close', { number: 7, reason: 'not planned' })).text).toContain('Closed #7 as not planned')
  expect(github.issues.get(7)?.stateReason).toBe('NOT_PLANNED')
  expect((await callModTool($, 'issue_comment', { number: 7, body: 'Resolved.' })).text).toContain('#issuecomment-1')
})

test('issue_close reports an issue that never had an assignee as closed', async ($, on) => {
  const github = createIssueGithub({ issues: { 7: { labels: ['needs-triage'], assignees: [] } } })
  createIssueWorld(on, github)
  const outcome = await callModTool($, 'issue_close', { number: 7, reason: 'not planned', comment: 'Obsolete.' })
  expect(outcome.isError).toBe(false)
  expect(outcome.text).toContain('Closed #7 as not planned')
})

test('a coordinator comments through issue_comment',async ($, on) => {
  const github = createIssueGithub()
  createWorld(on, { branch: 'feat' }, { gh: github.gh, session: coordinator })
  expect((await callModTool($, 'issue_comment', { number: 7, body: 'Decision.' })).isError).toBe(false)
})

for (const command of [
  'gh issue create --title x --body y', 'gh issue edit 3 --add-label wontfix', 'gh issue close 3', 'gh issue reopen 3', 'gh issue comment 3 -b hi',
  'gh issue develop 3', 'gh issue transfer 3 o/r', 'gh issue delete 3', 'gh label create x', 'gh label clone o/r',
  'gh api -X POST repos/{owner}/{repo}/issues -f title=x', 'gh api repos/{owner}/{repo}/issues -ftitle=x', 'gh api repos/{owner}/{repo}/issues/3/labels -f labels[]=x',
  'gh api --method DELETE repos/{owner}/{repo}/milestones/1', 'gh api repos/{owner}/{repo}/issues/3/sub_issues -F sub_issue_id=9',
  'gh api graphql -f query=\'mutation{addSubIssue(input:{issueId:"a",subIssueId:"b"}){clientMutationId}}\'',
]) {
  test(`a raw Bash issue write is denied with the tool to use: ${command}`, async ($, on) => {
    createIssueWorld(on, createIssueGithub())
    const deny = await readBashDeny($, command)
    expect(deny).toContain('issue_create (to-spec')
    expect(deny).toContain('wayfinder')
  })
}

test('a raw issue write quoted inside an argument is denied naming the matched words and a file for the text', async ($, on) => {
  createIssueWorld(on, createIssueGithub())
  const deny = await readBashDeny($, 'herdr agent prompt manager "the unit ran gh label edit x --color 000000"')
  expect(deny).toContain('`gh label edit`')
  expect(deny).toContain('from a file')
  expect(deny).not.toContain('writes are denied')
})

for (const command of ['gh issue view 3 --comments','gh api repos/{owner}/{repo}/issues/3/comments --paginate', 'gh api graphql -f query=\'query{viewer{login}}\'', 'gh api -X GET repos/{owner}/{repo}/labels -f per_page=100']) {
  test(`a GitHub read in Bash is not denied: ${command}`, async ($, on) => {
    createIssueWorld(on, createIssueGithub())
    expect(await readBashDeny($, command) ?? '').not.toContain('issue_create')
  })
}

test('/flow setup-labels is the user\'s and creates every configured label idempotently', async ($, on) => {
  const github = createIssueGithub()
  createIssueWorld(on, github, { issues: { ...typed, labels: { 'type::feat': { color: '2da160', description: 'New feature' } } } })
  expect((await runFlowCommand($, 'setup-labels', { kind: 'plugin', name: 'working-agreement' })).text).toContain("user's to run")
  expect(writes(github)).toEqual([])
  const first = (await runFlowCommand($, 'setup-labels')).text
  const created = github.calls.filter(args => args[0] === 'label')
  expect(created.every(args => args.includes('--force'))).toBe(true)
  expect(new Set(created.map(args => args[2]))).toEqual(new Set([...triage, 'delegated-review', 'type::feat', 'type::fix', 'priority::high', 'priority::low']))
  expect(values(created.find(args => args[2] === 'type::feat') ?? [], '--color')).toEqual(['2da160'])
  expect((await runFlowCommand($, 'setup-labels')).text).toBe(first)
  expect(github.calls.filter(args => args[0] === 'label')).toEqual([...created, ...created])
})

test('issue_create that created the issue but cannot confirm it answers stopped, never refused', async ($, on) => {
  const github = createIssueGithub({ isParentDropped: true })
  createIssueWorld(on, github)
  const outcome = await callModTool($, 'issue_create', ticket)
  expect(outcome.isError).toBe(true)
  expect(outcome.text).toContain('issue_create stopped: Created https://github.com/o/r/issues/101')
  expect(outcome.text).not.toContain('refused')
})

test('issue_edit whose gh edit applied its changes and then failed answers stopped with what was applied and gh\'s real error', async ($, on) => {
  const github = createIssueGithub()
  const failing: IssueGithub = { ...github, gh: args => {
    const answer = github.gh(args)
    return args[0] === 'issue' && args[1] === 'edit'
      ? { exitCode: 1, stderr: 'failed to update https://github.com/o/r/issues/7:\nGraphQL: Something went wrong while executing your query. (addBlockedBy)\n' } : answer
  } }
  createIssueWorld(on, failing)
  const outcome = await callModTool($, 'issue_edit', { number: 7, triage: 'ready-for-human', type: 'fix', priority: 'high' })
  expect(github.issues.get(7)?.labels).toEqual(['ready-for-human', 'type::fix', 'priority::high'])
  expect(outcome.isError).toBe(true)
  expect(outcome.text).toContain('issue_edit stopped: ')
  expect(outcome.text).toContain('failed to update https://github.com/o/r/issues/7:')
  expect(outcome.text).toContain('GraphQL: Something went wrong while executing your query. (addBlockedBy)')
  expect(outcome.text).toContain('ready-for-human')
  expect(outcome.text).not.toContain('refused')
})

/**
 * Wraps a fake GitHub so one issue subcommand fails, after its change landed when told to.
 * @param github - The fake GitHub.
 * @param subcommand - The subcommand that fails, such as edit.
 * @param failure - gh's answer.
 * @param isLanded - Whether the change landed before gh failed.
 * @returns The wrapped fake.
 */
const failIssueCall = (github: IssueGithub, subcommand: string, failure: { exitCode?: number; stdout?: string; stderr?: string }, isLanded: boolean): IssueGithub =>
  ({ ...github, gh: args => {
    if (args[0] !== 'issue' || args[1] !== subcommand) return github.gh(args)
    if (isLanded) github.gh(args)
    return failure
  } })

// contract: an edit whose only landed change is the @me assignee answers stopped naming the login, never that nothing was applied
test('issue_edit whose @me assignee landed before gh failed answers stopped naming the login', async ($, on) => {
  const github = createIssueGithub({ issues: { 7: { labels: completeLabels, assignees: [] } } })
  createIssueWorld(on, failIssueCall(github, 'edit', graphqlFailure, true))
  const outcome = await callModTool($, 'issue_edit', { number: 7, assignees: ['@me'] })
  expect(outcome.text).toContain('issue_edit stopped: ')
  expect(outcome.text).toContain('assignee me applied')
})

// contract: a failed edit keeps every line of gh's error, not only the first
test('issue_edit that fails with nothing applied is refused with every line of the error gh gave', async ($, on) => {
  createIssueWorld(on, failIssueCall(createIssueGithub(), 'edit', graphqlFailure, false))
  const outcome = await callModTool($, 'issue_edit', { number: 7, triage: 'ready-for-human', type: 'fix', priority: 'high' })
  expect(outcome.text).toContain('issue_edit refused: ')
  expect(outcome.text).toContain('(addLabelsToLabelable)')
  expect(outcome.text).toContain('nothing was applied')
})

// contract: a bare reopen that fails and leaves the issue closed is refused, never reported as an edit
test('a bare reopen that fails and leaves the issue closed is refused', async ($, on) => {
  const github = createIssueGithub({ issues: { 7: { labels: completeLabels, state: 'CLOSED', stateReason: 'COMPLETED' } } })
  createIssueWorld(on, failIssueCall(github, 'reopen', graphqlFailure, false))
  const outcome = await callModTool($, 'issue_edit', { number: 7, state: 'open' })
  expect(outcome.text).toContain('issue_edit refused: ')
  expect(outcome.text).toContain('#7 is still closed')
  expect(outcome.text).not.toContain('Edited')
})

// contract: a bare reopen that landed before gh failed answers stopped, naming the issue open
test('a bare reopen that landed before gh failed answers stopped, naming the issue open', async ($, on) => {
  const github = createIssueGithub({ issues: { 7: { labels: completeLabels, state: 'CLOSED', stateReason: 'COMPLETED' } } })
  createIssueWorld(on, failIssueCall(github, 'reopen', graphqlFailure, true))
  const outcome = await callModTool($, 'issue_edit', { number: 7, state: 'open' })
  expect(outcome.text).toContain('issue_edit stopped: #7 is open')
  expect(outcome.text).not.toContain('Edited')
})

// contract: a create that gh reports done without an issue URL did not finish, naming where to check, never refused
test('issue_create that exits zero without an issue URL answers that it did not finish', async ($, on) => {
  createIssueWorld(on, failIssueCall(createIssueGithub(), 'create', { stdout: '' }, true))
  const outcome = await callModTool($, 'issue_create', ticket)
  expect(outcome.text).toContain('issue_create did not finish (')
  expect(outcome.text).toContain('before creating it again')
})

// contract: a read GitHub answers not found keeps gh's own error after the classification
test('an issue GitHub reports not found keeps the error gh gave', async ($, on) => {
  const github = createIssueGithub()
  createIssueWorld(on, { ...github, gh: args => args.join(' ').includes('issue(number:99)')
    ? { exitCode: 1, stderr: 'GraphQL: Could not resolve to an Issue with the number of 99. (repository.issue)' } : github.gh(args) })
  const outcome = await callModTool($, 'issue_edit', { number: 99, triage: 'ready-for-human' })
  expect(outcome.text).toContain('not found: GraphQL: Could not resolve to an Issue with the number of 99.')
})

// contract: an edit whose @me assignee cannot be checked because the gh login cannot be read did not finish, naming the unread assignee
test('issue_edit whose @me cannot be read back after gh failed answers that it did not finish', async ($, on) => {
  const github = createIssueGithub({ issues: { 7: { labels: completeLabels, assignees: [] } } })
  const state = { isEdited: false }
  createIssueWorld(on, { ...github, gh: args => {
    if (args[0] === 'issue' && args[1] === 'edit') {
      github.gh(args)
      state.isEdited = true
      return graphqlFailure
    }
    return state.isEdited && args.join(' ').startsWith('api user') ? { exitCode: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/user)' } : github.gh(args)
  } })
  const outcome = await callModTool($, 'issue_edit', { number: 7, assignees: ['@me'] })
  expect(outcome.text).toContain('issue_edit did not finish (')
  expect(outcome.text).toContain('assignee @me cannot be read back')
})

// contract: a comment that gh reports done without a comment URL did not finish, naming where to check, never refused
test('issue_comment that exits zero without a comment URL answers that it did not finish', async ($, on) => {
  createIssueWorld(on, failIssueCall(createIssueGithub(), 'comment', { stdout: '' }, true))
  const outcome = await callModTool($, 'issue_comment', { number: 7, body: 'Resolved.' })
  expect(outcome.text).toContain('issue_comment did not finish (')
  expect(outcome.text).toContain('before posting it again')
})

// contract: a failed edit matches its assignee regardless of case, as GitHub reads a login back in the account's own spelling
test('issue_edit whose assignee landed in another case before gh failed names it applied', async ($, on) => {
  const github = createIssueGithub({ issues: { 7: { labels: completeLabels, assignees: [] } } })
  createIssueWorld(on, { ...github, gh: args => {
    if (args[0] !== 'issue' || args[1] !== 'edit') return github.gh(args)
    github.gh(args.map(arg => arg === 'Alice' ? 'alice' : arg))
    return graphqlFailure
  } })
  const outcome = await callModTool($, 'issue_edit', { number: 7, assignees: ['Alice'] })
  expect(outcome.text).toContain('issue_edit stopped: #7: assignee Alice applied')
})
