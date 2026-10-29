import { createQueue } from '../lib/queue'
import { executeProcess } from '../lib/process'
import type { Session } from '../domain/records'
import { isDeliveryStep } from '../domain/flow-definitions'
import { formatStepLabel, markStep } from '../domain/step-states'
import type { Position } from '../domain/step-states'
import { formatError } from '../lib/result'
import { symbol } from '../ui/symbols'
import type { EnginePort } from './engine-port'
import { sessionMemory, holdError } from './session-memory'
import { tickMs } from './timing'
import { isCoordinatorSession } from '../domain/coordinator'

const herdrTimeoutMs = 5000
const queueReport = createQueue()
/** The report lifetime spans two and a half background refresh intervals. */
const herdrReportTtlMs = 2.5 * tickMs

/**
 * Reports a full sidebar snapshot, serializing callers and holding failures only in memory.
 * @param port - The engine calls.
 * @param session - The freshly read session.
 * @param position - The current unit position, if declared.
 * @param dismissed - Shared violation dismissals.
 * @param isTreeChanged - Whether the last Verify run changed the tree and so left no record.
 * @param isDelegated - Whether the unit is delegated, or the coordinator delegates any issue.
 * @returns Once this report finishes, including a failed attempt.
 */
export function reportHerdr(port: EnginePort, session: Session, position: Position | null, dismissed: Set<string>, isTreeChanged: boolean, isDelegated = false): Promise<void> {
  const unit = position ? `${position.flow.label}${session.issues.length
    ? ` #${session.issues[0]}${session.issues.length > 1 ? ` +${session.issues.length - 1}` : ''}`
    : ` · ${session.unit?.branch ?? position.git?.branch ?? ''}`}${isDelegated ? ' · delegated' : ''}`
    : isCoordinatorSession(session) ? `Coordinator${isDelegated ? ' · delegating' : ''}` : ''
  // A finished unit has no current step; its last done step, or its delivery once concluded, stands for it.
  const shown = position?.isConcluded ? position.states.find(state => isDeliveryStep(state.step))
    : position?.current ?? position?.states.findLast(state => state.state === 'done')
  const step = shown && position ? `${symbol[markStep(shown, position, isTreeChanged).mark]} ${formatStepLabel(shown.step, position.pullRequest)}${position.verify.queued ? ` · Verify ${position.verify.queued}` : ''}` : ''
  const violations = (session.violations ?? []).filter(record => record.kind !== 'unchecked' && !dismissed.has(record.factId)).sort((a, b) => b.end - a.end)
  const alert = violations[0] ? `${symbol.failed} ${violations[0].kind} by agent${violations.length > 1 ? ` +${violations.length - 1}` : ''}` : ''
  const report = async (): Promise<void> => {
    try {
      const { environment, paneId } = await port.readHerdrEnv()
      if (environment !== '1' || !paneId) return
      const result = await executeProcess(port.processes, [
        // herdr 0.9.5's parser rejects options before the pane id, although its usage line puts the id last.
        'herdr', 'pane', 'report-metadata', paneId, '--source', 'working-agreement', '--ttl-ms', String(herdrReportTtlMs),
        ...[unit, step, alert].flatMap((value, index) => ['--token', `${['flow_unit', 'flow_step', 'flow_alert'][index]}=${[...value].slice(0, 80).join('')}`]),
      ], { timeoutMs: herdrTimeoutMs })
      if (result.exitCode !== 0) {
        const message = `exit ${result.exitCode}${result.stderr.trim().split(/\r?\n/)[0] ? `: ${result.stderr.trim().split(/\r?\n/)[0]}` : ''}`
        const now = await port.now()
        sessionMemory.herdrError = holdError(sessionMemory.herdrError, message, now)
        return
      }
      sessionMemory.herdrError = null
    } catch (error) {
      const message = `could not run: ${formatError(error).split(/\r?\n/)[0]}`
      const now = await port.now()
      sessionMemory.herdrError = holdError(sessionMemory.herdrError, message, now)
    }
  }
  // report holds the error in the herdr error window.
  return queueReport(report).catch(() => {})
}
