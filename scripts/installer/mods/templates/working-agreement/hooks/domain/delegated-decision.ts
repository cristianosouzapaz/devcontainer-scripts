import { formatIssueReferences } from './messages'
import type { MarkedComment } from '../lib/github'
import { markForAgent } from './messages'

/** A delegated decision as the coordinator's report lists it. */
export interface DecisionFact { url: string; question: string; cost: string }

/** A comment's record kind, read from its first line. */
type RecordKind = 'decision' | 'review' | undefined

/** The section a delegated unit's spec carries, one line per decision. */
export const decisionsSection = 'Delegated decisions'

/** The first line that marks an issue comment as a delegated decision. */
const decisionMarker = '## Delegated decision'

/** The fields of a delegated decision, as `###` headings in this order. */
const decisionFields = ['Question', 'Alternatives considered', 'Choice', 'Reason', 'Cost of going back']
const costs = ['low', 'medium', 'high']

/** The first line that marks an issue comment as the review of one delegated decision. */
const reviewMarker = '## Delegated review'

/** The fields of a review: the decision comment's URL, and confirmed, follow-up #n or fix #n. */
const reviewFields = ['Decision', 'Outcome']
const outcomePattern = /^(confirmed|(follow-up|fix) #\d+)$/

/**
 * Names the record a comment's first line marks it as.
 * @param body - The comment's markdown.
 * @returns decision, review, or undefined for any other comment.
 */
export function readRecordKind(body: string): RecordKind {
  const first = body.trim().split('\n')[0]?.trim()
  return first === decisionMarker ? 'decision' : first === reviewMarker ? 'review' : undefined
}

/**
 * Splits a marked comment into its `###` fields, refusing any other headings or order.
 * @param body - The comment's markdown, marker first.
 * @param marker - Its marker.
 * @param fields - The headings it carries, in order.
 * @param name - What the record is, for the refusal.
 * @returns Each field's text in order, or the defect.
 */
function readFields(body: string, marker: string, fields: string[], name: string): string[] | string {
  const parts = body.trim().split('\n').slice(1).join('\n').split(/^### (.+)$/m)
  const headings = parts.filter((_, index) => index % 2 === 1).map(heading => heading.trim())
  const texts = parts.filter((_, index) => index % 2 === 0).map(text => text.trim())
  const shape = `${marker} then the headings ${fields.map(field => `### ${field}`).join(', ')}, in that order`
  if (texts[0] || headings.join('\n') !== fields.join('\n')) return `A ${name} is ${shape}.`
  const empty = fields.find((_, index) => !texts[index + 1])
  return empty ? `A ${name} needs a non-empty ${empty}.` : texts.slice(1)
}

/**
 * Finds what is wrong with a comment marked as a delegated decision or the review of one.
 * @param body - The comment's markdown.
 * @returns The defect, or undefined when the comment is well-formed or carries no marker.
 */
export function findDecisionDefect(body: string): string | undefined {
  const kind = readRecordKind(body)
  if (kind === 'review') {
    const texts = readFields(body, reviewMarker, reviewFields, 'delegated review')
    if (typeof texts === 'string') return texts
    if (!/#issuecomment-\d+$/.test(texts[0]!)) return 'The Decision of a delegated review is the decision comment\'s URL.'
    return outcomePattern.test(texts[1]!) ? undefined : 'The Outcome of a delegated review is confirmed, follow-up #<issue> or fix #<issue>.'
  }
  if (kind !== 'decision') return undefined
  const texts = readFields(body, decisionMarker, decisionFields, 'delegated decision')
  if (typeof texts === 'string') return texts
  return costs.includes(texts.at(-1)!.toLowerCase()) ? undefined : `The cost of going back must be one of: ${costs.join(', ')}.`
}

/**
 * Reads the decision a well-formed review comment reviews.
 * @param body - The review comment's markdown.
 * @returns The decision comment's URL.
 */
export function readReviewedDecision(body: string): string {
  return body.split(/^### Decision$/m)[1]!.split(/^### /m)[0]!.trim()
}

/**
 * Lists the well-formed delegated decisions among an issue's comments that no well-formed review covers.
 * @param comments - The issue's comments.
 * @returns The unreviewed decisions' URLs.
 */
export function listUnreviewed(comments: MarkedComment[]): string[] {
  const valid = comments.filter(comment => !findDecisionDefect(comment.body))
  const reviewed = new Set(valid.filter(comment => readRecordKind(comment.body) === 'review').map(comment => readReviewedDecision(comment.body)))
  return valid.filter(comment => readRecordKind(comment.body) === 'decision' && !reviewed.has(comment.url)).map(comment => comment.url)
}

/**
 * Lists the well-formed delegated decisions among an issue's comments, the highest cost of going back first.
 * @param comments - The issue's comments.
 * @returns Each decision's URL, the first line of its question, and its cost in lowercase.
 */
export function listDecisions(comments: MarkedComment[]): DecisionFact[] {
  return comments.filter(comment => readRecordKind(comment.body) === 'decision' && !findDecisionDefect(comment.body)).map(comment => {
    const texts = readFields(comment.body, decisionMarker, decisionFields, 'delegated decision') as string[]
    return { url: comment.url, question: texts[0]!.split('\n')[0]!, cost: texts.at(-1)!.toLowerCase() }
  }).sort((a, b) => costs.indexOf(b.cost) - costs.indexOf(a.cost))
}

/**
 * Writes the line that tells a delegated unit session to route its decisions to the coordinator and record them.
 * @param issues - The unit's issues, which receive the decision comments.
 * @returns The line, marked as the working agreement's.
 */
export function composeDelegatedLine(issues: number[]): string {
  const references = formatIssueReferences(issues, ' or ')
  return markForAgent('This unit is delegated: never stop for a user decision. Route each decision to the coordinator instead — end the turn with the question, ' +
    'the alternatives and your proposal; it answers in this session. Record each answer as one issue_comment on ' +
    `${references} whose body is ${decisionMarker} then ${decisionFields.map(field => `### ${field}`).join(', ')} (low, medium or high). ` +
    `In a grilling, propose the decision tree to the coordinator instead of interviewing the user; the spec then carries a ${decisionsSection} section ` +
    '(question → choice → reason → cost of going back). The PR body lists every high-cost delegated decision under High-cost delegated decisions.')
}
