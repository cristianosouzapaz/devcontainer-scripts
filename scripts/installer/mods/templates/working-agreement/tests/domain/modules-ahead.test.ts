import { expect } from 'claude-code/testing'
import type { Plugin } from 'claude-code/testing'

import { readModulesAhead, refuseModulesAhead } from '../../hooks/domain/coordinator'
import { buildWriteCall, coordinator, noFlow } from '../support/builders'
import { readFlowStatus, runFlowCommand } from '../support/helpers'
import { test } from '../support/kit'
import { createWorld, root } from '../support/world'


// A prepend module nests outside the mod and allows every call, as a guard of another plugin could.
const outerGuard: Plugin = {
  name: 'outer-guard',
  tier: 'prepend',
  register(on) {
    on('tool.check', async (_$, e, next) => ({ ...await next(e), decision: 'allow' }))
  },
}

test('an outer module\'s allow overrides the mod\'s deny, which is why the mod refuses to coordinate under one', { plugins: [outerGuard] }, async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: coordinator })
  on('tool.check', () => ({ decision: 'ask' }))
  expect((await $.tool.check(buildWriteCall('src/a.ts') as never)).decision).toBe('allow')
})

test('/flow coordinate and /flow delegate refuse to start under a module ahead, and /flow status names it', { plugins: [outerGuard] }, async ($, on) => {
  createWorld(on, { branch: 'feat' }, { session: noFlow })
  expect((await runFlowCommand($, 'coordinate')).text).toContain('Refused: outer-guard is a hooks module ahead of the working-agreement mod')
  expect((await runFlowCommand($, 'delegate #3')).text).toContain('Refused: outer-guard')
  expect(await readFlowStatus($)).toContain('overridden by outer-guard, hooks modules ahead · coordinator and delegation refused')
})

test('a session under a module ahead opens the pane at start with a short Guards note', { plugins: [outerGuard] }, async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect(world.views.at(-1)?.notes).toContainEqual({ key: 'Guards', value: 'guards overridable — see /flow status', tone: 'error' })
  expect(world.opened.length).toBeGreaterThan(0)
})

test('/flow status shows the mod as the outermost module when none is ahead, and the pane carries no Guards note', async ($, on) => {
  const world = createWorld(on, { branch: 'feat' }, { session: noFlow })
  await $.session.start({ cwd: root, surface: null, isInteractive: false })
  expect(world.views.at(-1)?.notes.some(note => note.key === 'Guards') ?? false).toBe(false)
  expect(await readFlowStatus($)).toContain('outermost hooks module')
  expect((await runFlowCommand($, 'coordinate')).text).toContain('Coordinator')
})

test('a refresh that omits the mod leaves the module order unknown, and coordinating then asks for a restart', () => {
  expect(readModulesAhead(['outer', 'working-agreement', 'inner'], [])).toEqual(['outer'])
  expect(readModulesAhead(['working-agreement'], ['outer'])).toEqual(['outer'])
  expect(readModulesAhead(['other'], [])).toBeNull()
  expect(refuseModulesAhead(null)).toContain('Restart the session')
})
