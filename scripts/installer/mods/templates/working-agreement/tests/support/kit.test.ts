import { expect } from 'claude-code/testing'

import { test, withTestTimeout } from './kit'

test('a test without its own timeout gets the support default, beside its other options', () => {
  expect(withTestTimeout({})).toEqual({ timeoutMs: 20_000 })
  expect(withTestTimeout({ plugins: [] })).toEqual({ plugins: [], timeoutMs: 20_000 })
  expect(withTestTimeout({ timeoutMs: undefined })).toEqual({ timeoutMs: 20_000 })
})

test('a test that sets its own timeout keeps it', () => {
  expect(withTestTimeout({ timeoutMs: 1_000 })).toEqual({ timeoutMs: 1_000 })
})
