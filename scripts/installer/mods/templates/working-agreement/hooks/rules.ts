import type { Blocked } from './records'
import { runtime } from './runtime'

interface Allow { decision: 'allow' }
interface Objection { decision: 'ask' | 'deny'; reason: string }
/** Whether a call goes through, asks the user first, or is refused, and why. */
export type Verdict = Allow | Objection
/** A repository write a call makes, by kind, and whether the verdict refuses it. */
export interface WriteCheck { kind: keyof Blocked; isDenied: boolean }
interface WriteNote { write?: WriteCheck }
/** A verdict on a tool call; `write` is present only when the call writes to the repository. */
export type Judgement = Verdict & WriteNote

/** The tools that write files by path; Bash writes are found by parsing its command. */
export const fileTools = ['Edit', 'Write', 'NotebookEdit']

const decisionRank = { allow: 0, ask: 1, deny: 2 }

/**
 * Refuses a call.
 *
 * @param rule - The rule the call breaks.
 * @param todo - What to do instead.
 * @returns A deny verdict.
 */
export const deny = (rule: string, todo: string): Verdict => ({ decision: 'deny', reason: `[working-agreement] ${rule} — ${todo}` })

/**
 * Lets a call through only once the user approves it.
 *
 * @param rule - The rule the call breaks.
 * @param todo - What to do instead.
 * @returns An ask verdict.
 */
export const ask = (rule: string, todo: string): Verdict => ({ decision: 'ask', reason: `[working-agreement] ${rule} — ${todo}` })

/**
 * Picks the verdict that holds when several rules judged one call.
 *
 * @param vs - The rules' verdicts.
 * @returns The first deny, else the first ask, else allow.
 */
export const strictest = (vs: Verdict[]): Verdict =>
  vs.reduce<Verdict>((a, b) => (decisionRank[b.decision] > decisionRank[a.decision] ? b : a), { decision: 'allow' })

/**
 * Tells whether the permission mode puts an ask in front of the user; in any other mode an ask runs unanswered.
 *
 * @returns True in default and plan mode.
 */
export const asksHuman = (): boolean => runtime.permissionMode === 'default' || runtime.permissionMode === 'plan'

/**
 * Tells whether the write and command checks judge a tool.
 *
 * @param tool - The tool's name.
 * @returns True for the file-writing tools and Bash.
 */
export const isJudgedTool = (tool: string): boolean => fileTools.includes(tool) || tool === 'Bash'
