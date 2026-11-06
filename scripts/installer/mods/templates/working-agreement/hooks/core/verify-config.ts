import type { VerifyStage } from '../../types'
import { parseIssuesConfig } from '../domain/issue-fields'
import type { IssuesConfig } from '../domain/issue-fields'
import { diffPaths, hashObject, runGit } from '../lib/git'
import { parseJson } from '../lib/json'
import { formatError } from '../lib/result'
import { isFiniteNumber, isNonEmptyString, isRecord, rejectUnknownFields } from '../lib/guards'
import { bestEffort } from './best-effort'
import type { EnginePort } from './engine-port'
import { readRepositoryRoot } from './repository'
import { facts } from '../domain/facts'

/** A rule's stage: which Verify runs it, both when the config leaves it out. */
type RuleStage = VerifyStage | 'both'
interface VerifyRule { paths: string[]; run: string[]; stage: RuleStage }
/** The validated config: Verify's argv and git pathspecs, and the issue-write rules. */
interface VerifyConfig { always: string[][]; rules: VerifyRule[]; timeoutMinutes: number; waitForCiLabels: string[]; issues: IssuesConfig }
interface ValidConfig { kind: 'valid'; blob: string; config: VerifyConfig }
interface MissingConfig { kind: 'missing'; fact: string }
interface InvalidConfig { kind: 'invalid'; fact: string }
/** A config as read: valid with its blob id, missing, or invalid with the error naming the field. */
type ConfigResult = ValidConfig | MissingConfig | InvalidConfig
/**
 * The commands selected for this exact slice at one stage, with the selected rules' path globs, each once; `stageNote` names the stage
 * and the matching rules of the other stage it leaves out.
 */
interface VerifySelection { commands: string[][]; description: string; isLeftToCi: boolean; paths: string[]; stageNote: string }

/** The stages a rule may name. */
const ruleStages: readonly RuleStage[] = ['unit', 'gate', 'both']
/** The timeout used when a Verify config does not specify one. */
export const defaultVerifyTimeoutMinutes = 30
/** Where the config lives, relative to the repository root. */
export const configPath = '.claude/working-agreement.json'

/**
 * Rejects malformed command arrays with a configuration field location.
 * @param value - The untrusted command value.
 * @param path - The field location for validation failures.
 * @returns The validated non-empty command arguments.
 */
function argv(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${path}: expected a non-empty argv array`)
  return value.map((item: unknown, index: number) => {
    if (!isNonEmptyString(item)) throw new Error(`${path}[${index}]: expected a non-empty string`)
    return item
  })
}

/**
 * Restricts selection patterns to non-empty relative git globs.
 * @param value - The untrusted glob list.
 * @param path - The field location for validation failures.
 * @returns The validated glob patterns.
 */
function globs(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path}: expected an array of globs`)
  return value.map((item: unknown, index: number) => {
    if (!isNonEmptyString(item) || /^[:/]/.test(item) || item.includes('..') || item.includes('\\')) throw new Error(`${path}[${index}]: invalid git glob`)
    return item
  })
}

/**
 * Validates Verify configuration and supplies defaults for omitted options.
 * @param text - The untrusted configuration JSON.
 * @returns The validated Verify configuration, rejecting malformed fields.
 */
function parseConfig(text: string): VerifyConfig {
  const parsed = parseJson(text)
  if (!parsed.isOk) throw new Error('$: invalid JSON')
  const data = parsed.value
  if (!isRecord(data)) throw new Error('$: expected an object')
  // A retired field fails instead of being ignored, so an approved config that relied on it is edited and approved again.
  const retired = ['verify', 'full'].find(key => key in data)
  if (retired !== undefined) throw new Error(`${retired}: retired field in ${configPath}, local Verify runs only rule-selected checks and leaves full suites to CI; regenerate the config, or move per-change checks into rules`)
  rejectUnknownFields(data, ['$schema', 'always', 'rules', 'timeoutMinutes', 'waitForCiLabels', 'issues'], '')
  if (data.always !== undefined && !Array.isArray(data.always)) throw new Error('always: expected an array of argv arrays')
  if (data.rules !== undefined && !Array.isArray(data.rules)) throw new Error('rules: expected an array')
  const always = (data.always ?? []).map((item, index) => argv(item, `always[${index}]`))
  const rules = (data.rules ?? []).map((rule, index) => {
    const path = `rules[${index}]`
    if (!isRecord(rule)) throw new Error(`${path}: expected an object`)
    rejectUnknownFields(rule, ['paths', 'run', 'stage'], path)
    const stage = rule.stage === undefined ? 'both' : rule.stage
    if (!ruleStages.includes(stage as RuleStage)) throw new Error(`${path}.stage: expected unit, gate or both, got ${JSON.stringify(stage)}`)
    return { paths: globs(rule.paths, `${path}.paths`), run: argv(rule.run, `${path}.run`), stage: stage as RuleStage }
  })
  const timeoutMinutes = data.timeoutMinutes === undefined ? defaultVerifyTimeoutMinutes : data.timeoutMinutes
  if (!isFiniteNumber(timeoutMinutes) || timeoutMinutes <= 0) throw new Error('timeoutMinutes: expected a positive finite number')
  const waitForCiLabels = data.waitForCiLabels === undefined ? [] : data.waitForCiLabels
  if (!Array.isArray(waitForCiLabels) || !waitForCiLabels.every(isNonEmptyString)) throw new Error('waitForCiLabels: expected an array of non-empty strings')
  return { always, rules, timeoutMinutes, waitForCiLabels, issues: parseIssuesConfig(data.issues) }
}

/**
 * Reads immutable config content, never the chat checkout's file.
 * @param port - Engine calls.
 * @param tree - The unit's content tree.
 * @returns A validated config with its blob id, or a short failing fact.
 */
export async function readVerifyConfig(port: EnginePort, tree: string | null): Promise<ConfigResult> {
  if (!tree) return { kind: 'missing', fact: facts.verifyConfigMissing }
  const ref = `${tree}:${configPath}`
  const read = await runGit(port.processes, ['cat-file', 'blob', ref])
  if (read.exitCode !== 0) return { kind: 'missing', fact: facts.verifyConfigMissing }
  try {
    const config = parseConfig(read.stdout)
    const blob = await runGit(port.processes, ['rev-parse', ref])
    if (blob.exitCode !== 0 || !blob.stdout.trim()) throw new Error('$: cannot resolve config blob')
    return { kind: 'valid', config, blob: blob.stdout.trim() }
  } catch (error) { return { kind: 'invalid', fact: formatError(error) } }
}

/**
 * Reads a config by the blob id an approval names, whatever tree holds it now.
 * @param port - Engine calls.
 * @param blob - The config blob id.
 * @returns A validated config, missing when the repository does not hold the blob, or invalid with the error naming the field.
 */
export async function readConfigBlob(port: EnginePort, blob: string): Promise<ConfigResult> {
  const read = await runGit(port.processes, ['cat-file', 'blob', blob])
  if (read.exitCode !== 0) return { kind: 'missing', fact: facts.verifyConfigMissing }
  try { return { kind: 'valid', config: parseConfig(read.stdout), blob } } catch (error) { return { kind: 'invalid', fact: formatError(error) } }
}

/**
 * Lists the programs and scripts a config runs: the first word of each command, each once.
 * @param config - A validated config.
 * @returns The runners.
 */
export const listConfigRunners = (config: VerifyConfig): string[] => [...new Set([...config.always, ...config.rules.map(rule => rule.run)].map(([runner]) => runner!))]

/**
 * Parses the working tree's config afresh on every call, so an edit shows at the next refresh; a read error counts as invalid.
 * @param port - Engine calls.
 * @param root - The repository root, or null outside a repository.
 * @returns The config with the blob id its text hashes to, missing, or invalid with the error naming the field.
 */
export async function readRepositoryConfig(port: EnginePort, root: string | null): Promise<ConfigResult> {
  const path = `${root}/${configPath}`
  if (!root || !await port.files.exists(path).catch(() => false)) return { kind: 'missing', fact: facts.verifyConfigMissing }
  try {
    const text = await port.files.read(path)
    const config = parseConfig(text)
    const blob = await hashObject(port.processes, text)
    if (blob.exitCode !== 0 || !blob.stdout.trim()) throw new Error('$: cannot hash the config')
    return { kind: 'valid', config, blob: blob.stdout.trim() }
  } catch (error) { return { kind: 'invalid', fact: formatError(error) } }
}

/**
 * Reads the working tree's config at a hook's start, where a failed read must not stop the hook.
 * @param port - Engine calls.
 * @returns The config as read, or null when the read itself failed.
 */
export const readWorkingTreeConfig = (port: EnginePort): Promise<ConfigResult | null> =>
  bestEffort(port, 'config read', async () => readRepositoryConfig(port, await readRepositoryRoot(port)), null)

/**
 * Uses git's case-sensitive glob semantics, preserving NUL-delimited filenames.
 * @param port - Engine calls.
 * @param base - Base tree.
 * @param tree - Unit tree.
 * @param paths - Optional glob filter.
 * @returns The changed paths.
 */
export async function changedPaths(port: EnginePort, base: string, tree: string, paths: string[] = []): Promise<string[]> {
  const run = await diffPaths(port.processes, base, tree, paths)
  if (run.exitCode !== 0) throw new Error(run.stderr || 'cannot read the unit change set')
  return run.stdout.split('\0').filter(Boolean)
}

/**
 * Tells a repository runner script taking only test paths, whose commands can merge into one run.
 * @param command - A selected argv.
 * @returns Whether the runner is a path and no argument is an option.
 */
const isPathRunner = ([runner, ...args]: string[]): boolean => runner!.includes('/') && !args.some(arg => arg.startsWith('-'))

/**
 * Runs each repository runner script once: its arguments name the test paths to run, so its commands merge theirs, a path inside
 * another one is dropped, and a bare run, which runs everything, absorbs the rest. Any other command runs as written, once.
 * @param commands - The selected argv in config order.
 * @returns The argv to run, each merged runner where it first appears.
 */
function mergeByRunner(commands: string[][]): string[][] {
  const unique = commands.filter((command, index) => commands.findIndex(other => JSON.stringify(other) === JSON.stringify(command)) === index)
  return unique.flatMap(command => {
    if (!isPathRunner(command)) return [command]
    const runner = command[0]!
    const runs = unique.filter(other => other[0] === runner && isPathRunner(other))
    if (runs[0] !== command) return []
    if (runs.some(run => run.length === 1)) return [[runner]]
    const args = [...new Set(runs.flatMap(([, ...rest]) => rest))]
    return [[runner, ...args.filter(arg => !args.some(other => arg.startsWith(`${other}/`)))]]
  })
}

/**
 * Tells whether a run's commands ran everything a selection asks for: each selected argv ran as written, or its runner ran bare
 * or on paths that include each selected path.
 * @param ran - The argv of the recorded run.
 * @param selected - The argv the current selection would run.
 * @returns Whether the run covers the selection.
 */
export function coversSelection(ran: string[][], selected: string[][]): boolean {
  return selected.every(command => ran.some(run => JSON.stringify(run) === JSON.stringify(command)
    || (isPathRunner(command) && isPathRunner(run) && run[0] === command[0] && (run.length === 1
      || (command.length > 1 && command.slice(1).every(path => run.slice(1).some(other => path === other || path.startsWith(`${other}/`))))))))
}

/**
 * Selects `always` plus every rule matching a changed path whose stage runs at this one; full suites are CI's, so nothing falls back
 * to them. A matching rule of the other stage is named as left out, so a reader sees what did not run and where it runs instead.
 * @param port - Engine calls.
 * @param config - Validated config.
 * @param base - Base tree, or null for a unit without a base, whose change set no rule can match.
 * @param tree - Unit tree.
 * @param stage - The Verify selecting: a unit's own, or the merge_child gate's.
 * @returns One argv per runner in config order and the selection reason.
 */
export async function selectVerify(port: EnginePort, config: VerifyConfig, base: string | null, tree: string, stage: VerifyStage): Promise<VerifySelection> {
  const isUnchanged = base !== null && !(await changedPaths(port, base, tree)).length
  const matches = await Promise.all(config.rules.map(rule => base && !isUnchanged && rule.paths.length ? changedPaths(port, base, tree, rule.paths) : []))
  const matched = config.rules.filter((_rule, index) => matches[index]!.length)
  const selected = matched.filter(rule => rule.stage === 'both' || rule.stage === stage)
  const leftOut = [...new Set(matched.filter(rule => !selected.includes(rule)).map(rule => rule.run.join(' ')))]
  const commands = mergeByRunner([...config.always, ...selected.map(rule => rule.run)])
  const isLeftToCi = !isUnchanged && !matched.length
  const paths = [...new Set(selected.flatMap(rule => rule.paths))]
  const stageNote = `${stage} stage${!leftOut.length ? '' : `${stage === 'unit' ? ' · left to the gate: ' : ' · left out as unit-only: '}${leftOut.join(', ')}`}`
  const reason = isUnchanged ? 'no change from the base' : isLeftToCi ? facts.leftToCi : paths.length ? `rules ${paths.join(', ')}` : 'no rule of this stage'
  return { commands, isLeftToCi, paths, stageNote, description: `${reason} · ${stageNote}` }
}
