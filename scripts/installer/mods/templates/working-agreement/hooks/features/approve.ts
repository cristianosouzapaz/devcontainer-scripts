import type { IssueComment } from '../../types'
import { findFlow, hasDiagnoseStep } from '../domain/flow-definitions'
import type { Identity, Session, Unit } from '../domain/records'
import { findEarliestRed } from '../domain/step-states'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'

/** The engine and core calls `/flow approve` makes, each a closure the entry file builds. */
export interface ApprovePort {
  readSession: () => Promise<Session>
  writeSession: (session: Session) => Promise<void>
  readComments: (issue: number) => Promise<Result<IssueComment[]>>
  readUnit: (identity: Identity) => Promise<Unit>
  updateUnits: (session: Session, change: (unit: Unit) => Unit) => Promise<void>
  refresh: () => Promise<void>
  /** Runs a read-modify-write of the records under the store lock; the work must not refresh the pane, whose GitHub sync takes the lock too. */
  withLock: <T>(work: () => Promise<T>) => Promise<T>
}

/**
 * Approves a live diagnosis comment posted after the unit's earliest red run.
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
 * Accepts diagnosis approval only from a declared issue comment posted after the earliest red run.
 * @param port - The approval's persistence and GitHub calls.
 * @param url - The user-supplied diagnosis comment URL.
 * @returns The approval confirmation, or the first unmet approval requirement.
 */
async function storeApproval(port: ApprovePort, url: string): Promise<Result<string>> {
  const session = await port.readSession()
  const flow = findFlow(session.flow)
  if (!session.unit || !hasDiagnoseStep(flow)) return fail('The declared flow has no Diagnose step, so there is nothing to approve.')
  const red = findEarliestRed((await port.readUnit(session.unit)).runs)
  if (!red) return fail('There is no red run yet: reproduce the bug through the run tool first.')
  const comments: IssueComment[] = []
  const info = { ...session.info }
  for (const issue of session.issues) {
    const read = await port.readComments(issue)
    if (!read.isOk) return fail(read.error)
    comments.push(...read.value)
    const issueInfo = info[issue]
    if (issueInfo && !('error' in issueInfo)) info[issue] = { ...issueInfo, comments: read.value }
  }
  const comment = comments.find(comment => comment.url === url)
  if (!comment) return fail('That URL is not a comment of the declared issue.')
  if (Date.parse(comment.createdAt) <= red.at) return fail('That comment was created before the red run; post a diagnosis comment after it.')
  await port.updateUnits(session, unit => ({ ...unit, approval: url }))
  const current = await port.readSession()
  await port.writeSession({ ...current, info })
  return succeed(`Diagnosis approved: ${url}`)
}
