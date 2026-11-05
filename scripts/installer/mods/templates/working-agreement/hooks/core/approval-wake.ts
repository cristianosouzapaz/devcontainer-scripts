import type { KeyedRow } from '../ui/theme'
import { markForAgent } from '../domain/messages'
import { facts } from '../domain/facts'
import type { Position } from '../domain/step-states'
import { bestEffort } from './best-effort'
import type { EnginePort } from './engine-port'
import { sessionMemory } from './session-memory'
import { isVerifyApproved } from './verify'

/** The prompt that wakes a delegated unit once the user approved, in their terminal, the config it waited on. */
const wakePrompt = markForAgent('The user approved the Verify config this unit waited on, from their own terminal: call the verify tool.')

/**
 * Follows a Verify config approval given in the user's terminal, which no session sees: once the config the unit waited on is
 * approved, a delegated unit's idle session is prompted, once per config, to call Verify, which checks the approval again, so the
 * prompt grants nothing; outside delegation nobody's typing is interrupted, and a note says Verify is next instead.
 * @param port - Engine calls.
 * @param position - The unit's position, or null with no flow declared.
 * @param isDelegated - Whether the unit is delegated.
 * @returns The note to show outside delegation, or none.
 */
export async function followApproval(port: EnginePort, position: Position | null, isDelegated: boolean): Promise<KeyedRow[]> {
  if (position?.verify.isWaitingApproval && position.verify.approvalBlob) sessionMemory.approvalWait = position.verify.approvalBlob
  const blob = sessionMemory.approvalWait
  if (!blob || !position || position.verify.approval || !await isVerifyApproved(port, blob)) return []
  if (!isDelegated) return [{ key: 'Approve', value: facts.verifyConfigApproved, tone: 'text' }]
  if (sessionMemory.isTurnLive || sessionMemory.wokenBlobs.has(blob)) return []
  sessionMemory.wokenBlobs.add(blob)
  sessionMemory.approvalWait = null
  port.defer(() => void bestEffort(port, 'approval wake', () => port.submitPrompt(wakePrompt), undefined))
  return []
}
