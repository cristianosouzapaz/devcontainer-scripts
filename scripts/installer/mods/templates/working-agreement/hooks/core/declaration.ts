import { flowDefinitions } from '../domain/flow-definitions'
import type { FlowDefinition } from '../domain/flow-definitions'
import { composeInstruction, formatIssueReferences } from '../domain/instruction'
import { mergeSkills } from '../domain/records'
import type { IssueInfo, Session } from '../domain/records'
import { describeRequirement } from '../domain/requirements'
import { formatStepLabel } from '../domain/step-states'
import { readIssue } from '../lib/github'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'
import { stepSymbol } from '../ui/theme'
import type { EnginePort } from './engine-port'
import { describeIssue, readGithubStatus, readPullRequests, storePullRequests } from './github-sync'
import { refreshView } from './pane-view'
import { locatePosition } from './position'
import { readSession, updateUnits, writeSession } from './record-store'
import { readGit, readHeadCommit } from './repository'
import { sessionMemory } from './session-memory'

/**
 * Declares the session's flow and the issues its unit resolves; runs inside `serial`.
 *
 * @param port - The engine calls.
 * @param flow - The flow's id.
 * @param issues - The declared issue numbers.
 * @param declaredBy - Who declares it: a flow the user owns refuses the agent.
 * @returns The declaration with the flow's steps and next action, or why it was refused.
 */
export async function declareFlow(port: EnginePort, flow: string, issues: number[], declaredBy: FlowDefinition['declaredBy']): Promise<Result<string>> {
  const definition = flowDefinitions.flows[flow]
  if (!definition) return fail(`Unknown flow "${flow}" — use one of ${Object.keys(flowDefinitions.flows).join(', ')}.`)
  if (definition.declaredBy === 'human' && declaredBy === 'agent') {
    return fail(`${definition.label} is declared only by the user — tell the user why and ask them to run /flow.`)
  }
  const session = await readSession(port)
  if (session.prCreated) return fail('A PR was already created in this session — one unit of work per session: run /handoff, then /clear, then declare the next flow.')
  if (session.flow && session.output && !session.reclassifyOk) {
    return fail(`${flowDefinitions.flows[session.flow]?.label} already produced output (issue or commit) — reclassification needs /flow override reclassify <reason>.`)
  }
  if (definition.issue === 'required' && !issues.length) return fail(`${definition.label} needs an issue — pass its number.`)
  const declared = definition.issue === 'none' ? [] : issues

  const github = await readGithubStatus(port, true)
  const info: Record<string, IssueInfo> = {}
  if (github === 'connected') {
    for (const issue of declared) {
      const read = await readIssue(port.processes, issue)
      if (!read.isOk) return fail(`Issue #${issue}: ${read.error} — check the number.`)
      if (read.value.state !== 'OPEN') return fail(`Issue #${issue} is ${read.value.state.toLowerCase()} — declare an open issue.`)
      info[issue] = await describeIssue(port, flow, issue, read.value)
    }
  }
  if (flow === 'close-out') {
    const git = await readGit(port)
    if (!git || (git.ahead === 0 && !git.isDirty)) return fail('Close out needs code on the issue branch — nothing ahead of base and no changes here.')
  }
  const next: Session = {
    ...session, flow, issues: declared, info, gh: github, reclassifyOk: false, followUp: undefined,
    skills: undefined,
  }
  await writeSession(port, next)
  // Flow steps that ran before the declaration count for the unit; Close out also owns the commits made before it.
  const before = session.skills ?? []
  const start = flow === 'close-out' ? undefined : await readHeadCommit(port)
  await updateUnits(port, next, unit => ({ ...unit, skills: mergeSkills(unit.skills, before), start: unit.start ?? start }))
  // This runs inside `serial`, which syncPullRequests and syncIssues would wait on, so the PR read is stored lock-free here.
  sessionMemory.pullRequestsCheckedAt = await port.now()
  if (github === 'connected') await storePullRequests(port, await readPullRequests(port, next))
  sessionMemory.issuesCheckedAt = await port.now()
  await refreshView(port, false, true)
  void port.openPane()
  const position = await locatePosition(port, next)
  if (!position) return fail('The flow was declared but its position could not be located.')
  const warning = github === 'connected' ? '' : ` (GitHub ${github}: issues not verified)`
  const which = declared.length ? ` for ${formatIssueReferences(declared, ', ')}` : ''
  const steps = position.states.map(state => `${stepSymbol[state.state]} ${formatStepLabel(state.step, position.unit.pr)} (${describeRequirement(state, next, position)})`).join('; ')
  return succeed(`Flow declared: ${definition.label}${which}${warning}. Steps: ${steps}. ${composeInstruction(position, next)}`)
}
