import { withTimeout } from './result'
import type { ClockPort, Result } from './result'

/** What a stat reports of a file: its size and when it last changed. */
interface FileStat { size: number; mtimeMs: number }

/** The engine's file system. */
export interface FilePort { read: (path: string) => Promise<string>; stat: (path: string) => Promise<FileStat>; write: (path: string, text: string) => Promise<void> }

/** How long a file-system call may take. */
const fileTimeoutMs = 5000

/**
 * Reads a text file.
 *
 * @param files - The engine's file system.
 * @param clock - The clock the timeout waits on.
 * @param path - The file's path.
 * @returns Its contents, or a failure when it cannot be read in time.
 */
export const readTextFile = (files: FilePort, clock: ClockPort, path: string): Promise<Result<string>> =>
  withTimeout(clock, fileTimeoutMs, `read ${path}`, () => files.read(path))

/**
 * Stats a file.
 *
 * @param files - The engine's file system.
 * @param clock - The clock the timeout waits on.
 * @param path - The file's path.
 * @returns Its size and change time, or a failure when it is missing or cannot be read in time.
 */
export const statFile = (files: FilePort, clock: ClockPort, path: string): Promise<Result<FileStat>> =>
  withTimeout(clock, fileTimeoutMs, `stat ${path}`, () => files.stat(path))

/**
 * Writes a text file whole.
 *
 * @param files - The engine's file system.
 * @param clock - The clock the timeout waits on.
 * @param path - The file's path.
 * @param text - Its new contents.
 * @returns Nothing, or a failure when it cannot be written in time.
 */
export const writeTextFile = (files: FilePort, clock: ClockPort, path: string, text: string): Promise<Result<void>> =>
  withTimeout(clock, fileTimeoutMs, `write ${path}`, () => files.write(path, text))
