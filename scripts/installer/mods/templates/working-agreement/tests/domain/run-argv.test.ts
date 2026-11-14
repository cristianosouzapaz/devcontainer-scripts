import { expect } from 'claude-code/testing'

import { masksExitStatus } from '../../hooks/domain/run-argv'
import { test } from '../support/kit'

// why: a variable and a descriptor duplication leave the exit status the test command's own.
const keepsStatus = ['npm test 2>&1', 'npm test -- $FILE', 'cd /r && npm test 2>&1', 'bats "$DIR"/a.bats 1>&2']

// why: each can report another status than the test command's own.
const masks = ['npm test | tail', 'npm test; true', 'npm test || true', 'npm test &', 'npm test > out', 'npm test 2> out', 'npm test &> out', 'npm test >&2',
  'npm test $(cat f)', 'npm test `cat f`', 'npm test ${X:-$(cat f)}',
  'if npm test; then :; fi', '! npm test', '']

for (const script of keepsStatus) {
  // contract: a shell -c script of one command may use $name and N>&M
  test(`sh -c ${JSON.stringify(script)} keeps its test command's exit status`, () => {
    expect(masksExitStatus(['sh', '-c', script])).toBe(false)
  })
}

for (const script of masks) {
  // contract: a shell -c script with a pipe, list, background job, file redirection, substitution or conditional is refused
  test(`sh -c ${JSON.stringify(script)} may mask its exit status`, () => {
    expect(masksExitStatus(['sh', '-c', script])).toBe(true)
  })
}
