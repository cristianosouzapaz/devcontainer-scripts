import { bestEffort } from './best-effort'
import type { GuardTimeout, GuardUsage } from './check-retry'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { readSession } from './record-store'

// A check past half its budget is logged: the measurement that names the check running closest to the budget.
const nearBudgetShare = 0.5

/**
 * Reads the host's one-minute load average, where the host has one.
 * @param port - The engine calls.
 * @returns The load, or undefined when it cannot be read.
 */
async function readLoad(port: EnginePort): Promise<number | undefined> {
  const text = await bestEffort(port, 'load read', () => port.files.read('/proc/loadavg'), undefined)
  const load = Number.parseFloat(text?.split(' ')[0] ?? '')
  return Number.isFinite(load) ? load : undefined
}

/**
 * Logs a guard check that used more than half its budget to the unit's flow log, once the guard has answered.
 * @param port - The engine calls.
 * @param usage - The check's usage.
 */
export function reportGuardUsage(port: EnginePort, usage: GuardUsage): void {
  if (usage.usedMs < usage.budgetMs * nearBudgetShare) return
  port.defer(() => {
    void bestEffort(port, 'guard usage log', async () => {
      logEvent(port, await readSession(port), 'guard-slow', { guard: usage.guard, usedMs: Math.round(usage.usedMs), budgetMs: usage.budgetMs, load: await readLoad(port) })
    }, undefined)
  })
}

/**
 * Logs a guard check that ran past its budget to the unit's flow log, with whether the retry recovered it, once the handler has answered.
 * @param port - The engine calls.
 * @param timeout - The timeout.
 */
export function reportGuardTimeout(port: EnginePort, timeout: GuardTimeout): void {
  port.defer(() => {
    void bestEffort(port, 'guard timeout log', async () => {
      logEvent(port, await readSession(port), 'guard-timeout', { guard: timeout.guard, isRecovered: timeout.isRecovered, load: await readLoad(port) })
    }, undefined)
  })
}
