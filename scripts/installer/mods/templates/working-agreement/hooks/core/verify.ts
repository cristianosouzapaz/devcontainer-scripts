import { readJson } from '../lib/json'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { VerifyRecord } from '../../types'
import type { Unit } from '../domain/records'
import type { Evidence, UnitSlice } from '../domain/step-states'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { atomicReplace, readCommonDir, readSession, readUnit, recordsPath } from './record-store'
import { readGit } from './repository'
import type { FinishedCommand } from './run-command'
import { formatExit } from './run-view'
import { readUnitSlice } from './unit-slice'
import { readVerifyConfig, selectVerify } from './verify-config'
import { facts } from '../domain/facts'

/**
 * Checks clone-local trust for the immutable blob, across units and chats.
 * @param port - Engine calls.
 * @param blob - Config blob id.
 * @returns Whether the user approved this blob.
 */
export async function isVerifyApproved(port: EnginePort, blob: string): Promise<boolean> {
  const common = await readCommonDir(port)
  return JSON.stringify(await readJson(port.files, recordsPath(common, 'ok', `${blob}.json`))) === '{"v":1}'
}

/**
 * Shortens a config blob id to the prefix the preview prints and the approval command names.
 * @param blob - The config blob id.
 * @returns The first twelve characters.
 */
const shortenBlob = (blob: string): string => blob.slice(0, 12)

/**
 * Previews the config and blob id without an id, or approves the current blob when a seven-or-more-hex-character id prefixes it.
 * @param port - Engine calls.
 * @param id - Optional confirmed blob prefix.
 * @returns The preview or approval for the user, or the refusal.
 */
export async function approveVerify(port: EnginePort, id?: string): Promise<Result<string>> {
  const session = await readSession(port)
  if (!session.unit) return fail('No unit declared in this chat.')
  const git = await readGit(port)
  const slice = git ? await readUnitSlice(port, session.unit, await readUnit(port, session.unit), git) : null
  const loaded = await readVerifyConfig(port, slice?.tree ?? null)
  if (loaded.kind !== 'valid') return fail(loaded.fact)
  const { blob, config } = loaded
  const short = shortenBlob(blob)
  if (id === undefined) return succeed(`Verify config ${short}:\n${JSON.stringify(config, null, 2)}\nRun /flow approve verify ${short} to approve this config.`)
  if (!/^[a-fA-F0-9]{7,}$/.test(id) || !blob.startsWith(id.toLowerCase())) return fail(`Config id does not match. Current config: ${short}. Run /flow approve verify to review it.`)
  const common = await readCommonDir(port)
  if (!common) return fail('Cannot locate the repository metadata.')
  await atomicReplace(port, recordsPath(common, 'ok', `${blob}.json`), '{"v":1}')
  logEvent(port, session, 'approve', { config: blob })
  return succeed(`Verify config ${short} approved.`)
}

/**
 * Recomputes selection before accepting any stored result.
 * @param port - Engine calls.
 * @param slice - Current unit boundaries and content.
 * @param unit - Evidence merged across session files.
 * @returns The Verify verdict, whether a run on this tree and base or a config blocker ends Code, and one short fact.
 */
export async function readVerifyState(port: EnginePort, slice: UnitSlice | null, unit: Unit): Promise<Evidence['verify']> {
  const loaded = await readVerifyConfig(port, slice?.tree ?? null)
  if (loaded.kind === 'missing') return { isVerified: false, isReached: true, fact: loaded.fact, factCode: 'verify-config-missing' }
  if (loaded.kind === 'invalid') return { isVerified: false, isReached: true, fact: facts.verifyConfigInvalid, detail: loaded.fact }
  if (!await isVerifyApproved(port, loaded.blob)) {
    return { isVerified: false, isReached: true, fact: facts.verifyConfigApproval, isWaitingApproval: true, command: `/flow approve verify ${shortenBlob(loaded.blob)}` }
  }
  if (!slice?.tree) return { isVerified: false, isReached: false, fact: facts.verifyNotRun }
  // Any outcome, config or selection on this tree and base ends Code; whether it verifies the current config is judged below.
  const onSlice = unit.verifyRuns.filter(run => run.tree === slice.tree && run.base === slice.base)
  const isReached = onSlice.length > 0
  const selection = await selectVerify(port, loaded.config, slice.baseTree, slice.tree)
  const records = onSlice.filter(run => run.configBlob === loaded.blob).sort((a, b) => b.at - a.at)
  const matching = records.filter(run => JSON.stringify(run.commands) === JSON.stringify(selection.commands))
  if (matching.some(run => run.outcome.kind === 'pass')) return { isVerified: true, isReached, fact: selection.isLeftToCi ? facts.leftToCi : facts.verifyPassed }
  const outcome = records[0]?.outcome
  return { isVerified: false, isReached, isError: outcome?.kind === 'fail' || outcome?.kind === 'timeout', fact: outcome?.kind === 'timeout' ? facts.verifyTimedOut(outcome.minutes)
    : outcome?.kind === 'fail' ? (outcome.signal ? facts.verifyFailedSignal : outcome.code === null ? facts.verifyFailed : facts.verifyFailedExit(outcome.code)) : facts.verifyNotRun,
    ...(outcome?.kind === 'fail' && outcome.signal ? { detail: `failed, ${formatExit(outcome.code, outcome.signal)}` } : {}) }
}

/**
 * Converts an ended or timed-out command into its persistent outcome.
 * @param run - The command result after cancellation has been excluded.
 * @param minutes - The configured timeout duration.
 * @returns The timeout, pass, or exact process failure outcome.
 */
export function verifyOutcome(run: FinishedCommand, minutes: number): VerifyRecord['outcome'] {
  return run.kind === 'timeout' ? { kind: 'timeout', minutes } : run.code === 0 && run.signal === null ? { kind: 'pass' } : { kind: 'fail', code: run.code, signal: run.signal }
}
