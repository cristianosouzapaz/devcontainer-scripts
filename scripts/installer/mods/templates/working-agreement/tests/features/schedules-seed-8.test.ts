import { expect } from 'claude-code/testing'

import { drawChunks, explore } from '../support/explorer'
import { test } from '../support/kit'

for (const chunk of drawChunks(8)) {
  // group: Seeded random exploration
  // contract: seeded random schedules over every event, loads that coexist and faults and suspensions of the engine calls included, hold every invariant; a soak run (MOD_TEST_SOAK=<n> test/runners/mods.sh) draws n more per seed, one seed per file so each file stays within the runner's bound
  test(chunk.name, async (_$, on) => {
    expect(await explore(on, chunk.schedules, 8)).toEqual([])
  })
}
