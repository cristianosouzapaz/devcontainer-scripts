import { markForAgent } from '../domain/messages'
import { readTextFile } from '../lib/files'
import { isRecord, parseJson } from '../lib/json'
import type { EnginePort } from './engine-port'
import { readRepositoryRoot } from './repository'

/** No verify file in the repository. */
interface NoVerify { kind: 'none' }
/** The verify command the repository file names. */
interface VerifyCommand { kind: 'command'; command: string }
/** A malformed verify file, and the notice that says why it was ignored. */
interface IgnoredVerify { kind: 'ignored'; notice: string }
/** What the repository's verify file configures. */
type VerifyConfig = NoVerify | VerifyCommand | IgnoredVerify

const verifyFile = '.agents/working-agreement.json'

/**
 * Reads the verify command from `.agents/working-agreement.json` at the repository root.
 *
 * @param port - The engine calls.
 * @returns The command, the notice that says why a malformed file was ignored, or none when there is no file.
 */
export async function readVerifyConfig(port: EnginePort): Promise<VerifyConfig> {
  const root = await readRepositoryRoot(port)
  if (!root) return { kind: 'none' }
  const text = await readTextFile(port.files, port.clock, `${root}/${verifyFile}`)
  if (!text.isOk) return { kind: 'none' }
  const data = parseJson(text.value)
  if (!data.isOk || !isRecord(data.value)) return { kind: 'ignored', notice: markForAgent(`${verifyFile} ignored: not a JSON object.`) }
  const verify = data.value.verify
  if (typeof verify !== 'string' || !verify.trim()) return { kind: 'ignored', notice: markForAgent(`${verifyFile} ignored: "verify" must be a non-empty string.`) }
  return { kind: 'command', command: verify }
}

/**
 * Reads the verify command, if the repository's file names one.
 *
 * @param port - The engine calls.
 * @returns The command, or undefined.
 */
export async function readVerifyCommand(port: EnginePort): Promise<string | undefined> {
  const verifyConfig = await readVerifyConfig(port)
  return verifyConfig.kind === 'command' ? verifyConfig.command : undefined
}
