import { hashObject } from '../lib/git'
import type { Violation, ViolationFact } from '../../types'
import { readJson } from '../lib/json'
import { isRecord } from '../lib/guards'
import type { EnginePort } from './engine-port'
import { atomicReplace, readCommonDir, readSession, writeSession, recordsPath } from './record-store'
import { withRecordLock } from './session-memory'

/** Attribution shared by facts observed in one window. */
export interface WindowAttribution { toolUseId: string; agentId?: string; start: number; end: number }

/**
 * Reads every valid shared dismissal, retaining them independently of session lifetimes.
 * @param port - The engine calls.
 * @returns The dismissed fact identities.
 */
export async function readDismissals(port: EnginePort): Promise<Set<string>> {
  const common = await readCommonDir(port)
  const directory = recordsPath(common, 'd')
  // The bucket directory may not exist yet.
  const entries = common ? await port.files.list(directory).catch(() => []) : []
  const facts = await Promise.all(entries.filter(entry => entry.name.endsWith('.json')).map(async entry => {
    const value: unknown = await readJson(port.files, recordsPath(common, 'd', entry.name))
    return isRecord(value) && value.v === 1 && typeof value.factId === 'string' && entry.name === `${value.factId}.json` ? value.factId : null
  }))
  return new Set(facts.filter((fact): fact is string => fact !== null))
}

/**
 * Atomically dismisses exactly the facts displayed when the user pressed the button.
 * @param port - The engine calls.
 * @param factIds - Every displayed fact identity.
 */
export async function dismissViolations(port: EnginePort, factIds: string[]): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) throw new Error('repository unreadable')
  for (const factId of factIds) await atomicReplace(port, recordsPath(common, 'd', `${factId}.json`), JSON.stringify({ v: 1, factId }))
}

/**
 * Merges fact attribution under the session lock, retaining only the latest unchecked call and its accumulated count.
 * @param port - The engine calls.
 * @param facts - The independently judged facts.
 * @param window - The call and its time interval.
 * @returns This window's records, including already observed facts.
 */
export async function recordViolations(port: EnginePort, facts: ViolationFact[], window: WindowAttribution): Promise<Violation[]> {
  const sessionId = await port.readSessionId()
  const added = await Promise.all(facts.map(async (fact): Promise<Violation> => {
    const run = await hashObject(port.processes, JSON.stringify({ kind: fact.kind, fact: fact.fact }))
    if (run.exitCode !== 0 || !run.stdout.trim()) throw new Error('cannot hash guarantee fact')
    return { ...fact, factId: run.stdout.trim(), toolUseIds: [window.toolUseId], agentIds: window.agentId ? [window.agentId] : [], start: window.start, end: window.end, sessionId }
  }))
  return withRecordLock(async () => {
    const session = await readSession(port)
    const unchecked = added.find(record => record.kind === 'unchecked')
    const previous = unchecked ? session.violations?.findLast(record => record.kind === 'unchecked') : undefined
    const continuing = previous && !(await readDismissals(port)).has(previous.factId) ? previous : undefined
    const observed = added.map(record => record.kind === 'unchecked' ? {
      ...record, count: continuing ? (continuing.count ?? 1) + 1 : 1, start: continuing?.start ?? record.start,
    } : record)
    const violations = (session.violations ?? []).filter(record => !unchecked || record.kind !== 'unchecked')
    for (const record of observed) {
      const index = violations.findIndex(held => held.factId === record.factId)
      const held = violations[index]
      if (!held) violations.push(record)
      else violations[index] = { ...held, ...(held.kind === 'commit' && record.kind === 'commit' ? { checkouts: held.checkouts ?? record.checkouts } : {}),
        toolUseIds: [...new Set([...held.toolUseIds, ...record.toolUseIds])],
        agentIds: [...new Set([...(held.agentIds ?? []), ...(record.agentIds ?? [])])], start: Math.min(held.start, record.start), end: Math.max(held.end, record.end) }
    }
    await writeSession(port, { ...session, violations })
    return observed.map(record => violations.find(held => held.factId === record.factId)!)
  })
}
