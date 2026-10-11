import { markForAgent } from './messages'
import type { Blocked } from './records'

interface Allow { decision: 'allow' }
interface Objection { decision: 'ask' | 'deny'; reason: string }
/** Names whether a call goes through, asks the user first, or is refused, and why. */
export type Verdict = Allow | Objection
/** Holds a repository write a call makes, by kind, and whether the verdict refuses it. */
interface WriteCheck {
  kind: keyof Blocked
  isDenied: boolean
}
interface WriteNote { write?: WriteCheck }
/** Holds a verdict on a tool call; `write` is present only when the call writes to the repository. */
export type Judgement = Verdict & WriteNote

const decisionRank = { allow: 0, ask: 1, deny: 2 }

/**
 * Refuses a call.
 *
 * @param rule - The rule the call breaks.
 * @param todo - What to do instead.
 * @returns A deny verdict.
 */
export const deny = (rule: string, todo: string): Verdict => ({ decision: 'deny', reason: markForAgent(`${rule} — ${todo}`) })

/**
 * Lets a call through only once the user approves it.
 *
 * @param rule - The rule the call breaks.
 * @param todo - What to do instead.
 * @returns An ask verdict.
 */
export const ask = (rule: string, todo: string): Verdict => ({ decision: 'ask', reason: markForAgent(`${rule} — ${todo}`) })

/**
 * Picks the verdict that holds when several rules judged one call.
 *
 * @param verdicts - The rules' verdicts.
 * @returns The first deny, else the first ask, else allow.
 */
export const pickStrictest = (verdicts: Verdict[]): Verdict =>
  verdicts.reduce<Verdict>((strictest, candidate) => (decisionRank[candidate.decision] > decisionRank[strictest.decision] ? candidate : strictest), { decision: 'allow' })
