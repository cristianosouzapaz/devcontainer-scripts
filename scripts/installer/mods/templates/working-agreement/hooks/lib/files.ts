import { runProcess } from './process'
import type { ProcessPort, ProcessResult } from './process'

/** A directory entry: its name and modification time in epoch ms. */
interface FileEntry { name: string; mtimeMs: number }

/** The path resolved by the engine's file system. */
type FileKind = 'file' | 'dir' | 'other'
/** A path's kind, where it resolved, and its modification time in epoch ms, which a listing gives only for files. */
interface FileStat { kind: FileKind; realPath?: string; mtimeMs: number }

/** The engine's file system. */
export interface FilePort { stat: (path: string) => Promise<FileStat>; exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<string>; write: (path: string, text: string) => Promise<void>; list: (path: string) => Promise<FileEntry[]> }

/**
 * Removes named files while retaining rejected runs as failures and non-zero exits as output.
 * @param processes - The engine's process runner.
 * @param paths - The exact paths to remove.
 * @returns The process output, or a failure retaining the original rejection.
 */
export function removeFile(processes: ProcessPort, ...paths: string[]): Promise<ProcessResult> {
  return runProcess(processes, ['rm', '-f', '--', ...paths])
}
