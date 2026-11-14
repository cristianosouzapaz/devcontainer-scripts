import { findDialog } from '../domain/dialogs'
import { parseStallRecord } from '../domain/liveness'
import { markForAgent } from '../domain/messages'
import { readJson } from '../lib/json'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { EnginePort } from './engine-port'
import { outsideHerdr } from './herdr-worktrees'
import { clearStallRecord, readDialog, stallPath } from './liveness'
import { readCommonDir } from './record-store'
import { readSpawnedSession } from './spawn'
import { readUnitHost } from './unit-host'

/**
 * Sends Esc to a stalled unit only when a stall report named the dialog, the catalogue allows Esc on it, and the pane, read again just
 * before acting, still shows it; then forgets the report, so the unit's next stall is reported again.
 * @param port - The engine calls.
 * @param issue - The unit's issue.
 * @param dialog - The catalogue id the report named.
 * @param key - The key asked for, if any.
 * @returns What was sent, or the first unmet check.
 */
export async function dismissDialog(port: EnginePort, issue: number, dialog: unknown, key: unknown): Promise<Result<string>> {
  if (key !== undefined && key !== 'Escape') return fail('only Escape is ever sent: never Enter, a digit, "Yes" or "Don\'t show again"')
  if (typeof dialog !== 'string' || !dialog.trim()) return fail('dialog must be the catalogue id the stall report named')
  const entry = findDialog(dialog.trim())
  if (!entry) return fail(`${dialog} is not in the dialog catalogue: a dialog the mod does not know is the user's to answer in the unit's pane`)
  if (!entry.key) return fail(`the mod sends no key to ${entry.name}: it is the user's to answer in the unit's pane`)
  const host = await readUnitHost(port)
  const common = await readCommonDir(port)
  if (!host || !common) return fail(outsideHerdr)
  const session = await readSpawnedSession(port, issue, false)
  // why: a stall record that cannot be read names no dialog, so the dismissal is refused rather than a key sent to a dialog no report named.
  const record = parseStallRecord(await readJson(port.files, stallPath(common, issue)).catch(() => undefined))
  if (!session || record?.session !== session || record.dialog !== entry.id) {
    return fail(`no stall report of #${issue}'s current session named ${entry.id}: only a dialog a report named is cleared`)
  }
  const workspace = (await host.list(port)).find(each => each.issue === issue)
  if (!workspace) return fail(`#${issue} has no open workspace`)
  // why: the pane can change between the report and this call, and a key meant for one dialog may answer another.
  const seen = await readDialog(port, host, workspace)
  if (seen.kind !== 'known' || seen.entry.id !== entry.id) return fail(`#${issue}'s pane no longer shows ${entry.name}, so nothing was sent: read it with unit_read`)
  await host.keys(port, workspace, entry.key)
  await clearStallRecord(port, common, issue)
  return succeed(markForAgent(`Sent Esc to #${issue}, which showed ${entry.name}. Its next stall is reported again; read it with unit_read to see it resume.`))
}
