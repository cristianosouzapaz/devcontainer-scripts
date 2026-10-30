import { readJson } from '../lib/json'
import { formatIssueReferences } from '../domain/messages'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { Identity, VerifyEvidence, VerifyRecord } from '../../types'
import { parseVerifyEvidence } from '../domain/records'
import type { Unit } from '../domain/records'
import type { Evidence, UnitSlice } from '../domain/step-states'
import type { EnginePort } from './engine-port'
import { logEvent } from './flow-log'
import { atomicReplace, readCommonDir, readSession, readUnit, recordsPath, updateUnits } from './record-store'
import { readGit } from './repository'
import { hashObject } from '../lib/git'
import type { FinishedCommand } from './run-command'
import { formatExit } from './run-view'
import { readUnitSlice } from './unit-slice'
import { coversSelection, readVerifyConfig, selectVerify } from './verify-config'
import { facts } from '../domain/facts'

/** The content of an approval record; any other content approves nothing. */
const approvalText = '{"v":1}'

/**
 * Checks clone-local trust for the immutable blob, across units and chats.
 * @param port - Engine calls.
 * @param blob - Config blob id.
 * @returns Whether the user approved this blob.
 */
export async function isVerifyApproved(port: EnginePort, blob: string): Promise<boolean> {
  const common = await readCommonDir(port)
  return JSON.stringify(await readJson(port.files, approvalPath(common, blob))) === approvalText
}

/**
 * Names a config blob's approval record.
 * @param common - The git common directory.
 * @param blob - The config blob id.
 * @returns The file path.
 */
const approvalPath = (common: string | null, blob: string): string => recordsPath(common, 'ok', `${blob}.json`)

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
  await atomicReplace(port, approvalPath(common, blob), approvalText)
  const { tree, base } = slice ?? {}
  if (tree) await updateUnits(port, session, unit => ({ ...unit, verifyApproved: { tree, base: base ?? null } }))
  logEvent(port, session, 'approve', { config: blob })
  return succeed(`Verify config ${short} approved.`)
}

/**
 * Names the repository-wide evidence file of one content key, so a run counts for every unit on the same tree, config and selection.
 * @param port - Engine calls.
 * @param common - The git common directory.
 * @param key - The tree, config blob and selected commands the run is bound to.
 * @returns The evidence file path.
 */
async function evidencePath(port: EnginePort, common: string, key: Pick<VerifyRecord, 'tree' | 'configBlob' | 'commands'>): Promise<string> {
  const run = await hashObject(port.processes, JSON.stringify([key.tree, key.configBlob, key.commands]))
  if (run.exitCode !== 0 || !run.stdout.trim()) throw new Error(run.stderr || 'cannot hash the Verify key')
  return recordsPath(common, 'v', `${run.stdout.trim()}.json`)
}

/**
 * Replaces the evidence of a run's content key with that run, the latest on the key.
 * @param port - Engine calls.
 * @param run - The recorded run.
 * @param origin - The unit the run ran in.
 */
export async function writeVerifyEvidence(port: EnginePort, run: VerifyRecord, origin: Identity): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  const evidence: VerifyEvidence = { v: 1, run, origin }
  await atomicReplace(port, await evidencePath(port, common, run), JSON.stringify(evidence))
}

/**
 * Reads the latest run of any unit on a content key.
 * @param port - Engine calls.
 * @param key - The tree, config blob and selected commands.
 * @returns The evidence, or null when none is recorded or readable.
 */
async function readVerifyEvidence(port: EnginePort, key: Pick<VerifyRecord, 'tree' | 'configBlob' | 'commands'>): Promise<VerifyEvidence | null> {
  const common = await readCommonDir(port)
  return common ? parseVerifyEvidence(await evidencePath(port, common, key).then(path => readJson(port.files, path)).catch(() => null)) : null
}

/**
 * Names a unit by its issues, or by its branch when it has none.
 * @param identity - The unit identity.
 * @returns The label, such as `#460`.
 */
const nameUnit = (identity: Identity): string => identity.issues.length ? formatIssueReferences(identity.issues, ' ') : identity.branch

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
  const selection = await selectVerify(port, loaded.config, slice.baseTree, slice.tree)
  const shared = await readVerifyEvidence(port, { tree: slice.tree, configBlob: loaded.blob, commands: selection.commands })
  const isOwn = (run: VerifyRecord): boolean => unit.verifyRuns.some(own => own.runId === run.runId)
  const foreign = shared && !isOwn(shared.run) ? shared : null
  // Any outcome, config or selection on this tree and base ends Code, and so do another unit's run on this content and the config
  // approval Verify waited on here; whether it verifies is judged below.
  // why: The base only selects the commands, so a run on this tree under an earlier base, as before a merge commit moved it,
  // still stands when its config ran every command the current selection asks for.
  const onSlice = unit.verifyRuns.filter(run => run.tree === slice.tree
    && (run.base === slice.base || (run.configBlob === loaded.blob && coversSelection(run.commands, selection.commands))))
  const isApprovedHere = unit.verifyApproved?.tree === slice.tree && unit.verifyApproved.base === slice.base
  const isReached = onSlice.length > 0 || !!foreign || isApprovedHere
  const records = [...onSlice.filter(run => run.configBlob === loaded.blob), ...(foreign ? [foreign.run] : [])].sort((a, b) => b.at - a.at)
  const matching = records.filter(run => coversSelection(run.commands, selection.commands))
  const decider = matching[0]
  const run = decider ? { run: `${decider.runId} in ${decider === foreign?.run ? nameUnit(foreign.origin) : 'this unit'}` } : {}
  if (decider?.outcome.kind === 'pass') {
    return { isVerified: true, isReached, fact: selection.isLeftToCi ? facts.leftToCi : decider !== foreign?.run ? facts.verifyPassed
      : foreign.origin.issues[0] ? facts.verifyPassedIn(foreign.origin.issues[0]) : facts.verifyPassedElsewhere, ...run }
  }
  const outcome = records[0]?.outcome
  return { isVerified: false, isReached, isError: outcome?.kind === 'fail' || outcome?.kind === 'timeout', fact: outcome?.kind === 'timeout' ? facts.verifyTimedOut(outcome.minutes)
    : outcome?.kind === 'fail' ? (outcome.signal ? facts.verifyFailedSignal : outcome.code === null ? facts.verifyFailed : facts.verifyFailedExit(outcome.code)) : facts.verifyNotRun,
    ...(outcome?.kind === 'fail' && outcome.signal ? { detail: `failed, ${formatExit(outcome.code, outcome.signal)}` } : {}), ...run }
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
