import { flowDefinitions } from '../domain/flow-definitions'
import { recordOverride } from '../domain/records'
import type { Session, Unit } from '../domain/records'
import type { GitState } from '../lib/git'
import { fail, succeed } from '../lib/result'
import type { Result } from '../lib/result'

/** The engine and core calls `/flow override` makes, each a closure the entry file builds. */
export interface OverridePort {
  readSession: () => Promise<Session>
  writeSession: (session: Session) => Promise<void>
  readGit: () => Promise<GitState | null>
  readUnit: (key: string) => Promise<Unit>
  writeStored: (key: string, value: unknown) => Promise<void>
  findIssueKey: (issue: number) => Promise<string>
  findUnitKey: (session: Session) => Promise<string>
  updateUnits: (session: Session, change: (unit: Unit) => Unit) => Promise<void>
  refresh: () => Promise<void>
  /** Runs a read-modify-write of the records under the store lock; the work must not refresh the pane, whose GitHub sync takes the lock too. */
  withLock: <T>(work: () => Promise<T>) => Promise<T>
}

/**
 * Runs `/flow override <step> [#issue] <reason>`: lets one step, the branch check or one reclassification through, and logs the reason.
 *
 * @param port - The engine and core calls.
 * @param args - The words after `override`.
 * @returns The message for the user, or why the override was refused.
 */
export async function applyOverride(port: OverridePort, args: string): Promise<Result<string>> {
  const match = args.match(/^(\S+)\s+(?:#(\d+)\s+)?(.+)$/)
  if (!match) return fail('Usage: /flow override <step> [#issue] <reason>.')
  const issue = match[2] === undefined ? undefined : Number(match[2])
  const result = await port.withLock(() => storeOverride(port, match[1]!, issue, match[3]!.replace(/^["']|["']$/g, '')))
  if (result.isOk) await port.refresh()
  return result
}

// Checks and stores an override; the caller holds the lock, so no other write lands between the read and the write.
async function storeOverride(port: OverridePort, step: string, issue: number | undefined, reason: string): Promise<Result<string>> {
  const session = await port.readSession()
  if (!session.flow) return fail('No flow is declared, so there is nothing to override.')
  const declared = session.issues.map(declaredIssue => `#${declaredIssue}`).join(', ')
  if (issue !== undefined && !session.issues.includes(issue)) return fail(`#${issue} is not a declared issue — declared: ${declared || 'none'}.`)
  if (step === 'reclassify') {
    await port.writeSession({ ...session, reclassifyOk: true })
    return succeed(`Reclassification allowed once — "${reason}".`)
  }
  if (step === 'branch') {
    const git = await port.readGit()
    if (!git) return fail('Not in a git repository.')
    await port.updateUnits(session, unit => ({ ...recordOverride(unit, 'branch', reason), branch: git.branch }))
    return succeed(`Override logged: the issue's work now lives on ${git.branch} — "${reason}".`)
  }
  const flow = flowDefinitions.flows[session.flow]
  if (!flow) return fail(`Unknown flow "${session.flow}" — nothing to override.`)
  if (!flow.steps.some(candidate => candidate.id === step)) {
    return fail(`No step "${step}" in ${flow.label} — steps: ${flow.steps.map(candidate => candidate.id).join(', ')}, branch, reclassify.`)
  }
  if (issue === undefined) {
    await port.updateUnits(session, unit => recordOverride(unit, step, reason))
    return succeed(`Override logged for ${step}${declared ? ` on ${declared}` : ''} — "${reason}".`)
  }
  const key = session.followUp ? await port.findUnitKey(session) : await port.findIssueKey(issue)
  await port.writeStored(key, recordOverride(await port.readUnit(key), step, reason))
  if (session.issues.length > 1) {
    return succeed(`Override logged for ${step} on #${issue} only — it holds once every declared issue (${declared}) overrides it — "${reason}".`)
  }
  return succeed(`Override logged for ${step} on #${issue} — "${reason}".`)
}
