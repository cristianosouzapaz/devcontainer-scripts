import type { BodyPart, CommandEvent } from '../domain/command-events'
import { diagnosisHeadings, listMissingDiagnosis } from '../domain/diagnosis-comment'
import { flowDefinitions } from '../domain/flow-definitions'
import { writePolicy } from '../domain/messages'
import { listMissingLines } from '../domain/pull-request-body'
import { listUnrestored } from '../domain/tree-changes'
import type { Session, UnexplainedWrites } from '../domain/records'
import { branchFirstInstruction } from '../domain/requirements'
import { findDiagnoseStep, findPullRequestStep, isOnBase, isRedGreenSettled } from '../domain/step-states'
import { ask, deny, pickStrictest } from '../domain/verdicts'
import type { Judgement, Verdict } from '../domain/verdicts'
import { judgeHandoffCall } from '../features/handoff'
import { readTextFile } from '../lib/files'
import { toStringOrEmpty } from '../lib/json'
import { isPathMatched, normalizePath, toRepoRelative } from '../lib/paths'
import type { ShellContext, WriteTarget } from '../lib/shell-parser'
import { listCallWrites, recogniseCall } from './command-observation'
import type { EnginePort } from './engine-port'
import { readGithubStatus } from './github-sync'
import { canAskHuman, fileTools, readJudgedTool } from './judged-tools'
import { worktreesFolder } from './main-checkout'
import { hasIssueSkill, locatePosition } from './position'
import { readSession } from './record-store'
import { readDirtyTree, readRepositoryRoot } from './repository'

/**
 * Judges a tool call as the tool.call hook does: the handoff's own rule first, then the agreement's,
 * with an ask turned into a deny when no human answers asks in this permission mode.
 *
 * @param port - The engine calls.
 * @param tool - The tool's name.
 * @param args - The tool's input.
 * @returns The judgement.
 */
export async function judgeToolCall(port: EnginePort, tool: string, args: Record<string, unknown>): Promise<Judgement> {
  const handoffVerdict = readJudgedTool(tool) === 'Bash' ? judgeHandoffCall(tool, listCallWrites(toStringOrEmpty(args.command), await readShellContext(port))) : null
  if (handoffVerdict) return handoffVerdict
  const judged = await judgeCall(port, tool, args)
  return judged.decision === 'ask' && !canAskHuman()
    ? { ...judged, decision: 'deny', ...(judged.write ? { write: { ...judged.write, isDenied: true } } : {}) }
    : judged
}

/**
 * Judges a file write or a Bash command against the declared flow.
 *
 * @param port - The engine calls.
 * @param tool - The tool's name.
 * @param args - The tool's input.
 * @returns The judgement, with the kind of write when the call writes.
 */
export async function judgeCall(port: EnginePort, tool: string, args: Record<string, unknown>): Promise<Judgement> {
  const session = await readSession(port)
  if (fileTools.includes(tool)) {
    const verdict = await judgeWrite(port, session, toStringOrEmpty(args.file_path ?? args.notebook_path))
    return verdict ? { ...verdict, write: { kind: 'edits', isDenied: verdict.decision === 'deny' } } : { decision: 'allow' }
  }
  if (readJudgedTool(tool) !== 'Bash') return { decision: 'allow' }
  const command = toStringOrEmpty(args.command)
  const writes: Verdict[] = []
  for (const target of listCallWrites(command, await readShellContext(port))) {
    const verdict = await judgeWrite(port, session, target)
    if (verdict) writes.push(verdict)
  }
  const verdicts = [...writes]
  const position = session.flow ? await locatePosition(port, session) : null
  // The gates judge the events the observation layer recognises, so a command gets the same verdict run directly or in a herdr pane.
  const events = await recogniseCall(port, session, command)

  if (events.some(event => event.kind === 'issue-create') && !hasIssueSkill(position)) {
    verdicts.push(ask('gh issue create outside /to-spec or /triage', 'issues come from those skills: stop and ask the user to run one'))
  }
  // Commits, pushes and the PR's merge, close and review are the user's in every flow and mode: no override lets one through.
  for (const name of new Set(events.flatMap(nameUserStep))) {
    verdicts.push(deny(`${name} is the user's step`, name === 'git commit'
      ? 'stop and give the user the commands generate-commit produced'
      : `stop and ask the user to run ${name} themselves`))
  }
  const bodies = events.flatMap(event => ((event.kind === 'pr-create' || event.kind === 'pr-edit') && event.body ? [event.body] : []))
  if (position) for (const parts of bodies) {
    if (position.git?.isDirty) verdicts.push(deny('working tree is dirty', 'commit (or stash) everything first so the PR holds what was committed'))
    const requires = findPullRequestStep(position.flow)?.requires ?? 'none'
    const body = await readBodyText(port, command, parts)
    if ((requires === 'refs' || requires === 'linked') && session.followUp === undefined) {
      verdicts.push(deny('the follow-up issue is unknown', 'ask the user to run /flow follow-up #<n> again'))
    }
    const missing = listMissingLines(requires, session, body, position.unit)
    if (missing.length) {
      verdicts.push(deny(`PR body lacks ${missing.join(', ')}`, missing.every(line => line.startsWith('the approved diagnosis comment link'))
        ? 'add the approved diagnosis comment link to the body'
        : requires === 'linked'
        ? `keep a line linking #${session.followUp} (Closes, Refs, Fixes or Resolves)`
        : `add a "${requires === 'refs' ? 'Refs' : 'Closes'} #<n>" line for every declared issue`))
    }
    // A PR shows only what is pushed, and the push is the user's, so it comes first.
    if (position.git && !position.git.isUpToDate) verdicts.push(deny('the branch is not pushed', 'stop and ask the user to push it, then retry'))
  }
  // A comment on the issue once the red and the green are settled is the diagnosis comment, which must hold everything the user reads to approve it.
  const diagnose = position && findDiagnoseStep(position.flow)
  if (position && diagnose && isRedGreenSettled(diagnose, position.unit)) {
    for (const event of events) {
      if (event.kind !== 'issue-comment' || !event.issues.length) continue
      const missing = listMissingDiagnosis(position.unit, await readBodyText(port, command, event.body))
      if (missing.length) {
        verdicts.push(deny(`the diagnosis comment lacks ${missing.join('; ')}`,
          `post it again with the headings ${diagnosisHeadings.join(', ')}, quoting the red command and naming every red file`))
      }
    }
  }
  return {
    ...pickStrictest(verdicts),
    ...(writes.length ? { write: { kind: 'shell', isDenied: pickStrictest(writes).decision === 'deny' } } : {}),
  }
}

/**
 * Reads where a Bash command runs: the session's working directory and the home directory.
 *
 * @param port - The engine calls.
 * @returns The shell context.
 */
export async function readShellContext(port: EnginePort): Promise<ShellContext> {
  const home = await port.readHome()
  return { cwd: await port.readCwd(), ...(home ? { home } : {}) }
}

/**
 * Tells whether the agreement lets a write to a path through without asking anyone.
 *
 * @param port - The engine calls.
 * @param session - The session.
 * @param path - The written path, or null for one a command hides.
 * @returns False when a step, a path rule or an unexplained write holds it back, or when the check fails.
 */
export async function isWriteAllowed(port: EnginePort, session: Session, path: WriteTarget): Promise<boolean> {
  try {
    const verdict = await judgeWrite(port, session, path)
    return !verdict || verdict.decision === 'allow'
  } catch {
    return false
  }
}

// A null path is a shell target the command hides: it counts as a repository write, so the gate fails closed.
async function judgeWrite(port: EnginePort, session: Session, path: WriteTarget): Promise<Verdict | null> {
  // A git that cannot run rejects here rather than reading as "outside a repository": with no root to compare against,
  // the hook's .catch denies every write, those outside the repository (scratchpad, /tmp) included.
  const root = await readRepositoryRoot(port, true)
  if (!root) return null
  const file = path === null ? undefined : toRepoRelative(normalizePath(path, await port.readCwd()), root)
  if (file === null) return null
  // A worktree's files are its own checkout's: only an unexplained write to the main checkout holds them back.
  if (file !== undefined && `/${file}`.startsWith(worktreesFolder)) {
    const position = session.flow ? await locatePosition(port, session) : null
    return position ? await judgeUnexplained(port, root, position.unit.unexplained, undefined) : null
  }
  if (file !== undefined && isPathMatched(flowDefinitions.paths.ephemeral, file)) {
    return deny(`${file} is an ephemeral planning file`, 'put plans, specs and todos in a GitHub issue, not in the repo')
  }
  if (file !== undefined && isPathMatched(flowDefinitions.paths.generated, file)) {
    return deny(`${file} is generated or vendored`, 'edit the source and let the pipeline produce the copy')
  }
  const position = await locatePosition(port, session)
  if (!position) {
    return deny('no flow declared', 'classify the work per AGENTS.md and call declare_flow before writing (ask the user if unsure; Trivial change and Follow-up are theirs to declare with /flow)')
  }
  if (position.flow.isReadOnly) {
    return deny(`${position.flow.label} never writes to the repository`, 'put the outcome in the tracker; code starts in a later session from its ticket')
  }
  const unexplained = await judgeUnexplained(port, root, position.unit.unexplained, file)
  const verdicts: Verdict[] = unexplained ? [unexplained] : []
  const unlock = position.states.findIndex(state => state.step.isUnlocking)
  for (const state of position.states.slice(0, Math.max(unlock, 0))) {
    if ((state.state !== 'current' && state.state !== 'pending') || !state.step.isWriteGated) continue
    // The main checkout is read-only for the whole of Diagnose, test files included: no approval lets a write through.
    if (state.step.isInWorktree && state.state === 'current') {
      verdicts.push(deny(`${position.flow.label}: ${state.step.label} not done, and the main checkout is read-only until its approval`,
        `work in the worktree (EnterWorktree); a bug no command can reproduce needs the user's /flow override ${state.step.id} <reason>. ${writePolicy}`))
      continue
    }
    const todo = state.step.isHuman
      ? `stop and ask the user to run /${state.step.skill}, or /flow override ${state.step.id} <reason>`
      : state.step.isInWorktree
        ? `run the ${state.step.skill} skill in a worktree and see the red and the green first; a bug no command can reproduce needs the user's /flow override ${state.step.id} <reason>`
        : `run the ${state.step.skill} skill, then retry`
    verdicts.push(ask(`${position.flow.label}: ${state.step.label} not done`, `${todo}. ${writePolicy}`))
  }
  if (session.issues.some(issue => !session.info[issue]) && (await readGithubStatus(port)) !== 'connected') {
    verdicts.push(ask('GitHub is unavailable, so the declared issue and its labels are unverified', 'stop and ask the user to fix gh (gh auth status), then declare again'))
  }
  // Every repository-writing flow ends with a PR, which cannot come from the default branch.
  if (position.git && isOnBase(position.git)) verdicts.push(deny(`writing on the default branch (${position.git.base})`, `${branchFirstInstruction}, then retry`))
  if (position.unit.branch && position.git && position.unit.branch !== position.git.branch) {
    verdicts.push(ask(`this issue's work is on ${position.unit.branch}, not ${position.git.branch}`, `switch to ${position.unit.branch}, or ask the user to run /flow override branch <reason> to move it here`))
  }
  return pickStrictest(verdicts)
}

// Holds a write back while the unit's unexplained writes are not restored; a write to a recorded file is how the agent
// restores it, so it is not held back here.
async function judgeUnexplained(port: EnginePort, root: string, unexplained: UnexplainedWrites | undefined, file: string | undefined): Promise<Verdict | null> {
  if (!unexplained || (file !== undefined && file in unexplained.files)) return null
  if (unexplained.isUnchecked) {
    return deny('the working tree could not be read at a tool call or a turn end, so what changed it is unknown', `stop and ask the user to check the tree and run /flow override writes <reason>. ${writePolicy}`)
  }
  const unrestored = listUnrestored(unexplained, Object.keys(unexplained.files).length ? await readDirtyTree(port, root) : null)
  return unrestored.length
    ? deny(`${unrestored.join(', ')} changed outside Edit or Write while a step held writes back, by a Bash call or by a writer outside any call (a background run, a herdr pane, a detached process)`,
      `restore it to what it held before (git restore for a file that was committed unchanged, rm for one the call created), or stop and ask the user to run /flow override writes <reason>. ${writePolicy}`)
    : null
}

// The command a user's step event stands for, or none for an event the agent may cause.
function nameUserStep(event: CommandEvent): string[] {
  if (event.kind === 'commit' || event.kind === 'push') return [`git ${event.kind}`]
  if (event.kind === 'history') return [`git ${event.subcommand}`]
  if (event.kind === 'pr-merge' || event.kind === 'pr-close' || event.kind === 'pr-review') return [`gh pr ${event.kind.slice(3)}`]
  return []
}

// The text a gh pr or gh issue command's body holds: its text parts and the contents of its files; a file that cannot be read leaves
// the whole call's text standing in for it.
async function readBodyText(port: EnginePort, command: string, parts: BodyPart[]): Promise<string> {
  const texts: string[] = []
  for (const part of parts) {
    if (part.kind === 'text') texts.push(part.text)
    else {
      const text = await readTextFile(port.files, port.clock, part.path)
      texts.push(text.isOk ? text.value : command)
    }
  }
  return texts.join('\n')
}
