import type { FlowStepState } from '../types'
import { checksTodo } from './checks'
import type { Checks } from './checks'
import type { FlowDef, Step } from './flows'
import type { Pr, Session, Unit } from './records'

/** The checkout as git reports it: where it is, which branch and commit, and how it stands against the default branch. */
export interface GitState { root: string; branch: string; head: string; base: string; ahead: number; dirty: boolean; upToDate: boolean }

/** A step of the declared flow and where it stands. */
export interface StepState { step: Step; state: FlowStepState }

/** The repository's verify command, if it has one, and whether a run of it passed on the current tree. */
export interface VerifyState { cmd: string | undefined; isVerified: boolean }

/** Whether the reproduction test has been seen failing on unfixed code: never, and still unchanged since, or changed since. */
export type RedState = 'none' | 'holds' | 'stale'

/** Where the session's unit stands in its flow, with the checkout, the Verify state and the CI state of its PR it was judged on. */
export interface Position {
  def: FlowDef; u: Unit; g: GitState | null; states: StepState[]; current: StepState | null
  /** The unit's own commits: those past its start, or every commit ahead of base when it has none. */
  own: number
  isVerified: boolean; verifyCmd: string | undefined; red: RedState
  /** Off unless the PR step waits only on CI, then what `gh pr checks` reported. */
  checks: Checks
}

/** The mark the pane draws beside a step in each state. */
export const stepSymbol: Record<FlowStepState, string> = { done: '✓', current: '▸', pending: '○', skipped: '↷', override: '⚑' }

/** The instruction that sends the agent to a branch before its first write on the default branch. */
export const branchFirst = 'create a branch for the issue (git switch -c <name>)'

/**
 * Tells whether the checkout is on its default branch.
 *
 * @param g - The checkout, or null outside a repository.
 * @returns True on the default branch.
 */
export const onBase = (g: GitState | null): boolean => !!g && g.branch === g.base

/**
 * Names a step as the pane and the instruction show it: the PR step says what it does to the unit's open PR, or names the one the unit created, except a follow-up's, which keeps its label.
 *
 * @param step - The step.
 * @param pr - The unit's PR on record, if any.
 * @returns The step's label.
 */
export function stepLabel(step: Step, pr: Pr | undefined): string {
  if (step.observe !== 'pr.created' || step.requires === 'refs' || pr?.state !== 'OPEN') return step.label
  if (pr.isCreated) return `PR #${pr.number}`
  return step.skill ? `Update PR #${pr.number}` : `Push to PR #${pr.number}`
}

/**
 * Tells whether a step is a PR update gone stale: its last confirmed head is no longer the checkout's HEAD.
 *
 * @param step - The step.
 * @param u - The unit.
 * @param g - The checkout, or null outside a repository.
 * @returns True for a confirmable PR step whose recorded head differs from HEAD.
 */
export const isPrStale = (step: Step, u: Unit, g: GitState | null): boolean =>
  step.observe === 'pr.created' && !!step.skill && step.requires !== 'refs' && !!u.prHead && !!g?.head && u.prHead !== g.head

/**
 * Lists the lines a PR body must carry but does not.
 *
 * @param requires - What the PR step requires of the body.
 * @param s - The session, which holds the declared issues and the followed-up issue.
 * @param body - The PR body text.
 * @returns The missing lines as displayed, empty when the body is complete.
 */
export function missingLines(requires: Step['requires'], s: Session, body: string): string[] {
  const has = (word: string, n: number) => new RegExp(`\\b${word}\\s+#${n}\\b`, 'i').test(body)
  if (requires === 'closes') return s.issues.filter(n => !has('Closes', n)).map(n => `Closes #${n}`)
  if (s.followUp === undefined) return []
  if (requires === 'refs') return has('Refs', s.followUp) ? [] : [`Refs #${s.followUp}`]
  return requires === 'linked' && !has('(?:closes|refs|fixes|resolves)', s.followUp) ? [`Closes|Refs|Fixes|Resolves #${s.followUp}`] : []
}

/**
 * Says what the agent must do to complete a step.
 *
 * @param step - The step.
 * @param s - The session.
 * @param verifyCmd - The repository's verify command, if it has one.
 * @param skills - The skills the unit has run.
 * @param isOnBase - Whether the checkout is on the default branch.
 * @param pr - The unit's PR on record, if any.
 * @param isStale - Whether the step's confirmed update no longer matches HEAD, so the branch must be pushed first.
 * @param testFiles - The test files the unit wrote.
 * @param red - Whether the reproduction test has been seen failing on unfixed code.
 * @returns The step's next action, as an imperative phrase.
 */
export function requirement(step: Step, s: Session, verifyCmd: string | undefined, skills: string[], isOnBase = false, pr?: Pr, isStale = false, testFiles: string[] = [], red: RedState = 'none'): string {
  if (step.human && step.skill) return `the user's step: stop and ask them to run /${step.skill}`
  if (step.exempt === 'tests') {
    const first = step.skill && !skills.includes(step.skill) ? `run the ${step.skill} skill, then ` : ''
    if (!testFiles.length) return `${first}write the failing test that reproduces the bug before editing non-test files`
    if (red === 'holds') return `run the ${step.skill} skill`
    if (red === 'stale') {
      return `${first}the reproduction test changed since it failed: re-run it on unfixed code and see it fail (if non-test changes are already in the tree, set them aside with git stash push -- <non-test paths>, re-run the test, then restore them with git stash pop)`
    }
    const alt = verifyCmd ? `, or run ${verifyCmd}` : ''
    return `${first}run the reproduction test directly by its path (the test file or its directory${alt}) and see it fail on unfixed code, before changing any non-test file`
  }
  if (step.skill && !step.observe) return `run the ${step.skill} skill`
  if (step.unlocks) {
    const change = verifyCmd ? `make the change, then run ${verifyCmd} to pass Verify` : 'make the change'
    return isOnBase ? `${branchFirst} first, then ${change}` : change
  }
  if (step.observe === 'verify.passed') return `run ${verifyCmd} exactly (no pipe, not in background)`
  if (step.observe === 'commit') {
    if (!step.skill) return 'commit the change'
    return skills.includes(step.skill)
      ? `commit with the message ${step.skill} already produced (no need to run it again)`
      : `run the ${step.skill} skill, then commit`
  }
  if (step.observe === 'pr.created') {
    const isOpen = pr?.state === 'OPEN' && step.requires !== 'refs'
    if (!step.skill) return isOpen ? `push the branch to PR #${pr.number}` : 'open the PR with gh pr create'
    const lines = step.requires === 'refs' ? [`Refs #${s.followUp}`] : step.requires === 'closes' ? s.issues.map(n => `Closes #${n}`) : []
    const body = step.requires === 'linked' ? ` (body must keep a line linking #${s.followUp}: Closes, Refs, Fixes or Resolves)`
      : lines.length ? ` (body must carry ${lines.join(', ')})` : ''
    return `${isStale ? 'push the branch, then run' : 'run'} the ${step.skill} skill ${isStale ? 'again ' : ''}to ${isOpen ? `update PR #${pr.number}` : 'open the PR'}${body}`
  }
  return step.label
}

/**
 * Writes the line that tells the agent its current step and next action.
 *
 * @param p - The unit's position.
 * @param s - The session.
 * @returns The instruction, prefixed with `[working-agreement]`.
 */
export function instruction(p: Position, s: Session): string {
  const issue = s.issues.length ? ` ${issueRefs(s.issues, ' ')}` : ''
  if (!p.current) return `[working-agreement] ${p.def.label}${issue} — all steps done.`
  if (isCiWait(p)) {
    const { reason, todo } = checksTodo(p.checks, `#${p.u.pr?.number ?? ''}`)
    return `[working-agreement] ${p.def.label}${issue} — current step: ${stepLabel(p.current.step, p.u.pr)}. ${reason}: ${todo}; do not report the unit as done before every check passes.`
  }
  // Name a following human step now: otherwise the agent closes this step by offering to run it itself.
  const next = p.states.slice(p.states.indexOf(p.current) + 1).find(st => st.state === 'pending')
  const handover = next?.step.human && next.step.skill
    ? ` When it is done, do not run or offer ${next.step.skill} yourself: the next step is the user's — tell them to run /${next.step.skill}.`
    : ''
  return `[working-agreement] ${p.def.label}${issue} — current step: ${stepLabel(p.current.step, p.u.pr)}. Next action: ${requirement(p.current.step, s, p.verifyCmd, p.u.skills, onBase(p.g), p.u.pr, isPrStale(p.current.step, p.u, p.g), p.u.testFiles, p.red)}.${handover}`
}

/**
 * Tells whether the unit's current step is its PR step, held back only by a PR whose CI has not passed.
 *
 * @param p - The unit's position.
 * @returns True while the PR step waits on CI.
 */
export const isCiWait = (p: Position): boolean =>
  p.current?.step.observe === 'pr.created' && p.checks !== 'off' && p.checks !== 'passing'

/**
 * Tells whether the session's unit has reached its end: every step done and a PR on record, or, with no flow, a PR created here.
 *
 * @param s - The session.
 * @param p - The unit's position, or null with no flow declared.
 * @returns True once the unit is finished.
 */
export const isUnitFinished = (s: Session, p: Position | null): boolean =>
  p ? !p.current && (s.prCreated || !!p.u.pr) : s.prCreated

/**
 * Formats issue numbers as references.
 *
 * @param issues - The issue numbers.
 * @param separator - What goes between two references.
 * @returns The `#n` references, joined.
 */
export const issueRefs = (issues: number[], separator: string): string => issues.map(n => `#${n}`).join(separator)

/**
 * Finds a flow's PR step.
 *
 * @param def - The flow.
 * @returns The step that observes the PR, if the flow has one.
 */
export const prStep = (def: FlowDef): Step | undefined => def.steps.find(st => st.observe === 'pr.created')

/**
 * Lists the labels of the session's declared issues, as last read from GitHub.
 *
 * @param s - The session.
 * @returns Every declared issue's labels, in issue order.
 */
export const declaredLabels = (s: Session): string[] => s.issues.flatMap(n => s.info[n]?.labels ?? [])

/**
 * Names the branch a unit's PR lives on: the branch the unit recorded, else the checkout's branch unless it is the default one
 * or the unit has a start and no commit past it, since a branch it has no work on carries other work's PR.
 *
 * @param u - The unit.
 * @param g - The checkout, or null outside a repository.
 * @param own - The unit's commits past its start; ignored for a unit with no start.
 * @returns The branch, or undefined when there is none to look on.
 */
export const prBranch = (u: Unit, g: GitState | null, own: number): string | undefined =>
  u.branch ?? (g && !onBase(g) && (!u.start || own > 0) ? g.branch : undefined)

/**
 * Tells whether a PR step's own work is done, CI aside: the branch pushed to the open PR, or the PR opened or updated to HEAD.
 *
 * @param st - The PR step.
 * @param u - The unit.
 * @param g - The checkout, or null outside a repository.
 * @param own - How many commits the unit made since its start.
 * @param hasRun - Whether the unit ran the step's skill.
 * @returns True once the PR holds the unit's work.
 */
export function isPrDone(st: Step, u: Unit, g: GitState | null, own: number, hasRun: boolean): boolean {
  if (!st.skill && u.pr?.state === 'OPEN') return !!g && !g.dirty && g.upToDate && (!!u.pushed || own > 0)
  if (st.skill && st.requires !== 'refs') return !!g?.head && !!u.prHead && u.prHead === g.head
  return !!u.pr && (!st.skill || hasRun)
}

/**
 * Decides where each step of the unit's flow stands: done, skipped, overridden, the current one, or pending.
 *
 * @param def - The declared flow.
 * @param s - The session.
 * @param u - The unit.
 * @param g - The checkout, or null outside a repository.
 * @param own - How many commits the unit made since its start.
 * @param verify - The verify command and whether it passed on the current tree.
 * @param checks - The CI state of the unit's PR; the PR step is done only when it is passing or off.
 * @param red - Whether the reproduction test has been seen failing on unfixed code; the test-exempt step is done only while it holds.
 * @returns The flow's steps with their states; Verify is left out when the repository has no verify command.
 */
export function stepStates(def: FlowDef, s: Session, u: Unit, g: GitState | null, own: number, verify: VerifyState, checks: Checks = 'off', red: RedState = 'none'): StepState[] {
  const steps = def.steps.filter(st => st.observe !== 'verify.passed' || verify.cmd)
  const labels = declaredLabels(s)
  const skipTarget = Object.entries(def.skipTo ?? {})
    .find(([k]) => k.startsWith('label:') && labels.includes(k.slice(6)))?.[1]
  const skipIndex = skipTarget ? steps.findIndex(st => st.id === skipTarget) : -1
  const committed = !!g && !g.dirty && (own > 0 || !!u.committed)
  // Verify keys the tree, so a run on the tree as declared would verify a change never made.
  const changed = !!g && (g.dirty || own > 0 || !!u.committed)
  const ran = (st: Step) => !!st.skill && u.skills.includes(st.skill)
  const talk = steps.filter(st => st.skill && !st.observe)

  const isGreen = checks === 'off' || checks === 'passing'

  const isDone = (st: Step): boolean => {
    // A test-exempt step (Diagnose) is done once its reproduction was seen failing and has not changed since, not when its skill starts.
    if (st.exempt === 'tests') return ran(st) && red === 'holds'
    // An issue-producing step (Spec, Triage, Map) follows the issue's labels on GitHub, not the command that wrote them;
    // `produced` counts only while no declared issue has stored info, so once GitHub has answered the labels alone decide.
    if (st.doneLabels) return ran(st) && ((!!u.produced?.includes(st.skill!) && s.issues.every(n => !s.info[n])) || s.issues.some(n => s.info[n]?.labels.some(l => st.doneLabels!.includes(l))))
    // The mod sees a skill start, never its end: a talk step is done once the next one has started.
    if (st.skill && !st.observe) {
      const later = talk.slice(talk.indexOf(st) + 1)
      return ran(st) && (!later.length || later.some(ran))
    }
    if (st.unlocks) return verify.cmd ? changed && verify.isVerified : committed
    if (st.observe === 'verify.passed') return verify.isVerified
    if (st.observe === 'commit') return committed && (!st.skill || u.skills.includes(st.skill))
    if (st.observe === 'pr.created') return isGreen && isPrDone(st, u, g, own, ran(st))
    return ran(st)
  }
  // Null marks a step still open: the first open one is current, the rest pending.
  const settled = steps.map((step, i): StepState | null => {
    if (u.overrides.some(o => o.step === step.id)) return { step, state: 'override' }
    // Done wins over skipped: /to-spec itself applies ready-for-agent, and its steps did run.
    if (isDone(step)) return { step, state: 'done' }
    if ((step.skipIfIssue && s.hadIssue) || i < skipIndex) return { step, state: 'skipped' }
    return null
  })
  const current = settled.indexOf(null)
  return settled.map((st, i): StepState => st ?? { step: steps[i]!, state: i === current ? 'current' : 'pending' })
}
