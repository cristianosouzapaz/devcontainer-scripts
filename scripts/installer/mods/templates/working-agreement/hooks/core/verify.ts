import { readJson } from '../lib/json'
import { formatIssueReferences } from '../domain/messages'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import type { Identity, VerifyEvidence, VerifyRecord, VerifyStage } from '../../types'
import { parseVerifyEvidence, sameIdentity } from '../domain/records'
import type { Unit } from '../domain/records'
import type { Evidence, UnitSlice } from '../domain/step-states'
import type { EnginePort } from './engine-port'
import { atomicReplace, readCommonDir, readSession, readUnit, recordsPath } from './record-store'
import { readGit, readRepositoryRoot } from './repository'
import { hashObject, runGit } from '../lib/git'
import type { FinishedCommand } from './run-command'
import { formatExit } from './run-view'
import { readRunDisplay, sessionMemory } from './session-memory'
import { readUnitSlice } from './unit-slice'
import { configPath, coversSelection, listConfigRunners, readConfigBlob, readRepositoryConfig, readVerifyConfig, readWorkingTreeConfig, selectVerify } from './verify-config'
import { approvalScript } from '../domain/bash-guards'
import { quoteIfNeeded } from '../lib/shell'
import { facts } from '../domain/facts'
import { isOwnTurnLive } from './verify-queue'

/** Binds shared evidence to content and to the stage it ran at, so a pass at one stage never stands for the other. */
interface EvidenceKey extends Pick<VerifyRecord, 'tree' | 'configBlob' | 'commands'> { stage: VerifyStage }

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
 * Lists the programs and scripts the user's approved Verify configs run, which a delegated unit may only start through the queue.
 * @param port - Engine calls.
 * @returns The runners; the working tree's config adds its own when an approval cannot be read back to a valid config.
 */
export async function readApprovedRunners(port: EnginePort): Promise<string[]> {
  const common = await readCommonDir(port)
  const names = common ? await port.files.list(recordsPath(common, 'ok')).then(entries => entries.map(entry => entry.name), () => null) : null
  const blobs = (names ?? []).filter(name => /^[0-9a-f]+\.json$/.test(name)).map(name => name.slice(0, -'.json'.length))
  const approved = (await Promise.all(blobs.map(async blob => await isVerifyApproved(port, blob) ? readConfigBlob(port, blob) : null))).filter(loaded => loaded !== null)
  const configs = approved.flatMap(loaded => loaded.kind === 'valid' ? [loaded.config] : [])
  // why: a unit can edit its own tree's config, so that copy only ever adds runners, and only when the approved ones cannot all be read.
  const tree = names !== null && configs.length && configs.length === approved.length ? null : await readWorkingTreeConfig(port)
  return [...new Set([...configs, ...tree?.kind === 'valid' ? [tree.config] : []].flatMap(listConfigRunners))]
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
 * Names the terminal command that approves a config: the mod's approval script, by its absolute path, and the config's id.
 * @param port - Engine calls.
 * @param blob - The config blob id.
 * @returns The command line the user runs in their own terminal.
 */
export async function composeApprovalCommand(port: EnginePort, blob: string): Promise<string> {
  return `bash ${quoteIfNeeded(`${await port.readPluginRoot()}/scripts/${approvalScript}`)} ${shortenBlob(blob)}`
}

/**
 * Reads the config a preview shows: the unit tree's, or without a unit the working tree's, stored in the object database so the
 * approval script finds it by its id.
 * @param port - Engine calls.
 * @returns The config as read.
 */
async function readPreviewedConfig(port: EnginePort): Promise<Awaited<ReturnType<typeof readVerifyConfig>>> {
  const session = await readSession(port)
  const git = await readGit(port)
  if (session.unit) {
    const slice = git ? await readUnitSlice(port, session.unit, await readUnit(port, session.unit), git) : null
    return readVerifyConfig(port, slice?.tree ?? null)
  }
  const root = await readRepositoryRoot(port)
  const loaded = await readRepositoryConfig(port, root)
  if (loaded.kind !== 'valid') return loaded
  const stored = await runGit(port.processes, ['hash-object', '-w', '--stdin'], await port.files.read(`${root}/${configPath}`))
  return stored.exitCode === 0 && stored.stdout.trim() === loaded.blob ? loaded : { kind: 'invalid', fact: '$: cannot store the config for its approval' }
}

/**
 * Shows the config, its id and the terminal command that approves it; approving is never done here, since any agent can type
 * into any pane.
 * @param port - Engine calls.
 * @returns The preview for the user, or the reason there is no config to show.
 */
export async function previewVerify(port: EnginePort): Promise<Result<string>> {
  const loaded = await readPreviewedConfig(port)
  if (loaded.kind !== 'valid') return fail(loaded.fact)
  const { blob, config } = loaded
  const preview = `Verify config ${shortenBlob(blob)}:\n${JSON.stringify(config, null, 2)}\n`
  if (await isVerifyApproved(port, blob)) return succeed(`${preview}It is approved for this clone.`)
  return succeed(`${preview}Approve it from your own terminal, never from a session: ${await composeApprovalCommand(port, blob)}`)
}

/**
 * Names the repository-wide evidence file of one content key, so a run counts for every unit on the same tree, config, selection and
 * stage.
 * @param port - Engine calls.
 * @param common - The git common directory.
 * @param key - The tree, config blob, selected commands and stage the run is bound to.
 * @returns The evidence file path.
 */
async function evidencePath(port: EnginePort, common: string, key: EvidenceKey): Promise<string> {
  const run = await hashObject(port.processes, JSON.stringify([key.tree, key.configBlob, key.commands, key.stage]))
  if (run.exitCode !== 0 || !run.stdout.trim()) throw new Error(run.stderr || 'cannot hash the Verify key')
  return recordsPath(common, 'v', `${run.stdout.trim()}.json`)
}

/**
 * Replaces the evidence of a run's content key with that run, the latest on the key.
 * @param port - Engine calls.
 * @param run - The recorded run.
 * @param origin - The unit the run ran in.
 */
export async function writeVerifyEvidence(port: EnginePort, run: VerifyRecord & EvidenceKey, origin: Identity): Promise<void> {
  const common = await readCommonDir(port)
  if (!common) return
  const evidence: VerifyEvidence = { v: 1, run, origin }
  await atomicReplace(port, await evidencePath(port, common, run), JSON.stringify(evidence))
}

/**
 * Reads the latest run of any unit on a content key.
 * @param port - Engine calls.
 * @param key - The tree, config blob, selected commands and stage.
 * @returns The evidence, or null when none is recorded or readable.
 */
export async function readVerifyEvidence(port: EnginePort, key: EvidenceKey): Promise<VerifyEvidence | null> {
  const common = await readCommonDir(port)
  return common ? parseVerifyEvidence(await evidencePath(port, common, key).then(path => readJson(port.files, path)).catch(() => null)) : null
}

/**
 * Names a unit by its issues, or by its branch when it has none.
 * @param identity - The unit identity.
 * @returns The label, such as `#<n>`.
 */
const nameUnit = (identity: Identity): string => identity.issues.length ? formatIssueReferences(identity.issues, ' ') : identity.branch

/**
 * Recomputes selection before accepting any stored result.
 * @param port - Engine calls.
 * @param slice - Current unit boundaries and content.
 * @param unit - Evidence merged across session files.
 * @param identity - The declared unit, whose live Verify run in this session holds the slice.
 * @returns The Verify verdict, whether a run on this tree and base or a config blocker ends Code, and one short fact, absent before any run.
 */
export async function readVerifyState(port: EnginePort, slice: UnitSlice | null, unit: Unit, identity?: Identity | null): Promise<Evidence['verify']> {
  const loaded = await readVerifyConfig(port, slice?.tree ?? null)
  if (loaded.kind === 'missing') return { isVerified: false, isReached: true, fact: loaded.fact, factCode: 'verify-config-missing' }
  if (loaded.kind === 'invalid') return { isVerified: false, isReached: true, fact: facts.verifyConfigInvalid, detail: loaded.fact }
  if (!await isVerifyApproved(port, loaded.blob)) {
    const approval = await composeApprovalCommand(port, loaded.blob)
    // why: Yellow says the user blocks the unit, so the wait shows only once the unit has nothing else to do: its turn ended, or its
    // Verify call was refused for this config. Until then the unapproved config is a note on Code, which stays current.
    // The turn and the Verify call are this session's own, so another unit judged from here, as a coordinator does, reads as waiting.
    const own = (await readSession(port)).unit
    const isOwnUnit = !!identity && !!own && sameIdentity(own, identity)
    if (isOwnUnit && sessionMemory.isTurnLive && sessionMemory.verifyAskedBlob !== loaded.blob) return { isVerified: false, isReached: false, approval, approvalBlob: loaded.blob }
    return { isVerified: false, isReached: true, fact: facts.verifyConfigApproval, isWaitingApproval: true, approval, approvalBlob: loaded.blob }
  }
  if (!slice?.tree) return { isVerified: false, isReached: false }
  // why: A started run records nothing until it ends, yet it already holds the change; older records on its tree no longer decide.
  if (await isLiveVerifyOn(port, slice, unit, identity)) return { isVerified: false, isReached: true, isRunning: true }
  const selection = await selectVerify(port, loaded.config, slice.baseTree, slice.tree, 'unit')
  const shared = await readVerifyEvidence(port, { tree: slice.tree, configBlob: loaded.blob, commands: selection.commands, stage: 'unit' })
  const isOwn = (run: VerifyRecord): boolean => unit.verifyRuns.some(own => own.runId === run.runId)
  const foreign = shared && !isOwn(shared.run) ? shared : null
  // Any outcome, config or selection on this tree and base ends Code, and so does another unit's run on this content; whether it
  // verifies is judged below.
  // why: The base only selects the commands, so a run on this tree under an earlier base, as before a merge commit moved it,
  // still stands when its config ran every command the current selection asks for.
  const onSlice = unit.verifyRuns.filter(run => run.tree === slice.tree
    && (run.base === slice.base || (run.configBlob === loaded.blob && coversSelection(run.commands, selection.commands))))
  const isReached = onSlice.length > 0 || !!foreign
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
    : outcome?.kind === 'fail' ? (outcome.signal ? facts.verifyFailedSignal : outcome.code === null ? facts.verifyFailed : facts.verifyFailedExit(outcome.code)) : undefined,
    ...(outcome?.kind === 'fail' && outcome.signal ? { detail: `failed, ${formatExit(outcome.code, outcome.signal)}` } : {}), ...run }
}

/**
 * Tells whether this session's Verify run of the unit is running on the slice's tree and base while it holds a live queue turn.
 * @param port - Engine calls.
 * @param slice - Current unit boundaries and content.
 * @param unit - The unit, whose generation the run display belongs to.
 * @param identity - The declared unit.
 * @returns Whether the live run holds the slice.
 */
async function isLiveVerifyOn(port: EnginePort, slice: UnitSlice, unit: Unit, identity: Identity | null | undefined): Promise<boolean> {
  const display = await readRunDisplay(port, identity, unit.generation)
  const live = display?.live
  return live?.kind === 'Verify' && live.status === 'running' && live.tree === slice.tree && display?.base === slice.base && await isOwnTurnLive(port)
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
