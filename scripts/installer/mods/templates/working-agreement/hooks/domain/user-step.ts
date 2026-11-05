import { readDecisionReasoning } from './delegated-decision'

/** A user's step a coordinator takes for a delegated unit: approve a diagnosis, skip a step with a reason, or declare a follow-up. */
export type UserStep = ApproveStep | SkipStep | FollowUpStep

/** Approves the diagnosis comment, pinning the red the unit recorded before it. */
interface ApproveStep { kind: 'approve'; diagnosis: string }
/** Skips a step of the unit's flow, by its id, for a reason. */
interface SkipStep { kind: 'skip'; step: string; reason: string }
/** Declares the Follow-up flow on an issue. */
interface FollowUpStep { kind: 'follow-up'; issue: number }

const commentUrl = /^https:\/\/\S+#issuecomment-\d+$/

/**
 * Writes the command a step runs, as the user would type it: a step message carries it as its body.
 * @param step - The step.
 * @returns The command line.
 */
export function composeStepCommand(step: UserStep): string {
  if (step.kind === 'approve') return `/flow approve ${step.diagnosis}`
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
  if (kind === 'approve') return !rest && commentUrl.test(first) ? { kind, diagnosis: first } : null
  if (kind === 'skip') return rest?.trim() && /^[a-z-]+$/.test(first) ? { kind, step: first, reason: rest.trim() } : null
  const issue = Number(first.replace(/^#/, ''))
  return !rest && first.startsWith('#') && Number.isSafeInteger(issue) && issue > 0 ? { kind: 'follow-up', issue } : null
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
