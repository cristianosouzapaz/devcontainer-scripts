import type { AutoMergeFields, PrFields } from '../../types'
import { hasOnlyKeys, isRecord, isNonEmptyString, isSafeInteger } from './guards'

interface PageInfo { hasNextPage: false }
interface CompleteConnection { pageInfo: PageInfo; nodes?: unknown }
interface IssueNumber { number: number }
interface IssueReferences { nodes: IssueNumber[] }
/**
 * Holds a validated candidate PR with its state normalized for delivery.
 */
export interface PullRequestRow { number: number; state: string; url: string; headRefOid: string; isCrossRepository: boolean; closingIssuesReferences: IssueReferences }
interface RepositoryName { nameWithOwner: string }
interface ClosingPullRequestRow { number: number; state: string; headRefName: string; isCrossRepository: boolean; baseRepository: RepositoryName }
interface ComparisonRow { status: string; ahead_by: number }
interface CheckRunRow extends Record<string, unknown> { name: string; status: string; conclusion: string | null }
interface StatusRow extends Record<string, unknown> { context: string; state: unknown }
interface RequiredContext { context: string }
interface RequiredParameters { required_status_checks: RequiredContext[] }
interface RequiredCheckRule extends Record<string, unknown> { parameters: RequiredParameters }
interface RulesetRow extends Record<string, unknown> { id: number; current_user_can_bypass?: unknown }
interface ActiveRuleRow extends Record<string, unknown> { ruleset_id: number; type?: unknown }

/**
 * Identifies a connection that explicitly rules out another page.
 * @param value - The decoded connection.
 * @returns Whether pagination is complete, independently of its nodes.
 */
export const isCompleteConnection = (value: unknown): value is CompleteConnection => isRecord(value) && isRecord(value.pageInfo) && value.pageInfo.hasNextPage === false

/**
 * Identifies a candidate PR with usable delivery and closing-issue fields.
 * @param value - The row with its state normalized to a string.
 * @returns Whether the candidate fields are readable.
 */
export const isPullRequestCandidate = (value: unknown): value is PullRequestRow => isRecord(value) && isSafeInteger(value.number) && value.number > 0
  && typeof value.state === 'string' && ['OPEN', 'MERGED', 'CLOSED'].includes(value.state) && typeof value.url === 'string' && isNonEmptyString(value.headRefOid)
  && typeof value.isCrossRepository === 'boolean' && isRecord(value.closingIssuesReferences) && Array.isArray(value.closingIssuesReferences.nodes)
  && value.closingIssuesReferences.nodes.every((issue: unknown): issue is IssueNumber => isRecord(issue) && isSafeInteger(issue.number))

/**
 * Identifies a closing PR with its repository identity.
 * @param value - The decoded row.
 * @returns Whether the closing PR fields are readable.
 */
export const isClosingPullRequest = (value: unknown): value is ClosingPullRequestRow => isRecord(value) && isSafeInteger(value.number)
  && typeof value.state === 'string' && typeof value.headRefName === 'string' && typeof value.isCrossRepository === 'boolean'
  && isRecord(value.baseRepository) && typeof value.baseRepository.nameWithOwner === 'string'

/**
 * Identifies an ancestry comparison with a non-negative commit count.
 * @param value - The body with its status normalized to a string.
 * @returns Whether the comparison fields are readable.
 */
export const isComparison = (value: unknown): value is ComparisonRow => isRecord(value) && typeof value.status === 'string' && ['identical', 'ahead', 'behind', 'diverged'].includes(value.status)
  && isSafeInteger(value.ahead_by) && value.ahead_by >= 0

/**
 * Identifies a named check run with a readable conclusion.
 * @param value - The decoded row.
 * @returns Whether the check fields are readable.
 */
export const isCheckRun = (value: unknown): value is CheckRunRow => isRecord(value) && typeof value.name === 'string' && typeof value.status === 'string'
  && (value.conclusion === null || typeof value.conclusion === 'string')

/**
 * Identifies a named commit status whose state has a recognized string representation.
 * @param value - The decoded row.
 * @returns Whether the status fields are readable.
 */
export const isStatus = (value: unknown): value is StatusRow => isRecord(value) && typeof value.context === 'string'
  && ['success', 'failure', 'error', 'pending'].includes(String(value.state))

/**
 * Identifies a rule whose required contexts are all readable.
 * @param value - The decoded rule.
 * @returns Whether every required context is a string.
 */
export const isRequiredCheckRule = (value: unknown): value is RequiredCheckRule => isRecord(value) && isRecord(value.parameters) && Array.isArray(value.parameters.required_status_checks)
  && value.parameters.required_status_checks.every((check: unknown): check is RequiredContext => isRecord(check) && typeof check.context === 'string')

/**
 * Identifies a ruleset with an integer identity.
 * @param value - The decoded row.
 * @returns Whether the row is a ruleset that carries its identity.
 */
export const isRuleset = (value: unknown): value is RulesetRow => isRecord(value) && isSafeInteger(value.id)

/**
 * Identifies an active rule with a usable ruleset identity.
 * @param value - The row with its ruleset identity normalized to a number.
 * @returns Whether its ruleset identity is a safe integer.
 */
export const isActiveRule = (value: unknown): value is ActiveRuleRow => isRecord(value) && isSafeInteger(value.ruleset_id)

/**
 * Validates the complete protected GraphQL field set.
 * @param value - The decoded fields.
 * @returns Whether the fields are usable for comparison.
 */
export function isPrFields(value: unknown): value is PrFields {
  return isRecord(value) && hasOnlyKeys(value, ['state', 'closedAt', 'autoMergeRequest', 'isInMergeQueue', 'reviews'])
    && typeof value.state === 'string' && ['OPEN', 'CLOSED', 'MERGED'].includes(value.state) && (value.closedAt === null || typeof value.closedAt === 'string')
    && (value.autoMergeRequest === null || isAutoMergeFields(value.autoMergeRequest))
    && typeof value.isInMergeQueue === 'boolean' && isRecord(value.reviews) && hasOnlyKeys(value.reviews, ['totalCount'])
    && isSafeInteger(value.reviews.totalCount) && value.reviews.totalCount >= 0
}

/**
 * Identifies the protected auto-merge request fields.
 * @param value - The decoded request.
 * @returns Whether the request fields are readable.
 */
function isAutoMergeFields(value: unknown): value is AutoMergeFields {
  return isRecord(value) && hasOnlyKeys(value, ['authorEmail', 'commitBody', 'commitHeadline', 'enabledAt', 'enabledBy', 'mergeMethod'])
    && ['authorEmail', 'commitBody', 'commitHeadline', 'enabledAt'].every(key => value[key] === null || typeof value[key] === 'string')
    && (value.enabledBy === null || (isRecord(value.enabledBy) && hasOnlyKeys(value.enabledBy, ['login']) && typeof value.enabledBy.login === 'string'))
    && typeof value.mergeMethod === 'string' && ['MERGE', 'SQUASH', 'REBASE'].includes(value.mergeMethod)
}
