import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { humanOnlyFlowCommands } from '../../hooks/domain/coordinator'
import { replyStepDone } from '../../hooks/core/owed-done'
import { takeMail } from '../../hooks/core/mail-delivery'
import { bodyLimit } from '../../hooks/domain/mail'
import type { Envelope } from '../../hooks/domain/mail'
import { createEmptySession } from '../../hooks/domain/records'
import type { RunRecord } from '../../types'
import { diagnoseRuns, noFlow } from '../support/builders'
import { callModTool, enterOwnPrompt, readPromptContext, runFlowCommand, startSession } from '../support/helpers'
import { createIssueGithub } from '../support/issue-github'
import type { IssueGithub } from '../support/issue-github'
import { test } from '../support/kit'
import { createModuleHarness, newProcess, reloadModule } from '../support/reload'
import type { ModuleHarness } from '../support/reload'
import { seedUnit } from '../support/parallel-worktrees'
import { buildScope, createTestPort, createWorld, markSpawned, records, root, scopeFile } from '../support/world'
import type { Options, World } from '../support/world'

/** A message as its file holds it. */
interface Mail { id: string; kind: string; from: string; in_reply_to: string; body: string; author: string; refs: string[] }

/** The world of one test: the unit session, the coordinator's chat beside it, and the fake GitHub both post to. */
interface Arranged { world: World; github: IssueGithub }

const coordinator = 'coord'
const unitBox = `${records}/mail/3`
const coordinatorBox = `${records}/mail/coordinator-${coordinator}`
const doorbell = '[working-agreement] Checking this session\'s mailbox; any mail comes with this prompt.'
const diagnosis = { issue: 3, url: 'https://github.com/o/r/issues/3#issuecomment-900', body: 'Cause: x. Red: ./check', createdAt: new Date(3).toISOString() }
const reason = 'no command reproduces it'
const skipChoice = `/flow skip diagnose: ${reason}.`
const closing = { number: 5, state: 'OPEN', headRefName: 'feature', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }
const mainSocket = '/h/herdr.sock'
const probeSocket = '/h/sessions/probe-7/herdr.sock'
const setupCommands = ['/flow coordinate', '/flow delegate 9', '/flow delegate triage 9']
const amendment = 'Amendment A: compose the switch once.'
const shownLine = 'its decision\'s Choice is shown to the agent with this outcome'
const beginMarker = '===== BEGIN Choice of delegated decision'
// why: each test's world gets its own harness, so one test's reloads and pids never reach another's.
const harnesses = new WeakMap<World, ModuleHarness>()

/**
 * Builds the unit session spawn started for issue 3, delegated by the coordinator chat `coord` beside it: at Diagnose of a Fix, with a red run
 * and its diagnosis comment, or with no flow yet.
 * @param on - The test's hook registration.
 * @param unit - The unit's state.
 * @param changes - Further world options.
 * @returns The world, in the unit's session, and the fake GitHub.
 */
async function arrange(on: Parameters<typeof createWorld>[0], unit: 'fix' | 'none' = 'fix', changes: Options = {}, runs = [diagnoseRuns[0]!]): Promise<Arranged> {
  const github = createIssueGithub({ issues: { 3: { labels: ['ready-for-agent'] } } })
  github.comments.push({ ...diagnosis })
  const world = unit === 'fix'
    ? createWorld(on, { branch: 'fix/3-bug' }, { session: { flow: 'fix', issues: [3], info: { 3: { title: 'bug', labels: ['ready-for-agent'] } } },
      unit: { runs }, gh: github.gh, ...changes })
    : createWorld(on, { branch: 'feature', ahead: 2 }, { session: noFlow, gh: github.gh, closingPrs: { 3: [closing] }, ...changes })
  world.files.set(scopeFile(coordinator), buildScope(coordinator, [3]))
  markSpawned(world, [3])
  world.seedChat(coordinator, { ...createEmptySession(coordinator), role: 'coordinator' })
  if (unit === 'fix') await seedUnit(world, 'sid', { branch: 'fix/3-bug', issues: [3] }, { runs }, 'fix')
  return { world, github }
}

/**
 * Moves the world to a session.
 * @param world - The world.
 * @param session - The unit's or the coordinator's.
 */
const become = (world: World, session: 'unit' | 'coordinator'): void => { world.chat.id = session === 'unit' ? 'sid' : coordinator }

/**
 * Builds a delegated decision's body.
 * @param choice - The Choice text.
 * @param why - The Reason text.
 * @returns The markdown.
 */
const decisionBody = (choice: string, why: string): string =>
  `## Delegated decision\n\n### Question\nWhich step?\n\n### Alternatives considered\n- none\n\n### Choice\n${choice}\n\n### Reason\n${why}\n\n### Cost of going back\nlow`

/**
 * Posts a delegated decision on issue 3 with issue_comment from a session.
 * @param $ - The engine.
 * @param world - The world.
 * @param choice - The Choice text.
 * @param why - The Reason text.
 * @param from - The session that posts it.
 * @returns The comment's URL.
 */
async function decide($: Engine, world: World, choice: string, why = 'Decided.', from: 'unit' | 'coordinator' = 'coordinator'): Promise<string> {
  become(world, from)
  const posted = await callModTool($, 'issue_comment', { number: 3, body: decisionBody(choice, why) })
  expect(posted.isError).toBe(false)
  return /https:\S+#issuecomment-\d+/.exec(posted.text)![0]
}

/**
 * Reads the messages of a mailbox directory.
 * @param world - The world.
 * @param box - The mailbox.
 * @param directory - new or cur.
 * @returns The messages.
 */
const readBox = (world: World, box: string, directory: 'new' | 'cur'): Mail[] =>
  [...world.files.entries()].filter(([path]) => path.startsWith(`${box}/${directory}/`)).map(([, text]) => JSON.parse(text) as Mail)

/**
 * Rings the unit's doorbell and reads the context its prompt entered with.
 * @param $ - The engine.
 * @param world - The world.
 * @returns The context, joined.
 */
async function ring($: Engine, world: World): Promise<string> {
  become(world, 'unit')
  const result = await $.classic.UserPromptSubmit({ prompt: doorbell, permission_mode: 'default' } as never) as { additionalContext?: string[] }
  return result.additionalContext?.join('\n') ?? ''
}

/**
 * Reads the done the unit's mod sent the coordinator for a step.
 * @param world - The world.
 * @param id - The step's id.
 * @returns The done, if any.
 */
const readDone = (world: World, id: string): Mail | undefined => readBox(world, coordinatorBox, 'new').find(mail => mail.kind === 'done' && mail.in_reply_to === id)

/**
 * Reads whether a decision's provenance record says a step used it.
 * @param world - The world.
 * @param url - The decision's URL.
 * @returns The session that used it, if any.
 */
const readConsumer = (world: World, url: string): string | undefined =>
  (JSON.parse(world.files.get(`${records}/dd/${/\d+$/.exec(url)![0]}.json`) ?? '{}') as { consumedBy?: string }).consumedBy

/**
 * Writes a step message straight into the unit's mailbox, as no tool of the mod would.
 * @param world - The world.
 * @param body - The step command.
 * @param refs - The decision's URL first.
 * @param from - The sender's address.
 * @returns The message's id.
 */
function deliverStep(world: World, body: string, refs: string[], from = `coordinator-${coordinator}`): string {
  const id = `forged-${readBox(world, unitBox, 'new').length + readBox(world, unitBox, 'cur').length}`
  world.files.set(`${unitBox}/new/${id}.1.json`, JSON.stringify({ v: 2, id, kind: 'step', from, to: '3', issue: 3, in_reply_to: '', seq: 1,
    created_at: '2026-01-01T00:00:00.000Z', expects: '', attempt: 1, body, refs, author: 'agent', options: [] }))
  return id
}

/**
 * Builds a step message from the coordinator to the unit of issue 3, as it reached the unit.
 * @param id - The message's id.
 * @returns The envelope.
 */
const buildStep = (id: string): Envelope => ({ v: 2, id, kind: 'step', from: `coordinator-${coordinator}`, to: '3', issue: 3, in_reply_to: '', seq: 1,
  created_at: '2026-01-01T00:00:00.000Z', expects: '', attempt: 1, body: '/flow skip diagnose x', refs: [], author: 'agent', options: [] })

/**
 * Relays a skip of Diagnose with skip_unit and reads the step message it sent.
 * @param $ - The engine.
 * @param world - The world.
 * @param decision - The decision's URL.
 * @returns The step message.
 */
async function relaySkip($: Engine, world: World, decision: string): Promise<Mail> {
  become(world, 'coordinator')
  const relayed = await callModTool($, 'skip_unit', { number: 3, decision, step: 'diagnose', reason })
  expect(relayed.isError).toBe(false)
  return readBox(world, unitBox, 'new').find(mail => mail.kind === 'step')!
}

// contract: skip_unit sends the unit a step message carrying the command and the decision, and the unit's mod applies the skip itself, replies done with the outcome, and marks the decision used
test('skip_unit relays a checked skip that the unit\'s mod applies, replies done to and marks used', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  expect(step.body).toBe(`/flow skip diagnose ${reason}`)
  expect(step.refs).toEqual([decision])
  expect(world.herdrCalls).toEqual([])
  const context = await ring($, world)
  expect(context).toContain('applied: Skipped Diagnose')
  expect(readDone(world, step.id)).toMatchObject({ author: 'mod', from: '3' })
  expect(readDone(world, step.id)?.body).toContain('applied')
  expect(readConsumer(world, decision)).toBe('sid')
})

/**
 * Builds a unit world whose host throws on the next link into the coordinator's mailbox once the fault is armed.
 * @param on - The test's hook registration.
 * @param fault - Whether the next link throws; it disarms itself once it has.
 * @returns The world, in the unit's session, and the fake GitHub.
 */
const arrangeFailingDone = (on: Parameters<typeof createWorld>[0], fault: { isArmed: boolean }): Promise<Arranged> => arrange(on, 'fix', { beforeRun: argv => {
  if (!fault.isArmed || argv[0] !== 'ln' || !(argv.at(-1) ?? '').startsWith(`${coordinatorBox}/new/`)) return
  fault.isArmed = false
  throw new Error('disk full')
} })

// contract: a step's done the mod fails to send is owed on disk and the reply says so with the error; the mod sends it with its own outcome at the next prompt and clears it, and the agent still cannot close the step
test('a step whose done the mod fails to send is owed, and the mod sends it at the next prompt', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrangeFailingDone(on, fault)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  expect(context).toContain('applied: Skipped Diagnose')
  expect(context).not.toContain('already replied done')
  expect(context).toMatch(/the done was not sent \([^)]+\); this session's mod resends it at its next prompt; nothing to do/)
  expect(readDone(world, step.id)).toBeUndefined()
  expect(world.files.has(`${records}/owed/${step.id}.json`)).toBe(true)
  const refused = await callModTool($, 'send', { kind: 'done', in_reply_to: step.id, body: 'Skipped Diagnose.' })
  expect(refused.isError).toBe(true)
  expect(refused.text).toContain('closed by this session\'s mod')
  await ring($, world)
  expect(readDone(world, step.id)).toMatchObject({ author: 'mod', from: '3' })
  expect(readDone(world, step.id)?.body).toContain('applied: Skipped Diagnose')
  expect(world.files.has(`${records}/owed/${step.id}.json`)).toBe(false)
})

// contract: a done the mod can neither send nor keep tells the agent to tell the user the outcome, and the still-claimed step's done is replayed at the next prompt with the same reply id
test('a step whose done can be neither sent nor kept tells the agent to tell the user, and its done is replayed at the next prompt', async ($, on) => {
  const fault = { isArmed: false, isOwedFailing: false }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    const target = argv.at(-1) ?? ''
    if (fault.isArmed && argv[0] === 'ln' && target.startsWith(`${coordinatorBox}/new/`)) {
      fault.isArmed = false
      throw new Error('disk full')
    }
    if (fault.isOwedFailing && argv[0] === 'mv' && target.startsWith(`${records}/owed/`)) throw new Error('disk full')
  } })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  Object.assign(fault, { isArmed: true, isOwedFailing: true })
  const context = await ring($, world)
  expect(context).toContain('the step stays claimed, so this session\'s mod tries its done again at the next prompt')
  expect(context).not.toContain('resends it')
  expect(world.files.has(`${records}/owed/${step.id}.json`)).toBe(false)
  expect(context).toContain(`Stop and tell the user: the coordinator was not told step ${step.id}'s outcome`)
  expect(context).not.toContain('kind blocked')
  fault.isOwedFailing = false
  expect(await ring($, world)).toContain('applied earlier (done ')
  expect(readDone(world, step.id)?.body).toContain('applied: Skipped Diagnose')
  expect(countSkips(world)).toBe(1)
  expect(countDones(world, step.id)).toBe(1)
})

// contract: outside a repository a done can be neither sent nor kept, and the reply tells the agent to tell the user, never to send mail
test('a done outside a repository tells the agent to tell the user, never to send mail', async (_$, on) => {
  const world = createWorld(on, { branch: 'fix/3-bug' }, { isOutsideRepo: true })
  const text = await replyStepDone(createTestPort(world), buildStep('step-1'), 'Step step-1 (/flow skip diagnose x) applied: Skipped Diagnose.')
  expect(text).toContain('will not retry it')
  expect(text).toContain('Stop and tell the user: the coordinator was not told step step-1\'s outcome')
  expect(text).not.toContain('blocked')
})

// contract: a done whose outcome is longer than a message carries is cut to fit and sent, never left unsendable
test('a done with an outcome longer than a message carries is cut to fit and sent', async (_$, on) => {
  const { world } = await arrange(on)
  const text = await replyStepDone(createTestPort(world), buildStep('step-long'), `Step step-long (/flow skip diagnose ${'x'.repeat(bodyLimit)}) applied.`)
  expect(text).toContain('already replied done')
  expect(readDone(world, 'step-long')?.body.length).toBeLessThanOrEqual(bodyLimit)
})

// contract: a long skip reason is cut with a named marker in the done, and the mod's own warning after it always survives
test('a long skip reason is cut in the done, keeping the warning that its outcome was not recorded', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    if (fault.isArmed && argv[0] === 'mv' && (argv.at(-1) ?? '').startsWith(`${records}/dd/`) && (world.files.get(argv.at(-2) ?? '') ?? '').includes('"outcome"')) throw new Error('disk full')
  } })
  const long = 'r'.repeat(7800)
  const decision = await decide($, world, '/flow skip diagnose, as the Reason says.', long)
  become(world, 'coordinator')
  expect((await callModTool($, 'skip_unit', { number: 3, decision, step: 'diagnose', reason: long })).isError).toBe(false)
  const step = readBox(world, unitBox, 'new').find(mail => mail.kind === 'step')!
  fault.isArmed = true
  await ring($, world)
  const body = readDone(world, step.id)?.body ?? ''
  expect(body).toMatch(/… \[cut: \d+ more characters\]/)
  expect(body).toContain('its outcome was not recorded')
})

// contract: a step whose run throws still gets its done, saying it did not finish and what to check
test('a step whose run throws still sends its done, saying it did not finish', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { missSessionWrite: () => fault.isArmed && world.chat.id === 'sid' })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  expect(context).toContain('did not finish (')
  expect(readDone(world, step.id)?.body).toContain('did not finish (')
})

// contract: a step applied whose outcome cannot be recorded still sends its done, naming the unrecorded outcome
test('a step whose outcome cannot be recorded still sends its done, naming it', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    if (fault.isArmed && argv[0] === 'mv' && (argv.at(-1) ?? '').startsWith(`${records}/dd/`) && (world.files.get(argv.at(-2) ?? '') ?? '').includes('"outcome"')) throw new Error('disk full')
  } })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  expect(context).toContain('applied: Skipped Diagnose')
  expect(context).toContain('; its outcome was not recorded (')
  expect(readDone(world, step.id)?.body).toContain('its outcome was not recorded')
})

// contract: a done that keeps failing is named to the agent at the prompt and on /flow status after three failed resends, with what to check
test('a done that keeps failing is named at the prompt and on /flow status after three resends', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrangeFailingDone(on, fault)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  const failedRing = async (): Promise<string> => {
    fault.isArmed = true
    return ring($, world)
  }
  await failedRing()
  const rings = [await failedRing(), await failedRing(), await failedRing()]
  expect(rings[1]).not.toContain('The mod still owes a done')
  expect(rings[2]).toContain(`The mod still owes a done: step ${step.id}'s done not sent after 3 resends`)
  expect(rings[2]).toContain('Stop and tell the user')
  expect(await failedRing()).not.toContain('The mod still owes a done')
  become(world, 'unit')
  expect((await runFlowCommand($, 'status')).text).toContain(`step ${step.id}'s done not sent after 4 resends`)
})

// contract: (pin, not a red: an earlier round's third Stop asserted nothing of the second; here the disk fault fails the skip start's composition, so no Stop carries it and it stays kept) a done that keeps failing never enters a Stop's block: the turn's first Stop ends it, and the kept start is not lost
test('a done that keeps failing never holds the turn at its Stop', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrangeFailingDone(on, fault)
  const decision = await decide($, world, skipChoice)
  await relaySkip($, world, decision)
  const failedRing = async (): Promise<string> => {
    fault.isArmed = true
    return ring($, world)
  }
  await failedRing()
  await failedRing()
  await failedRing()
  expect(await failedRing()).toContain('The mod still owes a done')
  // why: the done keeps failing through both Stops, as a stuck one does.
  fault.isArmed = true
  const first = await stop($, false)
  fault.isArmed = true
  const second = await stop($, true)
  fault.isArmed = false
  const kept = (await runFlowCommand($, 'status')).text?.includes('1 start prompt wait') ?? false
  expect({ first, second, kept }).toEqual({ first: '', second: '', kept: true })
})

// contract: a resend whose failure cannot be counted names the owed outcome and the error to the agent at once
test('a resend whose failure cannot be counted is named to the agent at once', async ($, on) => {
  const fault = { isArmed: false, isOwedFailing: false }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    const target = argv.at(-1) ?? ''
    if (fault.isArmed && argv[0] === 'ln' && target.startsWith(`${coordinatorBox}/new/`)) {
      fault.isArmed = false
      throw new Error('disk full')
    }
    if (fault.isOwedFailing && argv[0] === 'mv' && target.startsWith(`${records}/owed/`)) throw new Error('disk full')
  } })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  await ring($, world)
  Object.assign(fault, { isArmed: true, isOwedFailing: true })
  const first = await ring($, world)
  expect(first).toContain(`The mod could not count a failed resend of step ${step.id}'s done (`)
  expect(first).toContain(`it keeps resending the done at each prompt and tick. Check ${records}/owed/${step.id}.json.`)
  expect(first).not.toContain('/flow status')
  expect(first).not.toContain('Stop and tell the user')
  expect(world.files.has(`${records}/owed/${step.id}.json`)).toBe(true)
  fault.isArmed = true
  const second = await ring($, world)
  expect(second).toContain('That write failed at 2 prompts in a row. Stop and tell the user')
  expect(second).toContain('applied: Skipped Diagnose')
})

/**
 * Builds a unit world whose done to the coordinator fails once per arming, and whose owed-record writes and reads fail while told to.
 * @param on - The test's hook registration.
 * @param fault - What fails: the next done, the owed writes, the owed reads.
 * @returns The world, in the unit's session, and the fake GitHub.
 */
const arrangeOwedFaults = (on: Parameters<typeof createWorld>[0], fault: { isArmed: boolean; isOwedFailing: boolean; isReadFailing: boolean }): Promise<Arranged> =>
  arrange(on, 'fix', {
    beforeRun: argv => {
      const target = argv.at(-1) ?? ''
      if (fault.isArmed && argv[0] === 'ln' && target.startsWith(`${coordinatorBox}/new/`)) {
        fault.isArmed = false
        throw new Error('disk full')
      }
      if (fault.isOwedFailing && argv[0] === 'mv' && target.startsWith(`${records}/owed/`)) throw new Error('disk full')
    },
    failRead: path => fault.isReadFailing && path.startsWith(`${records}/owed/`),
  })

// contract: the user is told only when the count write failed at prompts in a row; a prompt that finds the record unreadable ends the streak
test('a prompt that finds the owed record unreadable ends the streak of failed count writes', async ($, on) => {
  const fault = { isArmed: false, isOwedFailing: false, isReadFailing: false }
  const { world } = await arrangeOwedFaults(on, fault)
  const decision = await decide($, world, skipChoice)
  await relaySkip($, world, decision)
  fault.isArmed = true
  await ring($, world)
  Object.assign(fault, { isArmed: true, isOwedFailing: true })
  expect(await ring($, world)).toContain('The mod could not count a failed resend')
  Object.assign(fault, { isOwedFailing: false, isReadFailing: true })
  expect(await ring($, world)).toContain('cannot be read (')
  Object.assign(fault, { isArmed: true, isOwedFailing: true, isReadFailing: false })
  const third = await ring($, world)
  expect(third).toContain('The mod could not count a failed resend')
  expect(third).not.toContain('prompts in a row')
})

// contract: a prompt whose count write succeeds ends the streak, so a later failed write starts it again
test('a prompt whose count write succeeds ends the streak of failed count writes', async ($, on) => {
  const fault = { isArmed: false, isOwedFailing: false, isReadFailing: false }
  const { world } = await arrangeOwedFaults(on, fault)
  const decision = await decide($, world, skipChoice)
  await relaySkip($, world, decision)
  fault.isArmed = true
  await ring($, world)
  Object.assign(fault, { isArmed: true, isOwedFailing: true })
  await ring($, world)
  Object.assign(fault, { isArmed: true, isOwedFailing: false })
  await ring($, world)
  Object.assign(fault, { isArmed: true, isOwedFailing: true })
  const third = await ring($, world)
  expect(third).toContain('The mod could not count a failed resend')
  expect(third).not.toContain('prompts in a row')
})

// contract: a resend counts its failure on the record as it is now, so a count written meanwhile by another resend is kept, and a done already named is not named again
test('a failed resend counts on the record as it is now, keeping what another resend wrote meanwhile', async ($, on) => {
  const fault = { isArmed: false, isRacing: false }
  const owedPath = (id: string): string => `${records}/owed/${id}.json`
  const state = { id: '' }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    if (!fault.isArmed || argv[0] !== 'ln' || !(argv.at(-1) ?? '').startsWith(`${coordinatorBox}/new/`)) return
    fault.isArmed = false
    if (fault.isRacing) {
      // why: a tick resending the same done meanwhile has counted its own failures and named it.
      const record = JSON.parse(world.files.get(owedPath(state.id)) ?? '{}') as Record<string, unknown>
      world.files.set(owedPath(state.id), JSON.stringify({ ...record, attempts: 5, isTold: true }))
    }
    throw new Error('disk full')
  } })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  state.id = step.id
  fault.isArmed = true
  await ring($, world)
  Object.assign(fault, { isArmed: true, isRacing: true })
  const context = await ring($, world)
  expect(context).not.toContain('The mod still owes a done')
  expect(JSON.parse(world.files.get(owedPath(step.id)) ?? '{}')).toMatchObject({ attempts: 6, isTold: true })
})

// contract: a resent done whose owed record cannot be removed is named as sent at the prompt, and the record is removed at a later resend
test('a resent done whose record cannot be removed is named as sent, and removed later', async ($, on) => {
  const fault = { isArmed: false, isRemoveFailing: false }
  const { world } = await arrange(on, 'fix', {
    beforeRun: argv => {
      if (!fault.isArmed || argv[0] !== 'ln' || !(argv.at(-1) ?? '').startsWith(`${coordinatorBox}/new/`)) return
      fault.isArmed = false
      throw new Error('disk full')
    },
    failRun: argv => fault.isRemoveFailing && argv[0] === 'rm' && argv.some(arg => arg.startsWith(`${records}/owed/`)) ? { exitCode: 1, stderr: 'rm: read-only file system' } : undefined,
  })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  await ring($, world)
  fault.isRemoveFailing = true
  const context = await ring($, world)
  expect(readDone(world, step.id)?.body).toContain('applied: Skipped Diagnose')
  expect(context).toContain(`Step ${step.id}'s done is now sent, but its owed record ${records}/owed/${step.id}.json could not be removed (rm: read-only file system); the mod tries again at its next prompt or tick. Check ${records}/owed/${step.id}.json.`)
  expect(context).not.toContain('Nothing to do')
  fault.isRemoveFailing = false
  await ring($, world)
  expect(world.files.has(`${records}/owed/${step.id}.json`)).toBe(false)
})

// contract: an owed record that cannot be read is named at the prompt with its path and listed by /flow status, never dropped silently
test('an owed record that cannot be read is named at the prompt and by /flow status', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { readFailurePrefix: `${records}/owed/`, beforeRun: argv => {
    if (!fault.isArmed || argv[0] !== 'ln' || !(argv.at(-1) ?? '').startsWith(`${coordinatorBox}/new/`)) return
    fault.isArmed = false
    throw new Error('disk full')
  } })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  await ring($, world)
  const context = await ring($, world)
  expect(context).toContain(`The mod cannot resend a done: owed record ${records}/owed/${step.id}.json cannot be read (`)
  become(world, 'unit')
  expect((await runFlowCommand($, 'status')).text).toContain(`owed record ${records}/owed/${step.id}.json cannot be read (`)
})

// contract: an owed done whose reply is already in the coordinator's mailbox counts as sent: the record is cleared and no second done is written
test('an owed done whose reply is already present counts as sent', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrangeFailingDone(on, fault)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  await ring($, world)
  expect(world.files.has(`${records}/owed/${step.id}.json`)).toBe(true)
  const present = `${coordinatorBox}/cur/${step.id}-re-3.1.json`
  world.files.set(present, JSON.stringify({ id: `${step.id}-re-3`, kind: 'done', from: '3', in_reply_to: step.id, body: 'sent before', author: 'mod', refs: [] }))
  await ring($, world)
  expect(world.files.has(`${records}/owed/${step.id}.json`)).toBe(false)
  expect(readDone(world, step.id)).toBeUndefined()
  expect(world.files.get(present)).toContain('sent before')
})

// contract: approve_unit relays the diagnosis URL and says the approval is sent, not applied, naming unit_read and /flow inbox for a done that never arrives; the unit's mod approves it, pinning the red recorded before the diagnosis
test('approve_unit relays a checked approval of the diagnosis that the unit\'s mod applies', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, `/flow approve ${diagnosis.url}.`, 'The red ./check fails for the cause the diagnosis names.')
  become(world, 'coordinator')
  const relayed = await callModTool($, 'approve_unit', { number: 3, kind: 'approve', decision, diagnosis: diagnosis.url, red: './check' })
  expect(relayed.isError).toBe(false)
  for (const words of ['sent, not applied', 'send the unit nothing about the step', 'unit_read', '/flow inbox']) expect(relayed.text).toContain(words)
  const step = readBox(world, unitBox, 'new').find(mail => mail.kind === 'step')!
  expect(step.body).toBe(`/flow approve ${diagnosis.url} ["./check"]`)
  expect(await ring($, world)).toContain(`applied: Diagnosis approved: ${diagnosis.url}`)
  expect(readConsumer(world, decision)).toBe('sid')
})

// contract: approve_unit pins the red the decision cites, not a later failing probe, on both sides, and the unit persists that red as approved
test('approve_unit citing the real red approves it over a later failing probe', async ($, on) => {
  const probe: RunRecord = { argv: ['./probe'], tree: 'red', outcome: { kind: 'fail', code: 1, signal: null }, runId: 'probe', at: 2 }
  const { world } = await arrange(on, 'fix', {}, [diagnoseRuns[0]!, probe])
  const decision = await decide($, world, `/flow approve ${diagnosis.url}.`, 'The red ./check fails for the cause the diagnosis names.')
  become(world, 'coordinator')
  const relayed = await callModTool($, 'approve_unit', { number: 3, kind: 'approve', decision, diagnosis: diagnosis.url, red: './check' })
  expect(relayed.text).not.toContain('is not the red command')
  expect(relayed.isError).toBe(false)
  expect(await ring($, world)).toContain(`applied: Diagnosis approved: ${diagnosis.url}`)
  const unit = (JSON.parse(world.files.get(`${records}/s/sid.json`) ?? '{}') as { units?: { approvedRed?: { argv: string[] } }[] }).units?.[0]
  expect(unit?.approvedRed?.argv).toEqual(['./check'])
})

// contract: approve_unit refuses a cited text that joins more than one distinct red argv, lists them as argv JSON, and sends nothing
test('approve_unit refuses a red whose text matches two distinct red argvs', async ($, on) => {
  const red = (argv: string[], at: number): RunRecord => ({ argv, tree: 'red', outcome: { kind: 'fail', code: 1, signal: null }, runId: `r${at}`, at })
  const { world } = await arrange(on, 'fix', {}, [red(['a', 'b c'], 1), red(['a b', 'c'], 2)])
  const decision = await decide($, world, `/flow approve ${diagnosis.url}.`, 'The red a b c fails.')
  become(world, 'coordinator')
  const result = await callModTool($, 'approve_unit', { number: 3, kind: 'approve', decision, diagnosis: diagnosis.url, red: 'a b c' })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('`a b c` matches several red commands before the diagnosis: ["a b","c"], ["a","b c"]')
  expect(readBox(world, unitBox, 'new')).toEqual([])
})

// contract: approve_unit refuses a red the unit's records hold no run of before the diagnosis, listing the reds they hold, and sends nothing
test('approve_unit refuses a red with no run before the diagnosis, listing the reds', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, `/flow approve ${diagnosis.url}.`, 'The red ./other fails.')
  become(world, 'coordinator')
  const result = await callModTool($, 'approve_unit', { number: 3, kind: 'approve', decision, diagnosis: diagnosis.url, red: './other' })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('the unit\'s records hold no red run of `./other` before the diagnosis; the reds they hold before it are: ["./check"]')
  expect(readBox(world, unitBox, 'new')).toEqual([])
})

// contract: approve_unit refuses a decision that does not cite the diagnosis and the red command it pins, and sends nothing
test('approve_unit refuses a decision that cites neither the diagnosis nor the red command', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, '/flow approve.', 'Looks fine.')
  become(world, 'coordinator')
  const result = await callModTool($, 'approve_unit', { number: 3, kind: 'approve', decision, diagnosis: diagnosis.url, red: './check' })
  expect(result.isError).toBe(true)
  expect(result.text).toContain(`does not cite ${diagnosis.url} and ./check`)
  expect(readBox(world, unitBox, 'new')).toEqual([])
})

// contract: follow_up_unit relays a follow-up that the unit's mod declares
test('follow_up_unit relays a checked follow-up that the unit\'s mod declares', async ($, on) => {
  const { world } = await arrange(on, 'none')
  const decision = await decide($, world, '/flow follow-up #3, on the open PR.')
  become(world, 'coordinator')
  expect((await callModTool($, 'follow_up_unit', { number: 3, decision, issue: 3 })).isError).toBe(false)
  expect(await ring($, world)).toContain('applied: Flow declared: Follow-up')
})

for (const [name, choice, why, args, refusal] of [
  ['a decision that names another step', '/flow skip code: no code.', reason, { step: 'diagnose', reason }, 'does not name the step /flow skip diagnose'],
  ['a decision that does not cite the reason', '/flow skip diagnose.', 'Decided.', { step: 'diagnose', reason }, `does not cite ${reason}`],
] as const) {
  // contract: the coordinator's tool refuses a decision that does not name its exact step or cite what it rests on, and sends nothing
  test(`skip_unit refuses ${name} and sends nothing`, async ($, on) => {
    const { world } = await arrange(on)
    const decision = await decide($, world, choice, why)
    become(world, 'coordinator')
    const result = await callModTool($, 'skip_unit', { number: 3, decision, ...args })
    expect(result.isError).toBe(true)
    expect(result.text).toContain(refusal)
    expect(readBox(world, unitBox, 'new')).toEqual([])
  })
}

// contract: a unit's refused approval names why its Diagnose is not waiting, as the coordinator's tool does
test('the unit refuses an approval while its Diagnose is not waiting, naming what it needs', async ($, on) => {
  const { world, github } = await arrange(on)
  // why: with no comment after the red, Diagnose needs a diagnosis comment; the step is refused before its decision is read.
  github.comments.length = 0
  const id = deliverStep(world, `/flow approve ${diagnosis.url}`, ['https://github.com/o/r/issues/3#issuecomment-901'])
  expectRefused(await ring($, world), world, id, 'Diagnose next needs a diagnosis comment on #3')
})

for (const side of ['unit', 'coordinator'] as const) {
  // contract: an approval refused because the issue's comments could not be read names that read failure, never a Diagnose state
  test(`the ${side} side names a failed comment read when it refuses an approval`, async ($, on) => {
    const { world, github } = await arrange(on)
    const decision = await decide($, world, `/flow approve ${diagnosis.url}.`, 'The red ./check fails for the cause the diagnosis names.')
    become(world, 'coordinator')
    if (side === 'coordinator') github.faults.isCommentReadFailing = true
    const relayed = await callModTool($, 'approve_unit', { number: 3, kind: 'approve', decision, diagnosis: diagnosis.url, red: './check' })
    if (side === 'coordinator') {
      expect(relayed.text).toContain('could not read #3: ')
      expect(relayed.text).not.toContain('not waiting for approval')
      return
    }
    github.faults.isCommentReadFailing = true
    const step = readBox(world, unitBox, 'new').find(mail => mail.kind === 'step')!
    const context = await ring($, world)
    expectRefused(context, world, step.id, 'could not read #3: ')
    expect(context).not.toContain('not waiting for approval')
  })
}

// contract: a decision a unit posted has no provenance record, so the coordinator's tool refuses it
test('skip_unit refuses a decision a unit posted itself', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice, 'Decided.', 'unit')
  become(world, 'coordinator')
  const result = await callModTool($, 'skip_unit', { number: 3, decision, step: 'diagnose', reason })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('not a delegated decision this coordinator\'s mod recorded')
  expect(readBox(world, unitBox, 'new')).toEqual([])
})

// contract: a decision edited after it was posted, or already used by a step, is refused by the coordinator's tool
test('skip_unit refuses an edited decision and a used one', async ($, on) => {
  const { world, github } = await arrange(on)
  const edited = await decide($, world, skipChoice)
  github.comments.find(comment => comment.url === edited)!.body += '\nEdited.'
  become(world, 'coordinator')
  expect((await callModTool($, 'skip_unit', { number: 3, decision: edited, step: 'diagnose', reason })).text).toContain('was edited after the coordinator posted it')
  const used = await decide($, world, skipChoice)
  await relaySkip($, world, used)
  await ring($, world)
  become(world, 'coordinator')
  const refused = (await callModTool($, 'skip_unit', { number: 3, decision: used, step: 'diagnose', reason })).text
  expect(refused).toContain('was already claimed by sid for step ')
  expect(refused).toContain('(outcome: applied: Skipped Diagnose')
  expect(refused).not.toContain('applied by')
})

/**
 * Tells whether the unit refused a step: the model is shown the refusal, the coordinator gets a done saying so, and the decision stays unused.
 * @param context - The prompt's context.
 * @param world - The world.
 * @param id - The step's id.
 * @param refusal - Words of the reason.
 */
function expectRefused(context: string, world: World, id: string, refusal: string): void {
  expect(context).toContain('refused')
  expect(context).toContain(refusal)
  expect(readDone(world, id)?.body).toContain('refused: ')
  expect(readDone(world, id)?.body).toContain(refusal)
  expect(context).not.toContain('Skipped Diagnose')
}

// contract: a step message alone, about a decision the coordinator's mod never recorded, is refused by the unit's mod and changes nothing
test('the unit refuses a step envelope alone', async ($, on) => {
  const { world, github } = await arrange(on)
  github.comments.push({ issue: 3, url: 'https://github.com/o/r/issues/3#issuecomment-901', body: decisionBody(skipChoice, 'Decided.'), createdAt: new Date(2000).toISOString() })
  const id = deliverStep(world, `/flow skip diagnose ${reason}`, ['https://github.com/o/r/issues/3#issuecomment-901'])
  expectRefused(await ring($, world), world, id, 'not a delegated decision this coordinator\'s mod recorded')
})

// contract: the unit's mod checks again: a decision edited after the coordinator relayed it is refused
test('the unit refuses a step whose decision was edited after it was relayed', async ($, on) => {
  const { world, github } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  github.comments.find(comment => comment.url === decision)!.body += '\nEdited.'
  expectRefused(await ring($, world), world, step.id, 'was edited after the coordinator posted it')
  expect(readConsumer(world, decision)).toBeUndefined()
})

for (const [name, body, refusal] of [
  ['another step than its decision names', '/flow skip code because', 'does not name the step /flow skip code'],
  ['a reason its decision does not cite', '/flow skip diagnose another reason', 'does not cite another reason'],
] as const) {
  // contract: the unit's mod refuses a step whose command its decision does not name and cite exactly
  test(`the unit refuses ${name}`, async ($, on) => {
    const { world } = await arrange(on)
    const decision = await decide($, world, skipChoice)
    const id = deliverStep(world, body, [decision])
    expectRefused(await ring($, world), world, id, refusal)
    expect(readConsumer(world, decision)).toBeUndefined()
  })
}

// contract: a decision authorises one step, once: a second step message about a used decision is refused, naming who claimed it and the recorded outcome
test('the unit refuses a second step about a used decision', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const first = await relaySkip($, world, decision)
  expect(await ring($, world)).toContain('applied')
  const id = deliverStep(world, `/flow skip diagnose ${reason}`, [decision])
  const context = await ring($, world)
  expect(context).toContain(`refused: ${decision} was already claimed by sid for step ${first.id} at `)
  expect(context).not.toContain('applied by')
  expect(readDone(world, id)?.body).toContain('a decision authorises one step, once')
  expect(countSkips(world)).toBe(1)
})

// contract: a decision posted before the unit started belongs to an earlier unit of the issue and is refused
test('the unit refuses a decision posted before it started', async ($, on) => {
  const { world } = await arrange(on)
  world.files.set(`${records}/spawn/3.json`, JSON.stringify({ isStarted: true, isPrompted: true, mode: 'default', sessionId: 'sid', startedAt: new Date(10 ** 12).toISOString() }))
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  expectRefused(await ring($, world), world, step.id, 'was posted before this unit started')
})

// contract: a decision whose comment another GitHub account wrote is refused, even with a provenance record and an unchanged body
test('the unit refuses a decision a third party wrote', async ($, on) => {
  const { world, github } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  github.comments.find(comment => comment.url === decision)!.author = 'stranger'
  expectRefused(await ring($, world), world, step.id, 'was written by stranger, not by me')
})

// contract: a step message from any address but the live coordinator that delegates the unit is refused
test('the unit refuses a step from another sender than its live coordinator', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const id = deliverStep(world, `/flow skip diagnose ${reason}`, [decision], 'coordinator-other')
  const context = await ring($, world)
  expect(context).toContain('coordinator-other is not the live coordinator that delegates #3')
  expect(readConsumer(world, decision)).toBeUndefined()
  expect(readBox(world, `${records}/mail/coordinator-other`, 'new').find(mail => mail.in_reply_to === id)?.body).toContain('refused')
})

// contract: a step's done is the mod's: the unit's agent cannot reply to a step with send
test('the unit\'s agent cannot close a step with send', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  become(world, 'unit')
  const result = await callModTool($, 'send', { kind: 'done', body: 'Done.', in_reply_to: step.id })
  expect(result.isError).toBe(true)
  expect(result.text).toContain('closed by this session\'s mod')
})

// contract: the user's own typed /flow skip in the unit's prompt keeps its composer path
test('the user\'s typed /flow skip still applies from the unit\'s prompt', async ($, on) => {
  const { world } = await arrange(on)
  become(world, 'unit')
  expect((await runFlowCommand($, `skip diagnose ${reason}`)).text).toContain('Skipped Diagnose')
})

// contract: no agent types any of the user's /flow subcommands into a pane or a prompt through herdr
test('herdr typing of every human-only /flow subcommand is denied', async ($, on) => {
  const { world } = await arrange(on)
  for (const session of ['unit', 'coordinator'] as const) {
    become(world, session)
    for (const subcommand of humanOnlyFlowCommands) {
      for (const command of [`herdr agent prompt issue-3 "/flow ${subcommand} x"`, `herdr pane send-text w1:p2 '/flow ${subcommand} x'`]) {
        expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain(`/flow ${subcommand} is the user's alone`)
      }
    }
  }
})

/**
 * Builds a delegated unit's session inside herdr, on a socket.
 * @param on - The test's hook registration.
 * @param socket - The caller's own HERDR_SOCKET_PATH.
 */
function arrangeInHerdr(on: Parameters<typeof createWorld>[0], socket: string): void {
  const world = createWorld(on, { branch: 'fix/3-bug' }, { herdrEnv: { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p1', HERDR_SOCKET_PATH: socket } })
  world.files.set(scopeFile(coordinator), buildScope(coordinator, [3]))
  markSpawned(world, [3])
}

// contract: an agent may type /flow coordinate or /flow delegate into a pane's agent prompt of an explicit probe-* herdr session that is not its own
test('herdr agent prompt of /flow coordinate or delegate into another probe-* session is allowed', async ($, on) => {
  arrangeInHerdr(on, mainSocket)
  for (const text of setupCommands) {
    for (const command of [`herdr --session probe-7 agent prompt w1:p1 "${text}"`, `herdr --session=probe-7 agent prompt w1:p1 '${text}'`,
      `HERDR_SOCKET_PATH=${probeSocket} herdr agent prompt w1:p1 "${text}"`]) {
      expect((await $.tool.call({ tool: 'Bash', command })).deny ?? '').not.toContain('is the user\'s alone')
    }
  }
})

// contract: the probe setup commands stay denied into the default session, the caller's own socket, or a target named only inside the typed text
test('herdr agent prompt of /flow coordinate or delegate stays denied outside another probe-* session', async ($, on) => {
  arrangeInHerdr(on, probeSocket)
  for (const text of setupCommands) {
    for (const command of [`herdr agent prompt w1:p1 "${text}"`, `herdr --session default agent prompt w1:p1 "${text}"`,
      `herdr --session probe-7 agent prompt w1:p1 "${text}"`, `HERDR_SOCKET_PATH=${probeSocket} herdr agent prompt w1:p1 "${text}"`,
      `HERDR_SOCKET_PATH=/h/sessions/probe-8/../../herdr.sock herdr agent prompt w1:p1 "${text}"`,
      `herdr agent prompt w1:p1 "${text} --session probe-8"`, `herdr --session probe-8 pane list; herdr agent prompt w1:p1 "${text}"`,
      `herdr --session probe-8 pane send-text w1:p1 "${text}"`]) {
      expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('is the user\'s alone')
    }
  }
})

// contract: every human-only /flow subcommand but coordinate and delegate stays denied into a probe-* session, alone or beside a setup command
test('herdr typing of a step /flow subcommand into a probe-* session is denied', async ($, on) => {
  arrangeInHerdr(on, mainSocket)
  for (const subcommand of humanOnlyFlowCommands.filter(name => name !== 'coordinate' && name !== 'delegate')) {
    for (const command of [`herdr --session probe-7 agent prompt w1:p1 "/flow ${subcommand} x"`,
      `herdr --session probe-7 agent prompt w1:p1 "/flow coordinate /flow ${subcommand} x"`]) {
      expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain(`/flow ${subcommand} is the user's alone`)
    }
  }
})

// contract: herdr api calls and a herdr workspace started with a command are denied when they carry a human-only /flow subcommand, probes included
test('herdr api and herdr workspace create forms carrying a /flow subcommand are denied', async ($, on) => {
  arrangeInHerdr(on, mainSocket)
  for (const command of ['herdr api snapshot "/flow approve x"', 'herdr workspace create --cwd /w -- claude "/flow approve x"',
    'herdr --session probe-7 workspace create --cwd /w -- claude "/flow coordinate"', 'herdr --session probe-7 api snapshot \'/flow delegate 9\'']) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('is the user\'s alone')
  }
})

// contract: a Bash command that writes anywhere under the records directory is denied, not only under the mailbox
test('Bash writes under the records directory are denied', async ($, on) => {
  const { world } = await arrange(on)
  become(world, 'unit')
  for (const command of [`rm ${records}/dd/1.json`, `echo x > ${records}/spawn/3.json`]) {
    expect((await $.tool.call({ tool: 'Bash', command })).deny).toContain('are written only by the mod')
  }
  expect((await $.tool.call({ tool: 'Bash', command: `cat ${records}/spawn/3.json` })).deny ?? '').not.toContain('written only by the mod')
})

/**
 * Has the coordinator assign work to the unit, then cancel it; the world ends in the unit's session, both messages unread.
 * @param $ - The engine.
 * @param world - The world.
 * @returns The cancel's id.
 */
async function assignThenCancel($: Engine, world: World): Promise<string> {
  become(world, 'coordinator')
  expect((await callModTool($, 'unit_prompt', { number: 3, text: 'Fix it.', kind: 'assign' })).isError).toBe(false)
  expect((await callModTool($, 'unit_prompt', { number: 3, text: 'Stop: moved to #4.', kind: 'cancel' })).isError).toBe(false)
  become(world, 'unit')
  return readBox(world, unitBox, 'new').find(mail => mail.kind === 'cancel')!.id
}

/**
 * Raises the main agent's Stop and reads its block.
 * @param $ - The engine.
 * @param isActive - Whether the stop continues from an earlier block.
 * @returns The block, or an empty string.
 */
const stop = async ($: Engine, isActive: boolean): Promise<string> =>
  (await $.classic.Stop({ stop_hook_active: isActive, background_tasks: [] } as never)).block ?? ''

// group: Start prompt of a step applied while busy
// contract: a step applied while a prompt enters submits no start prompt, which would queue past the turn, and its Stop carries none; the turn's end submits the start of the step current then
test('a step applied by an entering prompt queues no start prompt into its turn, and its turn\'s end submits one naming the current step', async ($, on) => {
  const { world } = await arrange(on)
  await startSession($)
  await relaySkip($, world, await decide($, world, skipChoice))
  expect(await ring($, world)).toContain('applied: Skipped Diagnose')
  await world.clock.settle()
  expect(world.prompts.filter(text => text.includes('Skipped Diagnose'))).toEqual([])
  await $.turn.start({ text: 'work', turnId: 't' })
  expect(await stop($, false)).not.toContain('Skipped Diagnose')
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  await world.clock.settle()
  const starts = world.prompts.filter(text => text.includes('Skipped Diagnose'))
  expect(starts).toHaveLength(1)
  expect(await enterOwnPrompt($, starts[0]!)).toContain('current step: Code')
})

// contract: a start of a step applied in a live turn while a cancel is owed names the cancel and the done it needs, never the cancelled work, and is submitted once the turn ends
test('a step applied in a live turn with a cancel owed gets a start at the turn end that names the cancel, not the work', async ($, on) => {
  const { world } = await arrange(on)
  await startSession($)
  await relaySkip($, world, await decide($, world, skipChoice))
  const cancelId = await assignThenCancel($, world)
  await $.turn.start({ text: 'work', turnId: 't' })
  expect(await stop($, false)).toContain('applied: Skipped Diagnose')
  await world.clock.settle()
  expect(world.prompts.filter(text => text.includes('Skipped Diagnose'))).toEqual([])
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  await world.clock.settle()
  const start = await enterOwnPrompt($, world.prompts.find(text => text.includes('Skipped Diagnose')) ?? '')
  expect(start).toContain(cancelId)
  expect(start).not.toContain('Next action:')
})

// contract: a start kept while busy is submitted once the turn ends, interrupted or not, and its entry names the step current then
test('a step applied while busy whose turn is interrupted gets its start submitted at the turn end', async ($, on) => {
  const { world } = await arrange(on)
  await startSession($)
  await relaySkip($, world, await decide($, world, skipChoice))
  await ring($, world)
  await world.clock.settle()
  await $.turn.start({ text: 'work', turnId: 't' })
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 0, isAborted: true, turnId: 't' })
  await world.clock.settle()
  const starts = world.prompts.filter(text => text.includes('Skipped Diagnose'))
  expect(starts).toHaveLength(1)
  expect(await enterOwnPrompt($, starts[0]!)).toContain('current step: Code')
})

// contract: mail that came during a turn whose end submits a kept start rings no doorbell: the start's entry delivers it, and no prompt enters empty
test('a kept start submitted at an interrupted turn\'s end is the only prompt, and carries the mail that came meanwhile', async ($, on) => {
  const { world } = await arrange(on)
  await startSession($)
  await relaySkip($, world, await decide($, world, skipChoice))
  await ring($, world)
  await world.clock.settle()
  await $.turn.start({ text: 'work', turnId: 't' })
  become(world, 'coordinator')
  await callModTool($, 'unit_prompt', { number: 3, text: 'Meanwhile news.' })
  become(world, 'unit')
  await $.turn.complete({ reason: 'aborted', answer: '', durationMs: 0, isAborted: true, turnId: 't' })
  await world.clock.settle()
  expect(world.prompts.filter(text => text === doorbell)).toEqual([])
  const starts = world.prompts.filter(text => text.includes('Skipped Diagnose'))
  expect(starts).toHaveLength(1)
  const [start] = starts
  const entry = await $.classic.UserPromptSubmit({ prompt: start!, permission_mode: 'default' } as never) as { additionalContext?: string[] }
  expect(entry.additionalContext?.join('\n')).toContain('Meanwhile news.')
  expect(readBox(world, unitBox, 'cur').map(mail => mail.body)).toContain('Meanwhile news.')
})

// contract: a start kept behind a prompt whose turn never starts waits past every tick, never for a set time; once a prompt the user types runs its turn, the idle tick submits it once and its entry names the step
test('a start kept for a prompt that never starts its turn waits until a typed prompt runs a turn, then the idle tick submits it', async ($, on) => {
  const { world } = await arrange(on)
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  await relaySkip($, world, await decide($, world, skipChoice))
  await ring($, world)
  for (const minutes of [1, 2, 3]) await world.clock.advance(minutes * 61000)
  await world.clock.settle()
  const held = world.prompts.filter(text => text.includes('Skipped Diagnose')).length
  await $.classic.UserPromptSubmit({ prompt: 'typed by the user', permission_mode: 'default' } as never)
  await $.turn.start({ text: 'typed by the user', turnId: 't' })
  await $.turn.complete({ reason: 'answer', answer: '', durationMs: 0, isAborted: false, turnId: 't' })
  await world.clock.settle()
  const starts = world.prompts.filter(text => text.includes('Skipped Diagnose'))
  expect({ held, submitted: starts.length }).toEqual({ held: 0, submitted: 1 })
  expect(await enterOwnPrompt($, starts[0]!)).toContain('current step: Code')
})

// contract: while a cancel is owed, lifted or not, the per-prompt instruction names it and its done instead of the step's next action
test('the per-prompt instruction names an owed cancel, lifted or not, instead of the next action', async ($, on) => {
  const { world } = await arrange(on)
  const cancelId = await assignThenCancel($, world)
  await ring($, world)
  for (const isLifted of [false, true]) {
    if (isLifted) await runFlowCommand($, 'lift')
    const context = await readPromptContext($)
    expect(context).toContain(cancelId)
    expect(context).not.toContain('Next action:')
  }
})


/**
 * Counts the skips of Diagnose the unit's records hold: the step's effect.
 * @param world - The world.
 * @returns How many times the skip was applied.
 */
const countSkips = (world: World): number => (world.sessions.get('sid')?.units ?? []).flatMap(unit => unit.skips ?? []).filter(skip => skip.step === 'diagnose').length

/**
 * Counts the dones the unit's mod sent the coordinator for a step.
 * @param world - The world.
 * @param id - The step's id.
 * @returns How many are in the coordinator's mailbox, read or not.
 */
const countDones = (world: World, id: string): number =>
  [...readBox(world, coordinatorBox, 'new'), ...readBox(world, coordinatorBox, 'cur')].filter(mail => mail.kind === 'done' && mail.in_reply_to === id).length

/**
 * Moves the unit's step message to cur/ and edits its decision's record, as a process killed after the claim leaves them.
 * @param world - The world.
 * @param step - The step message.
 * @param decision - The decision's URL.
 * @param fields - What the record gains.
 */
function leaveClaimed(world: World, step: Mail, decision: string, fields: Record<string, unknown>): void {
  const name = `${step.id}.1.json`
  world.files.set(`${unitBox}/cur/${name}`, world.files.get(`${unitBox}/new/${name}`)!)
  world.files.delete(`${unitBox}/new/${name}`)
  const path = `${records}/dd/${/\d+$/.exec(decision)![0]}.json`
  world.files.set(path, JSON.stringify({ ...JSON.parse(world.files.get(path)!) as object, ...fields }))
}

/**
 * Builds a unit world whose session id read throws once an armed fault sees a write of a decision record, as a step's try counts
 * itself after its message was claimed, so the step's check fails as a host fault would.
 * @param on - The test's hook registration.
 * @param fault - Whether a decision record write arms the throw, and how many throws are left.
 * @returns The world, in the unit's session, and the fake GitHub.
 */
const arrangeThrowAfterAck = (on: Parameters<typeof createWorld>[0], fault: { isArmed: boolean; throws: number }): Promise<Arranged> => {
  const state = { isPending: false }
  return arrange(on, 'fix', {
    beforeRun: argv => {
      const target = argv.at(-1) ?? ''
      if (fault.isArmed && fault.throws > 0 && argv[0] === 'mv' && target.startsWith(`${records}/dd/`)) state.isPending = true
    },
    beforeSessionId: () => {
      if (!state.isPending) return
      state.isPending = false
      fault.throws -= 1
      throw new Error('host fault')
    } })
}

// contract: a step that throws after its claim stays claimed, the other messages of its batch are still delivered, and the next prompt applies it once
test('a step that throws after its claim keeps its batch delivered and is applied once at the next prompt', async ($, on) => {
  const fault = { isArmed: false, throws: 1 }
  const { world } = await arrangeThrowAfterAck(on, fault)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  world.files.set(`${unitBox}/new/note-1.1.json`, JSON.stringify({ v: 2, id: 'note-1', kind: 'inform', from: `coordinator-${coordinator}`, to: '3', issue: 3,
    in_reply_to: '', seq: 2, created_at: '2026-01-01T00:00:01.000Z', expects: '', attempt: 1, body: 'Phase B note.', refs: [], author: 'agent', options: [] }))
  fault.isArmed = true
  const first = await ring($, world)
  expect(first).toContain('Phase B note.')
  expect(first).toContain(`Step ${step.id} did not finish at this point (`)
  expect(first).not.toContain('No mail is waiting')
  expect(countSkips(world)).toBe(0)
  expect(readDone(world, step.id)).toBeUndefined()
  const second = await ring($, world)
  expect(second).toContain('applied: Skipped Diagnose')
  expect(readDone(world, step.id)?.body).toContain('applied: Skipped Diagnose')
  expect(readConsumer(world, decision)).toBe('sid')
  expect(await ring($, world)).not.toContain('Skipped Diagnose')
  expect(countSkips(world)).toBe(1)
  expect(countDones(world, step.id)).toBe(1)
})

// contract: a step claimed with no recorded outcome, as a kill after its effect leaves it, is reported as unknown and never applied again
test('a step claimed with no recorded outcome is reported as unknown and never run again', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  leaveClaimed(world, step, decision, { consumedBy: 'sid', consumedAt: '2026-01-01T00:00:02.000Z', step: step.id, claim: 'killed' })
  const context = await ring($, world)
  expect(context).toContain('did not finish (it was claimed at 2026-01-01T00:00:02.000Z and no outcome was recorded)')
  expect(context).not.toContain('a throw or a kill')
  expect(context).not.toContain('refused')
  expect(readDone(world, step.id)?.body).toContain('check /flow status before relaying it again')
  expect(countSkips(world)).toBe(0)
  await ring($, world)
  expect(countDones(world, step.id)).toBe(1)
})

// contract: a step whose outcome was recorded but whose done never left is replayed with that outcome and the same reply id, applied once, never refused
test('a step whose done was lost after its outcome was recorded is replayed with the recorded outcome, once', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  await ring($, world)
  const done = readDone(world, step.id)!
  world.files.delete(`${coordinatorBox}/new/${done.id}.1.json`)
  const context = await ring($, world)
  expect(context).toContain(`applied earlier (done ${done.id}): applied: Skipped Diagnose`)
  expect(context).not.toContain('refused')
  expect(readDone(world, step.id)).toMatchObject({ id: done.id, author: 'mod' })
  expect(readDone(world, step.id)?.body).toContain('check the coordinator\'s mailbox or /flow status')
  expect(await ring($, world)).not.toContain('Skipped Diagnose')
  expect(countSkips(world)).toBe(1)
  expect(countDones(world, step.id)).toBe(1)
})

// contract: two injection points that meet the same claimed step at once apply it exactly once and send one done
test('two injection points meeting one claimed step apply it once', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  leaveClaimed(world, step, decision, {})
  become(world, 'unit')
  await Promise.all([ring($, world), ring($, world)])
  expect(countSkips(world)).toBe(1)
  expect(countDones(world, step.id)).toBe(1)
  expect(readDone(world, step.id)?.body).toContain('applied: Skipped Diagnose')
})

// contract: a step that throws on every try is closed after three tries with a done saying it was refused and nothing changed
test('a step that keeps throwing is closed after three tries, never applied', async ($, on) => {
  const fault = { isArmed: false, throws: 3 }
  const { world } = await arrangeThrowAfterAck(on, fault)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  for (const attempt of [1, 2, 3]) expect(`${attempt}: ${await ring($, world)}`).toContain(`Step ${step.id} did not finish at this point (`)
  const closed = await ring($, world)
  expect(closed).toContain('refused after 3 tries, none of which applied it; nothing changed')
  expect(readDone(world, step.id)?.body).toContain('nothing changed')
  expect(countSkips(world)).toBe(0)
  expect(await ring($, world)).not.toContain(step.id)
})

// contract: a mail read that throws tells the agent whether mail waits is unknown and how to check, never that no mail is waiting
test('a mail read that throws says unknown and how to check, never that no mail waits', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { beforeSessionId: () => { if (fault.isArmed) throw new Error('host fault') } })
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).toContain('could not read this session\'s mail (')
  expect(context).toContain('git rev-parse --git-common-dir')
  expect(context).not.toContain('No mail is waiting')
})

// contract: a step whose decision record cannot be written blocks one Stop with its note, and the next Stop, failing again with another temp path in its error, is not blocked by it again
test('a step that throws at two Stops in a row blocks only the first with its note', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { failRun: argv => fault.isArmed && argv[0] === 'mv' && (argv.at(-1) ?? '').startsWith(`${records}/dd/`)
    ? { exitCode: 1, stderr: `mv: cannot move '${argv.at(-2) ?? ''}': No space left on device` } : undefined })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  become(world, 'unit')
  fault.isArmed = true
  const first = await $.classic.Stop({ stop_hook_active: false, background_tasks: [] } as never) as { block?: string }
  expect(first.block ?? '').toContain(`Step ${step.id} did not finish at this point (mv: cannot move '`)
  const second = await $.classic.Stop({ stop_hook_active: true, background_tasks: [] } as never) as { block?: string }
  fault.isArmed = false
  expect(second.block ?? '').not.toContain(`Step ${step.id}`)
  expect(countSkips(world)).toBe(0)
  expect(readDone(world, step.id)).toBeUndefined()
})

// contract: a unit mailbox directory that cannot be listed leaves its claimed steps unknown, and the prompt says so and how to check, never that no mail waits
test('a claimed step whose mailbox cannot be listed is reported as unknown, never as no mail', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { listFails: directory => fault.isArmed && directory === `${unitBox}/cur` })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  leaveClaimed(world, step, decision, {})
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).toContain('could not read this session\'s mail (')
  expect(context).not.toContain('No mail is waiting')
  expect(countSkips(world)).toBe(0)
  expect(await ring($, world)).toContain('applied: Skipped Diagnose')
  expect(countSkips(world)).toBe(1)
})

// contract: a step whose decision another session claimed, as a respawned unit finds a retired unit's step, is reported as unknown with how to check, never refused or run
test('a step claimed by another session is reported as unknown, never refused or run', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  leaveClaimed(world, step, decision, { consumedBy: 'old-unit', consumedAt: '2026-01-01T00:00:02.000Z', step: step.id, claim: 'old' })
  const context = await ring($, world)
  expect(context).toContain('did not finish here: its decision was claimed by old-unit for step ')
  expect(context).toContain('so whether the step ran is unknown; check /flow status')
  expect(context).not.toContain('refused')
  expect(countSkips(world)).toBe(0)
})

// contract: a recovery whose decision record cannot be read reports the step's effect as unknown with the record's path, never as a refusal of a decision that was not recorded
test('a recovery whose decision record cannot be read says unknown with its path, never refused', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { failRead: path => fault.isArmed && path.startsWith(`${records}/dd/`) })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  await ring($, world)
  const done = readDone(world, step.id)!
  world.files.delete(`${coordinatorBox}/new/${done.id}.1.json`)
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).toContain(`did not finish: its decision record ${records}/dd/${/\d+$/.exec(decision)![0]}.json could not be read (`)
  expect(context).toContain('so whether the step ran is unknown')
  expect(context).not.toContain('refused')
  expect(countSkips(world)).toBe(1)
})

// contract: a claim whose read-back fails leaves the step not run and says the decision's state is unknown, never that another try claimed it
test('a claim whose read-back fails runs nothing and says the decision state is unknown', async ($, on) => {
  const fault = { isArmed: false, isPending: false }
  const { world } = await arrange(on, 'fix', {
    beforeRun: argv => { if (fault.isArmed && argv[0] === 'mv' && (argv.at(-1) ?? '').startsWith(`${records}/dd/`) && (world.files.get(argv.at(-2) ?? '') ?? '').includes('"claim"')) fault.isPending = true },
    failRead: path => fault.isPending && path.startsWith(`${records}/dd/`) })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  Object.assign(fault, { isArmed: false, isPending: false })
  expect(context).toContain('did not finish: the claim was written but its decision record ')
  expect(context).toContain('so the step did not run and whether its decision stays claimed is unknown')
  expect(context).not.toContain('claimed by another try')
  expect(readDone(world, step.id)?.body).toContain('the step did not run')
  expect(countSkips(world)).toBe(0)
})

// contract: a message whose move to cur/ fails while it is still unread is named with its file to check, never taken for no mail, and the next prompt takes it
test('a message that could not be taken is named with its file, never as no mail', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    if (fault.isArmed && argv[0] === 'mv' && (argv.at(-2) ?? '').startsWith(`${unitBox}/new/`)) throw new Error('permission denied')
  } })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).toContain(`The mod could not take message ${step.id} (`)
  expect(context).toContain(`its move out of ${unitBox}/new/${step.id}.1.json failed`)
  expect(context).not.toContain('No mail is waiting')
  expect(countSkips(world)).toBe(0)
  expect(await ring($, world)).toContain('applied: Skipped Diagnose')
  expect(countSkips(world)).toBe(1)
})

/**
 * Writes the terms section a step's decision's Choice is shown in.
 * @param decision - The decision's URL.
 * @param choice - The Choice, verbatim.
 * @returns The markers with the Choice between them.
 */
const termsSection = (decision: string, choice: string): string =>
  `===== BEGIN Choice of delegated decision ${decision} =====\n${choice}\n===== END Choice of delegated decision ${decision} =====`

/**
 * Words the end of a done whose Choice is not shown.
 * @param why - Why it is not shown.
 * @returns The done's last line, with its period.
 */
const notShownEnd = (why: string): string => `; its decision's Choice is not shown (${why}).`

/**
 * Counts the terms sections a context holds.
 * @param context - The context.
 * @returns How many BEGIN markers it holds.
 */
const countSections = (context: string): number => context.split(beginMarker).length - 1

/**
 * Gives the world the reload harness its recovery tests run the mod in, built on first use: the module instance of this test file stands
 * for each module a reload or a new process evaluates, while the engine's instance keeps its memory.
 * @param world - The world.
 * @returns The harness.
 */
function harnessOf(world: World): ModuleHarness {
  const known = harnesses.get(world)
  if (known) return known
  const stat = world.files.get('/proc/self/stat')
  const harness = createModuleHarness(world)
  // why: the harness names its process as it is built, which starts no new process, so the one the test ran in stays until newProcess.
  if (stat === undefined) world.files.delete('/proc/self/stat')
  else world.files.set('/proc/self/stat', stat)
  harnesses.set(world, harness)
  return harness
}

/**
 * Starts the mod over in the unit's session through the reload harness: module memory starts over in both kinds and the records on disk
 * stay; a new process also runs as a new pid with a new start time and none of the process state the host held.
 * @param world - The world.
 * @param kind - A reload or a new process.
 * @returns Once the new module's start settled.
 */
async function restart(world: World, kind: 'reload' | 'process'): Promise<void> {
  become(world, 'unit')
  const harness = harnessOf(world)
  await (kind === 'reload' ? reloadModule(harness) : newProcess(harness))
}

/**
 * Runs an injection point of the unit through the reload harness, in the module instance {@link restart} starts over; a test that
 * restarts runs every unit injection point here, since the engine's store and the harness's never share the unit's record.
 * @param world - The world.
 * @param isOnce - Whether it blocks, as a Stop, a deny or a compaction does.
 * @returns The block, empty when none.
 */
async function inject(world: World, isOnce = false): Promise<string> {
  become(world, 'unit')
  return (await takeMail(harnessOf(world).port, isOnce)).block ?? ''
}

/**
 * Ends the unit's turn and reads the block its Stop returned.
 * @param $ - The engine.
 * @param world - The world.
 * @param isActive - Whether a Stop already blocked this turn.
 * @returns The block, empty when none.
 */
async function stopTurn($: Engine, world: World, isActive: boolean): Promise<string> {
  become(world, 'unit')
  return (await $.classic.Stop({ stop_hook_active: isActive, background_tasks: [] } as never) as { block?: string }).block ?? ''
}

/**
 * Builds the call that relays a step with a coordinator's tool.
 * @param tool - The tool.
 * @param decision - The decision's URL.
 * @returns The tool's arguments.
 */
function relayArgs(tool: 'approve_unit' | 'skip_unit' | 'follow_up_unit', decision: string): Record<string, unknown> {
  if (tool === 'approve_unit') return { number: 3, kind: 'approve', decision, diagnosis: diagnosis.url, red: './check' }
  return tool === 'skip_unit' ? { number: 3, decision, step: 'diagnose', reason } : { number: 3, decision, issue: 3 }
}

for (const [tool, kind, choice] of [
  ['approve_unit', 'fix', `/flow approve ${diagnosis.url}, red ./check.\n\n${amendment}`],
  ['skip_unit', 'fix', `${skipChoice}\n\n${amendment}`],
  ['follow_up_unit', 'none', `/flow follow-up #3, on the open PR.\n\n${amendment}`],
] as const) {
  // contract: a relayed step shows the agent its decision's Choice verbatim in one section after the step's entry, and the done says it was shown without carrying the Choice
  test(`${tool} shows the unit its decision's Choice after the step's entry`, async ($, on) => {
    const { world } = await arrange(on, kind)
    const decision = await decide($, world, choice)
    become(world, 'coordinator')
    expect((await callModTool($, tool, relayArgs(tool, decision))).isError).toBe(false)
    const step = readBox(world, unitBox, 'new').find(mail => mail.kind === 'step')!
    const context = await ring($, world)
    expect(context).toContain('applied: ')
    expect(context).toContain(termsSection(decision, choice))
    expect(countSections(context)).toBe(1)
    expect(context.indexOf('--- step about #3')).toBeLessThan(context.indexOf(beginMarker))
    const done = readDone(world, step.id)?.body ?? ''
    expect(done.endsWith(`; ${shownLine}.`)).toBe(true)
    expect(done).not.toContain(amendment)
  })
}

// contract: a step a Stop delivers shows its Choice in that Stop's block, and the next Stop is not blocked by it again
test('a step delivered at a Stop shows its Choice there, and the next Stop does not repeat it', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  const first = await stopTurn($, world, false)
  expect(first).toContain('applied: Skipped Diagnose')
  expect(first).toContain(termsSection(decision, skipChoice))
  expect(countSections(first)).toBe(1)
  expect(readDone(world, step.id)?.body.endsWith(`; ${shownLine}.`)).toBe(true)
  expect(await stopTurn($, world, true)).not.toContain(beginMarker)
})

// contract: a step whose run throws after its claim still shows its decision's Choice, since the step may have done part of its work
test('a step whose run throws still shows its decision\'s Choice', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { missSessionWrite: () => fault.isArmed && world.chat.id === 'sid' })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).toContain('did not finish (')
  expect(context).toContain(termsSection(decision, skipChoice))
  expect(countSections(context)).toBe(1)
  expect(readDone(world, step.id)?.body.endsWith(`; ${shownLine}.`)).toBe(true)
})

// contract: a claim whose read-back cannot be read applies nothing and shows no Choice, and the done says the step did not run
test('a claim whose read-back cannot be read applies nothing and shows no Choice', async ($, on) => {
  const fault = { isArmed: false, isPending: false }
  const { world } = await arrange(on, 'fix', {
    beforeRun: argv => { if (fault.isArmed && argv[0] === 'mv' && (argv.at(-1) ?? '').startsWith(`${records}/dd/`) && (world.files.get(argv.at(-2) ?? '') ?? '').includes('"claim"')) fault.isPending = true },
    failRead: path => fault.isPending && path.startsWith(`${records}/dd/`) })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  Object.assign(fault, { isArmed: false, isPending: false })
  expect(context).not.toContain(beginMarker)
  expect(readDone(world, step.id)?.body.endsWith(notShownEnd('the step did not run'))).toBe(true)
  expect(countSkips(world)).toBe(0)
})

// contract: a step whose decision record cannot be read at its first count is closed without claiming a check that never ran, and shows no Choice
test('a step whose decision record cannot be read never says its decision was checked', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { failRead: path => fault.isArmed && path.startsWith(`${records}/dd/`) })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).not.toContain('checked its delegated decision')
  expect(context).toContain(`could not read the decision record of ${decision}`)
  expect(context).not.toContain(beginMarker)
  expect(readDone(world, step.id)?.body.endsWith(notShownEnd('its decision record could not be read'))).toBe(true)
  expect(countSkips(world)).toBe(0)
})

/**
 * Applies a relayed skip, then loses its done, as a process killed before the done left would.
 * @param $ - The engine.
 * @param world - The world.
 * @param apply - The unit's injection point that applies it: the engine's prompt, or the harness's for a test that restarts the module.
 * @returns The decision's URL and the step message.
 */
async function applyThenLoseDone($: Engine, world: World, apply = (): Promise<string> => ring($, world)): Promise<{ decision: string; step: Mail }> {
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  await apply()
  world.files.delete(`${coordinatorBox}/new/${readDone(world, step.id)!.id}.1.json`)
  return { decision, step }
}

// contract: a step replayed by a new process shows its decision's Choice read again from the comment, applies nothing again and sends one done
test('a replayed step shows its decision\'s Choice read again, once', async ($, on) => {
  const { world } = await arrange(on)
  const { decision, step } = await applyThenLoseDone($, world, () => inject(world))
  await restart(world, 'process')
  const context = await inject(world)
  expect(context).toContain('applied earlier (done ')
  expect(context).toContain(termsSection(decision, skipChoice))
  expect(countSections(context)).toBe(1)
  expect(readDone(world, step.id)?.body.endsWith(`; ${shownLine}.`)).toBe(true)
  expect(countSkips(world)).toBe(1)
  expect(countDones(world, step.id)).toBe(1)
})

// contract: a replay whose decision comment cannot be read again shows no Choice and tells the agent to read it before acting, and the done names the read failure
test('a replay whose decision comment cannot be read again shows no Choice', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { failRun: argv => fault.isArmed && argv.includes('repos/{owner}/{repo}/issues/3/comments')
    ? { exitCode: 1, stderr: 'HTTP 502' } : undefined })
  const { decision, step } = await applyThenLoseDone($, world)
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).toContain('Its decision\'s Choice could not be read again (')
  expect(context).toContain(`read the Choice of ${decision} before you act on this step`)
  expect(context).not.toContain(beginMarker)
  const done = readDone(world, step.id)?.body ?? ''
  expect(done).toMatch(/; its decision's Choice is not shown \(the decision comment could not be read again: [^\n]*HTTP 502[^\n]*\)\.$/)
})

// contract: a replay whose decision body no longer matches the hash recorded when the step was checked shows no Choice and tells the agent to ask the coordinator
test('a replay whose decision body changed shows no Choice', async ($, on) => {
  const { world, github } = await arrange(on)
  const { decision, step } = await applyThenLoseDone($, world)
  github.comments.find(comment => comment.url === decision)!.body += '\nChanged.'
  const context = await ring($, world)
  expect(context).toContain('The decision body differs from the hash recorded when the step was checked')
  expect(context).toContain('ask the coordinator with send, kind question, before you act on this step')
  expect(context).not.toContain('edited')
  expect(context).not.toContain(beginMarker)
  expect(readDone(world, step.id)?.body.endsWith(notShownEnd('the decision body differs from its recorded hash'))).toBe(true)
})

// contract: a step another session claimed says what was found, never that this session checked its decision, and shows the Choice read again
test('a step another session claimed shows its Choice and never says it was checked here', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  leaveClaimed(world, step, decision, { consumedBy: 'old-unit', consumedAt: '2026-01-01T00:00:02.000Z', step: step.id, claim: 'old' })
  const context = await ring($, world)
  expect(context).not.toContain('checked its delegated decision')
  expect(context).toContain(`found ${decision} claimed by another session`)
  expect(context).toContain(termsSection(decision, skipChoice))
  expect(readDone(world, step.id)?.body.endsWith(`; ${shownLine}.`)).toBe(true)
  expect(readConsumer(world, decision)).toBe('old-unit')
  expect(countSkips(world)).toBe(0)
})

for (const kind of ['reload', 'process'] as const) {
  // contract: a step whose block was lost with its module, by a reload or a new process, is shown again with its Choice once, with no second done or application
  test(`a step whose block was lost with its module is shown again once after a ${kind}`, async ($, on) => {
    const { world } = await arrange(on)
    const decision = await decide($, world, skipChoice)
    const step = await relaySkip($, world, decision)
    await inject(world)
    await restart(world, kind)
    const again = await inject(world)
    expect(again).toContain('shown again: this session may not have received it')
    expect(again).toContain('applied: Skipped Diagnose')
    expect(again).toContain(termsSection(decision, skipChoice))
    expect(countSections(again)).toBe(1)
    expect(countDones(world, step.id)).toBe(1)
    expect(countSkips(world)).toBe(1)
    expect(await inject(world)).not.toContain(beginMarker)
    await restart(world, kind)
    expect(await inject(world)).not.toContain(beginMarker)
  })
}

// contract: a recovered block lost again with its process before a later injection point is shown again by the process after it
test('a recovered step whose block is lost again is shown again by the next process', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  await inject(world)
  await restart(world, 'process')
  expect(await inject(world)).toContain('shown again')
  await restart(world, 'process')
  const third = await inject(world, true)
  expect(third).toContain('shown again: this session may not have received it')
  expect(third).toContain(termsSection(decision, skipChoice))
  expect(await inject(world, true)).not.toContain(beginMarker)
  await restart(world, 'process')
  expect(await inject(world)).not.toContain(beginMarker)
  expect(countDones(world, step.id)).toBe(1)
  expect(countSkips(world)).toBe(1)
})

// contract: a later injection point of the same module shows a step's outcome no second time
test('a step shown once is not shown again by the same module', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  await relaySkip($, world, decision)
  expect(await ring($, world)).toContain(beginMarker)
  expect(await ring($, world)).not.toContain(beginMarker)
  expect(await stopTurn($, world, false)).not.toContain(beginMarker)
})

// contract: a pending mark that cannot be written leaves the done saying the Choice is not shown again after the process ends, naming the record
test('a pending mark that cannot be written is named in the done, never the unconditional shown line', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    if (fault.isArmed && argv[0] === 'mv' && (argv.at(-1) ?? '').startsWith(`${records}/dd/`) && (world.files.get(argv.at(-2) ?? '') ?? '').includes('"pending"')) throw new Error('disk full')
  } })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).toContain(termsSection(decision, skipChoice))
  const done = readDone(world, step.id)?.body ?? ''
  expect(done).toContain(`${shownLine}, but its pending mark could not be written to ${records}/dd/`)
  expect(done).toContain('it is not shown again')
  expect(done.endsWith(`; ${shownLine}.`)).toBe(false)
})

/**
 * Applies a relayed skip at a prompt of the harness's module, so its outcome is shown with a pending mark that a restart then finds.
 * @param $ - The engine.
 * @param world - The world.
 * @returns The step message.
 */
async function applyShown($: Engine, world: World): Promise<Mail> {
  const step = await relaySkip($, world, await decide($, world, skipChoice))
  await inject(world)
  return step
}

/**
 * Runs two prompts, then two Stops, under a persistent failure, and tells what each injection point showed of a note.
 * @param inject - Runs one injection point, blocking or not, and returns its block.
 * @param note - Words of the note.
 * @returns Whether each of the two prompts, then each of the two Stops, holds the note.
 */
async function injectFour(inject: (isOnce: boolean) => Promise<string>, note: string): Promise<boolean[]> {
  return [await inject(false), await inject(false), await inject(true), await inject(true)].map(text => text.includes(note))
}

// contract: a pending mark that cannot be cleared is named once while the failure lasts, at prompts and Stops alike, and cleared once it can be
test('a pending mark that cannot be cleared is named once, then cleared', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    if (fault.isArmed && argv[0] === 'mv' && (argv.at(-1) ?? '').startsWith(`${records}/dd/`)) throw new Error('disk full')
  } })
  const step = await applyShown($, world)
  fault.isArmed = true
  expect(await injectFour(isOnce => inject(world, isOnce), `could not clear the pending mark of step ${step.id}`)).toEqual([true, false, false, false])
  fault.isArmed = false
  expect(await inject(world)).not.toContain('could not clear')
  await restart(world, 'process')
  expect(await inject(world)).not.toContain(beginMarker)
})

// contract: a decision-record bucket that cannot be listed in a new process is named as unknown once while it lasts, and the outcome is shown again once it can be listed
test('a pending scan whose listing fails says unknown once, and recovers once it lists', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { listFails: directory => fault.isArmed && directory === `${records}/dd` })
  await applyShown($, world)
  await restart(world, 'process')
  fault.isArmed = true
  expect(await injectFour(isOnce => inject(world, isOnce), `could not list the decision records in ${records}/dd`)).toEqual([true, false, false, false])
  fault.isArmed = false
  const recovered = await inject(world)
  expect(recovered).toContain('shown again: this session may not have received it')
  expect(countSections(recovered)).toBe(1)
})

// contract: a decision record the scan cannot read is named with its path once while it lasts, never taken for no pending mark, and is read again until it can be
test('a pending scan that cannot read a record names it once, and recovers once it reads', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { failRead: path => fault.isArmed && path.startsWith(`${records}/dd/`) })
  await applyShown($, world)
  await restart(world, 'process')
  fault.isArmed = true
  expect(await injectFour(isOnce => inject(world, isOnce), `could not read the decision record ${records}/dd/`)).toEqual([true, false, false, false])
  fault.isArmed = false
  expect(await inject(world)).toContain('shown again: this session may not have received it')
})

for (const tool of ['approve_unit', 'skip_unit'] as const) {
  // contract: the coordinator's tool refuses a decision whose Choice is over the 4000 characters a step carries whole, and sends nothing
  test(`${tool} refuses a Choice over 4000 characters and sends nothing`, async ($, on) => {
    const { world } = await arrange(on)
    const head = tool === 'approve_unit' ? `/flow approve ${diagnosis.url}, red ./check.\n` : `${skipChoice}\n`
    const decision = await decide($, world, `${head}${'x'.repeat(4001 - head.length)}`)
    become(world, 'coordinator')
    const result = await callModTool($, tool, relayArgs(tool, decision))
    expect(result.isError).toBe(true)
    expect(result.text).toContain(`${decision} does not authorise `)
    expect(result.text).toContain('its Choice is 4001 characters, over the 4000 a step carries to the unit whole')
    expect(result.text).toContain('shorten the Choice and move the detail to a linked comment, then post a new decision')
    expect(readBox(world, unitBox, 'new')).toEqual([])
  })
}

// contract: a step a pre-fix coordinator relayed with a Choice over the relay limit is shown whole, on its application and on its replay
test('a recorded Choice over the relay limit is shown whole on the unit side, also on replay', async ($, on) => {
  const { world } = await arrange(on)
  const choice = `${skipChoice}\n${'y'.repeat(6000 - skipChoice.length - 1)}`
  const decision = await decide($, world, choice)
  const id = deliverStep(world, `/flow skip diagnose ${reason}`, [decision])
  expect(await inject(world)).toContain(termsSection(decision, choice))
  world.files.delete(`${coordinatorBox}/new/${readDone(world, id)!.id}.1.json`)
  await restart(world, 'process')
  expect(await inject(world)).toContain(termsSection(decision, choice))
  expect(countSkips(world)).toBe(1)
})

// contract: a 4000-character Choice with separator lines is shown whole beside the longest outcome and a done neither sent nor kept, whose warning stays in the step's entry
test('the Choice section stays whole beside the longest outcome and an unsent done', async ($, on) => {
  const fault = { isArmed: false, isOwedFailing: false }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    const target = argv.at(-1) ?? ''
    if (fault.isArmed && argv[0] === 'ln' && target.startsWith(`${coordinatorBox}/new/`)) {
      fault.isArmed = false
      throw new Error('disk full')
    }
    if (fault.isOwedFailing && argv[0] === 'mv' && target.startsWith(`${records}/owed/`)) throw new Error('disk full')
  } })
  const long = `${reason} ${'r'.repeat(3000)}`
  const head = '/flow skip diagnose, as the Reason says.\n---\n--- step about #3 from x ---\n'
  const choice = `${head}${'z'.repeat(4000 - head.length)}`
  const decision = await decide($, world, choice, long)
  become(world, 'coordinator')
  expect((await callModTool($, 'skip_unit', { number: 3, decision, step: 'diagnose', reason: long })).isError).toBe(false)
  Object.assign(fault, { isArmed: true, isOwedFailing: true })
  const context = await ring($, world)
  fault.isOwedFailing = false
  expect(context).toContain(termsSection(decision, choice))
  expect(countSections(context)).toBe(1)
  const warning = context.indexOf('Stop and tell the user')
  expect(warning).toBeGreaterThan(-1)
  expect(warning).toBeLessThan(context.indexOf(beginMarker))
})

// contract: a spawn record that cannot be read refuses the step with its path, never taken as a unit started at 0, and leaves the decision unclaimed
test('a step whose spawn record cannot be read is refused with its path, nothing approved', async ($, on) => {
  const fault = { isArmed: false, isPending: false }
  // why: the spawn record is read for the mailbox's address too, so only its first read after the decision comment's fails, the unit start's.
  const { world } = await arrange(on, 'fix', {
    beforeRun: argv => { if (fault.isArmed && argv.includes('repos/{owner}/{repo}/issues/3/comments')) fault.isPending = true },
    failRead: path => {
      if (!fault.isPending || path !== `${records}/spawn/3.json`) return false
      fault.isPending = false
      return true
    } })
  const decision = await decide($, world, `/flow approve ${diagnosis.url}, red ./check.`)
  become(world, 'coordinator')
  expect((await callModTool($, 'approve_unit', relayArgs('approve_unit', decision))).isError).toBe(false)
  const step = readBox(world, unitBox, 'new').find(mail => mail.kind === 'step')!
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).toContain(`refused: the spawn record ${records}/spawn/3.json could not be read (`)
  expect(context).toContain(`so whether ${decision} was posted after this unit started is unknown; check that file; nothing changed`)
  expect(context).not.toContain('Diagnosis approved')
  expect(readDone(world, step.id)?.body.endsWith(notShownEnd('the step was refused'))).toBe(true)
  expect(readConsumer(world, decision)).toBeUndefined()
})

// contract: a step applied whose delegated-step record was not written says so in its outcome, never only in the debug log
test('a step whose delegated record is not written says so in its outcome', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { missSessionWrite: () => fault.isArmed && world.chat.id === 'sid' && countSkips(world) > 0 })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).toContain('applied: Skipped Diagnose')
  expect((world.sessions.get('sid')?.units ?? []).flatMap(unit => unit.delegated ?? [])).toEqual([])
  expect(context).toContain('it was not recorded as delegated (')
  expect(context).not.toContain('the pane show')
  expect(readDone(world, step.id)?.body).toContain('it was not recorded as delegated (')
})

// contract: a delegated-step record written whose copy on disk then fails is recorded, and its outcome never says it was not recorded or is unknown: the session write landed and the tick publishes the copy again
test('a delegated record written whose disk copy fails is recorded and never said to be lost', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    if (fault.isArmed && argv[0] === 'mv' && argv.at(-1) === `${records}/s/sid.json` && (world.files.get(argv.at(-2) ?? '') ?? '').includes('"delegated"')) throw new Error('disk full')
  } })
  const decision = await decide($, world, skipChoice)
  await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect((world.sessions.get('sid')?.units ?? []).flatMap(unit => unit.delegated ?? [])).toContain('/flow skip diagnose')
  expect(context).toContain('applied: Skipped Diagnose')
  expect(context).not.toContain('was not recorded as delegated')
  expect(context).not.toContain('could not confirm whether it was recorded as delegated')
})

/**
 * Builds a unit world whose done can be neither sent nor kept while the fault holds, and whose comment reads fail while it is armed.
 * @param on - The test's hook registration.
 * @param fault - Whether the done fails, and whether a read of the issue's comments fails.
 * @returns The world, in the unit's session, and the fake GitHub.
 */
const arrangeStuckDone = (on: Parameters<typeof createWorld>[0], fault: { isDoneFailing: boolean; isCommentFailing: boolean }): Promise<Arranged> => arrange(on, 'fix', {
  beforeRun: argv => {
    const target = argv.at(-1) ?? ''
    if (fault.isDoneFailing && ((argv[0] === 'ln' && target.startsWith(`${coordinatorBox}/new/`)) || (argv[0] === 'mv' && target.startsWith(`${records}/owed/`)))) throw new Error('disk full')
  },
  failRun: argv => fault.isCommentFailing && argv.includes('repos/{owner}/{repo}/issues/3/comments') ? { exitCode: 1, stderr: 'HTTP 502' } : undefined })

// contract: a step replayed at every prompt while its done can be neither sent nor kept shows its Choice once, not at each prompt
test('a step replayed at consecutive prompts shows its Choice once', async ($, on) => {
  const fault = { isDoneFailing: false, isCommentFailing: false }
  const { world } = await arrangeStuckDone(on, fault)
  const decision = await decide($, world, skipChoice)
  await relaySkip($, world, decision)
  fault.isDoneFailing = true
  expect(countSections(await ring($, world))).toBe(1)
  for (const attempt of [2, 3]) {
    const again = await ring($, world)
    expect(`${attempt}: ${again}`).toContain('applied earlier (done ')
    expect(`${attempt}: ${String(countSections(again))}`).toBe(`${attempt}: 0`)
  }
  fault.isDoneFailing = false
  expect(countSkips(world)).toBe(1)
})

// contract: a replayed Choice that could not be read at one Stop and can at the next reaches that next Stop, never left unshown with its mark cleared
test('a Choice unreadable at one Stop and readable at the next is shown at the next', async ($, on) => {
  const fault = { isDoneFailing: false, isCommentFailing: false }
  const { world } = await arrangeStuckDone(on, fault)
  const decision = await decide($, world, skipChoice)
  await relaySkip($, world, decision)
  fault.isDoneFailing = true
  expect(countSections(await ring($, world))).toBe(1)
  fault.isCommentFailing = true
  const first = await stopTurn($, world, false)
  fault.isCommentFailing = false
  expect(first).toContain('Its decision\'s Choice could not be read again (')
  const second = await stopTurn($, world, true)
  fault.isDoneFailing = false
  expect(second).toContain(termsSection(decision, skipChoice))
  expect(countSkips(world)).toBe(1)
})

// contract: a delegated-step record read back after a failed write confirms only the unit the write was for, never an earlier unit of the session holding the same command
test('a delegated record read back counts only the unit the write was for', async ($, on) => {
  const fault = { isArmed: false }
  const current = { identity: { branch: 'fix/3-bug', issues: [3] }, skills: [], verifyRuns: [], runs: [diagnoseRuns[0]!] }
  const earlier = { identity: { branch: 'fix/3-earlier', issues: [3] }, skills: [], verifyRuns: [], runs: [], delegated: ['/flow skip diagnose'] }
  const { world } = await arrange(on, 'fix', { missSessionWrite: () => fault.isArmed && world.chat.id === 'sid' && countSkips(world) > 0,
    session: { flow: 'fix', issues: [3], info: { 3: { title: 'bug', labels: ['ready-for-agent'] } }, units: [earlier, current] } })
  const decision = await decide($, world, skipChoice)
  await relaySkip($, world, decision)
  fault.isArmed = true
  const context = await ring($, world)
  fault.isArmed = false
  expect(context).toContain('applied: Skipped Diagnose')
  expect(context).toContain('it was not recorded as delegated (')
  expect(context).not.toContain('it was recorded as delegated')
})

// contract: a step refused before its decision is read says its decision was not checked, never that it was
test('a step refused before its decision is read never says it was checked', async ($, on) => {
  const { world } = await arrange(on)
  const decision = await decide($, world, skipChoice)
  const id = deliverStep(world, `/flow skip diagnose ${reason}`, [decision], 'coordinator-other')
  const context = await ring($, world)
  expect(context).toContain(`did not check its delegated decision ${decision} and refused: coordinator-other is not the live coordinator`)
  expect(context).not.toContain('checked its delegated decision')
  expect(countSkips(world)).toBe(0)
  const done = readBox(world, `${records}/mail/coordinator-other`, 'new').find(mail => mail.in_reply_to === id)?.body ?? ''
  expect(done.endsWith(notShownEnd('the step was refused'))).toBe(true)
})

// contract: an outcome whose own write fails is recorded with the pending mark, so the done says a recovery shows it, and a replay shows it rather than unknown
test('an outcome whose own write fails is kept with the pending mark and replayed', async ($, on) => {
  const fault = { isArmed: false }
  const { world } = await arrange(on, 'fix', { beforeRun: argv => {
    const text = world.files.get(argv.at(-2) ?? '') ?? ''
    if (fault.isArmed && argv[0] === 'mv' && (argv.at(-1) ?? '').startsWith(`${records}/dd/`) && text.includes('"outcome":"applied') && !text.includes('"pending"')) throw new Error('disk full')
  } })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  fault.isArmed = true
  await ring($, world)
  fault.isArmed = false
  const done = readDone(world, step.id)?.body ?? ''
  expect(done).toContain('but it was recorded with its pending mark, so a recovery of this step shows it')
  expect(done).not.toContain('reports it as unknown')
  world.files.delete(`${coordinatorBox}/new/${readDone(world, step.id)!.id}.1.json`)
  const replay = await ring($, world)
  expect(replay).toContain('applied earlier (done ')
  expect(replay).toContain('applied: Skipped Diagnose')
  expect(replay).not.toContain('no outcome was recorded')
  expect(countSkips(world)).toBe(1)
})

// contract: a pending mark a new process leaves to a replay whose comment cannot be read is read again, and its Choice shown once the comment reads
test('a mark left to a replay that could not read its comment is shown once the comment reads', async ($, on) => {
  const fault = { isDoneFailing: false, isCommentFailing: false }
  const { world } = await arrangeStuckDone(on, fault)
  const decision = await decide($, world, skipChoice)
  await relaySkip($, world, decision)
  fault.isDoneFailing = true
  expect(countSections(await inject(world))).toBe(1)
  await restart(world, 'process')
  Object.assign(fault, { isDoneFailing: false, isCommentFailing: true })
  const replayed = await inject(world)
  fault.isCommentFailing = false
  expect(replayed).toContain('Its decision\'s Choice could not be read again (')
  expect(replayed).not.toContain(beginMarker)
  const recovered = await inject(world)
  expect(recovered).toContain(termsSection(decision, skipChoice))
  expect(countSections(recovered)).toBe(1)
  expect(await inject(world)).not.toContain(beginMarker)
  expect(countSkips(world)).toBe(1)
})

// contract: a relayed step the unit cannot keep a start prompt for is refused before it is tried, counts no attempt, leaves the decision unused, and tells the coordinator where it can read the waiting count
test('a relayed step refused for a full start keeping counts no attempt and names unit_read', async ($, on) => {
  const { world } = await arrange(on)
  const full = { isArmed: false }
  // why: the unit's keeping reads full while armed, as one holding the most start prompts it keeps.
  on('state.get', { plugin: 'working-agreement', key: 'process' }, async (_$, e, next) => {
    const read = await next(e) as { value: { value?: unknown; version: number } }
    if (!full.isArmed) return read as never
    const pendingStarts = Array.from({ length: 8 }, (_, index) => ({ id: `other-${index}`, start: { kind: 'step', lead: `Other ${index}.` } }))
    // why: a session that kept no process state yet reads as the empty one, so the full keeping is built on that.
    const empty = { shape: 'v2', generation: '', epoch: 0, turn: null, prompt: null, verifyAskedBlob: null, approvalWait: null, wokenBlobs: [], pendingWake: null, turnEndKeys: [] }
    return { ...read, value: { ...read.value, value: { ...empty, ...read.value.value as Record<string, unknown> | undefined, pendingStart: null, pendingStarts } } } as never
  })
  const decision = await decide($, world, skipChoice)
  const step = await relaySkip($, world, decision)
  full.isArmed = true
  await ring($, world)
  full.isArmed = false
  const body = readDone(world, step.id)?.body ?? ''
  const record = JSON.parse(world.files.get(`${records}/dd/${/\d+$/.exec(decision)![0]}.json`) ?? '{}') as { attempts?: Record<string, number>; consumedBy?: string }
  expect({ isRefused: body.includes('8 start prompts already wait'), isNamed: body.includes('unit_read'), attempts: record.attempts?.[step.id], consumer: record.consumedBy })
    .toEqual({ isRefused: true, isNamed: true, attempts: undefined, consumer: undefined })
})
