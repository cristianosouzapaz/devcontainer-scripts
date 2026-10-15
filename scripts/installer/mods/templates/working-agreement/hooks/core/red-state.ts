import type { Session } from '../domain/records'
import { hashFile, listChangedFiles, readWorktreeHead } from '../lib/git'
import { unwrapOr } from '../lib/result'
import type { EnginePort } from './engine-port'
import { findUnitKey, readUnit, updateUnits } from './record-store'
import { hasStaleRedFile } from './red-files'

/**
 * Records a finished run in the unit's worktree before the green. A failure is the red, accepted only from a worktree at
 * the unit's start commit: a command's red, and the red's own command failing again (the fix under way, or a re-proof),
 * take the worktree's changes against that commit as the red files, so a repro file created after the red is adopted.
 * A pass of the red's exact command text is the green, which also refreshes the fingerprints of the red files it has: a red
 * file that holds the fix as well as the test is fingerprinted as the green left it, so the fingerprints guard the test
 * and Verify covers the fix. Once the green is on record runs are recorded again only
 * while a red file is stale: the re-proof, whose failing run drops the green and whose passing run sets it again. A red of
 * another command is a new loop and also drops the diagnosis and its approval, since the approved comment quotes the
 * old red's command and files; the red's own command keeps them.
 *
 * @param port - The engine calls.
 * @param session - The session whose units get the red or the green.
 * @param worktree - The worktree's absolute path.
 * @param command - The command text as run.
 * @param isPassed - Whether it exited zero.
 */
export async function recordWorktreeRun(port: EnginePort, session: Session, worktree: string, command: string, isPassed: boolean): Promise<void> {
  const recorded = await readUnit(port, await findUnitKey(port, session))
  const { red, green, start } = recorded
  if (red && green === red.command && !await hasStaleRedFile(port, recorded)) return
  if (isPassed) {
    if (red?.command !== command) return
    const refreshed = await hashFiles(port, worktree, Object.keys(red.fingerprints))
    await updateUnits(port, session, unit => ({ ...unit, green: command, red: { command, fingerprints: refreshed } }))
    return
  }
  if (start && unwrapOr(await readWorktreeHead(port.processes, worktree), null) !== start) return
  const changed = await listChangedFiles(port.processes, worktree, start ?? 'HEAD')
  if (!changed.isOk) return
  const prints = await hashFiles(port, worktree, changed.value)
  const isNewRed = red?.command !== command
  await updateUnits(port, session, ({ green: _green, diagnosis, approval, ...unit }) => ({
    ...unit, ...(isNewRed ? {} : { diagnosis, approval }), red: { command, fingerprints: prints },
  }))
}

// Hashes each file as it stands in the worktree; a file that cannot be read hashes to the empty string.
async function hashFiles(port: EnginePort, worktree: string, files: string[]): Promise<Record<string, string>> {
  const prints = await Promise.all(files.map(async file => [file, unwrapOr(await hashFile(port.processes, `${worktree}/${file}`), '')] as const))
  return Object.fromEntries(prints)
}
