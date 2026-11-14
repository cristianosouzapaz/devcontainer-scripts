import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { test } from '../support/kit'
import { approvalCommand, diagnosed, diagnoseRuns, diagnosisComment, trivialFlow, verifyFile, verifyId } from '../support/builders'
import { readCurrentStep, readFlowStatus, runFlowCommand, startSession } from '../support/helpers'
import { createWorld, markSpawned, records, seedDelegation } from '../support/world'
import type { Options } from '../support/world'

const url = diagnosisComment.url
const doorbell = '[working-agreement] Checking this session\'s mailbox; any mail comes with this prompt.'
const options = (): Options => ({
  session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
  unit: { runs: [diagnoseRuns[0]!] }, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
})

test('composer approval reads comments fresh and completes the unit Diagnose row', async ($, on) => {
  const setup = options()
  setup.comments = { 1: [] }
  const { clock, sessions } = createWorld(on, { branch: 'fix' }, setup)
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('▸ Diagnose\n')
  setup.comments = { 1: [diagnosisComment] }
  expect((await runFlowCommand($, `approve ${url}`, { kind: 'composer' })).text).toContain(`Diagnosis approved: ${url}; pinned red: \`./check\``)
  expect(sessions.get('sid')?.units[0]?.approval).toBe(url)
  const { outcome, ...pinned } = diagnoseRuns[0]!
  expect(sessions.get('sid')?.units[0]?.approvedRed).toEqual(pinned)
  expect(await readCurrentStep($)).toBe('Code')
  expect(await readFlowStatus($)).toContain('✓ Diagnose')
})

test('approval belongs to the declared unit and cannot be submitted by another origin', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'fix' }, options())
  for (const origin of [{ kind: 'plugin', name: 'working-agreement' }, { kind: 'sdk' }] as const) {
    expect((await runFlowCommand($, `approve ${url}`, origin)).text).toContain("is the user's to run at the local terminal")
    expect(sessions.get('sid')?.units[0]?.approval).toBeUndefined()
  }
})

for (const [name, overrides, args, reason] of [
  ['old syntax', {}, 'diagnose', 'Usage: /flow approve <comment-url>'],
  ['no Diagnose', { session: { flow: 'close-out' } }, url, 'no Diagnose step'],
  ['no unit', { session: { flow: null } }, url, 'no Diagnose step'],
  ['no red', { unit: { runs: [] } }, url, 'There is no red run yet: reproduce the bug through the run tool first.'],
  ['only a green', { unit: { runs: [diagnoseRuns[1]!] } }, url, 'There is no red run yet'],
  ['another issue', { comments: { 2: [diagnosisComment] } }, url, 'not a comment of the declared issue'],
  ['comment before the red', { comments: { 1: [{ ...diagnosisComment, createdAt: new Date(0).toISOString() }] } }, url, 'That comment was created before the red run; post a diagnosis comment after it.'],
  ['comment at the red', { comments: { 1: [{ ...diagnosisComment, createdAt: new Date(1).toISOString() }] } }, url, 'created before the red run'],
  ['comment before the earliest red', { unit: { runs: [{ ...diagnoseRuns[0]!, at: 5 }, { ...diagnoseRuns[0]!, runId: 'early', at: 4 }] } }, url, 'created before the red run'],
  ['read error', { comments: { 1: { error: 'comments failed' } } }, url, 'comments failed'],
] as [string, Options, string, string][]) {
  test(`approval refuses ${name} as a plain reason`, async ($, on) => {
    const { sessions } = createWorld(on, { branch: 'fix' }, { ...options(), ...overrides })
    expect((await runFlowCommand($, `approve ${args}`)).text).toContain(reason)
    expect(sessions.get('sid')?.units[0]?.approval).toBeUndefined()
  })
}

test('approval needs no green: a red and a later comment suffice', async ($, on) => {
  const { sessions } = createWorld(on, { branch: 'fix' }, options())
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain('Diagnosis approved')
  expect(sessions.get('sid')?.units[0]?.approval).toBe(url)
})

test('approval measures the comment against the earliest red, not a later failed attempt', async ($, on) => {
  const later = { ...diagnoseRuns[0]!, runId: 'later', tree: 'attempt', at: 9 }
  const { sessions } = createWorld(on, { branch: 'fix' }, { ...options(), unit: { runs: [later, diagnoseRuns[0]!] } })
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain('Diagnosis approved')
  expect(sessions.get('sid')?.units[0]?.approval).toBe(url)
})

// contract: an approval citing no red refuses when several distinct red argvs precede the comment, lists them and pins nothing
test('approval without a cited red refuses several red commands before the comment', async ($, on) => {
  const probe = { ...diagnoseRuns[0]!, argv: ['./probe'], runId: 'probe', at: 2 }
  const { sessions } = createWorld(on, { branch: 'fix' }, { ...options(), unit: { runs: [diagnoseRuns[0]!, probe] } })
  const text = (await runFlowCommand($, `approve ${url}`)).text
  expect(text).toContain('several red commands precede the diagnosis: ["./probe"], ["./check"]')
  expect(text).toContain('Nothing changed.')
  expect(sessions.get('sid')?.units[0]?.approval).toBeUndefined()
})

// contract: an approval citing a red by its argv JSON pins that red over a later failing one
test('approval citing a red pins it over a later failing probe', async ($, on) => {
  const probe = { ...diagnoseRuns[0]!, argv: ['./probe'], runId: 'probe', at: 2 }
  const { sessions } = createWorld(on, { branch: 'fix' }, { ...options(), unit: { runs: [diagnoseRuns[0]!, probe] } })
  expect((await runFlowCommand($, `approve ${url} ["./check"]`)).text).toContain(`Diagnosis approved: ${url}; pinned red: \`./check\``)
  expect(sessions.get('sid')?.units[0]?.approvedRed?.argv).toEqual(['./check'])
})

// contract: a repeat of the approved comment citing another red names the stored pinned red, refuses the cited one and changes no record
test('a repeated approval citing another red names the stored red and pins nothing', async ($, on) => {
  const pinned = { argv: ['./check'], tree: 'pinned', at: 1, runId: 'pinned' }
  const { sessions } = createWorld(on, { branch: 'fix' }, { ...options(), unit: { ...diagnosed, approvedRed: pinned } })
  const text = (await runFlowCommand($, `approve ${url} ["./other"]`)).text
  expect(text).toContain(`Already approved: ${url}, with pinned red: \`./check\`; the cited red \`["./other"]\` was not pinned. Nothing changed.`)
  expect(sessions.get('sid')?.units[0]?.approvedRed).toEqual(pinned)
})

// contract: an approval pins the newest red of the cited argv before the comment, so the fix green is measured against that tree
test('approval pins the newest red of an argv run on two trees before the comment', async ($, on) => {
  const older = { ...diagnoseRuns[0]!, tree: 'first', runId: 'first', at: 1 }
  const newer = { ...diagnoseRuns[0]!, tree: 'second', runId: 'second', at: 2 }
  const { sessions } = createWorld(on, { branch: 'fix' }, { ...options(), unit: { runs: [older, newer] } })
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain('Diagnosis approved')
  expect(sessions.get('sid')?.units[0]?.approvedRed).toEqual({ argv: ['./check'], tree: 'second', at: 2, runId: 'second' })
})

// contract: an ambiguous cited text lists only the argvs it joins to, with the command that cites one exactly, and pins nothing
test('approval citing a text that joins two argvs lists only those and how to cite one', async ($, on) => {
  const red = (argv: string[], at: number) => ({ ...diagnoseRuns[0]!, argv, runId: `r${at}`, at })
  const { sessions } = createWorld(on, { branch: 'fix' }, { ...options(), unit: { runs: [red(['a', 'b c'], 0.5), red(['a b', 'c'], 1), red(['./probe'], 2)] } })
  const text = (await runFlowCommand($, `approve ${url} a b c`)).text
  expect(text).toContain('`a b c` matches several red commands before the diagnosis: ["a b","c"], ["a","b c"];')
  expect(text).not.toContain('./probe')
  expect(text).toContain(`/flow approve ${url} ["a b","c"]`)
  expect(sessions.get('sid')?.units[0]?.approval).toBeUndefined()
})

test('a repeated approval of the approved comment changes no record', async ($, on) => {
  const pinned = { argv: ['./check'], tree: 'pinned', at: 1, runId: 'pinned' }
  const { sessions } = createWorld(on, { branch: 'fix' }, { ...options(), unit: { ...diagnosed, approvedRed: pinned } })
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain(`Already approved: ${url}`)
  expect(sessions.get('sid')?.units[0]?.approvedRed).toEqual(pinned)
})

// group: A repeated approval starts no turn and records no delegated step
// contract: a repeat of the approved comment while the session is idle submits no start prompt
test('a repeated approval while idle submits no prompt', async ($, on) => {
  const world = createWorld(on, { branch: 'fix' }, { ...options(), unit: diagnosed })
  await startSession($)
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain(`Already approved: ${url}`)
  await world.clock.settle()
  expect(world.prompts.filter(text => text.includes('approved'))).toEqual([])
})

// contract: (pin, not a red: its change only starts the session, so the mod's tools are registered as at any real start) a repeat while the session is busy leaves the start the first approval kept, which the turn's end submits once, never the repeat's
test('a repeated approval while busy leaves the pending start untouched', async ($, on) => {
  const world = createWorld(on, { branch: 'fix' }, options())
  await startSession($)
  await $.turn.start({ text: 'work', turnId: 't' })
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain('Diagnosis approved')
  await world.clock.settle()
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain(`Already approved: ${url}`)
  await world.clock.settle()
  expect((await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never)).block ?? '').not.toContain('Diagnosis approved')
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  await world.clock.settle()
  expect(world.prompts.filter(text => text.includes(`Diagnosis approved: ${url}`))).toHaveLength(1)
  expect(world.prompts.filter(text => text.includes('Already approved'))).toEqual([])
})

// contract: a repeat in a delegated unit whose first approval was the user's records no delegated step, and the pane credits none to delegation
test('a repeated approval in a delegated unit records no delegated step', async ($, on) => {
  const world = createWorld(on, { branch: 'fix' }, { ...options(), unit: diagnosed })
  seedDelegation(world, 'coord', [1])
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain(`Already approved: ${url}`)
  expect(world.sessions.get('sid')?.units[0]?.delegated ?? []).toEqual([])
  expect(await readFlowStatus($)).not.toContain('took /flow approve')
})

// contract: a fresh approval starts a turn and, in a delegated unit, records /flow approve as delegated
test('a fresh approval in a delegated unit starts a turn and records /flow approve', async ($, on) => {
  const world = createWorld(on, { branch: 'fix' }, options())
  seedDelegation(world, 'coord', [1])
  await startSession($)
  expect((await runFlowCommand($, `approve ${url}`)).text).toContain('Diagnosis approved')
  await world.clock.settle()
  expect(world.prompts.filter(text => text.includes(`Diagnosis approved: ${url}`))).toHaveLength(1)
  expect(world.sessions.get('sid')?.units[0]?.delegated).toEqual(['/flow approve'])
  expect(await readFlowStatus($)).toContain('took /flow approve')
})

test('live comment deletion reopens Diagnose and a newer comment preserves the named approval', async ($, on) => {
  const setup = { ...options(), unit: diagnosed }
  const { clock } = createWorld(on, { branch: 'fix' }, setup)
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Diagnose')
  setup.comments = { 1: [diagnosisComment, { ...diagnosisComment, url: `${url}0` }] }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('✓ Diagnose')
  setup.comments = { 1: [] }
  await clock.advance(61000)
  expect(await readFlowStatus($)).toContain('▸ Diagnose · approved comment deleted')
})

/**
 * Puts an answer from the user's mailbox in this unit's mailbox, as the user's inbox would send it.
 * @param files - The world's files.
 * @param body - The answer's text.
 */
function deliverUserAnswer(files: Map<string, string>, body: string): void {
  const envelope = { v: 1, id: 'q-1-re-user', kind: 'answer', from: 'user', to: '1', issue: 1, in_reply_to: 'q-1', seq: 1,
    created_at: new Date(5).toISOString(), expects: '', attempt: 1, body, refs: [], author: 'agent' }
  files.set(`${records}/mail/1/new/q-1-re-user.1.json`, JSON.stringify(envelope))
}

/**
 * Submits the doorbell's prompt, as the mod's own ring does, and reads the mail block it entered with.
 * @param $ - The engine.
 * @returns The context, joined.
 */
const ring = async ($: Engine): Promise<string> =>
  ((await $.classic.UserPromptSubmit({ prompt: doorbell, permission_mode: 'default' } as never)) as { additionalContext?: string[] }).additionalContext?.join('\n') ?? ''

// contract: a mailbox answer that names the diagnosis approval is delivered as information and leaves Diagnose waiting for the user's typed /flow approve
test('a mailbox answer from the user never approves a diagnosis', async ($, on) => {
  const world = createWorld(on, { branch: 'fix' }, options())
  markSpawned(world, [1])
  deliverUserAnswer(world.files, `/flow approve ${url}`)
  expect(await ring($)).toContain(`from user (seq 1`)
  expect(world.sessions.get('sid')?.units[0]?.approval).toBeUndefined()
  expect(await readCurrentStep($)).toBe('Diagnose')
})

// contract: a mailbox answer that names the Verify config approval is delivered as information and approves no config
test('a mailbox answer from the user never approves a Verify config', async ($, on) => {
  const world = createWorld(on, { branch: 'feat', isDirty: true, changed: ['src/a.ts'], tree: 'tree' }, { session: trivialFlow(), verifyFile })
  markSpawned(world, [1])
  deliverUserAnswer(world.files, `/flow approve verify ${verifyId()} and ${approvalCommand()}`)
  expect(await ring($)).toContain(`from user`)
  expect([...world.files.keys()].some(path => path.startsWith(`${records}/ok/`))).toBe(false)
})

// contract: a User answer comment on the issue, even one naming the diagnosis approval, approves nothing: approval stays the user's typed /flow approve
test('a User answer comment naming /flow approve never approves a diagnosis', async ($, on) => {
  const setup = options()
  const answer = { url: 'https://github.com/o/r/issues/1#issuecomment-7', createdAt: new Date(4).toISOString(), body: `## User answer\n\nOption a: approve\nUser's words: "/flow approve ${url}"` }
  setup.comments = { 1: [diagnosisComment, answer as never] }
  const world = createWorld(on, { branch: 'fix' }, setup)
  await world.clock.advance(61000)
  expect(await readCurrentStep($)).toBe('Diagnose')
  expect(world.sessions.get('sid')?.units[0]?.approval).toBeUndefined()
})
