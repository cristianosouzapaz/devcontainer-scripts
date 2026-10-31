import type { IssueComment } from '../../types'
import { findFlow, hasDiagnoseStep } from '../domain/flow-definitions'
import { findEarliestRed, findLatestRedBefore } from '../domain/records'
import type { Identity, Session, Unit } from '../domain/records'
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

/**
 * Approves a live diagnosis comment posted after a red run, pinning the latest red before it: the one the diagnosis was written on.
 *
 * @param port - The engine and core calls.
 * @param args - The words after `approve`.
 * @returns The message for the user, or why there is nothing to approve.
 */
export async function applyApproval(port: ApprovePort, args: string): Promise<Result<string>> {
  const url = args.trim()
  if (!/^https:\/\/[^\s]+#issuecomment-[0-9]+$/.test(url)) return fail('Usage: /flow approve <comment-url>.')
  const result = await port.withLock(() => storeApproval(port, url))
  if (result.isOk) await port.refresh()
  return result
}

/**
 * Accepts diagnosis approval only from a declared issue comment posted after a red run, and pins the latest such red.
 * @param port - The approval's persistence and GitHub calls.
 * @param url - The user-supplied diagnosis comment URL.
 * @returns The approval confirmation, or the first unmet approval requirement.
 */
async function storeApproval(port: ApprovePort, url: string): Promise<Result<string>> {
  const session = await port.readSession()
  const flow = findFlow(session.flow)
  if (!session.unit || !hasDiagnoseStep(flow)) return fail('The declared flow has no Diagnose step, so there is nothing to approve.')
  const unit = await port.readUnit(session.unit)
  // why: A repeated approval, such as one delivered late, re-pins nothing, so evidence recorded after the first one stands.
  if (unit.approval === url) return succeed(`Already approved: ${url}`)
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
  const red = findLatestRedBefore(runs, Date.parse(comment.createdAt))
  if (!red) return fail('That comment was created before the red run; post a diagnosis comment after it.')
  const approvedRed = { argv: red.argv, tree: red.tree, at: red.at, runId: red.runId }
  await port.updateUnits(session, unit => ({ ...unit, approval: url, approvedRed }))
  port.log(session, 'approve', { comment: url })
  await port.updateSession(current => ({ ...current, info: Object.fromEntries(Object.entries(current.info).map(([issue, held]) => {
    const read = comments.get(Number(issue))
    return [issue, read && held && !('error' in held) ? { ...held, comments: read } : held]
  })) }))
  return succeed(`Diagnosis approved: ${url}`)
}
