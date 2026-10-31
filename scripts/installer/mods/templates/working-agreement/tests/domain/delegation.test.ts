import type { On } from 'claude-code'
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { coordinator, diagnoseRuns, diagnosisComment, fixed, guarded, noFlow, verifyFile } from '../support/builders'
import { callModTool, declareFlow, inside, readFlowStatus, readPromptContext, runFlowCommand, startSkill } from '../support/helpers'
import { createIssueGithub, defaultIssueLabels, ticket } from '../support/issue-github'
import type { IssueGithub } from '../support/issue-github'
import { test } from '../support/kit'
import { buildScope, buildStat, configBlob, coordinatorHost, createWorld, hashIdentity, markSpawned, records, scopeFile, seedDelegation } from '../support/world'
import type { Options } from '../support/world'

const unitScope = buildScope('coord', [1])
// The type and priority every issue carries, so an edit changes triage alone.
const typed = ['type::feat', 'priority::medium']
const spec = { title: 'feat(mod): delegated spec', kind: 'spec', triage: 'ready-for-agent', type: 'feat', priority: 'medium',
  sections: { Problem: 'It.', Solution: 'This.', 'Acceptance criteria': '- [ ] works' } }

/**
 * Builds a session in Small feature on #1, whose issue carries the given labels.
 * @param labels - The labels of #1.
 * @returns The world options.
 */
const smallFeatureOn1 = (labels: string[]): Options => ({ session: { flow: 'small-feature', issues: [1], info: { 1: { title: 'a', labels } } } })

/**
 * Reads a coordinator's scope file as the mod wrote it.
 * @param world - The test's world.
 * @param sessionId - The coordinator session.
 * @returns The decoded scope, or undefined when there is none.
 */
const readScope = (world: ReturnType<typeof createWorld>, sessionId = 'sid'): unknown => {
  const text = world.files.get(scopeFile(sessionId))
  return text === undefined ? undefined : JSON.parse(text)
}

/**
 * Creates the ticket through the mod's tool.
 * @param $ - The test's engine.
 * @returns The text the model reads.
 */
const createTicket = async ($: Engine): Promise<string> => (await callModTool($, 'issue_create', { ...ticket, triage: 'needs-triage' })).text

/**
 * Builds a delegated unit for #3 on a GitHub that keeps its issues and comments.
 * @param on - The test's engine hooks.
 * @param issues - The issues the coordinator's scope delegates.
 * @param options - The world's options beyond gh, such as the session.
 * @returns The fake GitHub.
 */
function createDelegatedUnit(on: On, issues = [3], options: Partial<Options> = {}): IssueGithub {
  const github = createIssueGithub({ issues: { 3: {} } })
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow, ...options, gh: github.gh })
  seedDelegation(world, 'coord', issues, { spawned: [1, 3, 7] })
  return github
}

const decision = (cost: string): string => '## Delegated decision\n\n### Question\nWhich store?\n\n### Alternatives considered\nA file; the session record.\n\n' +
  `### Choice\nA file.\n\n### Reason\nOne writer.\n\n### Cost of going back\n${cost}`
const review = (comment: number, outcome: string): string => `## Delegated review\n\n### Decision\nhttps://github.com/o/r/issues/3#issuecomment-${comment}\n\n### Outcome\n${outcome}`

test('/flow delegate is refused outside a coordinator session and from a non-composer origin', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow })
  expect((await runFlowCommand($, 'delegate #3')).text).toContain('needs a coordinator session')
  await runFlowCommand($, 'coordinate')
  expect((await runFlowCommand($, 'delegate #3', { kind: 'plugin', name: 'working-agreement' })).text).toContain("user's to run")
  expect((await runFlowCommand($, 'delegate triage soon')).text).toContain('Usage: /flow delegate')
  expect(readScope(world)).toBeUndefined()
})

test('/flow delegate parses the numbers first and records and appends the free text after them verbatim', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: coordinator, ...guarded() })
  const { clock, prompts } = world
  expect((await runFlowCommand($, 'delegate #5 3 keep #4 for later:\n  tests first')).text).toContain('Delegating #3 #5')
  await clock.settle()
  expect(readScope(world)).toEqual({ v: 1, sessionId: 'sid', issues: [3, 5], coversCreated: false, instructions: ['keep #4 for later:\n  tests first'] })
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toStartWith('Start the delegated issues #5 #3 with mcp__working-agreement__spawn, in blocked-by order')
  expect(prompts[0]).toContain('## Delegated decision')
  expect(prompts[0]).toEndWith("\n\nUser's instructions:\nkeep #4 for later:\n  tests first")
})

test('/flow delegate submits a byte-identical fixed prompt for the same input, with no instructions heading without text', async ($, on) => {
  const { clock, prompts } = createWorld(on, { branch: 'feat' }, { session: coordinator, ...guarded() })
  await runFlowCommand($, 'delegate #3')
  await runFlowCommand($, 'delegate #3')
  await clock.settle()
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).toBe(prompts[1] ?? '')
  expect(prompts[0]).not.toContain("User's instructions:")
})

test('/flow delegate stop and a refused /flow delegate submit no prompt', async ($, on) => {
  const { clock, prompts } = createWorld(on, { branch: 'feat' }, { session: noFlow })
  await runFlowCommand($, 'delegate #3')
  await runFlowCommand($, 'coordinate')
  await clock.settle()
  prompts.length = 0
  await runFlowCommand($, 'delegate triage')
  await runFlowCommand($, 'delegate stop')
  await clock.settle()
  expect(prompts).toEqual([])
})

test('/flow delegate records the named issues and the coordinator\'s herdr pane, and the coordinator shows them on every surface', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: coordinator, herdrEnv: inside, ...guarded() })
  expect((await runFlowCommand($, 'delegate #5 3')).text).toContain('Delegating #3 #5 until /flow delegate stop')
  expect((await runFlowCommand($, 'delegate #4')).text).toContain('Delegating #3 #4 #5')
  expect(readScope(world)).toEqual({ v: 1, sessionId: 'sid', issues: [3, 4, 5], coversCreated: false, paneId: 'pane id' })
  expect(world.views.at(-1)?.meta).toContainEqual({ key: 'Delegating', value: '#3–#5', tone: 'text' })
  expect(world.herdrCalls.at(-1)?.argv).toContain('flow_unit=Coordinator · delegating')
  expect(await readFlowStatus($)).toContain('#3 #4 #5')
})

test('/flow delegate without numbers adds each issue the coordinator creates', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: coordinator, gh: createIssueGithub().gh })
  expect((await runFlowCommand($, 'delegate')).text).toContain('Delegating issues it creates · no signed-commit ruleset')
  expect(await createTicket($)).toContain('#101 is delegated')
  // The scope keeps the push guard's answer when a created issue widens it.
  expect(readScope(world)).toEqual({ v: 1, sessionId: 'sid', issues: [101], coversCreated: true, isPushUnguarded: true })
})

test('/flow delegate with numbers only leaves a created issue undelegated', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: coordinator, gh: createIssueGithub().gh, ...guarded() })
  await runFlowCommand($, 'delegate #3')
  expect(await createTicket($)).not.toContain('delegated')
  expect(readScope(world)).toEqual({ v: 1, sessionId: 'sid', issues: [3], coversCreated: false })
})

test('/flow delegate stop revokes the scope', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: coordinator, herdrEnv: inside })
  await runFlowCommand($, 'delegate #3')
  expect((await runFlowCommand($, 'delegate stop')).text).toContain('Delegation stopped')
  expect(readScope(world)).toBeUndefined()
  expect(world.herdrCalls.at(-1)?.argv).toContain('flow_unit=Coordinator')
  expect((await runFlowCommand($, 'delegate stop')).text).toContain('No delegation to stop')
})

for (const [name, scope, isDelegated] of [
  ['a delegated unit shows', { v: 1, sessionId: 'coord', issues: [3, 7], coversCreated: false, host: coordinatorHost }, true],
  ['a unit outside the scope does not show', { v: 1, sessionId: 'coord', issues: [7], coversCreated: true }, false],
  ['a unit with no scope does not show', undefined, false],
  ['a unit with a malformed scope does not show', { v: 1, sessionId: 'other', issues: [3], coversCreated: false }, false],
] as const) {
  test(`${name} the delegation in the pane, the sidebar and /flow status`, async ($, on) => {
    const world = createWorld(on, { branch: 'feat' }, { session: noFlow, herdrEnv: inside })
    if (scope) world.files.set(scopeFile('coord'), JSON.stringify(scope))
    markSpawned(world, [1, 3, 7])
    await declareFlow($, 'fix', [3])
    const status = await readFlowStatus($)
    const row = { key: 'Delegation', value: 'on', tone: 'text' }
    if (isDelegated) expect(world.views.at(-1)?.meta).toContainEqual(row)
    else expect(world.views.at(-1)?.meta).not.toContainEqual(row)
    expect(world.herdrCalls.at(-1)?.argv.some(arg => arg.startsWith('flow_unit=') && arg.endsWith(' · delegated'))).toBe(isDelegated)
    expect(status?.includes('\nDelegation on')).toBe(isDelegated)
  })
}

for (const [name, host, stat, fact] of [
  ['its process ended', coordinatorHost, undefined, 'coordinator session gone'],
  ['its pid was reused by another process', coordinatorHost, buildStat(coordinatorHost.pid, '9999'), 'coordinator session gone'],
  ['the scope names no process', null, undefined, 'coordinator liveness unknown'],
  ['its process ran on another boot', { ...coordinatorHost, bootId: 'earlier' }, undefined, 'coordinator liveness unknown'],
] as const) {
  test(`a unit whose coordinator cannot be seen running because ${name} shows it and is not delegated`, async ($, on) => {
    const world = createWorld(on, { branch: 'feat' }, { session: noFlow, herdrEnv: inside })
    seedDelegation(world, 'coord', [3], { spawned: [1, 3, 7], host })
    if (stat) world.files.set(`/proc/${coordinatorHost.pid}/stat`, stat)
    else world.files.delete(`/proc/${coordinatorHost.pid}/stat`)
    await declareFlow($, 'small-feature', [3])
    await startSkill($, 'to-spec')
    expect(world.sessions.get('sid')?.units[0]?.delegated).toBeUndefined()
    expect(world.views.at(-1)?.meta).toContainEqual({ key: 'Delegation', value: fact, tone: 'warn' })
    expect(await readFlowStatus($)).toContain(fact)
    expect(world.herdrCalls.at(-1)?.argv.some(arg => arg.startsWith('flow_unit=') && arg.endsWith(' · delegated'))).toBe(false)
    expect(await readPromptContext($)).not.toContain('This unit is delegated')
    expect(fact.length).toBeLessThanOrEqual(39)
  })
}

test('/flow delegate records the coordinator\'s process, which keeps its units delegated', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: coordinator, ...guarded() })
  world.files.set('/proc/self/stat', buildStat(321, '4500'))
  await runFlowCommand($, 'delegate #3')
  expect(readScope(world)).toEqual({ v: 1, sessionId: 'sid', issues: [3], coversCreated: false, host: { pidns: 'pid:[1]', pid: 321, pidStart: '4500', bootId: 'boot' } })
})

test('/flow delegate stop typed in another session ends an orphaned scope, keeps a running one, and logs who ended it', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow })
  world.files.set(scopeFile('gone'), buildScope('gone', [3], { ...coordinatorHost, pid: 404 }))
  world.files.set(scopeFile('live'), buildScope('live', [9]))
  await declareFlow($, 'small-feature', [3])
  const reply = (await runFlowCommand($, 'delegate stop')).text
  expect(reply).toContain('Orphaned delegation of coordinator gone stopped (was #3)')
  expect(world.files.has(scopeFile('gone'))).toBe(false)
  expect(world.files.has(scopeFile('live'))).toBe(true)
  await world.clock.settle()
  const log = world.files.get(`${records}/log/${await hashIdentity('feat', [3])}.jsonl`) ?? ''
  expect(log.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.event === 'delegation-ended'))
    .toEqual([expect.objectContaining({ coordinator: 'gone', by: 'sid' })])
  expect((await runFlowCommand($, 'delegate stop')).text).toContain('every other coordinator still runs')
  expect(world.files.has(scopeFile('live'))).toBe(true)
})

test('saying "I delegate" pre-fills /flow delegate and delegates nothing by itself', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: coordinator })
  expect(await readPromptContext($)).toContain('suggest_delegate')
  const result = await $.tool.call({ tool: 'mcp__working-agreement__suggest_delegate', issues: [3, 5] } as never)
  expect(String(result.result)).toContain('nothing is delegated until they do')
  expect(world.suggestions).toContain('/flow delegate #3 #5')
  expect(readScope(world)).toBeUndefined()
})

test('suggest_delegate outside a coordinator session suggests nothing', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow })
  const result = await $.tool.call({ tool: 'mcp__working-agreement__suggest_delegate' } as never)
  expect(result.isError).toBe(true)
  expect(world.suggestions).not.toContain('/flow delegate')
})

test('the user\'s steps taken in a delegated unit are recorded as delegated and shown in the pane and /flow status', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, smallFeatureOn1(['ready-for-agent']))
  seedDelegation(world, 'coord', [1], { spawned: [1, 3, 7] })
  await startSkill($, 'to-spec')
  expect((await runFlowCommand($, 'skip PR delivered elsewhere')).text).toContain('Skipped PR')
  expect(world.sessions.get('sid')?.units[0]?.delegated).toEqual(['/to-spec', '/flow skip pr'])
  const row = { key: 'Delegation', value: 'on · took /to-spec, /flow skip pr', tone: 'text' }
  expect(world.views.at(-1)?.meta).toContainEqual(row)
  expect(await readFlowStatus($)).toContain('took /to-spec, /flow skip pr')
  expect(await readPromptContext($)).toContain('This unit is delegated')
})

test('a delegated unit\'s prompt tells it to commit its own work with the commit tool, overriding the rule that commits are the user\'s', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, smallFeatureOn1(['ready-for-agent']))
  seedDelegation(world, 'coord', [1], { spawned: [1, 3, 7] })
  const context = await readPromptContext($)
  expect(context).toContain('commit it with the commit tool')
  expect(context).toContain('overrides')
})

test('a delegated unit at Commit is told to commit with the commit tool and go on, never to hand the commands to the user', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', ahead: 8, isDirty: true }, {
    session: noFlow, unit: { skills: ['diagnosing-bugs', 'generate-commit'], ...fixed }, issueLabels: { 1: ['ready-for-agent'] }, comments: { 1: [diagnosisComment] },
  })
  await declareFlow($, 'fix', [1])
  await runFlowCommand($, 'skip verify covered separately')
  seedDelegation(world, 'coord', [1], { spawned: [1, 3, 7] })
  const context = await readPromptContext($)
  expect(context).toContain('current step: Commit')
  expect(context).not.toContain('ask the user to run the commit commands')
  expect(context).toContain('Next action: stage the finished work with git add, commit it with the commit tool with the message generate-commit produced and go on')
})

for (const source of ['projectSettings', 'plugin', 'built-in'] as const) {
  test(`a ${source} skill named like a flow skill proves no step and records nothing delegated`, async ($, on) => {
    const world = createWorld(on, { branch: 'feat' }, smallFeatureOn1([]))
    seedDelegation(world, 'coord', [1], { spawned: [1, 3, 7] })
    await startSkill($, 'to-spec', source)
    expect(world.sessions.get('sid')?.units[0]?.skills).not.toContain('to-spec')
    expect(world.sessions.get('sid')?.units[0]?.delegated).toBeUndefined()
  })
}

test('the diagnosis approval in a delegated unit is recorded as delegated', async ($, on) => {
  const world = createWorld(on, { branch: 'fix' }, {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
    unit: { runs: [diagnoseRuns[0]!] }, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
  })
  seedDelegation(world, 'coord', [1], { spawned: [1, 3, 7] })
  expect((await runFlowCommand($, `approve ${diagnosisComment.url}`)).text).toContain('Diagnosis approved')
  expect(world.sessions.get('sid')?.units[0]?.delegated).toEqual(['/flow approve'])
})

test('a session spawn did not start, though a live scope covers its issue, gets no delegated-unit rules and records no step as delegated', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, smallFeatureOn1(['ready-for-agent']))
  world.files.set(scopeFile('coord'), unitScope)
  markSpawned(world, [1], 'unit')
  await startSkill($, 'to-spec')
  expect(await readPromptContext($)).not.toContain('This unit is delegated')
  expect(world.sessions.get('sid')?.units[0]?.delegated).toBeUndefined()
})

test('declaring an issue whose spawned unit runs in another session is refused, naming that session, until that session is gone', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow })
  world.files.set(scopeFile('coord'), buildScope('coord', [3]))
  markSpawned(world, [3], 'unit')
  world.files.set(`${records}/host/unit.json`, JSON.stringify(coordinatorHost))
  expect((await callModTool($, 'declare_flow', { flow: 'fix', issues: [3] })).deny).toContain('runs in session unit')
  world.files.set(`${records}/host/unit.json`, JSON.stringify({ ...coordinatorHost, pid: 404 }))
  expect((await callModTool($, 'declare_flow', { flow: 'fix', issues: [3] })).deny).toBeUndefined()
})

test('the user\'s steps stay the user\'s outside the scope and after /flow delegate stop', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, smallFeatureOn1([]))
  seedDelegation(world, 'coord', [7], { spawned: [1, 3, 7] })
  await startSkill($, 'to-spec')
  expect(world.sessions.get('sid')?.units[0]?.delegated).toBeUndefined()
  expect(await readPromptContext($)).not.toContain('This unit is delegated')
  world.files.set(scopeFile('coord'), unitScope)
  await startSkill($, 'to-tickets')
  world.files.delete(scopeFile('coord'))
  await runFlowCommand($, 'skip verify covered separately')
  expect(world.sessions.get('sid')?.units[0]?.delegated).toEqual(['/to-tickets'])
  expect(await readFlowStatus($)).toContain('Delegation stopped · took /to-tickets')
})

for (const [name, scope, isApproved] of [['refused in a delegated unit', unitScope, false], ['the user\'s outside delegation', undefined, true]] as const) {
  test(`the Verify config approval is ${name}`, async ($, on) => {
    const world = createWorld(on, { branch: 'feat' }, { verifyFile })
    if (scope) world.files.set(scopeFile('coord'), scope)
    markSpawned(world, [1, 3, 7])
    const blob = configBlob(verifyFile)
    const reply = (await runFlowCommand($, `approve verify ${blob.slice(0, 12)}`)).text
    expect(reply?.includes('never taken in a delegated unit')).toBe(!isApproved)
    expect(world.files.has(`${records}/ok/${blob}.json`)).toBe(isApproved)
    expect(world.sessions.get('sid')?.units[0]?.delegated).toBeUndefined()
  })
}

for (const [name, issues, isDelegated] of [['a delegated unit is told', [3], true], ['a unit outside the scope is not told', [7], false]] as const) {
  test(`${name} to route its decisions to the coordinator and record them`, async ($, on) => {
    createDelegatedUnit(on, [...issues])
    await declareFlow($, 'small-feature', [3])
    const context = await readPromptContext($)
    expect(context.includes('Route each decision to the coordinator')).toBe(isDelegated)
    expect(context.includes('## Delegated decision')).toBe(isDelegated)
    expect(context.includes('High-cost delegated decisions')).toBe(isDelegated)
  })
}

test('the coordinator is told to answer delegated decisions with unit_prompt', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: coordinator })
  expect(await readPromptContext($)).toContain('unit_prompt')
})

for (const [name, body, refusal] of [
  ['a missing field', decision('low').replace(/### Reason\nOne writer.\n\n/, ''), 'in that order'],
  ['an empty field', decision('low').replace('A file.', ' '), 'non-empty Choice'],
  ['an unknown cost', decision('huge'), 'low, medium, high'],
] as const) {
  test(`a Delegated decision comment with ${name} is refused`, async ($, on) => {
    createDelegatedUnit(on)
    const outcome = await callModTool($, 'issue_comment', { number: 3, body })
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain(refusal)
  })
}

test('a well-formed Delegated decision comment is posted', async ($, on) => {
  createDelegatedUnit(on)
  expect((await callModTool($, 'issue_comment', { number: 3, body: decision('High') })).text).toContain('#issuecomment-1')
})

test('a delegated decision puts the delegated-review label on its issue', async ($, on) => {
  const github = createDelegatedUnit(on)
  expect((await callModTool($, 'issue_comment', { number: 3, body: decision('low') })).text).toContain('carries delegated-review')
  expect(github.issues.get(3)?.labels).toEqual(['delegated-review'])
})

test('a delegated decision on a repository without the delegated-review label is refused before anything is posted', async ($, on) => {
  const github = createIssueGithub({ issues: { 3: {} }, labels: defaultIssueLabels.filter(label => label !== 'delegated-review') })
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow, gh: github.gh })
  seedDelegation(world, 'coord', [3], { spawned: [1, 3, 7] })
  const outcome = await callModTool($, 'issue_comment', { number: 3, body: decision('low') })
  expect(outcome.isError).toBe(true)
  expect(outcome.text).toContain('/flow setup-labels')
  expect(github.comments).toHaveLength(0)
})

test('delegated-review is removed once every decision is reviewed, and not before', async ($, on) => {
  const github = createDelegatedUnit(on)
  await callModTool($, 'issue_comment', { number: 3, body: decision('low') })
  await callModTool($, 'issue_comment', { number: 3, body: decision('high') })
  expect((await callModTool($, 'issue_comment', { number: 3, body: review(1, 'confirmed') })).isError).toBe(false)
  expect(github.issues.get(3)?.labels).toEqual(['delegated-review'])
  expect((await callModTool($, 'issue_comment', { number: 3, body: review(2, 'follow-up #120') })).text).toContain('delegated-review removed')
  expect(github.issues.get(3)?.labels).toEqual([])
})

for (const [name, body, refusal] of [
  ['an unknown outcome', review(1, 'maybe'), 'confirmed, follow-up #<issue> or fix #<issue>'],
  ['a decision that is not a comment URL', review(1, 'fix #4').replace(/https:\S+/, 'the first one'), 'decision comment\'s URL'],
  ['a decision not on the issue', review(7, 'confirmed'), 'not an unreviewed delegated decision'],
  ['an already reviewed decision', review(1, 'fix #4'), 'not an unreviewed delegated decision'],
] as const) {
  test(`a Delegated review with ${name} is refused`, async ($, on) => {
    const github = createDelegatedUnit(on)
    await callModTool($, 'issue_comment', { number: 3, body: decision('low') })
    await callModTool($, 'issue_comment', { number: 3, body: review(1, 'confirmed') })
    github.issues.get(3)?.labels.push('delegated-review')
    const outcome = await callModTool($, 'issue_comment', { number: 3, body })
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain(refusal)
    expect(github.comments).toHaveLength(2)
  })
}

for (const [name, options, issues, refusal] of [
  ['the coordinator', { session: coordinator }, [], 'the coordinator took the decisions'],
  ['a delegated unit', {}, [3], 'a delegated unit cannot review'],
  ['a session whose delegation scope cannot be read', { readFailurePrefix: `${records}/delegation/` }, [3], 'cannot be read'],
] as const) {
  test(`a Delegated review from ${name} is refused`, async ($, on) => {
    const github = createDelegatedUnit(on, [3], options)
    await callModTool($, 'issue_comment', { number: 3, body: decision('low') })
    if (issues.length) await declareFlow($, 'small-feature', [...issues])
    const outcome = await callModTool($, 'issue_comment', { number: 3, body: review(1, 'confirmed') })
    expect(outcome.isError).toBe(true)
    expect(outcome.text).toContain(refusal)
    expect(github.comments).toHaveLength(1)
    expect(github.issues.get(3)?.labels).toEqual(['delegated-review'])
  })
}

test('a delegated unit\'s spec needs a Delegated decisions section', async ($, on) => {
  createDelegatedUnit(on)
  await declareFlow($, 'small-feature', [3])
  expect((await callModTool($, 'issue_create', spec)).text).toContain('needs a Delegated decisions section')
  const withDecisions = { ...spec, sections: { ...spec.sections, 'Delegated decisions': '- Which store? → a file → one writer → low' } }
  expect((await callModTool($, 'issue_create', withDecisions)).text).toContain('Created')
})

test('an undelegated unit\'s spec needs no Delegated decisions section', async ($, on) => {
  createDelegatedUnit(on, [7])
  await declareFlow($, 'small-feature', [3])
  expect((await callModTool($, 'issue_create', spec)).text).toContain('Created')
})

test('an unreadable delegation scope refuses the Verify approval and a spec without decisions, and arms the word guard', async ($, on) => {
  const options: Options = { session: noFlow, gh: createIssueGithub().gh }
  const world = createWorld(on, { branch: 'feat' }, options)
  seedDelegation(world, 'coord', [3], { spawned: [1, 3, 7] })
  await declareFlow($, 'small-feature', [3])
  options.readFailurePrefix = `${records}/delegation/`
  expect((await runFlowCommand($, 'approve verify 0123456789ab')).text).toContain('never taken in a delegated unit')
  expect((await callModTool($, 'issue_create', spec)).text).toContain('delegation scope cannot be read')
  expect((await $.tool.call({ tool: 'Bash', command: 'git push origin feat' })).deny).toContain('Under delegation')
})

test('/flow delegate names each delegated issue that is not ready-for-agent, and triage hands those over', async ($, on) => {
  const github = createIssueGithub({ issues: { 3: { labels: ['ready-for-agent'] }, 4: { labels: ['needs-triage'] }, 5: { labels: ['needs-info'] } } })
  const world = createWorld(on, { branch: 'feat' }, { session: coordinator, gh: github.gh, ...guarded() })
  const reply = (await runFlowCommand($, 'delegate #3 #4 #5')).text
  expect(reply).toContain('#4 needs-triage: not started until you triage it')
  expect(reply).toContain('#5 needs-info: not started until you triage it')
  expect(reply).not.toContain('#3 ready-for-agent')
  expect((await runFlowCommand($, 'delegate triage #4')).text).toContain('Delegating #3 #4 #5 · triage #4')
  expect(readScope(world)).toEqual({ v: 1, sessionId: 'sid', issues: [3, 4, 5], coversCreated: false, triage: [4] })
  expect((await runFlowCommand($, 'delegate triage')).text).toContain('Usage: /flow delegate')
})

test('/flow delegate names a missing delegated-review label', async ($, on) => {
  const github = createIssueGithub({ issues: { 3: { labels: ['ready-for-agent'] } }, labels: defaultIssueLabels.filter(label => label !== 'delegated-review') })
  createWorld(on, { branch: 'feat' }, { session: coordinator, gh: github.gh, ...guarded() })
  expect((await runFlowCommand($, 'delegate #3')).text).toContain('lacks the label delegated-review — the user runs /flow setup-labels')
})

test('/flow delegate is silent about a present delegated-review label', async ($, on) => {
  const github = createIssueGithub({ issues: { 3: { labels: ['ready-for-agent'] } } })
  createWorld(on, { branch: 'feat' }, { session: coordinator, gh: github.gh, ...guarded() })
  expect((await runFlowCommand($, 'delegate #3')).text).not.toContain('delegated-review')
})

for (const [name, from, to, isAllowed] of [
  ['sets needs-info', 'needs-triage', 'needs-info', true],
  ['cannot set ready-for-agent', 'needs-triage', 'ready-for-agent', false],
  ['cannot remove ready-for-agent', 'ready-for-agent', 'needs-info', false],
  ['cannot unblock ready-for-human', 'ready-for-human', 'needs-triage', false],
  ['cannot set wontfix', 'needs-info', 'wontfix', false],
] as const) {
  for (const [who, options, issues] of [['the coordinator', { session: coordinator }, []], ['a delegated unit', {}, [3]]] as const) {
    test(`without triage handed over, ${who} ${name}`, async ($, on) => {
      const github = createIssueGithub({ issues: { 3: { labels: [from, ...typed] } } })
      const world = createWorld(on, { branch: 'feat' }, { session: noFlow, ...options, gh: github.gh })
      seedDelegation(world, 'coord', [3], { spawned: [1, 3, 7] })
      if (issues.length) await declareFlow($, 'small-feature', [...issues])
      const outcome = await callModTool($, 'issue_edit', { number: 3, triage: to })
      expect(outcome.isError).toBe(!isAllowed)
      expect(github.issues.get(3)?.labels).toContain(isAllowed ? to : from)
    })
  }
}

test('a coordinator creates needs-triage issues unless triage is handed over', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: coordinator, gh: createIssueGithub().gh, ...guarded() })
  expect((await callModTool($, 'issue_create', ticket)).text).toContain('created as needs-triage')
  expect(await createTicket($)).toContain('Created')
  await runFlowCommand($, 'delegate triage #3')
  expect((await callModTool($, 'issue_create', ticket)).text).toContain('Created')
  expect((await callModTool($, 'issue_create', { ...ticket, triage: 'wontfix' })).text).toContain('wontfix stays the user\'s')
})

test('with triage handed over, the coordinator sets ready-for-agent only after a delegated decision, and never touches ready-for-human', async ($, on) => {
  const github = createIssueGithub({ issues: { 3: { labels: ['needs-info', ...typed] }, 4: { labels: ['ready-for-human', ...typed] } } })
  createWorld(on, { branch: 'feat' }, { session: coordinator, gh: github.gh, ...guarded() })
  await runFlowCommand($, 'delegate triage #3 #4')
  expect((await callModTool($, 'issue_edit', { number: 3, triage: 'ready-for-agent' })).text).toContain('comment it on #3 first')
  await callModTool($, 'issue_comment', { number: 3, body: decision('low') })
  expect((await callModTool($, 'issue_edit', { number: 3, triage: 'ready-for-agent' })).isError).toBe(false)
  expect(github.issues.get(3)?.labels).toContain('ready-for-agent')
  expect((await callModTool($, 'issue_edit', { number: 4, triage: 'ready-for-agent' })).text).toContain('ready-for-human stays the user\'s')
  expect(github.issues.get(4)?.labels).toContain('ready-for-human')
})
