import { coversIssues } from '../domain/delegation'
import { describeDiagnoseNeed } from '../domain/instruction'
import { pinDiagnosedRed } from '../domain/records'
import { describeUnpinned, parseArgvJson } from '../domain/user-step'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { readDiagnoseWait } from './approval-gate'
import { relayStep } from './delegated-step'
import { readOwnScope } from './delegation'
import type { EnginePort } from './engine-port'
import { readDeclaration, readSessionMirrors } from './record-store'

/** A coordinator's approval of a unit's diagnosis, as a typed message: the decision that approves, the diagnosis it read and the red that diagnosis explains, as its argv joined by spaces or as its argv JSON. */
export interface ApproveMessage { kind: 'approve'; decision: string; diagnosis: string; red: string }

const commentUrl = /^https:\/\/\S+#issuecomment-\d+$/

/**
 * Reads the typed approval message from a tool call's untyped arguments.
 * @param args - The call's arguments.
 * @returns The message, or why it is malformed.
 */
export function parseApproveMessage(args: Record<string, unknown>): Result<ApproveMessage> {
  const { kind, decision, diagnosis, red } = args
  if (kind !== 'approve') return fail('kind must be approve')
  if (typeof decision !== 'string' || !commentUrl.test(decision)) return fail('decision must be the delegated decision comment\'s URL')
  if (typeof diagnosis !== 'string' || !commentUrl.test(diagnosis)) return fail('diagnosis must be the unit\'s diagnosis comment URL')
  if (typeof red !== 'string' || !red.trim()) return fail('red must be the unit\'s recorded red command')
  return succeed({ kind: 'approve', decision, diagnosis, red: red.trim() })
}

/**
 * Approves a delegated unit's diagnosis by relaying the step `/flow approve <diagnosis URL>` to its mod, only once the decision is shown to
 * have read the diagnosis: its Choice names /flow approve, and its Choice or Reason cites the diagnosis comment and the red command the unit
 * recorded before it, the same red the unit's mod pins.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @param message - The approval.
 * @returns What was sent, or the first unmet check.
 */
export async function approveUnit(port: EnginePort, issue: number, message: ApproveMessage): Promise<Result<string>> {
  const scope = await readOwnScope(port)
  if (!scope || !coversIssues(scope, [issue])) return fail(`#${issue} is not in this coordinator's delegation scope, so its approval is the user's /flow approve`)
  const record = (await readSessionMirrors(port)).map(mirror => mirror.session).find(session => !session.role && session.unit?.issues.includes(issue))
  if (!record?.unit) return fail(`#${issue} has no unit session record: spawn it first`)
  const declaration = await readDeclaration(port, record.unit)
  const wait = await readDiagnoseWait(port, record.unit, declaration?.flow ?? null)
  if (!wait) return fail(`#${issue}'s unit has no Diagnose to approve`)
  if (wait.judgement.done) return fail(`#${issue}'s Diagnose is already approved`)
  if (!wait.judgement.isWaitingApproval) return fail(wait.unread ?? `#${issue}'s Diagnose is not waiting for approval: ${describeDiagnoseNeed(wait.judgement.need, record.unit.issues)}`)
  const diagnosis = wait.comments.find(comment => comment.url === message.diagnosis)
  if (!diagnosis) return fail(`${message.diagnosis} is not a comment of #${issue}`)
  const cited = parseArgvJson(message.red) ?? message.red
  const pin = pinDiagnosedRed(wait.unit.runs, Date.parse(diagnosis.createdAt), cited)
  if (pin.kind !== 'pinned') return fail(describeUnpinned(pin, message.diagnosis, cited))
  const recorded = pin.red.argv.join(' ')
  const decision = wait.comments.find(comment => comment.url === message.decision)
  if (!decision || Date.parse(decision.createdAt) <= Date.parse(diagnosis.createdAt)) return fail(`${message.decision} is not a comment of #${issue} posted after the diagnosis`)
  return relayStep(port, issue, message.decision, { kind: 'approve', diagnosis: message.diagnosis, red: pin.red.argv }, recorded)
}
