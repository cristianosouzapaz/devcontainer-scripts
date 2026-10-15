import { flowDefinitions } from '../domain/flow-definitions'
import type { Session, Unit } from '../domain/records'
import { findDiagnoseStep } from '../domain/step-states'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'

/** The engine and core calls `/flow approve` makes, each a closure the entry file builds. */
export interface ApprovePort {
  readSession: () => Promise<Session>
  readUnit: (key: string) => Promise<Unit>
  findUnitKey: (session: Session) => Promise<string>
  updateUnits: (session: Session, change: (unit: Unit) => Unit) => Promise<void>
  refresh: () => Promise<void>
  /** Runs a read-modify-write of the records under the store lock; the work must not refresh the pane, whose GitHub sync takes the lock too. */
  withLock: <T>(work: () => Promise<T>) => Promise<T>
}

/**
 * Runs `/flow approve diagnose`: approves the unit's latest diagnosis comment, by its id, so a newer comment voids the approval.
 *
 * @param port - The engine and core calls.
 * @param args - The words after `approve`.
 * @returns The message for the user, or why there is nothing to approve.
 */
export async function applyApproval(port: ApprovePort, args: string): Promise<Result<string>> {
  if (args.trim() !== 'diagnose') return fail('Usage: /flow approve diagnose.')
  const result = await port.withLock(() => storeApproval(port))
  if (result.isOk) await port.refresh()
  return result
}

// Checks and stores the approval; the caller holds the lock, so no comment is recorded between the read and the write.
async function storeApproval(port: ApprovePort): Promise<Result<string>> {
  const session = await port.readSession()
  const flow = session.flow ? flowDefinitions.flows[session.flow] : undefined
  if (!flow || !findDiagnoseStep(flow)) return fail('The declared flow has no Diagnose step, so there is nothing to approve.')
  const { diagnosis } = await port.readUnit(await port.findUnitKey(session))
  if (!diagnosis) return fail('There is no diagnosis comment to approve yet: after the green, the agent posts it on the issue with gh issue comment.')
  await port.updateUnits(session, unit => (unit.diagnosis ? { ...unit, approval: unit.diagnosis } : unit))
  return succeed('Diagnosis approved: the latest diagnosis comment stands until a newer one is posted.')
}
