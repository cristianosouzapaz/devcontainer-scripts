import { expect, test } from 'claude-code/testing'

import { noFlow, verifyFile } from '../support/builders'
import { declareFlow, readCurrentStep } from '../support/helpers'
import { completeDelivery } from '../support/delivery'
import { createWorld, linearGraph } from '../support/world'
import type { Checkout, Options } from '../support/world'

test('a Close out starts at Verify', async ($, on) => {
  const git: Checkout = { branch: 'feat', isDirty: true }
  const options: Options = { session: noFlow, verifyFile }
  createWorld(on, git, options)
  await declareFlow($, 'close-out', [1])
  expect(await readCurrentStep($)).toBe('Verify')

})

test('a Close out unit runs from Verify to a merged PR', async ($, on) => {
  const graph = linearGraph({ feat: 0 }, verifyFile, 1)
  const git: Checkout = { branch: 'feat', graph, isDirty: true }
  const options: Options = { session: noFlow, verifyFile }
  const { clock, views } = createWorld(on, git, options)
  expect((await declareFlow($, 'close-out', [1])).result).toContain('current step: Verify')
  await completeDelivery($, { git, options, clock, views })
})
