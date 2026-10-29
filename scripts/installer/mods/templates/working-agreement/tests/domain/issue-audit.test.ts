import { expect } from 'claude-code/testing'

import { pushedCloseOut } from '../support/builders'
import { endTurn, readFlowStatus, readPromptContext } from '../support/helpers'
import { test } from '../support/kit'
import { createWorld } from '../support/world'
import type { Options, World } from '../support/world'

interface FakeIssue { title: string; body: string; labels: string[]; assignees: string[] }

const compliant: FakeIssue = {
  title: 'feat(mod): audit', body: '## Problem\n\nx\n\n## Solution\n\ny\n\n## Acceptance criteria\n\n- [ ] z', labels: ['ready-for-agent', 'type::feat', 'priority::medium'], assignees: ['me'],
}
const broken: FakeIssue = { title: 'Audit', body: '## Problem\n\nx', labels: ['needs-triage', 'ready-for-agent', 'type::feat', 'priority::low'], assignees: [] }

/**
 * Builds a GitHub that answers the audit's reads from a mutable set of issues and records them.
 * @param issues - The issues by number; a string answers the read with that error.
 * @param authored - The issue numbers the user's account opened, listed only when the search references a unit issue.
 * @returns The gh answer and the recorded calls.
 */
function createGithub(issues: Map<number, FakeIssue | string>, authored: number[] = []): { gh: NonNullable<Options['gh']>; calls: string[][] } {
  const calls: string[][] = []
  const gh: NonNullable<Options['gh']> = args => {
    if (args[0] !== 'api') return undefined
    calls.push(args)
    if (args[1]?.startsWith('search/issues?')) return { stdout: (args.at(-1) ?? '').includes('#(1|2)') ? authored.map(String).join('\n') : '' }
    const read = /^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)$/.exec(args[1] ?? '')
    const issue = read ? issues.get(Number(read[1])) : undefined
    if (typeof issue === 'string') return { exitCode: 1, stderr: issue }
    return issue && { stdout: JSON.stringify(issue) }
  }
  return { gh, calls }
}

/**
 * Starts a Close out awaiting only its audit, whose session tracks the given issues.
 * @param on - The test's hook registration.
 * @param github - The fake GitHub.
 * @param tracked - The issues the issue tools wrote.
 * @returns The world.
 */
function createAuditWorld(on: Parameters<typeof createWorld>[0], github: ReturnType<typeof createGithub>, tracked: number[]): World {
  return createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, gh: github.gh, session: { ...pushedCloseOut.session, audit: { since: 0, issues: tracked } } })
}

/**
 * Lists the pane's notes as text.
 * @param world - The world.
 * @returns Each note's key and value.
 */
const readNotes = (world: World): string[] => (world.views.at(-1)?.notes ?? []).map(note => `${note.key}: ${note.value}`)

test('an issue the session wrote is re-read at turn end, each violation listed with field, expected and actual, and the PR step held', async ($, on) => {
  const issues = new Map<number, FakeIssue | string>([[101, broken]])
  const world = createAuditWorld(on, createGithub(issues), [101])
  await endTurn($)
  expect(readNotes(world)).toEqual([
    'Issue #101: title: expected matches ^[a-z]+(\\([^()\\s]+\\))?!?: \\S.*$, has Audit',
    'Issue #101: triage: expected one of needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix, has needs-triage, ready-for-agent',
    'Issue #101: assignee: expected at least one, has none',
    'Issue #101: body: expected the sections of one kind (spec, ticket, bug), has sections Problem',
  ])
  expect(await readFlowStatus($)).toContain('#101 non-compliant — fix with issue_edit')
  expect(await readPromptContext($)).toContain('with issue_edit')
  issues.set(101, compliant)
  await endTurn($)
  expect(readNotes(world)).toEqual([])
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

test('an issue the user\'s account opened this session that references a unit issue is audited without any tool having written it', async ($, on) => {
  const github = createGithub(new Map([[300, { ...compliant, labels: ['type::feat', 'priority::low'] }]]), [300])
  const world = createAuditWorld(on, github, [])
  await endTurn($)
  expect(readNotes(world)).toEqual(['Issue #300: triage: expected one of needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix, has none'])
})

test('a GitHub read failure keeps the audit pending and the PR step held, never compliant', async ($, on) => {
  const world = createAuditWorld(on, createGithub(new Map([[101, 'HTTP 502']])), [101])
  await endTurn($)
  expect(readNotes(world)).toEqual(['Issue audit: pending — cannot read #101: HTTP 502'])
  const status = await readFlowStatus($)
  expect(status).toContain('issue audit pending (cannot read #101: HTTP 502)')
  expect(status).not.toContain('✓ PR #5')
})

test('a wayfinder decision issue needs no Conventional title and no body sections', async ($, on) => {
  const world = createAuditWorld(on, createGithub(new Map([[101, { ...compliant, title: 'Which store?', body: 'Free text.', labels: ['ready-for-agent', 'type::docs', 'priority::low', 'wayfinder:research'] }]])), [101])
  await endTurn($)
  expect(readNotes(world)).toEqual([])
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})
