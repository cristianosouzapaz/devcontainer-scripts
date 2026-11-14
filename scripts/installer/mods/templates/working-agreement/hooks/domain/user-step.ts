import { readDecisionReasoning } from './delegated-decision'
import { describeReds } from './records'
import type { RedPin } from './records'

/** A user's step a coordinator takes for a delegated unit: approve a diagnosis, skip a step with a reason, or declare a follow-up. */
export type UserStep = ApproveStep | SkipStep | FollowUpStep

/** Approves the diagnosis comment, pinning the red the unit recorded before it: the cited argv, or the only red when none is cited. */
interface ApproveStep { kind: 'approve'; diagnosis: string; red?: string[] }
/** Skips a step of the unit's flow, by its id, for a reason. */
interface SkipStep { kind: 'skip'; step: string; reason: string }
/** Declares the Follow-up flow on an issue. */
interface FollowUpStep { kind: 'follow-up'; issue: number }

/** The longest Choice a relay carries to the unit, so the step's terms reach it whole beside the step's own entry. */
export const choiceRelayLimit = 4000
// why: an approval announced before its done arrived let a unit start editing, though nothing but its final write waits on Diagnose.
/** What a relayed step means to the coordinator and how it learns the outcome, said in each relay tool's description and success result. */
export const relayContract = 'Relayed means sent, not applied: send the unit nothing about the step, and wait for its done. The unit\'s mod answers the step itself '
  + 'with a done naming the outcome (applied, refused, or did not finish). If no done arrives, read the unit\'s pane (unit_read) and the user\'s /flow inbox: '
  + 'the unit may not have read the step yet, or its done may not have been sent, which its mod resends at its next prompt or, when it cannot, '
  + 'tells the user about in that pane.'
const commentUrl = /^https:\/\/\S+#issuecomment-\d+$/

/**
 * Writes the command a step runs, as the user would type it: a step message carries it as its body.
 * @param step - The step.
 * @returns The command line.
 */
export function composeStepCommand(step: UserStep): string {
  if (step.kind === 'approve') return `/flow approve ${step.diagnosis}${step.red ? ` ${JSON.stringify(step.red)}` : ''}`
  return step.kind === 'skip' ? `/flow skip ${step.step} ${step.reason}` : `/flow follow-up #${step.issue}`
}

/**
 * Reads a step back from the command a step message carries.
 * @param text - The message's body.
 * @returns The step, or null when the text is no step command.
 */
export function parseStepCommand(text: string): UserStep | null {
  const match = /^\/flow (approve|skip|follow-up) (\S+)(?: ([\s\S]+))?$/.exec(text)
  if (!match) return null
  const [, kind, first = '', rest] = match
  if (kind === 'approve') {
    const red = rest === undefined ? undefined : parseArgvJson(rest)
    return commentUrl.test(first) && red !== null ? { kind, diagnosis: first, ...red ? { red } : {} } : null
  }
  if (kind === 'skip') return rest?.trim() && /^[a-z-]+$/.test(first) ? { kind, step: first, reason: rest.trim() } : null
  const issue = Number(first.replace(/^#/, ''))
  return !rest && first.startsWith('#') && Number.isSafeInteger(issue) && issue > 0 ? { kind: 'follow-up', issue } : null
}

/**
 * Reads a cited red written as its argv in JSON, the form that carries it exactly.
 * @param text - The text after the diagnosis URL.
 * @returns The argv, or null when the text is no non-empty JSON array of strings.
 */
export function parseArgvJson(text: string): string[] | null {
  try {
    const value: unknown = JSON.parse(text)
    return Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string') ? value as string[] : null
  } catch {
    return null
  }
}

/**
 * Words why an approval pins no red, naming the reds the records hold before the diagnosis and how to cite one.
 * @param pin - The failed pin.
 * @param diagnosis - The diagnosis comment's URL.
 * @param cited - The red the approval cited, if any.
 * @param typed - Whether the user typed the approval, which then cites with `/flow approve`; otherwise approve_unit's red cites.
 * @returns The reason.
 */
export function describeUnpinned(pin: Exclude<RedPin, { kind: 'pinned' }>, diagnosis: string, cited?: string[] | string, typed = false): string {
  const named = typeof cited === 'string' ? cited : JSON.stringify(cited)
  const example = JSON.stringify(pin.reds[0] ?? [])
  const how = typed ? `cite the one the diagnosis was written on by its argv JSON: /flow approve ${diagnosis} ${example}`
    : `cite the one the diagnosis was written on as approve_unit's red, by its argv JSON, such as ${example}`
  if (pin.kind === 'none') return `${diagnosis} precedes the unit's red run, so it diagnoses no red`
  if (pin.kind === 'unmatched') return `the unit's records hold no red run of \`${named}\` before the diagnosis; the reds they hold before it are: ${describeReds(pin.reds)}`
  return cited === undefined ? `several red commands precede the diagnosis: ${describeReds(pin.reds)}; ${how}`
    : `\`${named}\` matches several red commands before the diagnosis: ${describeReds(pin.reds)}; ${how}`
}

/**
 * Names a step as its delegated decision's Choice must name it, exactly.
 * @param step - The step.
 * @returns The text the Choice contains.
 */
export function nameStep(step: UserStep): string {
  if (step.kind === 'approve') return '/flow approve'
  return step.kind === 'skip' ? `/flow skip ${step.step}` : `/flow follow-up #${step.issue}`
}

/**
 * Lists what a step's decision cites in its Choice or Reason, to show it read what the step rests on.
 * @param step - The step.
 * @param red - For an approval, the red command the diagnosis was written on.
 * @returns The citations.
 */
function listCitations(step: UserStep, red: string): string[] {
  if (step.kind === 'approve') return [step.diagnosis, red]
  return step.kind === 'skip' ? [step.step, step.reason] : [`#${step.issue}`]
}

/**
 * Judges a delegated decision's text against the step it authorises: well-formed, its Choice naming the step exactly, its Choice or Reason
 * citing what the step rests on.
 * @param body - The decision comment's markdown.
 * @param step - The step.
 * @param red - For an approval, the red command the diagnosis was written on; empty otherwise.
 * @returns The first unmet check, or undefined when the text authorises the step.
 */
export function judgeStepDecision(body: string, step: UserStep, red: string): string | undefined {
  const reasoning = readDecisionReasoning(body)
  if (!reasoning) return 'it is not a well-formed delegated decision'
  if (!reasoning.choice.includes(nameStep(step))) return `its Choice does not name the step ${nameStep(step)}`
  const text = `${reasoning.choice}\n${reasoning.reason}`
  const missing = listCitations(step, red).filter(citation => !text.includes(citation))
  return missing.length ? `its Choice or Reason does not cite ${missing.join(' and ')}` : undefined
}
