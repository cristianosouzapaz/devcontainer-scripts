import { buildView } from '../ui/view-model'
import type { EnginePort } from './engine-port'
import { readGithubStatus, syncIssues, syncPullRequests } from './github-sync'
import { locatePosition } from './position'
import { readSession } from './record-store'
import { sessionMemory } from './session-memory'

/**
 * Rebuilds the Flow pane's view from the stored session, writing it only when it changed.
 *
 * @param port - The engine calls.
 * @param isQuiet - Whether to skip every GitHub read and use the cached status.
 * @param isSynced - Whether the caller has just synced the PRs and issues: it skips both syncs, which take the lock that `declare` holds.
 */
export async function refreshView(port: EnginePort, isQuiet = false, isSynced = false): Promise<void> {
  const saved = await readSession(port)
  if (saved.flow && !isQuiet && !isSynced) await syncPullRequests(port, saved)
  const session = saved.flow && !isQuiet && !isSynced ? await syncIssues(port, saved) : saved
  const position = await locatePosition(port, session)
  if (!position) {
    if (await port.readView()) await port.writeView(null)
    return
  }
  const github = isQuiet ? sessionMemory.githubCache?.status ?? session.gh : await readGithubStatus(port)
  const view = buildView(session, position, github)
  if (JSON.stringify(await port.readView()) === JSON.stringify(view)) return
  await port.writeView(view)
}
