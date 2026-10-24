import { runGit } from '../lib/git'
import { branchFirstInstruction } from '../domain/requirements'
import { deny } from '../domain/verdicts'
import type { Verdict } from '../domain/verdicts'
import { toStringOrEmpty } from '../lib/json'
import { normalizePath, toRepoRelative } from '../lib/paths'
import type { EnginePort } from './engine-port'
import { createReadPort } from './read-port'
import { readCommonDir, recordsPath } from './record-store'
import { readGit } from './repository'

interface PlacedPath { path: string; directory: string }

/**
 * Refuses file-tool writes on the session repository's default branch or to its records.
 * @param engine - The engine calls.
 * @param args - The tool's input.
 * @returns The path's verdict, independent of flows and overrides.
 */
export async function judgeToolCall(engine: EnginePort, args: Record<string, unknown>): Promise<Verdict> {
  const port = createReadPort(engine)
  const input = toStringOrEmpty(args.file_path ?? args.notebook_path)
  if (!input.startsWith('/')) return deny('a file write requires an absolute path', 'pass an absolute path, then retry')
  // A git that cannot run rejects here, even for scratch files; the tool.call catch fails closed.
  const common = await readCommonDir(port)
  if (!common) return { decision: 'allow' }
  const sessionCommon = (await placePath(port, common)).path
  const records = (await placePath(port, recordsPath(sessionCommon))).path
  const resolved = await placePath(port, input)
  // Folding a missing tail's '..' may enter a different existing checkout.
  const placed = resolved.path === input ? resolved : await placePath(port, resolved.path)
  if (toRepoRelative(placed.path, records) !== null) {
    return deny("the agent cannot write the mod's records", "Verify config approval is the user's, via /flow approve")
  }
  const run = await runGit(port.processes, ['-C', placed.directory, 'rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'])
  // Outside a checkout (including inside git metadata) has no top level to judge.
  if (run.exitCode !== 0) return { decision: 'allow' }
  const [otherCommon, root] = run.stdout.trim().split('\n')
  if (!otherCommon || !root) throw new Error('cannot locate the file checkout')
  if ((await placePath(port, otherCommon)).path !== sessionCommon) return { decision: 'allow' }
  const ignored = await runGit(port.processes, ['-C', root, 'check-ignore', '--', placed.path])
  if (ignored.exitCode === 0) return { decision: 'allow' }
  if (ignored.exitCode !== 1) throw new Error('cannot check ignored paths')
  const head = await runGit(port.processes, ['-C', root, 'symbolic-ref', '-q', 'HEAD'])
  if (head.exitCode === 1) return { decision: 'allow' }
  if (head.exitCode !== 0) throw new Error('cannot read the checkout branch')
  const git = await readGit(port)
  if (!git) throw new Error('cannot read the default branch')
  return head.stdout.trim() === `refs/heads/${git.base}`
    ? deny(`writing on the default branch (${git.base})`, `${branchFirstInstruction}, then retry`)
    : { decision: 'allow' }
}

// Resolve before folding '..': a symlink can change which parent that component names.
/**
 * Resolves write targets through existing ancestors so newly created paths can be gated.
 * @param port - The engine calls.
 * @param path - The absolute target path.
 * @returns The resolved path and existing containing directory, rejecting unresolved paths.
 */
async function placePath(port: EnginePort, path: string): Promise<PlacedPath> {
  // A write may create the path.
  const stat = await port.files.stat(path).catch(() => undefined)
  if (stat) {
    if (!stat.realPath) throw new Error('cannot resolve the write path')
    return { path: stat.realPath, directory: stat.kind === 'dir' ? stat.realPath : stat.realPath.slice(0, stat.realPath.lastIndexOf('/')) || '/' }
  }
  const cut = path.lastIndexOf('/')
  if (cut < 0 || path === '/') throw new Error('cannot resolve the write path')
  const ancestor = await placePath(port, path.slice(0, cut) || '/')
  return { path: normalizePath(`${ancestor.path}/${path.slice(cut + 1)}`, '/'), directory: ancestor.directory }
}
