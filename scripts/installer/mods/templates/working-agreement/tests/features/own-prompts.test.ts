import { expect } from 'claude-code/testing'
import { test } from '../support/kit'
import { diagnoseRuns, diagnosisComment, verifyFile } from '../support/builders'
import { declareFlow, enterOwnPrompt as enter, runFlowCommand, startSession } from '../support/helpers'
import { createWorld, linearGraph, markSpawned, records } from '../support/world'
import type { Checkout, Options } from '../support/world'

const url = diagnosisComment.url
const doorbell = '[working-agreement] Checking this session\'s mailbox; any mail comes with this prompt.'
const noMail = '[working-agreement] No mail is waiting'
const unitOptions = (): Options => ({
  session: { flow: 'fix', info: { 1: { title: 'bug', labels: ['ready-for-agent'] } } },
  unit: { runs: [diagnoseRuns[0]!] }, comments: { 1: [diagnosisComment] }, issueLabels: { 1: ['ready-for-agent'] },
})

// contract: a mod start prompt that queued behind a busy turn enters naming the step the unit is at on entry
test('an approval start prompt entering after the fix green names the step at entry', async ($, on) => {
  const graph = linearGraph({ feat: 0 }, verifyFile, 1)
  const git: Checkout = { branch: 'feat', graph }
  const setup: Options = { session: { flow: 'fix', info: {} }, verifyFile, approvedConfig: verifyFile, issueLabels: { 1: ['ready-for-agent'] } }
  const { clock, prompts } = createWorld(on, git, setup)
  await startSession($)
  await declareFlow($, 'fix', [1])
  git.dirty = { 'test/a.test.ts': 'red' }
  setup.spawnCode = 1
  await $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./check'] })
  await clock.advance(1)
  setup.comments = { 1: [{ ...diagnosisComment, createdAt: new Date(clock.now() + 1).toISOString() }] }
  await runFlowCommand($, `approve ${url}`)
  await clock.settle()
  const queued = prompts.at(-1)!
  await clock.advance(10)
  git.dirty = { 'test/a.test.ts': 'green', 'src/a.ts': 'tree' }
  setup.spawnCode = 0
  await $.tool.call({ tool: 'mcp__working-agreement__run', argv: ['./check'] })
  expect(queued).toStartWith(`Diagnosis approved: ${url}; pinned red: \`./check\`.`)
  expect(queued).not.toContain('resume the diagnosing-bugs skill at Phase 5')
  const context = await enter($, queued)
  expect(context).toContain('call the verify tool on this tree')
  expect(context).not.toContain('resume the diagnosing-bugs skill at Phase 5')
})

// contract: the mod's doorbell enters carrying the flow line, as a typed prompt does
test('a doorbell carrying mail enters with the flow line', async ($, on) => {
  const world = createWorld(on, { branch: 'fix' }, unitOptions())
  markSpawned(world, [1])
  const envelope = { v: 1, id: 'q-1-re-user', kind: 'answer', from: 'user', to: '1', issue: 1, in_reply_to: 'q-1', seq: 1,
    created_at: new Date(5).toISOString(), expects: '', attempt: 1, body: 'News.', refs: [], author: 'agent' }
  world.files.set(`${records}/mail/1/new/q-1-re-user.1.json`, JSON.stringify(envelope))
  const context = await enter($, doorbell)
  expect(context).toContain('News.')
  expect(context.match(/current step: Diagnose/g)).toHaveLength(1)
})

// contract: a doorbell that finds no mail enters with only the no-mail line, which asks for nothing, and shows no toast or notification
test('an empty doorbell enters with only the no-mail line, and raises no alarm', async ($, on) => {
  const world = createWorld(on, { branch: 'fix' }, unitOptions())
  markSpawned(world, [1])
  const context = await enter($, doorbell)
  expect(context).toStartWith(noMail)
  expect(context).not.toContain('current step:')
  expect(world.toasts).toEqual([])
  expect(world.notifications).toEqual([])
})

// contract: a prompt the user typed enters through the classic hook with no flow line, which its prompt.submit already added
test('a typed prompt gains no flow line at entry', async ($, on) => {
  createWorld(on, { branch: 'fix' }, unitOptions())
  expect(await enter($, 'go')).not.toContain('current step:')
})
