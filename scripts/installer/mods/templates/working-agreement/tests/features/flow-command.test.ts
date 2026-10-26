import { expect, test } from 'claude-code/testing'
import { diagnoseRuns, diagnosisComment, noFlow, verifyFile } from '../support/builders'
import { readCurrentStep, runFlowCommand } from '../support/helpers'
import { configBlob, createWorld, root } from '../support/world'

const userOnly = ['trivial', 'follow-up #1', 'handoff', 'skip code reviewed']
test('the user-only /flow subcommands are refused unless typed at the prompt', async ($, on) => {
  createWorld(on, { branch: 'feat' })
  for (const args of userOnly) {
    const result = await runFlowCommand($, args, { kind: 'plugin', name: 'working-agreement' })
    expect(result.text, args).toContain("is the user's to run from the prompt")
  }
})

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

for (const [args, start] of [['follow-up #1', 'Flow declared: Follow-up for #1. Start the current step (Code) from the issue.'], ['trivial', 'Flow declared: Trivial change. Start the current step (Code).']] as const) {
  test(`a successful /flow ${args} starts the current step after its reply, carrying the flow line`, async ($, on) => {
    const { clock, prompts } = createWorld(on, { branch: 'feature' }, { session: noFlow, closingPrs: { 1: [closing] } })
    expect((await runFlowCommand($, args)).text).toContain('Flow declared')
    expect(prompts).toEqual([])
    await clock.settle()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toStartWith(`${start} [working-agreement] `)
    expect(prompts[0]).toContain('current step: Code')
  })
}

test('a prompt that already carries the flow line is not given it again', async ($, on) => {
  const { clock, prompts } = createWorld(on, { branch: 'feature' }, { session: noFlow })
  await runFlowCommand($, 'trivial')
  await clock.settle()
  const start = prompts[0] ?? ''
  const line = start.slice(start.indexOf('[working-agreement] '))
  expect((await $.prompt.submit({ text: start, wait: false, origin: { kind: 'composer' } })).context ?? []).not.toContain(line)
  expect((await $.prompt.submit({ text: 'go', wait: false, origin: { kind: 'composer' } })).context).toContain(line)
})

test('a failed start prompt leaves the declaration standing and is logged to debug', async ($, on) => {
  const { clock, logs } = createWorld(on, { branch: 'feature' }, {
    session: noFlow, beforePromptSubmit: text => { if (text.startsWith('Flow declared')) throw new Error('prompt failed') },
  })
  expect((await runFlowCommand($, 'trivial')).text).toContain('Flow declared: Trivial change')
  await clock.settle()
  expect(logs.some(log => log.to === 'debug' && log.text.includes('start prompt failed'))).toBe(true)
  expect(await readCurrentStep($)).toBe('Code')
})

for (const args of ['follow-up #1', 'follow-up', '', 'status', 'skip code reviewed', 'approve verify']) {
  test(`/flow ${args || '(bare)'} without a flow submits no prompt`, async ($, on) => {
    const { clock, prompts } = createWorld(on, { branch: 'feature' }, { session: noFlow, closingPrs: { 1: [] } })
    await runFlowCommand($, args)
    await clock.settle()
    expect(prompts).toEqual([])
  })
}

for (const args of ['skip absent why', 'skip code', 'approve verify', 'approve verify 0000000', 'approve diagnose', `approve ${diagnosisComment.url}`, '', 'status']) {
  test(`/flow ${args || '(bare)'} on a declared unit, refused or only informative, submits no prompt`, async ($, on) => {
    const { clock, prompts } = createWorld(on, { branch: 'feat' }, { session: { flow: 'trivial', issues: [], info: {} }, verifyFile })
    await runFlowCommand($, args)
    await clock.settle()
    expect(prompts).toEqual([])
  })
}

test('a successful /flow skip starts the new current step after its reply', async ($, on) => {
  const { clock, prompts } = createWorld(on, { branch: 'feat' }, { session: { flow: 'trivial', issues: [], info: {} }, verifyFile })
  expect((await runFlowCommand($, 'skip code reviewed elsewhere')).text).toBe('Skipped Code: reviewed elsewhere')
  expect(prompts).toEqual([])
  await clock.settle()
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toStartWith('Skipped Code: reviewed elsewhere. Start the current step (Verify). [working-agreement] ')
  expect(prompts[0]).toContain('current step: Verify')
})

test('a successful /flow approve starts the new current step after its reply', async ($, on) => {
  const { clock, prompts } = createWorld(on, { branch: 'fix' }, {
    session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
    unit: { runs: [diagnoseRuns[0]!] }, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
  })
  expect((await runFlowCommand($, `approve ${diagnosisComment.url}`)).text).toContain('Diagnosis approved')
  expect(prompts).toEqual([])
  await clock.settle()
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toStartWith(`Diagnosis approved: ${diagnosisComment.url}. Start the current step (Code) from the issue. [working-agreement] `)
  expect(prompts[0]).toContain('current step: Code')
})

test('a successful /flow approve verify <id> starts the current step after its reply', async ($, on) => {
  const id = configBlob(verifyFile).slice(0, 12)
  const { clock, prompts } = createWorld(on, { branch: 'feat', isDirty: true, changed: ['src/a.ts'], tree: 'tree' }, { session: { flow: 'trivial', issues: [], info: {} }, verifyFile })
  expect((await runFlowCommand($, `approve verify ${id}`)).text).toBe(`Verify config ${id} approved.`)
  expect(prompts).toEqual([])
  await clock.settle()
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toStartWith(`Verify config ${id} approved. Start the current step (Verify). [working-agreement] `)
})
