import { markForAgent } from './messages'

interface Allow { decision: 'allow' }
interface Objection { decision: 'deny'; reason: string }
/** Names whether a file-tool call goes through or is refused, and why. */
export type Verdict = Allow | Objection

/**
 * Refuses a call.
 *
 * @param rule - The rule the call breaks.
 * @param todo - What to do instead.
 * @returns A deny verdict.
 */
export const deny = (rule: string, todo: string): Verdict => ({ decision: 'deny', reason: markForAgent(`${rule} — ${todo}`) })
