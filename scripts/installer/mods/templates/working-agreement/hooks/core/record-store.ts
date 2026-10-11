import { parseSession, parseUnit } from '../domain/records'
import type { Session, Unit } from '../domain/records'
import { readRecord, writeRecord } from '../lib/store'
import type { EnginePort } from './engine-port'

/**
 * Names the repository the store keys are scoped to: its GitHub slug, else its root, else the working directory.
 *
 * @param port - The engine calls.
 * @returns The slug, root or directory.
 */
export async function readRepositorySlug(port: EnginePort): Promise<string> {
  const repository = await port.readRepository()
  const slug = repository?.remote?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)
  return slug?.[1] ?? repository?.root ?? (await port.readCwd())
}

/**
 * Names the store key of an issue's unit.
 *
 * @param port - The engine calls.
 * @param issue - The issue number.
 * @returns The key.
 */
export const findIssueKey = async (port: EnginePort, issue: number): Promise<string> => `issue:${await readRepositorySlug(port)}#${issue}`

/**
 * Names the store key of the session's unit: its first issue's, or the session's own for a follow-up or a unit without an issue.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @returns The key.
 */
export const findUnitKey = async (port: EnginePort, session: Session): Promise<string> =>
  session.issues.length && !session.followUp ? findIssueKey(port, session.issues[0]!) : `unit:${await findSessionKey(port)}`

/**
 * Reads a stored record; a store that cannot be read rejects, so a gate's `.catch` denies and a pane refresh is skipped.
 *
 * @param port - The engine calls.
 * @param key - The record's key.
 * @returns The record as stored.
 */
async function readStored(port: EnginePort, key: string): Promise<unknown> {
  const record = await readRecord(port.store, key)
  if (!record.isOk) throw new Error(record.error)
  return record.value
}

/**
 * Writes a record whole; a store that cannot be written rejects.
 *
 * @param port - The engine calls.
 * @param key - The record's key.
 * @param value - The record.
 */
export async function writeStored(port: EnginePort, key: string, value: unknown): Promise<void> {
  const written = await writeRecord(port.store, key, value)
  if (!written.isOk) throw new Error(written.error)
}

/**
 * Reads this session's record.
 *
 * @param port - The engine calls.
 * @returns The session, empty when none is stored.
 */
export const readSession = async (port: EnginePort): Promise<Session> => parseSession(await readStored(port, await findSessionKey(port)))

/**
 * Writes this session's record.
 *
 * @param port - The engine calls.
 * @param session - The session.
 */
export const writeSession = async (port: EnginePort, session: Session): Promise<void> => writeStored(port, await findSessionKey(port), session)

/**
 * Reads a unit's record.
 *
 * @param port - The engine calls.
 * @param key - The unit's key.
 * @returns The unit, empty when none is stored.
 */
export const readUnit = async (port: EnginePort, key: string): Promise<Unit> => parseUnit(await readStored(port, key))

/**
 * Applies a change to every unit the session works on: one per declared issue, or the session's own.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @param change - Builds the new unit from the stored one.
 */
export async function updateUnits(port: EnginePort, session: Session, change: (unit: Unit) => Unit): Promise<void> {
  for (const key of await listUnitKeys(port, session)) {
    await writeStored(port, key, change(await readUnit(port, key)))
  }
}

/**
 * Lists the store keys of every unit the session works on.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @returns The keys.
 */
export async function listUnitKeys(port: EnginePort, session: Session): Promise<string[]> {
  return session.followUp || !session.issues.length
    ? [await findUnitKey(port, session)]
    : await Promise.all(session.issues.map(issue => findIssueKey(port, issue)))
}

async function findSessionKey(port: EnginePort): Promise<string> {
  return `session:${await readRepositorySlug(port)}:${await port.readSessionId()}`
}
