import { runGit, diffPaths } from '../lib/git'
import { parseJson } from '../lib/json'
import { isFiniteNumber, isNonEmptyString, isRecord } from '../lib/guards'
import type { EnginePort } from './engine-port'

interface VerifyRule { paths: string[]; run: string[] }
/** Validated argv and git pathspecs from the unit tree. */
export interface VerifyConfig { verify: string[]; always: string[][]; full: string[]; rules: VerifyRule[]; timeoutMinutes: number }
interface ValidConfig { kind: 'valid'; blob: string; config: VerifyConfig }
type UnavailableConfigKind = 'invalid' | 'missing'
interface UnavailableConfig { kind: UnavailableConfigKind; fact: string }
type ConfigResult = ValidConfig | UnavailableConfig
/** The commands selected for this exact slice. */
export interface VerifySelection { commands: string[][]; description: string }

/** The timeout used when a Verify config does not specify one. */
export const defaultVerifyTimeoutMinutes = 30
const configPath = '.claude/working-agreement.json'

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
 * Rejects unknown configuration fields before they can silently change intent.
 * @param value - The configuration object.
 * @param allowed - The permitted field names.
 * @param path - The parent field location for validation failures.
 */
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const extra = Object.keys(value).find(key => !allowed.includes(key))
  if (extra !== undefined) throw new Error(`${path ? `${path}.` : ''}${extra}: unknown field`)
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
  keys(data, ['$schema', 'verify', 'always', 'full', 'rules', 'timeoutMinutes'], '')
  const verify = argv(data.verify, 'verify')
  if (data.always !== undefined && !Array.isArray(data.always)) throw new Error('always: expected an array of argv arrays')
  if (data.rules !== undefined && !Array.isArray(data.rules)) throw new Error('rules: expected an array')
  const always = (data.always ?? []).map((item, index) => argv(item, `always[${index}]`))
  const rules = (data.rules ?? []).map((rule, index) => {
    const path = `rules[${index}]`
    if (!isRecord(rule)) throw new Error(`${path}: expected an object`)
    keys(rule, ['paths', 'run'], path)
    return { paths: globs(rule.paths, `${path}.paths`), run: argv(rule.run, `${path}.run`) }
  })
  const timeoutMinutes = data.timeoutMinutes === undefined ? defaultVerifyTimeoutMinutes : data.timeoutMinutes
  if (!isFiniteNumber(timeoutMinutes) || timeoutMinutes <= 0) throw new Error('timeoutMinutes: expected a positive finite number')
  return { verify, always, rules, full: globs(data.full === undefined ? [] : data.full, 'full'), timeoutMinutes }
}

/**
 * Reads immutable config content, never the chat checkout's file.
 * @param port - Engine calls.
 * @param tree - The unit's content tree.
 * @returns A validated config with its blob id, or a short failing fact.
 */
export async function readVerifyConfig(port: EnginePort, tree: string | null): Promise<ConfigResult> {
  if (!tree) return { kind: 'missing', fact: 'no verify command configured' }
  const ref = `${tree}:${configPath}`
  const read = await runGit(port.processes, ['cat-file', 'blob', ref])
  if (read.exitCode !== 0) return { kind: 'missing', fact: 'no verify command configured' }
  try {
    const config = parseConfig(read.stdout)
    const blob = await runGit(port.processes, ['rev-parse', ref])
    if (blob.exitCode !== 0 || !blob.stdout.trim()) throw new Error('$: cannot resolve config blob')
    return { kind: 'valid', config, blob: blob.stdout.trim() }
  } catch (error) { return { kind: 'invalid', fact: error instanceof Error ? error.message : String(error) } }
}

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
 * Selects every matching rule, falling back to full verification for uncovered changes; an unchanged slice selects only `always`.
 * @param port - Engine calls.
 * @param config - Validated config.
 * @param base - Base tree, or null for a unit without a base.
 * @param tree - Unit tree.
 * @returns Deduplicated argv in config order and the selection reason.
 */
export async function selectVerify(port: EnginePort, config: VerifyConfig, base: string | null, tree: string): Promise<VerifySelection> {
  const changes = base ? await changedPaths(port, base, tree) : []
  const matches = await Promise.all(config.rules.map(rule => base && rule.paths.length ? changedPaths(port, base, tree, rule.paths) : []))
  const covered = new Set(matches.flat())
  const fullPaths = base && config.full.length ? await changedPaths(port, base, tree, config.full) : []
  const reason = !base ? 'no base' : !config.rules.length ? 'no rules' : fullPaths.length ? 'full path changed' : changes.some(path => !covered.has(path)) ? 'unmatched file' : null
  const isUnchanged = Boolean(base) && !changes.length
  const selected = config.rules.filter((_rule, index) => matches[index]!.length)
  const commands = [...config.always, ...(isUnchanged ? [] : reason ? [config.verify] : selected.map(rule => rule.run))]
    .filter((command, index, all) => all.findIndex(other => JSON.stringify(other) === JSON.stringify(command)) === index)
  return { commands, description: isUnchanged ? 'no change from the base' : reason ? `full (${reason})` : `rules ${selected.flatMap(rule => rule.paths).join(', ')}` }
}
