import type { PromptOrigin } from 'claude-code'
import { expect } from 'claude-code/testing'
import { test } from '../support/kit'
import { approvalCommand, coordinator, diagnoseRuns, diagnosisComment, guarded, noFlow, trivialFlow, verifyFile, verifyId } from '../support/builders'
import { enterOwnPrompt, readCurrentStep, runFlowCommand, startSession } from '../support/helpers'
import { createWorld, records, root, scopeFile } from '../support/world'

const userOnly = ['trivial', 'follow-up #1', 'handoff', 'skip code reviewed']
test('the user-only /flow subcommands are refused unless typed at the prompt', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  for (const args of userOnly) {
    const result = await runFlowCommand($, args, { kind: 'plugin', name: 'working-agreement' })
    expect(result.text, args).toContain("is the user's to run at the local terminal")
  }
})

const logs = `${records}/log/`
const agentOrigins: PromptOrigin[] = [{ kind: 'peer' }, { kind: 'peer-send-message' }, { kind: 'projects-relay' }, { kind: 'coordinator' },
  { kind: 'channel', server: 'slack' }, { kind: 'plugin', name: 'other' }, { kind: 'sdk' }, { kind: 'scheduled-trigger' }, { kind: 'task-notification' },
  { kind: 'observer' }, { kind: 'unclassified' } as PromptOrigin]

for (const allowRemoteCommands of [false, undefined] as const) {
  // contract: with allowRemoteCommands off or unset, a Remote Control /flow delegate is refused with the Remote Control reason
  test(`a bridge /flow delegate is refused while allowRemoteCommands is ${String(allowRemoteCommands)}`, async ($, on) => {
    createWorld(on, { branch: 'feat' }, { allowRemoteCommands })
    const { text } = await runFlowCommand($, 'delegate #4', { kind: 'bridge' })
    expect(text).toContain('/flow delegate arrived through Remote Control, which is off: run it at the local terminal, or enable working-agreement.allowRemoteCommands there.')
  })
}

// contract: when allowRemoteCommands cannot be read, a Remote Control command is refused as off, and the refusal says the read failed
test('a bridge /flow delegate is refused, naming the failed read, while allowRemoteCommands is unreadable', async ($, on) => {
  createWorld(on, { branch: 'feat' }, { allowRemoteCommands: 'unreadable' })
  const { text } = await runFlowCommand($, 'delegate #4', { kind: 'bridge' })
  expect(text).toContain('/flow delegate arrived through Remote Control: working-agreement.allowRemoteCommands could not be read, so it counts as off.')
})

// contract: with allowRemoteCommands on, a Remote Control /flow delegate in a coordinator session changes the scope and says it came through Remote Control
test('a bridge /flow delegate is accepted in a coordinator session while allowRemoteCommands is on', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: coordinator, ...guarded(), allowRemoteCommands: true })
  const { text } = await runFlowCommand($, 'delegate #4', { kind: 'bridge' })
  expect(text).toContain('Delegating #4')
  expect(text).toEndWith('(via Remote Control)')
  expect(JSON.parse(world.files.get(scopeFile('sid')) ?? '{}')).toMatchObject({ issues: [4] })
})

// contract: with allowRemoteCommands on, a human-only /flow command through Remote Control runs, says so in its answer and is logged as origin bridge
test('a bridge /flow trivial is accepted while allowRemoteCommands is on', async ($, on) => {
  const { files, clock } = createWorld(on, { branch: 'feature' }, { session: noFlow, allowRemoteCommands: true })
  const { text } = await runFlowCommand($, 'trivial', { kind: 'bridge' })
  expect(text).toContain('Flow declared: Trivial change')
  expect(text).toContain('(via Remote Control)')
  await clock.settle()
  const logged = [...files.entries()].filter(([path]) => path.startsWith(logs)).flatMap(([, body]) => body.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>))
  expect(logged.filter(line => line.event === 'remote-command')).toEqual([expect.objectContaining({ command: '/flow trivial', origin: 'bridge' })])
})

const settingChange = { key: 'working-agreement.allowRemoteCommands', provider: { plugin: 'working-agreement', tier: 'user' } } as const

// contract: allowRemoteCommands changes only from the local terminal's /config; a Remote Control or plugin change is refused either way
test('a change to allowRemoteCommands from Remote Control or a plugin is refused, and from the terminal accepted', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  on('config.set', (_$, e) => ({ value: e.value }))
  for (const value of [true, false]) {
    for (const origin of [{ kind: 'bridge' }, { kind: 'plugin', name: 'other' }] as const) {
      const { deny } = await $.config.set({ ...settingChange, value, previous: !value, origin })
      expect(deny, `${origin.kind} → ${String(value)}`).toContain('working-agreement.allowRemoteCommands changes only at the local terminal')
    }
    expect(await $.config.set({ ...settingChange, value, previous: !value, origin: { kind: 'composer' } })).toEqual({ value })
  }
})

for (const allowRemoteCommands of [false, true]) {
  // contract: an agent or relay origin is refused a human-only /flow command whatever allowRemoteCommands holds, and the refusal names it
  test(`agent origins are refused human-only /flow commands while allowRemoteCommands is ${String(allowRemoteCommands)}`, async ($, on) => {
    createWorld(on, { branch: 'feature' }, { session: noFlow, allowRemoteCommands })
    for (const origin of agentOrigins) {
      const { text } = await runFlowCommand($, 'delegate #4', origin)
      expect(text, origin.kind).toContain(`/flow delegate is the user's to run at the local terminal; it arrived from origin ${origin.kind}`)
    }
  })
}

test('/flow registration names every handler subcommand', async ($, on) => {
  const { registeredCommands } = createWorld(on, { branch: 'feat' })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  const flow = registeredCommands.find(command => command.name === 'flow')
  for (const subcommand of ['status', 'handoff', 'trivial', 'follow-up', 'skip', 'approve']) {
    expect(flow?.description).toContain(subcommand)
    expect(flow?.argumentHint).toContain(subcommand)
  }
})

const closing = { number: 5, state: 'OPEN', headRefName: 'feature', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }

const startTail = ' Start the current step.'

for (const [args, lead] of [['follow-up #1', 'Flow declared: Follow-up for #1.'], ['trivial', 'Flow declared: Trivial change.']] as const) {
  test(`a successful /flow ${args} starts the current step after its reply, carrying the flow line`, async ($, on) => {
    const { clock, prompts } = createWorld(on, { branch: 'feature' }, { session: noFlow, closingPrs: { 1: [closing] } })
    await startSession($)
    expect((await runFlowCommand($, args)).text).toContain('Flow declared')
    expect(prompts).toEqual([])
    await clock.settle()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toBe(`${lead}${startTail}`)
    expect(await enterOwnPrompt($, prompts[0]!)).toContain('current step: Code')
  })
}

test('a prompt that already carries the flow line is not given it again', async ($, on) => {
  const { clock } = createWorld(on, { branch: 'feature' }, { session: noFlow })
  await runFlowCommand($, 'trivial')
  await clock.settle()
  const line = (await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })).context?.find(each => each.includes('current step: Code')) ?? ''
  expect(line).toStartWith('[working-agreement] ')
  expect((await $.prompt.submit({ text: `Pasted: ${line}`, wait: false, origin: { kind: 'composer' } })).context ?? []).not.toContain(line)
})

test('a failed start prompt leaves the declaration standing and is logged to debug', async ($, on) => {
  const { clock, logs } = createWorld(on, { branch: 'feature' }, {
    session: noFlow, beforePromptSubmit: text => { if (text.startsWith('Flow declared')) throw new Error('prompt failed') },
  })
  await startSession($)
  expect((await runFlowCommand($, 'trivial')).text).toContain('Flow declared: Trivial change')
  await clock.settle()
  expect(logs.some(log => log.to === 'debug' && log.text.includes('start prompt failed'))).toBe(true)
  expect(await readCurrentStep($)).toBe('Code')
})

for (const args of ['follow-up #1', 'follow-up', '', 'status', 'skip code reviewed', 'approve verify']) {
  test(`/flow ${args || '(bare)'} without a flow submits no prompt`, async ($, on) => {
    const { clock, prompts } = createWorld(on, { branch: 'feature' }, { session: noFlow, closingPrs: { 1: [] } })
    await startSession($)
    await runFlowCommand($, args)
    await clock.settle()
    expect(prompts).toEqual([])
  })
}

for (const args of ['skip absent why', 'skip code', 'approve verify', 'approve verify 0000000', 'approve diagnose', `approve ${diagnosisComment.url}`, '', 'status']) {
  test(`/flow ${args || '(bare)'} on a declared unit, refused or only informative, submits no prompt`, async ($, on) => {
    const { clock, prompts } = createWorld(on, { branch: 'feat' }, { session: trivialFlow(), verifyFile })
    await startSession($)
    await runFlowCommand($, args)
    await clock.settle()
    expect(prompts).toEqual([])
  })
}

test('a successful /flow skip starts the new current step after its reply', async ($, on) => {
  const { clock, prompts } = createWorld(on, { branch: 'feat' }, { session: trivialFlow(), verifyFile })
  await startSession($)
  expect((await runFlowCommand($, 'skip code reviewed elsewhere')).text).toBe('Skipped Code: reviewed elsewhere')
  expect(prompts).toEqual([])
  await clock.settle()
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toBe(`Skipped Code: reviewed elsewhere.${startTail}`)
  expect(await enterOwnPrompt($, prompts[0]!)).toContain('current step: Verify')
})

test('a successful /flow approve starts the new current step after its reply', async ($, on) => {
  const { clock, prompts } = createWorld(on, { branch: 'fix' }, {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
    unit: { runs: [diagnoseRuns[0]!] }, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
  })
  await startSession($)
  expect((await runFlowCommand($, `approve ${diagnosisComment.url}`)).text).toContain('Diagnosis approved')
  expect(prompts).toEqual([])
  await clock.settle()
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toBe(`Diagnosis approved: ${diagnosisComment.url}; pinned red: \`./check\`.${startTail}`)
  expect(await enterOwnPrompt($, prompts[0]!)).toContain('current step: Code')
})

test('/flow approve verify with the current id approves nothing and starts no step', async ($, on) => {
  const id = verifyId()
  const { clock, prompts, files } = createWorld(on, { branch: 'feat', isDirty: true, changed: ['src/a.ts'], tree: 'tree' }, { session: trivialFlow(), verifyFile })
  await startSession($)
  expect((await runFlowCommand($, `approve verify ${id}`)).text).toContain(approvalCommand())
  await clock.settle()
  expect(prompts).toEqual([])
  expect([...files.keys()].some(path => path.startsWith(`${records}/ok/`))).toBe(false)
})
