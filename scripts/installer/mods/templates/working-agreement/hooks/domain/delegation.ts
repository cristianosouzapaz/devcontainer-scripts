import type { DelegationScope } from '../../types'
import { hasOnlyKeys, isNonEmptyString, isRecord, isSafeInteger } from '../lib/guards'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { modToolPrefix } from './messages'

export type { DelegationScope } from '../../types'

/** What `/flow delegate` asks: revoke the scope, or add the named issues (none names the issues the coordinator creates). */
export type DelegateRequest = { kind: 'stop' } | { kind: 'add'; issues: number[] }

/** The mod tool that proposes `/flow delegate` in the prompt box. */
export const suggestDelegateTool = `${modToolPrefix}suggest_delegate`

const usage = 'Usage: /flow delegate [#n …] | /flow delegate stop.'

/**
 * Validates a delegation scope read from disk with exactly its keys.
 * @param value - The decoded JSON.
 * @returns The scope, or null.
 */
export function parseScope(value: unknown): DelegationScope | null {
  return isRecord(value) && hasOnlyKeys(value, ['v', 'sessionId', 'issues', 'coversCreated', 'isPushUnguarded']) && value.v === 1 && isNonEmptyString(value.sessionId)
    && Array.isArray(value.issues) && value.issues.every(issue => isSafeInteger(issue) && issue > 0) && typeof value.coversCreated === 'boolean'
    && (value.isPushUnguarded === undefined || value.isPushUnguarded === true)
    ? { v: 1, sessionId: value.sessionId, issues: value.issues as number[], coversCreated: value.coversCreated, ...(value.isPushUnguarded ? { isPushUnguarded: true as const } : {}) } : null
}

/**
 * Reads the words after `/flow delegate`.
 * @param words - The command's arguments after the subcommand.
 * @returns The request, or the usage when a word is neither `stop` alone nor an issue number.
 */
export function parseDelegateRequest(words: string[]): Result<DelegateRequest> {
  if (words.length === 1 && words[0] === 'stop') return succeed({ kind: 'stop' })
  const issues = words.map(word => /^#?([1-9]\d*)$/.exec(word)?.[1])
  return issues.every(issue => issue !== undefined) ? succeed({ kind: 'add', issues: issues.map(Number) }) : fail(usage)
}

/**
 * Widens a scope by a request; a request without numbers makes it cover the issues the coordinator creates from then on.
 * @param scope - The current scope, or null before the first `/flow delegate`.
 * @param sessionId - The coordinator session.
 * @param issues - The issues to add.
 * @param isPushUnguarded - Whether no ruleset requires signed commits; the scope's own answer when omitted.
 * @returns The widened scope.
 */
export function widenScope(scope: DelegationScope | null, sessionId: string, issues: number[], isPushUnguarded = scope?.isPushUnguarded ?? false): DelegationScope {
  return { v: 1, sessionId, issues: [...new Set([...scope?.issues ?? [], ...issues])].sort((a, b) => a - b), coversCreated: (scope?.coversCreated ?? false) || !issues.length,
    ...isPushUnguarded ? { isPushUnguarded: true as const } : {} }
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
 * @returns The issues, the created ones while the scope covers them, and `push unguarded` without a signed-commit ruleset.
 */
export function describeScope(scope: DelegationScope): string {
  const named = scope.issues.map(issue => `#${issue}`).join(' ')
  return [named, scope.coversCreated ? 'issues it creates' : '', scope.isPushUnguarded ? 'push unguarded' : ''].filter(Boolean).join(' · ')
}
