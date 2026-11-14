import type { IssueComment } from '../../types'
import { findFlow, hasDiagnoseStep } from '../domain/flow-definitions'
import { findEarliestRed, pinDiagnosedRed } from '../domain/records'
import type { Identity, Session, Unit } from '../domain/records'
import { describeUnpinned, parseArgvJson } from '../domain/user-step'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'

/** The engine and core calls `/flow approve` makes, each a closure the entry file builds. */
export interface ApprovePort {
  readSession: () => Promise<Session>
  /** Applies a change to the fresh session; the change may run more than once, so it has no side effects. */
  updateSession: (change: (session: Session) => Session | null) => Promise<Session | null>
  readComments: (issue: number) => Promise<Result<IssueComment[]>>
  readUnit: (identity: Identity) => Promise<Unit>
  updateUnits: (session: Session, change: (unit: Unit) => Unit) => Promise<void>
  refresh: () => Promise<void>
  /** Runs a read-modify-write of the records under the store lock; the work must not refresh the pane, whose GitHub sync takes the lock too. */
  withLock: <T>(work: () => Promise<T>) => Promise<T>
  /** Appends an event to the unit's transition log in the background. */
  log: (session: Session, event: string, detail: Record<string, unknown>) => void
}

/** What `/flow approve` did: the reply for the user, and whether it stored an approval or only found the comment already approved. */
interface ApprovalOutcome {
  reply: string
  changed: boolean
}

/**
 * Approves a live diagnosis comment posted after a red run, pinning the red the diagnosis was written on: the cited one, or the only one.
 *
 * @param port - The engine and core calls.
 * @param args - The words after `approve`: the comment URL, then optionally the cited red as its argv JSON or its argv joined by spaces.
 * @returns The message for the user and whether the approval changed, or why there is nothing to approve.
 */
export async function applyApproval(port: ApprovePort, args: string): Promise<Result<ApprovalOutcome>> {
  // why: the cited text is trimmed like the rest of a typed command; a red whose argv ends in a space is cited by its argv JSON.
  const [, url = '', rest = ''] = /^\s*(\S*)\s*([\s\S]*?)\s*$/.exec(args) ?? []
  if (!/^https:\/\/[^\s]+#issuecomment-[0-9]+$/.test(url)) return fail('Usage: /flow approve <comment-url> [red argv JSON].')
  const cited = rest ? parseArgvJson(rest) ?? rest : undefined
  const result = await port.withLock(() => storeApproval(port, url, cited))
  if (result.isOk) await port.refresh()
  return result
}

/**
 * Accepts diagnosis approval only from a declared issue comment posted after a red run, and pins the cited red before it, or the only one.
 * @param port - The approval's persistence and GitHub calls.
 * @param url - The user-supplied diagnosis comment URL.
 * @param cited - The red the approval cites: its exact argv, its argv joined by spaces, or nothing.
 * @returns The approval confirmation and whether it changed the records, or the first unmet approval requirement.
 */
async function storeApproval(port: ApprovePort, url: string, cited?: string[] | string): Promise<Result<ApprovalOutcome>> {
  const session = await port.readSession()
  const flow = findFlow(session.flow)
  if (!session.unit || !hasDiagnoseStep(flow)) return fail('The declared flow has no Diagnose step, so there is nothing to approve.')
  const unit = await port.readUnit(session.unit)
  // why: A repeated approval, such as one delivered late, re-pins nothing, so evidence recorded after the first one stands.
  if (unit.approval === url) return describeRepeat(url, unit.approvedRed?.argv, cited)
  const runs = unit.runs
  if (!findEarliestRed(runs)) return fail('There is no red run yet: reproduce the bug through the run tool first.')
  const comments = new Map<number, IssueComment[]>()
  for (const issue of session.issues) {
    const read = await port.readComments(issue)
    if (!read.isOk) return fail(read.error)
    comments.set(issue, read.value)
  }
  const comment = [...comments.values()].flat().find(comment => comment.url === url)
  if (!comment) return fail('That URL is not a comment of the declared issue.')
  const pin = pinDiagnosedRed(runs, Date.parse(comment.createdAt), cited)
  if (pin.kind === 'none') return fail('That comment was created before the red run; post a diagnosis comment after it.')
  if (pin.kind !== 'pinned') return fail(`${describeUnpinned(pin, url, cited, true)}. Nothing changed.`)
  const red = pin.red
  const approvedRed = { argv: red.argv, tree: red.tree, at: red.at, runId: red.runId }
  await port.updateUnits(session, unit => ({ ...unit, approval: url, approvedRed }))
  port.log(session, 'approve', { comment: url })
  await port.updateSession(current => ({ ...current, info: Object.fromEntries(Object.entries(current.info).map(([issue, held]) => {
    const read = comments.get(Number(issue))
    return [issue, read && held && !('error' in held) ? { ...held, comments: read } : held]
  })) }))
  return succeed({ reply: `Diagnosis approved: ${url}; pinned red: \`${red.argv.join(' ')}\``, changed: true })
}

/**
 * Words a repeat of the approved comment, which re-pins nothing: it names the red stored at the first approval, and refuses a citation
 * of another red, which was not pinned.
 * @param url - The approved comment's URL.
 * @param stored - The pinned red's argv, when one was recorded.
 * @param cited - The red the repeat cites, if any.
 * @returns The repeat's reply, unchanged records, or the refusal of another red.
 */
function describeRepeat(url: string, stored: string[] | undefined, cited?: string[] | string): Result<ApprovalOutcome> {
  const pinned = stored ? `pinned red: \`${stored.join(' ')}\`` : 'no pinned red recorded'
  const same = cited === undefined || (stored !== undefined && (typeof cited === 'string' ? stored.join(' ') === cited : JSON.stringify(stored) === JSON.stringify(cited)))
  if (same) return succeed({ reply: `Already approved: ${url}; ${pinned}`, changed: false })
  return fail(`Already approved: ${url}, with ${pinned}; the cited red \`${typeof cited === 'string' ? cited : JSON.stringify(cited)}\` was not pinned. Nothing changed.`)
}
