import { test as kitTest } from 'claude-code/testing'
import type { TestBody, TestOptions, TestRest } from 'claude-code/testing'

// why: The kit's 5 s default only detects hangs, yet a host that shares its CPU stretches a sound
// 1 s flow test past it; the slowness signal is the 2.5 s budget warning in test/runners/mods.sh.
const testTimeoutMs = 20_000

/**
 * Fills in testTimeoutMs when the options give no timeout of their own.
 *
 * @param options - The kit options a test passes.
 * @returns The same options with a timeout.
 */
export function withTestTimeout(options: TestOptions): TestOptions {
  return { ...options, timeoutMs: options.timeoutMs ?? testTimeoutMs }
}

/**
 * Declares a kit test whose timeout defaults to testTimeoutMs.
 *
 * @param name - The test's name.
 * @param rest - The body, or the kit's options then the body.
 */
export function test(name: string, ...rest: TestRest): void {
  const [options, body]: readonly [TestOptions, TestBody] = rest.length === 1 ? [{}, rest[0]] : rest
  kitTest(name, withTestTimeout(options), body)
}
