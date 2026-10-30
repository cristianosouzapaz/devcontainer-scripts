import { createReadPort } from './read-port'
import type { IssueInfo } from '../../types'
import { readJson } from '../lib/json'
import { isRecord } from '../lib/guards'
import { bestEffort } from './best-effort'
import type { ErrorWindow } from './session-memory'
import { labelViolation } from './guarantees'
import type { EnginePort } from './engine-port'
import { readGithubFailure, readGithubStatus } from './github-sync'
import { reread } from './pane-view'
import { locatePosition } from './position'
import { readGit, readRepositoryRoot } from './repository'
import { readSession, unitLogPath } from './record-store'
import { sessionMemory } from './session-memory'
import { readSpawnMode } from './spawn'
import { isVerifyApproved } from './verify'
import { configPath, readRepositoryConfig, readVerifyConfig, selectVerify } from './verify-config'
import { readBranchProtection, readBranchRulesets } from '../lib/github'
import { findWorktreeRoot } from '../lib/git'
import { describeBaseMismatch, readCandidates, selectBasePullRequest } from './unit-github'
import { readDismissals } from './violation-store'
import { fail } from '../lib/result'
import { keyedLine } from '../ui/status-text'
import { formatLocalTime } from '../lib/time'

/**
 * Keeps object identifiers compact in diagnostic status rows.
 * @param value - The full identifier.
 * @returns The identifier's first seven characters.
 */
const short = (value: string): string => value.slice(0, 7)
/**
 * Makes diagnostic timestamps readable in the user's local timezone.
 * @param at - The observation time in milliseconds, or null if never observed.
 * @returns The local timestamp with timezone offset, or never.
 */
const time = (at: number | null): string => at === null ? 'never' : formatLocalTime(at, true)

/**
 * Keeps repeated failures and their observation window visible in status output.
 * @param label - The status row label.
 * @param operation - The operation that failed.
 * @param window - The accumulated failure window, if any.
 * @returns The aligned failure row, or null without failures.
 */
function formatErrorWindow(label: string, operation: string, window: ErrorWindow | null): string | null {
  return window ? keyedLine(label, `${operation} · ${time(window.lastSeen)} · since ${time(window.firstSeen)} · ×${window.failures} · ${window.error}`) : null
}

/**
 * Distinguishes unreadable issue facts from unknown GitHub state.
 * @param info - The issue facts or read failure, if available.
 * @returns The lowercase state or an unreadable or unknown marker.
 */
function issueState(info: IssueInfo | undefined): string {
  return !info || 'error' in info ? 'unreadable' : (info.state ?? 'unknown').toLowerCase()
}

/**
 * Names the branch the session unit's PR merges into.
 * @param port - The engine calls.
 * @param defaultBranch - The default branch, which applies without a single selected PR.
 * @returns The PR's base, or the default branch.
 */
async function readUnitBase(port: EnginePort, defaultBranch: string): Promise<string> {
  const session = await readSession(port)
  const candidates = session.unit ? await readCandidates(port, session.unit.branch) : null
  const chosen = candidates?.isOk ? selectBasePullRequest(candidates.value) : null
  return chosen?.isOk && chosen.value ? chosen.value.baseRefName : defaultBranch
}

/**
 * Refreshes and renders the facts that are deliberately outside the pane.
 * @param port - The engine calls.
 * @returns Keyed status groups as plain text.
 */
export async function renderFlowStatus(port: EnginePort): Promise<string> {
  const statusPort = createReadPort(port)
  const git = await readGit(statusPort)
  const control = new AbortController()
  // An abort ends the wait.
  const deadline = port.clock.sleep(30000, control.signal).then(() => true).catch(() => false)
  const shown = { base: git?.base }
  // The unit's PR base, once it has a PR, is the branch whose rules apply.
  const target = git ? readUnitBase(statusPort, git.base).then(base => { shown.base = base; return base }) : null
  const reads = Promise.all([
    bestEffort(port, 'status reread', () => reread(statusPort, true, true), undefined),
    readGithubStatus(statusPort, true),
    target ? target.then(base => readBranchRulesets(statusPort.processes, base)) : Promise.resolve(fail('not in a repository')),
    target ? target.then(base => readBranchProtection(statusPort.processes, base)) : Promise.resolve(fail('not in a repository')),
  ]).then(([, github, rules, classic]) => ({ github, rules, classic }))
  const result = await Promise.race([deadline, reads])
  const timedOut = typeof result === 'boolean'
  control.abort()
  const session = await readSession(port)
  const position = session.flow ? await locatePosition(statusPort, session, true) : null
  const groups: string[][] = []
  if (position && session.unit) {
    const issues = session.issues.map(issue => `#${issue} ${issueState(session.info[String(issue)])}`).join(' · ')
    const slice = position.slice
    const candidate = [...sessionMemory.candidates.values()].flatMap(value => value.result.isOk ? value.result.value : []).find(pr => pr.number === position.pullRequest?.number)
    const mismatch = describeBaseMismatch(position.unit, candidate) ? ` · base from ${position.unit.baseBranch}, PR into ${candidate?.baseRefName}` : ''
    const sliceText = !slice ? 'none' : `${slice.base ? short(slice.base) : 'none'}..${short(slice.end)}${slice.base && slice.isRewritten ? ' · base not in history' : slice.commits === 0 ? ' · empty' : ''}${mismatch}`
    const rows = [...(issues ? [keyedLine('Issue', issues)] : []), keyedLine('Slice', sliceText)]
    const root = await findWorktreeRoot(statusPort.processes, session.unit.branch) ?? null
    if (root) rows.push(keyedLine('Worktree', root))
    if (candidate) rows.push(keyedLine('PR', candidate.url))
    if (position.verify.queued) rows.push(keyedLine('Verify', position.verify.queued))
    if (position.verify.run) rows.push(keyedLine('Run', position.verify.run))
    const mode = await readSpawnMode(statusPort, session.issues)
    if (mode) rows.push(keyedLine('Spawned', `in ${mode} mode`))
    rows.push(keyedLine('Log', await unitLogPath(statusPort, session.unit)))
    const checks = slice ? sessionMemory.checks.get(slice.end)?.result : undefined
    if (slice && checks?.isOk && checks.value.length) rows.push(keyedLine('CI', `${short(slice.end)} · ${checks.value.map(check => `${check.name}: ${check.state}`).join(' · ')}`))
    groups.push(rows)
    const config = await readVerifyConfig(statusPort, slice?.tree ?? null)
    if (config.kind === 'valid') {
      const approved = await isVerifyApproved(port, config.blob)
      const selection = await selectVerify(statusPort, config.config, slice?.baseTree ?? null, slice?.tree ?? '')
      // Code spans keep a glob's `**` from reading as markdown bold.
      const reason = selection.paths.length ? `rules ${selection.paths.map(path => `\`${path}\``).join(', ')}` : selection.description
      groups.push([keyedLine('Config', `${configPath} @ blob ${short(config.blob)} · ${approved ? 'approved' : 'needs /flow approve verify'}`), keyedLine('Selection', selection.commands.length ? `${selection.commands.map(command => command.join(' ')).join(' · ')} · ${reason}` : `none: ${reason}`)])
    } else groups.push([keyedLine('Config', `${configPath} · ${config.kind === 'missing' ? 'not found in the unit tree' : `invalid: ${config.fact}`}`), keyedLine('Selection', 'none: verify refuses until a config exists')])
  }
  const root = await readRepositoryRoot(statusPort)
  const repository = await readRepositoryConfig(statusPort, root)
  // The working tree's file, which the pane flags with or without a unit; the unit tree's copy is the Config row above.
  if (repository.kind === 'invalid') groups.push([keyedLine('Config', `${configPath} in the working tree · invalid: ${repository.fact} · fix that field, or update the mod to the version the file was written for`)])
  else if (repository.kind === 'valid' && !await isVerifyApproved(port, repository.blob)) {
    groups.push([keyedLine('Issues', `${configPath} in the working tree is not approved · issue writes use the built-in defaults until /flow approve verify`)])
  }
  const lastOk = `last ok ${time(sessionMemory.githubLastOk)}`
  const failure = timedOut ? null : readGithubFailure(result.github)
  // The pane's phrase, with the dates a diagnostic row needs.
  const github = timedOut ? `${lastOk} · timed out after 30 s` : !failure ? lastOk
    : `${lastOk} · read failed (${failure.reason})${failure.readAt === null ? '' : ` · facts from ${time(failure.readAt)}`}`
  const base = shown.base
  const rules = timedOut ? fail('timed out after 30 s') : result.rules
  const classic = timedOut ? fail('timed out after 30 s') : result.classic
  groups.push([keyedLine('GitHub', github), ...(rules.isOk ? (rules.value.length ? rules.value.map(rule => keyedLine('Rulesets', `${base} · ${rule.types.join(', ')} · you can bypass: ${rule.bypass ?? 'unknown'}`)) : [keyedLine('Rulesets', `${base} · no active rules`)]) : [keyedLine('Rulesets', `not read: ${rules.error}`)]), keyedLine('Classic', classic.isOk ? `${base} · protection ${classic.value ? 'on' : 'off'}` : `not read: ${classic.error}`)])
  const dismissed = await readDismissals(port)
  const violations = [...(session.violations ?? [])].sort((left, right) => Number(dismissed.has(left.factId) || left.kind === 'unchecked') - Number(dismissed.has(right.factId) || right.kind === 'unchecked') || right.end - left.end)
  if (violations.length) groups.push(violations.map(record => keyedLine('Violation', `${labelViolation(record, root ?? undefined)} · ${time(record.end)} · ${[...record.toolUseIds, ...(record.agentIds ?? [])].join(', ')} · ${dismissed.has(record.factId) ? 'dismissed' : record.kind === 'unchecked' ? 'unchecked' : 'open'}`)))
  const errors = [formatErrorWindow('herdr', 'report-metadata', sessionMemory.herdrError),
    formatErrorWindow('herdr', 'worktree create', sessionMemory.worktreeError),
    formatErrorWindow('Records', 'record write', sessionMemory.recordError),
    formatErrorWindow('Log', 'log append', sessionMemory.logError),
    session.handoff?.state === 'failed' ? keyedLine('Handoff', `handoff not completed · ${session.handoff.reason}`) : null].filter((value): value is string => value !== null)
  if (errors.length) groups.push(errors)
  // why: A missing or unreadable manifest shows the version unknown, the safe direction for a display-only record; bestEffort logs a failure.
  const manifest = await bestEffort(port, 'manifest read', async () => readJson(port.files, `${await port.readPluginRoot()}/.claude-plugin/plugin.json`), undefined)
  const ahead = sessionMemory.modulesAhead
  groups.push([keyedLine('Mod', isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : 'unknown'),
    keyedLine('Guards', ahead === null ? 'module order unknown after a plugin refresh · coordinator and delegation refused until the session restarts'
      : ahead.length ? `overridden by ${ahead.join(', ')}, hooks modules ahead · coordinator and delegation refused` : 'outermost hooks module')])
  return groups.map(group => group.join('\n')).join('\n\n')
}
