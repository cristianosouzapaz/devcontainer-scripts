import { expect } from 'claude-code/testing'

import { test } from '../support/kit'
import { tickMs } from '../../hooks/core/timing'
import { createEmptySession } from '../../hooks/domain/records'
import { readJson } from '../../hooks/lib/json'
import { noFlow, verifyFile } from '../support/builders'
import { readCurrentStep, readPromptContext } from '../support/helpers'
import { common, configBlob, createTestPort, createWorld, root } from '../support/world'
import type { Options } from '../support/world'

const records = `${common}/working-agreement`
const unreadable = 'could not be read'
const pass = { tree: 'one', base: 'c0', configBlob: configBlob(verifyFile), commands: [['./test/run.sh']], outcome: { kind: 'pass' }, runId: 'r', at: 1 }
const verified = (): Options => ({ approvedConfig: verifyFile, verifyFile, unit: { verifyRuns: [pass] } })
const checkout = { branch: 'feat', ahead: 8, isDirty: true, tree: 'one' }

test('a present file whose read rejects, or that is not JSON, is a failed read; a missing file is absent', async (_$, on) => {
  const options: Options = {}
  const world = createWorld(on, { branch: 'feat' }, options)
  const port = createTestPort(world)
  world.files.set(`${records}/x/broken.json`, '{')
  world.files.set(`${records}/x/kept.json`, '{"v":1}')
  expect(await readJson(port.files, `${records}/x/missing.json`)).toBeUndefined()
  await expect(readJson(port.files, `${records}/x/broken.json`)).rejects.toThrow()
  options.readFailurePrefix = `${records}/x/`
  await expect(readJson(port.files, `${records}/x/kept.json`)).rejects.toThrow()
})

test("a unit declaration whose read rejects never drops the unit's Verify runs: the state is unreadable", async ($, on) => {
  const options = verified()
  createWorld(on, { ...checkout }, options)
  expect(await readCurrentStep($)).toBe('Commit')
  options.readFailurePrefix = `${records}/u/`
  const context = await readPromptContext($)
  expect(context).toContain(unreadable)
  expect(context).not.toMatch(/not run on this tree|no Verify run yet|since the last Verify/)
})

test("another chat's mirror whose read rejects never drops the Verify runs it holds: the state is unreadable", async ($, on) => {
  const options: Options = { approvedConfig: verifyFile, verifyFile }
  const world = createWorld(on, { ...checkout }, options)
  const own = world.sessions.get('sid')!
  world.files.set(`${records}/s/other.json`, JSON.stringify({ ...own, sessionId: 'other', units: own.units.map(unit => ({ ...unit, verifyRuns: [pass] })) }))
  expect(await readCurrentStep($)).toBe('Commit')
  options.readFailurePrefix = `${records}/s/other.json`
  const context = await readPromptContext($)
  expect(context).toContain(unreadable)
  expect(context).not.toMatch(/not run on this tree|no Verify run yet|since the last Verify/)
})

test('a unit declaration that is not JSON is unreadable, never an absent flow', async ($, on) => {
  const world = createWorld(on, { ...checkout }, verified())
  expect(await readCurrentStep($)).toBe('Commit')
  const path = [...world.files.keys()].find(file => file.startsWith(`${records}/u/`))!
  world.files.set(path, '{')
  expect(await readPromptContext($)).toContain(unreadable)
})

for (const [failure, text, options] of [
  ['rejects', 'mirror', { readFailurePrefix: `${records}/s/sid.json` }],
  ['is not JSON', '{', {}],
] as const) {
  test(`a startup mirror whose read ${failure} still registers the surface, seeds no empty record, and a tick seeds it once it reads`, async ($, on) => {
    const start: Options = { session: noFlow, isStateAbsent: true, ...options }
    const world = createWorld(on, { branch: 'feature' }, start)
    const { flow: _flow, issues: _issues, ...saved } = createEmptySession('sid')
    const mirror = JSON.stringify({ ...saved, blocked: { edits: 4 } })
    world.files.set(`${records}/s/sid.json`, text === 'mirror' ? mirror : text)
    await $.session.start({ cwd: root, surface: null, isInteractive: false })
    expect(world.registeredCommands.map(command => command.name)).toContain('flow')
    expect(world.registeredTools.map(tool => tool.name).sort()).toEqual(['declare_flow', 'run', 'verify'])
    expect(world.sessions.get('sid')).toBeUndefined()
    world.files.set(`${records}/s/sid.json`, mirror)
    delete start.readFailurePrefix
    await world.clock.advance(tickMs)
    expect(world.sessions.get('sid')?.blocked.edits).toBe(4)
  })
}

test('a config approval whose read rejects is unreadable, never a config not approved', async ($, on) => {
  const options = verified()
  createWorld(on, { ...checkout }, options)
  expect(await readCurrentStep($)).toBe('Commit')
  options.readFailurePrefix = `${records}/ok/`
  const context = await readPromptContext($)
  expect(context).toContain(unreadable)
  expect(context).not.toContain('config not approved')
})
