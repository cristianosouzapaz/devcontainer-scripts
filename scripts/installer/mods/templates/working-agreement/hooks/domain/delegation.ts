import type { DelegationScope, ScopeHost } from '../../types'

import { hasOnlyKeys, isNonEmptyString, isRecord, isSafeInteger } from '../lib/guards'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { appendInstructions, formatIssueReferences, modToolPrefix } from './messages'

export type { DelegationScope } from '../../types'

/** Whether a scope's coordinator still runs: `unknown` where its process cannot be judged, which counts as gone. */
export type CoordinatorLiveness = 'live' | 'gone' | 'unknown'

/**
 * What `/flow delegate` asks: revoke the scope, or add the named issues (none names the issues the coordinator creates),
 * handing over their triage too after `triage`, with the user's free text after the numbers.
 */
export type DelegateRequest = { kind: 'stop' } | { kind: 'add'; issues: number[]; isTriage: boolean; instructions: string }

/** The mod tool that proposes `/flow delegate` in the prompt box. */
export const suggestDelegateTool = `${modToolPrefix}suggest_delegate`

const usage = 'Usage: /flow delegate [#n …] [text] | /flow delegate triage #n … [text] | /flow delegate stop.'
/** Triage labels the coordinator and delegated units never set or remove, even with triage handed over. */
const userOnlyTriage = ['ready-for-human', 'wontfix']

/**
 * Validates a delegation scope read from disk with exactly its keys.
 * @param value - The decoded JSON.
 * @returns The scope, or null.
 */
export function parseScope(value: unknown): DelegationScope | null {
  if (!isRecord(value)) return null
  const host = value.host === undefined ? undefined : parseHost(value.host)
  return hasOnlyKeys(value, ['v', 'sessionId', 'issues', 'coversCreated', 'isPushUnguarded', 'triage', 'instructions', 'paneId', 'host']) && value.v === 1 && isNonEmptyString(value.sessionId)
    && Array.isArray(value.issues) && value.issues.every(issue => isSafeInteger(issue) && issue > 0) && typeof value.coversCreated === 'boolean'
    && (value.isPushUnguarded === undefined || value.isPushUnguarded === true)
    && (value.triage === undefined || Array.isArray(value.triage) && value.triage.length > 0 && value.triage.every(issue => isSafeInteger(issue) && issue > 0))
    && (value.instructions === undefined || Array.isArray(value.instructions) && value.instructions.length > 0 && value.instructions.every(isNonEmptyString))
    && (value.paneId === undefined || isNonEmptyString(value.paneId)) && host !== null
    ? { v: 1, sessionId: value.sessionId, issues: value.issues as number[], coversCreated: value.coversCreated, ...(value.isPushUnguarded ? { isPushUnguarded: true as const } : {}),
      ...(value.triage ? { triage: value.triage as number[] } : {}), ...(value.instructions ? { instructions: value.instructions as string[] } : {}),
      ...(value.paneId ? { paneId: value.paneId } : {}), ...(host ? { host } : {}) } : null
}

/**
 * Validates a coordinator's process identity with exactly its keys.
 * @param value - The decoded JSON.
 * @returns The identity, or null.
 */
function parseHost(value: unknown): ScopeHost | null {
  return isRecord(value) && hasOnlyKeys(value, ['pidns', 'pid', 'pidStart', 'bootId']) && isNonEmptyString(value.pidns) && isSafeInteger(value.pid) && value.pid > 0
    && isNonEmptyString(value.pidStart) && isNonEmptyString(value.bootId) ? { pidns: value.pidns, pid: value.pid, pidStart: value.pidStart, bootId: value.bootId } : null
}

/**
 * Reads the text after `/flow delegate`: the issue numbers first, then the user's free text, kept verbatim.
 * @param text - The command's arguments after the subcommand, trimmed.
 * @returns The request, or the usage when `triage` names no issue.
 */
export function parseDelegateRequest(text: string): Result<DelegateRequest> {
  if (text === 'stop') return succeed({ kind: 'stop' })
  const [, triage = '', numbers = '', instructions = ''] = /^(triage(?:\s+|$))?((?:#?[1-9]\d*(?:\s+|$))*)([\s\S]*)$/.exec(text) ?? []
  const issues = numbers.split(/\s+/).filter(Boolean).map(word => Number(word.replace('#', '')))
  if (triage && !issues.length) return fail(usage)
  return succeed({ kind: 'add', issues, isTriage: Boolean(triage), instructions })
}

/**
 * Widens a scope by a request; a request without numbers makes it cover the issues the coordinator creates from then on.
 * @param scope - The current scope, or null before the first `/flow delegate`.
 * @param sessionId - The coordinator session.
 * @param issues - The issues to add.
 * @param isPushUnguarded - Whether no ruleset requires signed commits; the scope's own answer when omitted.
 * @param isTriage - Whether the issues' triage is handed over too.
 * @param instructions - The user's free text, recorded after the scope's earlier ones; empty records none.
 * @param paneId - The coordinator's herdr pane; the scope's own when omitted.
 * @returns The widened scope.
 */
export function widenScope(scope: DelegationScope | null, sessionId: string, issues: number[], isPushUnguarded = scope?.isPushUnguarded ?? false, isTriage = false,
  instructions = '', paneId = scope?.paneId): DelegationScope {
  const triage = mergeIssues(scope?.triage ?? [], isTriage ? issues : [])
  const recorded = [...scope?.instructions ?? [], ...instructions ? [instructions] : []]
  return { v: 1, sessionId, issues: mergeIssues(scope?.issues ?? [], issues), coversCreated: (scope?.coversCreated ?? false) || !issues.length,
    ...isPushUnguarded ? { isPushUnguarded: true as const } : {}, ...triage.length ? { triage } : {}, ...recorded.length ? { instructions: recorded } : {},
    ...paneId ? { paneId } : {}, ...scope?.host ? { host: scope.host } : {} }
}

/**
 * Writes the prompt `/flow delegate` submits to the coordinator; the same request always writes the same bytes.
 * @param issues - The issues the request named; none means the issues the coordinator creates.
 * @param instructions - The user's free text, appended verbatim; empty appends nothing.
 * @returns The prompt.
 */
export function composeDelegatePrompt(issues: number[], instructions: string): string {
  const named = issues.length ? `the delegated issues ${formatIssueReferences(issues, ' ')}` : 'each issue you create, once it exists,'
  return appendInstructions(`Start ${named} with ${modToolPrefix}spawn, in blocked-by order, which ${modToolPrefix}plan shows with the base each would get: an issue no open issue blocks first, ` +
    'and an issue another one blocks only once its blocker\'s unit has a commit, so its unit starts from that branch. Spawn refuses an issue that is not ready-for-agent: leave it until it is. ' +
    'Give each unit its rules in spawn\'s instructions, so its first turn starts with them: a unit_prompt sent after spawn waits behind that turn. ' +
    `Answer each unit's question through the delegated-decision path: post the decision on its issue with ${modToolPrefix}issue_comment ` +
    `in a body whose first line is "## Delegated decision", then send the choice to the unit with ${modToolPrefix}unit_prompt.`, instructions)
}

/**
 * Merges two issue lists without repeats, ascending.
 * @param kept - The issues already listed.
 * @param added - The issues to add.
 * @returns The merged list.
 */
const mergeIssues = (kept: number[], added: number[]): number[] => [...new Set([...kept, ...added])].sort((a, b) => a - b)

/**
 * Judges a triage label change by the coordinator or a delegated unit: `ready-for-human` and `wontfix` stay the user's,
 * and `ready-for-agent` is set or removed only where the user handed the triage over.
 * @param from - The issue's triage label now, undefined for a new issue.
 * @param to - The triage label asked for.
 * @param isHandedOver - Whether the user handed this issue's triage over, or, for a new issue, any triage.
 * @returns The refusal, or undefined when the change is allowed.
 */
export function judgeTriageChange(from: string | undefined, to: string, isHandedOver: boolean): string | undefined {
  if (from === to) return undefined
  const reserved = [from, to].find(label => label !== undefined && userOnlyTriage.includes(label))
  if (reserved) return `${reserved} stays the user's to set or remove, even with triage handed over: propose it in a delegated decision and leave the issue as it is.`
  const isAllowed = isHandedOver || (from === undefined ? to === 'needs-triage' : from !== 'ready-for-agent' && to !== 'ready-for-agent')
  return isAllowed ? undefined : `triage stays the user's: without /flow delegate triage, ${from === undefined ? 'an issue is created as needs-triage' : 'only needs-info or needs-triage may be set'}.`
}

/**
 * Tells whether a scope delegates a unit: every issue the unit resolves must be in it, so a unit with none is never delegated.
 * @param scope - The scope.
 * @param issues - The unit's issues.
 * @returns Whether the unit is delegated.
 */
export const coversIssues = (scope: DelegationScope, issues: number[]): boolean => issues.length > 0 && issues.every(issue => scope.issues.includes(issue))

/**
 * Names what a scope delegates, as the coordinator's pane and status show it.
 * @param scope - The scope.
 * @returns The issues, the created ones while the scope covers them, and `no signed-commit ruleset` without one.
 */
export function describeScope(scope: DelegationScope): string {
  const named = formatIssueReferences(scope.issues, ' ')
  const triage = scope.triage && formatIssueReferences(scope.triage, ' ')
  return [named, scope.coversCreated ? 'issues it creates' : '', triage ? `triage ${triage}` : '', scope.isPushUnguarded ? 'no signed-commit ruleset' : ''].filter(Boolean).join(' · ')
}
