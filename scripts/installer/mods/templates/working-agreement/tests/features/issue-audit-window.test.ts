import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { Next } from 'claude-code'

import { reread } from '../../hooks/core/pane-view'
import { carryAudit } from '../../hooks/core/issue-audit'
import { readSession, unitLogPath } from '../../hooks/core/record-store'
import { isRecord } from '../../hooks/lib/guards'
import type { FlowStep } from '../../types'
import type { SessionRecord } from '../../hooks/domain/records'
import { handleTurnComplete } from '../../hooks/handlers/turn'
import { pushedCloseOut } from '../support/builders'
import { callModTool, endTurn, readFlowStatus, runFlowCommand, startSession } from '../support/helpers'
import { createIssueGithub, ticket } from '../support/issue-github'
import { test } from '../support/kit'
import { createModuleHarness, faultyHost, newProcess, reloadModule } from '../support/reload'
import type { ModuleHarness } from '../support/reload'
import { createTestPort, createWorld } from '../support/world'
import type { Options, World } from '../support/world'

/** An issue's audited fields. */
interface AuditedFields { title: string; body: string; labels: string[]; assignees: string[] }

/** An issue as the search and the audit's read see it: its fields and when it was created. */
interface SearchedIssue { fields: AuditedFields; createdAt: number }

/** The faults a handoff test switches on: the session start's read, and the flow log's. */
interface HandoffFault { isStartUnread: boolean; isLogUnread: boolean }

/** The fake GitHub: the issues the audit reads, the fields the next issue tool create gets, and its gh answer. */
interface AuditGithub { issues: Map<number, SearchedIssue>; created: { fields: AuditedFields }; faults: GithubFaults; gh: NonNullable<Options['gh']> }

/** The reads the fake GitHub fails: the search, and the issues whose read it fails. */
interface GithubFaults { isSearchFailing: boolean; unreadable: Set<number> }

const minuteMs = 60_000
/** The end of the query that reads only the repository's name, which the audit's checks name. */
const repositoryQuery = '{repository(owner:$owner,name:$name){nameWithOwner defaultBranchRef{name}}}'
const compliant: AuditedFields = {
  title: 'feat(mod): audit', body: '## Problem\n\nx\n\n## Solution\n\ny\n\n## Acceptance criteria\n\n- [ ] z', labels: ['ready-for-agent', 'type::feat', 'priority::medium'], assignees: ['me'],
}
/** A compliant issue that references unit issue 1 in its body, as an issue written around the tools does. */
const referencing: AuditedFields = { ...compliant, body: `${compliant.body}\n\nPart of #1` }
const untriaged: AuditedFields = { ...referencing, labels: ['type::feat', 'priority::low'] }
const unassigned: AuditedFields = { ...compliant, assignees: [] }
const triageFinding = 'Issue #300: triage: expected one of needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix, has none'
const assigneeFinding = 'Issue #101: assignee: expected at least one, has none'

/**
 * Builds a GitHub whose search answers from each issue's creation time against the query's `created:>=` bound and from its body
 * against the references the query's filter selects, and whose issue tools create issues the audit then reads.
 * @param clock - The world's clock, which stamps a created issue.
 * @param clock.now - The time now.
 * @returns The fake.
 */
function createAuditGithub(clock: { now: () => number }): AuditGithub {
  const tools = createIssueGithub()
  const issues = new Map<number, SearchedIssue>()
  const created = { fields: compliant }
  const faults: GithubFaults = { isSearchFailing: false, unreadable: new Set() }
  const gh: AuditGithub['gh'] = args => {
    if (args[1] === 'graphql' && (args.at(-1) ?? '').endsWith(repositoryQuery)) return { stdout: JSON.stringify({ data: { repository: { nameWithOwner: 'o/r', defaultBranchRef: { name: 'main' } } } }) }
    if (args[0] === 'api' && args[1]?.startsWith('search/issues?')) {
      if (faults.isSearchFailing) return { exitCode: 1, stderr: 'HTTP 502' }
      const query = decodeURIComponent(new URLSearchParams(args[1].slice('search/issues?'.length)).get('q') ?? '')
      const bound = /created:>=(\S+)/.exec(query)?.[1]
      const since = bound ? Date.parse(bound) : 0
      const filter = /test\("(.*)"\)/.exec(args.at(-1) ?? '')?.[1] ?? '$^'
      return { stdout: [...issues].filter(([, issue]) => issue.createdAt >= since && new RegExp(filter).test(issue.fields.body)).map(([number]) => number).join('\n') }
    }
    const read = args[0] === 'api' ? /^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)$/.exec(args[1] ?? '') : null
    if (read && faults.unreadable.has(Number(read[1]))) return { exitCode: 1, stderr: 'HTTP 502' }
    const issue = read ? issues.get(Number(read[1])) : undefined
    if (issue) return { stdout: JSON.stringify(issue.fields) }
    const answer = tools.gh(args)
    const number = args[0] === 'issue' && args[1] === 'create' ? /issues\/(\d+)/.exec(answer?.stdout ?? '')?.[1] : undefined
    if (number) issues.set(Number(number), { fields: created.fields, createdAt: clock.now() })
    return answer
  }
  return { issues, created, faults, gh }
}

/**
 * Builds a Close out of issues 1 and 2 awaiting only its PR and its issue audit, over the fake GitHub.
 * @param on - The test's hook registration.
 * @param extra - Options added to the world's.
 * @returns The world and its GitHub.
 */
function arrange(on: Parameters<typeof createWorld>[0], extra: Options = {}): { world: World; github: AuditGithub } {
  const held: { world?: World } = {}
  const github = createAuditGithub({ now: () => held.world?.clock.now() ?? 0 })
  const world = createWorld(on, { branch: 'feat', ahead: 1 }, { ...pushedCloseOut, gh: github.gh, ...extra })
  held.world = world
  return { world, github }
}

/**
 * Moves the clock on and starts the session there, as its first launch.
 * @param world - The world.
 * @returns The session's start.
 */
async function openSessionAt(world: World): Promise<number> {
  await world.clock.advance(60 * minuteMs)
  world.usage.startedAt = world.clock.now()
  return world.usage.startedAt
}

/**
 * Lists the pane's notes as text.
 * @param world - The world.
 * @returns Each note's key and value.
 */
const readNotes = (world: World): string[] => (world.views.at(-1)?.notes ?? []).map(note => `${note.key}: ${note.value}`)

/**
 * Ends the main loop's turn as the engine does, through the harness's module.
 * @param harness - The direct-dispatch harness.
 * @returns Once the turn's end settled.
 */
async function completeTurn(harness: ModuleHarness): Promise<void> {
  await handleTurnComplete(harness.port, { reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' } as never,
    (async () => ({ text: '' })) as unknown as Next<'turn.complete'>)
  await harness.world.clock.settle()
}

/**
 * Builds a Close out whose `/clear` moves to chat `next` and restarts the session's start there, with faults a test switches on for
 * the handoff: the start read, and the flow log read.
 * @param on - The test's hook registration.
 * @param extra - Options added to the world's.
 * @returns The world, its GitHub and the faults.
 */
function arrangeHandoff(on: Parameters<typeof createWorld>[0], extra: Options = {}): { world: World; github: AuditGithub; fault: HandoffFault } {
  const fault: HandoffFault = { isStartUnread: false, isLogUnread: false }
  const held: { world?: World } = {}
  on('command.run', { command: 'clear' }, (_$, event, next) => {
    const world = held.world!
    world.chat.id = 'next'
    world.usage.startedAt = world.clock.now()
    fault.isStartUnread = false
    return next(event)
  })
  const { world, github } = arrange(on, { ...extra, failRead: path => fault.isLogUnread && path.includes('/working-agreement/log/') })
  held.world = world
  // why: the start read fails through the world's usage, which the clear restarts.
  Object.defineProperty(world.usage, 'error', { get: () => fault.isStartUnread ? 'usage unavailable' : undefined, configurable: true })
  return { world, github, fault }
}

/**
 * Runs a handoff to its end: `/flow handoff`, its `/handoff` turn writing one document, the turn's end, and the cleared chat's start.
 * @param $ - The test's engine.
 * @param world - The world.
 * @returns Once the handoff settled.
 */
async function runHandoff($: Engine, world: World): Promise<void> {
  await runFlowCommand($, 'handoff')
  await world.clock.settle()
  await $.turn.start({ text: '/handoff', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  await endTurn($)
  await world.clock.settle()
  expect(world.chat.id).toBe('next')
  // why: the engine starts the cleared chat's session, as it does after every /clear, which the kit does not raise by itself.
  await startSession($)
}

/**
 * Says whether a session write records the running marker an audit writes before it reads.
 * @param value - The written record.
 * @returns Whether it does.
 */
const isRunningMarker = (value: SessionRecord): boolean => value.audit?.result?.state === 'pending' && value.audit.result.reason.startsWith('audit running since')

/**
 * Finds the PR step of the view the pane shows now.
 * @param world - The world.
 * @returns The step, if the view has one.
 */
const readPrStep = (world: World): FlowStep | undefined => world.views.at(-1)?.steps.find(row => row.label.startsWith('PR'))

/**
 * Says whether a session write records an audit result other than the given one.
 * @param value - The written record.
 * @param state - The result state let through.
 * @returns Whether the write changes the audit's result away from that state.
 */
const isOtherResult = (value: SessionRecord, state: string): boolean => !!value.audit?.result && value.audit.result.state !== state

// contract: a reload's session start never narrows the audit's window: an issue created around the tools before it is still audited
test('an issue the account created before a reload is audited at the next turn end', async ($, on) => {
  const { world, github } = arrange(on)
  await openSessionAt(world)
  await startSession($)
  await world.clock.advance(minuteMs)
  github.issues.set(300, { fields: untriaged, createdAt: world.clock.now() })
  await world.clock.advance(minuteMs)
  await startSession($)
  await endTurn($)
  expect(readNotes(world)).toEqual([triageFinding])
})

// contract: an issue tool's write after a reload never opens the audit's window at that write
test('an issue the account created before a reload is still audited after an issue tool writes', async ($, on) => {
  const { world, github } = arrange(on)
  await openSessionAt(world)
  await startSession($)
  await world.clock.advance(minuteMs)
  github.issues.set(300, { fields: untriaged, createdAt: world.clock.now() })
  await world.clock.advance(minuteMs)
  await startSession($)
  await world.clock.advance(minuteMs)
  expect((await callModTool($, 'issue_create', ticket)).isError).toBe(false)
  await endTurn($)
  expect(readNotes(world)).toEqual([triageFinding])
})

// contract: a resume, a new process adopting the session, keeps the window from the session's first launch
test('an issue the account created before a resume is audited at the next turn end', async (_$, on) => {
  const { world, github } = arrange(on)
  const harness = createModuleHarness(world)
  await openSessionAt(world)
  await reloadModule(harness)
  await world.clock.advance(minuteMs)
  github.issues.set(300, { fields: untriaged, createdAt: world.clock.now() })
  await world.clock.advance(minuteMs)
  await newProcess(harness)
  await completeTurn(harness)
  expect(readNotes(world)).toEqual([triageFinding])
})

// contract: a handoff carries the audit: its tracked issues and result hold the PR step in the new chat, and its window, read before /clear restarts the session's start, still finds an issue created around the tools
test('a handoff carries the audit: the earlier chat\'s finding holds the PR step, and both findings are listed at the new chat\'s turn end', async ($, on) => {
  on('command.run', { command: 'clear' }, (_$, event, next) => {
    held.world!.chat.id = 'next'
    held.world!.usage.startedAt = held.world!.clock.now()
    return next(event)
  })
  const held: { world?: World } = {}
  const { world, github } = arrange(on)
  held.world = world
  await openSessionAt(world)
  await startSession($)
  await world.clock.advance(minuteMs)
  github.issues.set(300, { fields: untriaged, createdAt: world.clock.now() })
  github.created.fields = unassigned
  expect((await callModTool($, 'issue_create', ticket)).isError).toBe(false)
  await endTurn($)
  expect(readNotes(world)).toEqual([assigneeFinding, triageFinding])
  await world.clock.advance(minuteMs)
  await runFlowCommand($, 'handoff')
  await world.clock.settle()
  await $.turn.start({ text: '/handoff', turnId: 't' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  await endTurn($)
  await world.clock.settle()
  expect(world.chat.id).toBe('next')
  expect(await readFlowStatus($)).toContain('#101, #300 non-compliant — fix with issue_edit')
  await world.clock.advance(minuteMs)
  await endTurn($)
  expect(readNotes(world)).toEqual([assigneeFinding, triageFinding])
})

// contract: a handoff carries the result of the turn it ends, which its audit writes before the carry, never the result before it or the running marker
test('a handoff carries the audit result of the turn it ends', async ($, on) => {
  on('command.run', { command: 'clear' }, (_$, event, next) => {
    held.world!.chat.id = 'next'
    held.world!.usage.startedAt = held.world!.clock.now()
    return next(event)
  })
  const held: { world?: World } = {}
  const gate = { isHeld: false }
  // why: the handoff turn's audit waits on its read of the tracked issue, so a carry that did not wait for it would take the result before it.
  const { world, github } = arrange(on, { ghDelayMs: args => gate.isHeld && args[1] === 'repos/{owner}/{repo}/issues/101' ? minuteMs : 0 })
  held.world = world
  await openSessionAt(world)
  await startSession($)
  github.created.fields = unassigned
  expect((await callModTool($, 'issue_create', ticket)).isError).toBe(false)
  await endTurn($)
  expect(readNotes(world)).toEqual([assigneeFinding])
  await runFlowCommand($, 'handoff')
  await world.clock.settle()
  await $.turn.start({ text: '/handoff', turnId: 't' })
  github.issues.set(101, { fields: compliant, createdAt: github.issues.get(101)?.createdAt ?? 0 })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/handoff.md', content: 'Continue.' })
  gate.isHeld = true
  const ending = endTurn($)
  await world.clock.settle()
  // why: while the turn's audit is held, no chat may show the turn before it as this one's result.
  expect(await readFlowStatus($)).not.toContain('#101 non-compliant')
  await world.clock.advance(minuteMs)
  gate.isHeld = false
  await ending
  await world.clock.settle()
  expect(world.chat.id).toBe('next')
  expect(world.sessions.get('next')?.audit?.result).toEqual({ state: 'compliant' })
  const status = await readFlowStatus($)
  expect(status).not.toContain('#101 non-compliant')
  expect(status).toContain('✓ PR #5')
})

// contract: a handoff that cannot read the session's start carries the unit's declaration as the window, so the new chat still finds an issue created around the tools before the handoff
test('a handoff that cannot read the session start carries the unit\'s declaration as the window', async ($, on) => {
  const held = arrangeHandoff(on)
  const { world, github } = held
  const unit = world.sessions.get('sid')?.unit
  if (!unit) throw new Error('the world declares no unit')
  await openSessionAt(world)
  world.files.set(await unitLogPath(createTestPort(world), unit), `${JSON.stringify({ at: world.clock.now(), event: 'declare' })}\n`)
  await startSession($)
  await world.clock.advance(minuteMs)
  github.issues.set(300, { fields: untriaged, createdAt: world.clock.now() })
  await world.clock.advance(minuteMs)
  held.fault.isStartUnread = true
  await runHandoff($, world)
  expect(world.sessions.get('next')?.audit?.unsearched).toBeUndefined()
  await world.clock.advance(minuteMs)
  await endTurn($)
  expect(readNotes(world)).toEqual([triageFinding])
})

// contract: a handoff that can read neither the session's start nor the unit's declaration searches from the handoff on, and keeps a note naming the window before it as unsearched with the search to run by hand, holding nothing back
test('a handoff that can read neither the start nor the declaration notes the unsearched window without holding the PR step', async ($, on) => {
  const held = arrangeHandoff(on)
  const { world } = held
  await openSessionAt(world)
  await startSession($)
  await world.clock.advance(minuteMs)
  held.fault.isStartUnread = true
  held.fault.isLogUnread = true
  await runHandoff($, world)
  held.fault.isLogUnread = false
  await world.clock.advance(minuteMs)
  await endTurn($)
  expect(readNotes(world)).toEqual([expect.stringMatching(new RegExp(`^Issue audit: issues created before \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z are no longer searched \\(the session start could not be read: .+\\); check them by hand with gh search issues --repo o/r --author @me --created ">=<the date this unit's flow was declared>" \\(the declaration date could not be read: .+\\)$`))])
  expect(await readFlowStatus($)).toContain('✓ PR #5')
})

// contract: a handoff whose turn could not record its audit result carries it as pending in the new chat, never the result before it as the new chat's
test('a handoff whose turn could not record its audit result carries it as pending, and the new chat holds the PR step', async ($, on) => {
  const writes = { isFailing: false }
  const held = arrangeHandoff(on, {
    session: { ...pushedCloseOut.session, audit: { issues: [101] } },
    missSessionWrite: value => writes.isFailing && value.sessionId === 'sid' && !!value.audit?.result && value.audit.result.state !== 'compliant',
  })
  const { world, github } = held
  github.issues.set(101, { fields: compliant, createdAt: 0 })
  await openSessionAt(world)
  await startSession($)
  await endTurn($)
  expect(await readFlowStatus($)).toContain('✓ PR #5')
  github.issues.set(101, { fields: unassigned, createdAt: 0 })
  writes.isFailing = true
  await runHandoff($, world)
  writes.isFailing = false
  const status = await readFlowStatus($)
  expect(status).toContain('issue audit pending (the last audit\'s result was not recorded before the handoff (')
  expect(status).not.toContain('✓ PR #5')
})

// contract: a handoff whose re-read of the record fails still carries the window, so the new chat finds an issue created around the tools before the handoff
test('a handoff whose re-read of the record fails still carries the window', async (_$, on) => {
  const store = { isFailing: false }
  const { world, github } = arrange(on)
  const harness = createModuleHarness(world, {
    readSessionState: async () => {
      if (store.isFailing) throw new Error('session store unreadable')
      return world.directSessionState.readSessionState()
    },
  })
  await openSessionAt(world)
  await reloadModule(harness)
  await world.clock.advance(minuteMs)
  github.issues.set(300, { fields: untriaged, createdAt: world.clock.now() })
  await completeTurn(harness)
  expect(readNotes(world)).toEqual([triageFinding])
  const previous = await readSession(harness.port)
  store.isFailing = true
  const audit = await carryAudit(harness.port, previous)
  store.isFailing = false
  world.seedChat('next', { v: 1, sessionId: 'next', unit: previous.unit, units: [], info: previous.info, blocked: { edits: 0 }, gh: previous.gh, isLong: false, audit })
  world.chat.id = 'next'
  await world.clock.advance(minuteMs)
  world.usage.startedAt = world.clock.now()
  await completeTurn(harness)
  expect(readNotes(world)).toEqual([triageFinding])
  expect(audit.result).toEqual({ state: 'pending', reason: 'the audit could not be read before the handoff (session store unreadable); it runs again at the next turn end', findings: [expect.objectContaining({ issue: 300, field: 'triage' })] })
})

// contract: an audit whose writes fail while the chat's id cannot be read keeps its note where the chat reads it, and holds the PR step
test('an audit whose writes fail while the chat\'s id cannot be read keeps its note where the chat reads it', async (_$, on) => {
  const fault = { isArmed: false, isIdUnread: false, fallbackMisses: 0 }
  const { world, github } = arrange(on, {
    session: { ...pushedCloseOut.session, audit: { issues: [101] } },
    missSessionWrite: value => {
      // why: the running marker lands, so only the result's note says the result is missing, as the old key hid it.
      if (!fault.isArmed || !isOtherResult(value, 'compliant') || isRunningMarker(value)) return false
      // why: the id read that follows the last miss of the did-not-finish write is the note's own, so only it fails.
      if (value.audit?.result?.state === 'pending' && value.audit.result.reason.startsWith('the audit did not finish')) fault.fallbackMisses += 1
      if (fault.fallbackMisses === 5) fault.isIdUnread = true
      return true
    },
  })
  github.issues.set(101, { fields: compliant, createdAt: 0 })
  const harness = createModuleHarness(world, {
    readSessionId: async () => {
      if (!fault.isIdUnread) return world.chat.id
      fault.isIdUnread = false
      throw new Error('session id unreadable')
    },
  })
  await reloadModule(harness)
  await completeTurn(harness)
  expect(readNotes(world)).toEqual([])
  github.issues.set(101, { fields: unassigned, createdAt: 0 })
  fault.isArmed = true
  await completeTurn(harness)
  await reread(harness.port, true)
  expect(readNotes(world).filter(note => note.startsWith('Issue'))).toEqual([
    'Issue audit: not recorded (session record: 5 writes in a row lost to newer ones; the process state could not keep this note either (the chat\'s id could not be read), so a reload loses it); the result shown may be from an earlier turn',
    expect.stringMatching(/^Issue audit: pending · audit running since /),
  ])
  expect(readPrStep(world)?.state).not.toBe('done')
})

// contract: a failed search and a failed issue read leave the audit pending with every reason, and every issue still readable is read, so none of its findings is hidden
test('a failed search and a failed issue read keep every finding of the issues still readable', async ($, on) => {
  const { world, github } = arrange(on, { session: { ...pushedCloseOut.session, audit: { issues: [101, 102] } } })
  github.issues.set(101, { fields: unassigned, createdAt: 0 })
  github.issues.set(102, { fields: compliant, createdAt: 0 })
  github.faults.isSearchFailing = true
  github.faults.unreadable.add(102)
  await endTurn($)
  const unreachable = 'GitHub unreachable after 3 attempts: HTTP 502'
  expect(readNotes(world)).toEqual([`Issue audit: pending · cannot list the issues opened this session: ${unreachable}; cannot read #102: ${unreachable}`, assigneeFinding])
  const status = await readFlowStatus($)
  expect(status).toContain(`#101 non-compliant — fix with issue_edit; issue audit pending (cannot list the issues opened this session: ${unreachable}; cannot read #102`)
  expect(status).not.toContain('✓ PR #5')
})

// contract: an audit that cannot read the session's start re-reads its tracked issues and lists their findings, stays pending with the search to run by hand from the day the unit's flow was declared, and holds the PR step with the fix to make
test('a session start that cannot be read keeps the tracked issues\' findings and leaves the audit pending with the search to run by hand', async ($, on) => {
  const { world, github } = arrange(on, { session: { ...pushedCloseOut.session, audit: { issues: [101] } } })
  github.issues.set(101, { fields: unassigned, createdAt: 0 })
  const unit = world.sessions.get('sid')?.unit
  if (!unit) throw new Error('the world declares no unit')
  world.files.set(await unitLogPath(createTestPort(world), unit), `${JSON.stringify({ at: Date.UTC(2026, 10, 12, 23, 30), event: 'declare' })}\n`)
  await openSessionAt(world)
  world.usage.error = 'usage unavailable'
  await endTurn($)
  const notes = readNotes(world)
  expect(notes).toHaveLength(2)
  expect(notes[0]).toStartWith('Issue audit: pending · the session start could not be read (')
  expect(notes[0]).toEndWith('), so issues created outside the issue tools were not searched; check with gh search issues --repo o/r --author @me --created ">=2026-11-12"')
  expect(notes[1]).toBe(assigneeFinding)
  const status = await readFlowStatus($)
  expect(status).toContain('#101 non-compliant — fix with issue_edit; issue audit pending (the session start could not be read (')
  expect(status).not.toContain('✓ PR #5')
})

// contract: the hand check names a placeholder, and why, for a repository or a declaration day it could not read
test('a session start that cannot be read, with no repository or flow log readable, names placeholders and why', async ($, on) => {
  const { world } = arrange(on, { session: { ...pushedCloseOut.session, audit: { issues: [] } }, gh: () => undefined })
  await openSessionAt(world)
  world.usage.error = 'usage unavailable'
  await endTurn($)
  const notes = readNotes(world)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('; check with gh search issues --repo <this repository> --author @me --created ">=<the date this unit\'s flow was declared>" (the repository could not be read: ')
  expect(notes[0]).toEndWith('; the declaration date could not be read: the unit\'s flow log does not exist)')
})

// contract: an audit whose final write fails never leaves the earlier all-clear standing: the record says it did not finish
test('an audit whose final write fails shows that it did not finish and holds the PR step', async ($, on) => {
  const fault = { isArmed: false }
  const { world, github } = arrange(on, {
    session: { ...pushedCloseOut.session, audit: { issues: [101] } },
    missSessionWrite: value => fault.isArmed && isOtherResult(value, 'pending'),
  })
  github.issues.set(101, { fields: compliant, createdAt: 0 })
  await endTurn($)
  expect(readNotes(world)).toEqual([])
  github.issues.set(101, { fields: unassigned, createdAt: 0 })
  fault.isArmed = true
  await endTurn($)
  const notes = readNotes(world)
  expect(notes).toHaveLength(1)
  expect(notes[0]).toContain('Issue audit: pending · the audit did not finish (')
  expect(notes[0]).toContain('); it runs again at the next turn end')
  expect(await readFlowStatus($)).not.toContain('✓ PR #5')
})

// contract: an audit none of whose writes lands says so on the pane and holds the PR step, and a reload within the process keeps that note
test('an audit none of whose writes lands is shown as not recorded, and the note and the hold survive a reload', async (_$, on) => {
  const fault = { isArmed: false }
  const { world, github } = arrange(on, {
    session: { ...pushedCloseOut.session, audit: { issues: [101] } },
    missSessionWrite: value => fault.isArmed && isOtherResult(value, 'compliant'),
  })
  github.issues.set(101, { fields: compliant, createdAt: 0 })
  const harness = createModuleHarness(world)
  await reloadModule(harness)
  await completeTurn(harness)
  expect(readNotes(world)).toEqual([])
  github.issues.set(101, { fields: unassigned, createdAt: 0 })
  fault.isArmed = true
  await completeTurn(harness)
  await reloadModule(harness)
  const notes = readNotes(world)
  expect(notes.filter(note => note.startsWith('Issue'))).toEqual(['Issue audit: not recorded (session record: 5 writes in a row lost to newer ones); the result shown may be from an earlier turn'])
  const step = readPrStep(world)
  expect(step?.state).not.toBe('done')
  expect(step?.fullDetail ?? step?.detail).toBe('issue audit not recorded (session record: 5 writes in a row lost to newer ones); the next turn end\'s audit writes a result and clears this')
  fault.isArmed = false
  github.issues.set(101, { fields: compliant, createdAt: 0 })
  await completeTurn(harness)
  expect(readNotes(world).filter(note => note.startsWith('Issue'))).toEqual([])
  expect(readPrStep(world)?.state).toBe('done')
})

// contract: an audit whose result and whose note in the process state both fail to land still holds the PR step, from this load's memory
test('an audit whose writes fail and whose note the process state cannot keep either still shows as not recorded and holds the PR step', async (_$, on) => {
  const fault = { isArmed: false }
  const { world, github } = arrange(on, {
    session: { ...pushedCloseOut.session, audit: { issues: [101] } },
    missSessionWrite: value => fault.isArmed && isOtherResult(value, 'compliant'),
  })
  github.issues.set(101, { fields: compliant, createdAt: 0 })
  const harness = faultyHost(world, { failWrite: next => fault.isArmed && isRecord(next) && next.auditUnrecorded !== undefined })
  await reloadModule(harness)
  await completeTurn(harness)
  expect(readNotes(world)).toEqual([])
  github.issues.set(101, { fields: unassigned, createdAt: 0 })
  fault.isArmed = true
  await completeTurn(harness)
  expect(readNotes(world).filter(note => note.startsWith('Issue'))).toEqual([
    'Issue audit: not recorded (session record: 5 writes in a row lost to newer ones; the process state could not keep this note either (host busy), so a reload loses it); the result shown may be from an earlier turn',
  ])
  expect(readPrStep(world)?.state).not.toBe('done')
})

// contract: a process state that cannot be read makes the audit's recording unknown, which holds the PR step until the state reads again; a note the state keeps for another chat never shows in this one
test('an unreadable process state makes the audit recording unknown and holds the PR step, while another chat\'s note never shows', async (_$, on) => {
  const { world, github } = arrange(on, { session: { ...pushedCloseOut.session, audit: { issues: [101] } } })
  github.issues.set(101, { fields: compliant, createdAt: 0 })
  const harness = createModuleHarness(world)
  await reloadModule(harness)
  await completeTurn(harness)
  const state = world.processState.value
  world.processState.value = { ...isRecord(state) ? state : {}, auditUnrecorded: { 'other-chat': 'its writes failed' } }
  await reread(harness.port, true)
  expect(readNotes(world).filter(note => note.startsWith('Issue'))).toEqual([])
  expect(readPrStep(world)?.state).toBe('done')
  world.processState.value = { shape: 'unknown' }
  await reread(harness.port, true)
  expect(readNotes(world).filter(note => note.startsWith('Issue'))).toEqual([
    expect.stringMatching(/^Issue audit: recording unknown \(the process state could not be read: .+\); the result shown may be from an earlier turn$/),
  ])
  const step = readPrStep(world)
  expect(step?.state).not.toBe('done')
  expect(step?.fullDetail ?? step?.detail).toMatch(/^issue audit recording unknown \(the process state could not be read: .+\); this clears once the process state reads again \(see the Process row\)$/)
  world.processState.value = state
  await reread(harness.port, true)
  expect(readNotes(world).filter(note => note.startsWith('Issue'))).toEqual([])
})

// contract: a running audit says so on the record before it reads, so the pane never shows an earlier result as this turn's while it runs
test('an audit shows that it is running until its result is written', async (_$, on) => {
  const gate = { isHeld: false }
  const { world, github } = arrange(on, {
    session: { ...pushedCloseOut.session, audit: { issues: [101] } },
    ghDelayMs: args => gate.isHeld && (args[1] ?? '').startsWith('search/issues?') ? 60 * minuteMs : 0,
  })
  github.issues.set(101, { fields: compliant, createdAt: 0 })
  const harness = createModuleHarness(world)
  await reloadModule(harness)
  await completeTurn(harness)
  expect(readNotes(world)).toEqual([])
  gate.isHeld = true
  const ending = completeTurn(harness)
  await world.clock.settle()
  await reread(harness.port, true)
  expect(readNotes(world).filter(note => note.startsWith('Issue'))).toEqual([expect.stringMatching(/^Issue audit: pending · audit running since \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)])
  expect(readPrStep(world)?.state).not.toBe('done')
  await world.clock.advance(60 * minuteMs)
  await ending
  expect(readNotes(world).filter(note => note.startsWith('Issue'))).toEqual([])
})

// contract: an issue tool whose write landed and whose tracking failed answers an error naming the issue, the cause and the check
test('an issue tool whose tracking write fails answers an error naming what landed and how to check it', async ($, on) => {
  const { world } = arrange(on, { missSessionWrite: value => !!value.audit?.issues.includes(101) })
  await openSessionAt(world)
  const outcome = await callModTool($, 'issue_create', ticket)
  expect(outcome.isError).toBe(true)
  expect(outcome.text).toContain('Created https://github.com/o/r/issues/101')
  expect(outcome.text).toContain('but the issue audit could not record #101 (')
  expect(outcome.text).toContain('so the turn-end audit will not re-read it; check its fields with gh issue view 101 --repo o/r')
})

// contract: the audit's window opens at the session's start: an issue created before it is never audited
test('an issue the account created before the session started is not audited', async ($, on) => {
  const { world, github } = arrange(on)
  github.issues.set(300, { fields: untriaged, createdAt: 0 })
  await openSessionAt(world)
  await startSession($)
  await endTurn($)
  expect(readNotes(world)).toEqual([])
})
