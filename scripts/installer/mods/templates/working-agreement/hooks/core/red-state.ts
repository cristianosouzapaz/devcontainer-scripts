import type { Session, Unit } from '../domain/records'
import type { RedState } from '../domain/step-states'
import { hashFile } from '../lib/git'
import type { GitState } from '../lib/git'
import { unwrapOr } from '../lib/result'
import type { EnginePort } from './engine-port'
import { updateUnits } from './record-store'

/**
 * Stores a red that fingerprints the given test files, replacing the previous one.
 *
 * @param port - The engine calls.
 * @param session - The session whose units get the red.
 * @param root - The repository root.
 * @param testFiles - The repo-relative test files the failing run exercised.
 */
export async function recordRed(port: EnginePort, session: Session, root: string, testFiles: string[]): Promise<void> {
  const prints = await Promise.all(testFiles.map(async file => [file, await fingerprintFile(port, root, file)] as const))
  await updateUnits(port, session, unit => ({ ...unit, red: { fingerprints: Object.fromEntries(prints) } }))
}

/**
 * Tells whether the unit's red is absent, still holds, or no longer matches the test files it exercised.
 *
 * @param port - The engine calls.
 * @param unit - The unit.
 * @param git - The working tree's git state.
 * @returns The red's state.
 */
export async function readRedState(port: EnginePort, unit: Unit, git: GitState | null): Promise<RedState> {
  if (!unit.red || !git) return 'none'
  for (const [file, print] of Object.entries(unit.red.fingerprints)) {
    if ((await fingerprintFile(port, git.root, file)) !== print) return 'stale'
  }
  return 'holds'
}

// The content hash git gives a repo-relative file, '' when it is absent; the absolute path resolves from any working directory.
async function fingerprintFile(port: EnginePort, root: string, file: string): Promise<string> {
  return unwrapOr(await hashFile(port.processes, `${root}/${file}`), '')
}
