import type { Args, EventResult, Frozen } from 'claude-code'

import { bestEffort } from '../core/best-effort'
import { addCreatedIssue, findDelegation, readOwnScope } from '../core/delegation'
import type { EnginePort } from '../core/engine-port'
import { trackIssue } from '../core/issue-audit'
import { closeIssue, commentIssue, createIssue, editIssue, readIssuesConfig } from '../core/issue-write'
import type { EditGuard, IssueWrite } from '../core/issue-write'
import { readSession } from '../core/record-store'
import { decisionsSection, listUnreviewed, readRecordKind } from '../domain/delegated-decision'
import { judgeTriageChange } from '../domain/delegation'
import { readIssueInput, triageLabels } from '../domain/issue-fields'
import type { IssueInput } from '../domain/issue-fields'
import { isCoordinatorSession, issueTools } from '../domain/coordinator'
import { answerTool, markForAgent } from '../domain/messages'
import { readMarkedComments } from '../lib/github'
import { fail, formatError, settle } from '../lib/result'
import type { Result } from '../lib/result'

/** One issue tool's name. */
type IssueTool = (typeof issueTools)[number]


/**
 * Runs an issue tool: checks its fields against the config and the repository, writes, and reads the issue back.
 * @param port - The engine calls.
 * @param tool - The issue tool called.
 * @param event - The tool call.
 * @returns The written issue or comment, or an error result; nothing written is reported as success unless it read back.
 */
export async function handleIssueCall(port: EnginePort, tool: IssueTool, event: Frozen<Args<'tool.call'>>): Promise<EventResult<'tool.call'>> {
  const input = readIssueInput({ ...event })
  const { result, written }: IssueWrite = !input.isOk ? { result: input, written: null }
    : tool === 'issue_close' ? { result: await closeIssue(port, input.value), written: null }
      : tool === 'issue_comment' ? { result: await judgeReviewer(port, input.value.body) ?? await commentIssue(port, input.value), written: null }
        : await writeFields(port, tool, input.value)
  // A write that landed is audited at every turn end, even when its read-back failed.
  const text = result.isOk ? result.value : result.error
  if (written) await bestEffort(port, 'issue audit tracking', () => trackIssue(port, written), undefined)
  // Both a confirmed create and one whose read-back failed name the created issue.
  const created = tool === 'issue_create' ? written : 0
  if (created) {
    const added = await settle(addCreatedIssue(port, created))
    if (!added.isOk) return { result: markForAgent(`${text}, but #${created} could not join the delegation scope: ${added.error} — tell the user.`), isError: true }
    if (added.value) return { result: markForAgent(`${text} — #${created} is delegated.`), ...(result.isOk ? {} : { isError: true }) }
  }
  return answerTool(tool, result)
}

/**
 * Creates or edits an issue under the repository's issues config; a delegated unit's spec must carry its delegated decisions.
 * @param port - The engine calls.
 * @param tool - issue_create or issue_edit.
 * @param input - The call's fields.
 * @returns The write's confirmation, or the refusal.
 */
async function writeFields(port: EnginePort, tool: IssueTool, input: IssueInput): Promise<IssueWrite> {
  const refuse = (error: string): IssueWrite => ({ result: fail(error), written: null })
  const config = await readIssuesConfig(port)
  if (!config.isOk) return refuse(config.error)
  if (input.kind === 'spec' && !input.sections?.[decisionsSection]?.trim()) {
    // why: a spec the mod cannot tell apart from a delegated unit's must not skip its decisions, so an unreadable scope refuses it.
    const delegation = await settle(readSession(port).then(session => findDelegation(port, session.issues, true)))
    if (!delegation.isOk) return refuse(`The delegation scope cannot be read (${delegation.error}), so a spec without a ${decisionsSection} section is refused.`)
    if (delegation.value) return refuse(`A delegated unit's spec needs a ${decisionsSection} section: one line per decision, question → choice → reason → cost of going back.`)
  }
  const triage = await settle(judgeTriage(port, tool, input))
  if (!triage.isOk) return refuse(`The session's role or delegation scope cannot be read (${triage.error}), so a triage change is refused.`)
  if (typeof triage.value === 'string') return refuse(triage.value)
  return tool === 'issue_create' ? createIssue(port, config.value, input) : editIssue(port, config.value, input, triage.value)
}

/**
 * Keeps triage the user's in the coordinator and in delegated units: a new issue's label is judged now, an edit's once its labels
 * are read; a change `/flow delegate triage` allows must follow an unreviewed delegated decision on the issue.
 * @param port - The engine calls.
 * @param tool - issue_create or issue_edit.
 * @param input - The call's fields.
 * @returns The refusal of a create, the guard of an edit, or undefined in the user's own sessions and for writes that leave triage alone.
 * @throws When the session or a delegation scope cannot be read: a write the mod cannot attribute must not change triage.
 */
async function judgeTriage(port: EnginePort, tool: IssueTool, input: IssueInput): Promise<string | EditGuard | undefined> {
  const to = input.triage
  if (to === undefined) return undefined
  const session = await readSession(port)
  const isCoordinator = isCoordinatorSession(session)
  if (!isCoordinator && !await findDelegation(port, session.issues, true)) return undefined
  // why: only the coordinator takes a handed-over triage; a delegated unit stays strict.
  const handedOver = isCoordinator ? (await readOwnScope(port))?.triage ?? [] : []
  // why: a delegated unit's spec issue is created ready-for-agent by its own Spec step; only the coordinator's creates stay untriaged.
  if (tool === 'issue_create') return isCoordinator ? judgeTriageChange(undefined, to, handedOver.length > 0) : undefined
  const issue = input.number
  return async current => {
    const from = current.find(label => triageLabels.includes(label))
    const isHandedOver = issue !== undefined && handedOver.includes(issue)
    const refusal = judgeTriageChange(from, to, isHandedOver)
    if (refusal || !isHandedOver || judgeTriageChange(from, to, false) === undefined) return refusal
    const comments = await readMarkedComments(port.processes, issue)
    if (!comments.isOk) return comments.error
    return listUnreviewed(comments.value).length ? undefined
      : `a triage you take for the user is a delegated decision: comment it on #${issue} first (## Delegated decision, listing the assumptions made for any missing information), then set ${to}.`
  }
}

/**
 * Refuses a delegated review from a session that is not the user's own: the coordinator, or a delegated unit.
 * @param port - The engine calls.
 * @param body - The comment's markdown, if any.
 * @returns The refusal, or undefined when the comment is no review or the session may review.
 */
async function judgeReviewer(port: EnginePort, body: string | undefined): Promise<Result<string> | undefined> {
  if (body === undefined || readRecordKind(body) !== 'review') return undefined
  const refusal = 'A delegated review is the user\'s verdict'
  try {
    const session = await readSession(port)
    if (isCoordinatorSession(session)) return fail(`${refusal}: the coordinator took the decisions, so it cannot review them.`)
    if (await findDelegation(port, session.issues, true)) return fail(`${refusal}: a delegated unit cannot review the decisions taken on the user's behalf.`)
    return undefined
  } catch (error) {
    // why: a review the mod cannot attribute to the user must not land, so an unreadable session or scope refuses it.
    return fail(`${refusal}, and the delegation scope cannot be read (${formatError(error)}).`)
  }
}
