import { handbackTool } from '../domain/coordinator'
import type { Envelope } from '../domain/mail'
import { unitAddress } from '../domain/mail'
import { markForAgent, modToolPrefix } from '../domain/messages'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { bestEffort } from './best-effort'
import type { EnginePort } from './engine-port'
import { takeMailBlock } from './mail-delivery'
import { AddressReadError, readCancelMailbox, readOwedCancels, readOwedMail, sendMail } from './mailbox'
import { readCommonDir, readSession, updateSession } from './record-store'
import { withRecordLock } from './session-memory'

/** A wait-only signal that a records check aborts once a cancel gates the unit, and the cancel that aborted it. */
export interface CancelWatch { signal: AbortSignal; check: () => Promise<void>; cancelId: () => string | undefined }

/** The one tool the gate leaves to the agent. */
const sendTool = `${modToolPrefix}send`

/**
 * Reads the cancels that gate this unit's tools: owed a done and not lifted by the user.
 * @param port - The engine calls.
 * @returns The gating cancels.
 */
async function readGatingCancels(port: EnginePort): Promise<Envelope[]> {
  const owed = await readOwedCancels(port)
  if (!owed.length) return []
  const lifted = (await readSession(port)).liftedCancels ?? []
  return owed.filter(envelope => !lifted.includes(envelope.id))
}

/**
 * Names the reply that lifts the gate.
 * @param cancels - The gating cancels.
 * @returns The send call to make.
 */
const describeReply = (cancels: readonly Envelope[]): string =>
  cancels.map(envelope => `send with kind done and in_reply_to ${envelope.id}`).join(', then ')

/**
 * Denies a tool call while a cancel gates the unit: every tool but send, and a subagent's handback, which it needs to stop with its report.
 * On the main thread the deny is an injection point that delivers and acknowledges all unread mail; a subagent's deny acknowledges nothing,
 * since its context is not the session's turn.
 * @param port - The engine calls.
 * @param tool - The tool called.
 * @param agentId - The subagent making the call, if any.
 * @returns The deny's text, or undefined when the call goes on.
 */
export async function denyCancelledCall(port: EnginePort, tool: string, agentId: string | undefined): Promise<string | undefined> {
  if (tool === sendTool || (agentId && tool === handbackTool)) return undefined
  // why: an address read that failed raised the Mail fault the pane shows, and a cancel nobody could read never denies every tool; any other failure stays one.
  const cancels = await readGatingCancels(port).catch((error: unknown) => { if (error instanceof AddressReadError) return []; throw error })
  if (!cancels.length) return undefined
  const ids = cancels.map(envelope => envelope.id).join(', ')
  if (agentId) return markForAgent(`Cancel ${ids} is open in this unit, so every tool but send and ${handbackTool} is denied: stop now and hand your report back `
    + `with ${handbackTool}, saying where you stopped; the main thread replies ${describeReply(cancels)}.`)
  const block = await takeMailBlock(port)
  const deny = markForAgent(`This unit's coordinator cancelled its work (cancel ${ids}): every tool but send is denied until you reply ${describeReply(cancels)}, `
    + 'saying where you stopped. A command already running finishes. Only the user\'s /flow lift, typed in this terminal, lifts the gate without the reply.')
  return block ? `${deny}\n\n${block}` : deny
}

/**
 * Runs the user's `/flow lift`: records the gating cancels as lifted by id, so tools work again across a resume and a retried cancel,
 * and tells each cancel's sender with a mod-written inform. Each cancel stays owed its done.
 * @param port - The engine calls.
 * @returns What was lifted, or why nothing was.
 */
export async function liftCancels(port: EnginePort): Promise<Result<string>> {
  const cancels = await readGatingCancels(port)
  if (!cancels.length) return fail('No cancel gates this session\'s tools, so there is nothing to lift.')
  const ids = cancels.map(envelope => envelope.id)
  await withRecordLock(() => updateSession(port, session => ({ ...session, liftedCancels: [...new Set([...session.liftedCancels ?? [], ...ids])] })))
  for (const envelope of cancels) {
    await bestEffort(port, 'lift inform', () => sendMail(port, { kind: 'inform', author: 'mod', to: envelope.from, issue: envelope.issue,
      body: markForAgent(`The user lifted the tool gate of cancel ${envelope.id} with /flow lift in #${envelope.issue}'s own terminal; the cancel still waits for the unit's done.`) }), undefined)
  }
  return succeed(`Lifted the tool gate of cancel ${ids.join(', ')}: tools work again. Each cancel still waits for this unit's done, and a new cancel gates again.`)
}

/**
 * Refuses a coordinator's cancel to a unit that owes no assign, or still owes a done to an earlier cancel: one cancel at a time.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @returns The refusal, or null when the cancel may go.
 */
export async function refuseCancel(port: EnginePort, issue: number): Promise<string | null> {
  const common = await readCommonDir(port)
  if (!common) return 'this session is not inside a git repository, which holds the mailboxes'
  const owed = await readOwedMail(port, common, unitAddress(issue))
  const open = owed.find(envelope => envelope.kind === 'cancel')
  if (open) return `cancel ${open.id} to #${issue} is still unanswered: a unit holds one cancel at a time`
  return owed.some(envelope => envelope.kind === 'assign') ? null : `#${issue} owes no assign, so there is no work to cancel`
}

/**
 * Watches for a cancel during a wait: each check reads the gate from the records and aborts the wait-only signal once one gates the unit,
 * so a lost doorbell never hides it. The dispatch's own signal still aborts the wait.
 * @param port - The engine calls.
 * @param signal - The dispatch's cancellation signal.
 * @returns The watch.
 */
export function watchCancels(port: EnginePort, signal: AbortSignal): CancelWatch {
  const control = new AbortController()
  const found: { id?: string } = {}
  return {
    signal: AbortSignal.any([signal, control.signal]),
    check: async () => {
      if (control.signal.aborted) return
      const cancel = (await bestEffort(port, 'cancel watch', () => readGatingCancels(port), []))[0]
      if (!cancel) return
      found.id = cancel.id
      control.abort()
    },
    cancelId: () => found.id,
  }
}

/**
 * Reads the directory a wait watches for a cancel, as the options of a Verify-queue wait take it.
 * @param port - The engine calls.
 * @returns The watch, or nothing outside a delegated unit.
 */
export async function readWatch(port: EnginePort): Promise<{ watch?: string }> {
  const dir = await readCancelMailbox(port)
  return dir ? { watch: dir } : {}
}

/**
 * Says a wait stopped for a cancel.
 * @param what - The wait: the Verify queue, or CI.
 * @param id - The cancel.
 * @returns The tool's answer.
 */
export const describeStoppedWait = (what: string, id: string): string => markForAgent(`Stopped waiting for ${what}: cancel ${id} arrived from the coordinator; `
  + `nothing ran and no record was written. Reply with send, kind done, in_reply_to ${id}.`)
