import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FlowRow } from '../types'
import { checksTodo, readChecks } from './checks'
import type { Checks } from './checks'
import { flowDefs } from './flows'
import type { FlowDef } from './flows'
import { herdrVerifyLaunch, herdrWaitArgs } from './herdr'
import { asRecords, asString, isRecord, parseJson } from './json'
import { bashOutcome } from './outcome'
import type { ToolRun } from './outcome'
import { matches, normalize, repoRelative } from './paths'
import { branchFirst, instruction, isUnitFinished, issueRefs, missingLines, onBase, prBranch, prStep, requirement, stepLabel, stepStates, stepSymbol } from './progress'
import type { GitState, Position, StepState } from './progress'
import { emptySession, emptyUnit, mergeSkills, toSession, toUnit, withOverride } from './records'
import type { Gh, IssueInfo, Pr, Session, Unit } from './records'
import { ask, asksHuman, deny, fileTools, isJudgedTool, strictest } from './rules'
import type { Judgement, Verdict } from './rules'
import { runtime, serial } from './runtime'
import type { Handoff } from './runtime'
import { ranCommands, runsVerify, shellTargets } from './shell'
import type { Invocation } from './shell'
import { buildView, keyWidth, labelColor, paneRule, palette, symbolColor, toneColor, viewText } from './view'

interface Issue extends IssueInfo { isFound: true; state: string }
interface IssueError { isFound: false; error: string }
type IssueLookup = Issue | IssueError
interface ProcessOutput { exitCode: number; stdout: string; stderr: string }
interface PrRef { number: number; state: string; headRefName: string; headRefOid: string; body: string }
/** No verify file in the repository. */
interface NoVerify { kind: 'none' }
/** The verify command the repository file names. */
interface VerifyCommand { kind: 'command'; cmd: string }
/** A malformed verify file, and the notice that says why it was ignored. */
interface IgnoredVerify { kind: 'ignored'; notice: string }
/** What the repository's verify file configures. */
type VerifyConfig = NoVerify | VerifyCommand | IgnoredVerify

const paneId = 'working-agreement'
const tickMs = 15000
const declareTool = 'mcp__working-agreement__declare_flow'
const checkFailed = '[working-agreement] the check failed, so the call is denied — retry; if it keeps failing, stop and tell the user'
const view = atom({ plugin: 'working-agreement', key: 'view' } as const, null)
const bodyFlag = /^(--body|-b|--body-file|-F)(=|$)/
// The gh pr merge flags that take a value as the next word, so it is not read as the PR.
const mergeValueFlags = ['-b', '--body', '-F', '--body-file', '-t', '--subject', '-A', '--author-email', '--match-head-commit']

async function runProcess($: EngineInterface, argv: string[], timeoutMs = 15000): Promise<ProcessOutput> {
  try {
    return await $.process.run(argv, { timeoutMs })
  } catch {
    return { exitCode: 127, stdout: '', stderr: 'could not run' }
  }
}

async function repoSlug($: EngineInterface) {
  const repo = await $.session.repo()
  const m = repo?.remote?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/)
  return m?.[1] ?? repo?.root ?? (await $.session.cwd())
}

/**
 * Reads the verify command from `.agents/working-agreement.json` at the repository root.
 *
 * @param $ - The engine.
 * @returns The command, the notice that says why a malformed file was ignored, or none when there is no file.
 */
async function readVerify($: EngineInterface): Promise<VerifyConfig> {
  const root = await gitRoot($)
  if (!root) return { kind: 'none' }
  const text = await readText($, `${root}/.agents/working-agreement.json`)
  if (text === null) return { kind: 'none' }
  const file = '.agents/working-agreement.json'
  const data = parseJson(text)
  if (!isRecord(data)) return { kind: 'ignored', notice: `[working-agreement] ${file} ignored: not a JSON object` }
  const verify = data.verify
  if (typeof verify !== 'string' || !verify.trim()) return { kind: 'ignored', notice: `[working-agreement] ${file} ignored: "verify" must be a non-empty string` }
  return { kind: 'command', cmd: verify }
}

// The verify command, if the repository's file names one.
async function verifyCommand($: EngineInterface): Promise<string | undefined> {
  const config = await readVerify($)
  return config.kind === 'command' ? config.cmd : undefined
}

// The contents of a file, or null when it cannot be read.
async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

async function gitRoot($: EngineInterface, isStrict = false) {
  const argv = ['git', 'rev-parse', '--show-toplevel']
  const r = isStrict ? await $.process.run(argv, { timeoutMs: 15000 }) : await runProcess($, argv)
  return r.exitCode === 0 ? r.stdout.trim() : null
}

// The trimmed output of a git command, whatever its exit code.
async function gitOut($: EngineInterface, ...args: string[]): Promise<string> {
  return (await runProcess($, ['git', ...args])).stdout.trim()
}

async function firstRef($: EngineInterface, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if ((await runProcess($, ['git', 'rev-parse', '--verify', '--quiet', candidate])).exitCode === 0) return candidate
  }
  return null
}

async function aheadOf($: EngineInterface, ref: string) {
  return Number(await gitOut($, 'rev-list', '--count', `${ref}..HEAD`)) || 0
}

async function head($: EngineInterface) {
  const r = await runProcess($, ['git', 'rev-parse', 'HEAD'])
  return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined
}

async function readGit($: EngineInterface): Promise<GitState | null> {
  const root = await gitRoot($)
  if (!root) return null
  const branch = await gitOut($, 'rev-parse', '--abbrev-ref', 'HEAD')
  const ref = await firstRef($, ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'])
  const named = ref === 'origin/HEAD' ? await gitOut($, 'rev-parse', '--abbrev-ref', ref) : ref
  const base = named?.replace(/^origin\//, '') || 'main'
  const ahead = ref ? await aheadOf($, ref) : 0
  const dirty = (await gitOut($, 'status', '--porcelain')) !== ''
  const up = await runProcess($, ['git', 'rev-list', '--count', '@{u}..HEAD'])
  return { root, branch, head: (await head($)) ?? '', base, ahead, dirty, upToDate: up.exitCode === 0 && up.stdout.trim() === '0' }
}

// Whether a GitHub Actions workflow runs on pull requests, so a PR has CI to wait for; without one the CI gate is off.
async function hasCi($: EngineInterface) {
  return (await runProcess($, ['git', 'grep', '-qE', 'pull_request(_target)?', '--', '.github/workflows'])).exitCode === 0
}

// The PR a gh pr merge names — number, URL or branch — or undefined for the current branch's.
function mergeTarget(args: string[]): string | undefined {
  const at = { i: 0 }
  while (at.i < args.length) {
    const arg = args[at.i++]!
    if (!arg.startsWith('-')) return arg
    if (mergeValueFlags.includes(arg)) at.i++
  }
  return undefined
}

// What a PR's checks report; the PR is a number, a URL, or none for the current branch's.
async function fetchChecks($: EngineInterface, pr?: string): Promise<Checks> {
  const r = await runProcess($, ['gh', 'pr', 'checks', ...(pr ? [pr] : []), '--json', 'bucket'])
  return readChecks(r.stdout)
}

// The CI state that holds back a PR step whose own work is done, or off when nothing does; cached briefly, since every refresh asks.
async function stepChecks($: EngineInterface, states: StepState[], u: Unit, g: GitState | null): Promise<Checks> {
  const pr = states.find(st => st.step.observe === 'pr.created')
  if (pr?.state !== 'done' || u.pr?.state !== 'OPEN' || !(await hasCi($))) return 'off'
  const key = `${u.pr.number}@${g?.head ?? ''}`
  const now = await $.clock.now()
  const cached = runtime.checksCache
  if (cached && cached.key === key && now - cached.at < 30000) return cached.checks
  const checks = await fetchChecks($, String(u.pr.number))
  runtime.checksCache = { key, at: now, checks }
  return checks
}

async function treeKey($: EngineInterface) {
  const r = await runProcess($, ['sh', '-c',
    'T=$(mktemp) && cp "$(git rev-parse --git-dir)/index" "$T" 2>/dev/null; ' +
    'GIT_INDEX_FILE="$T" git add -A >/dev/null 2>&1 && GIT_INDEX_FILE="$T" git write-tree; rm -f "$T"'])
  return r.exitCode === 0 ? r.stdout.trim() : null
}

async function ghStatus($: EngineInterface, force = false): Promise<Gh> {
  const now = await $.clock.now()
  if (!force && runtime.ghCache && now - runtime.ghCache.at < 60000) return runtime.ghCache.gh
  const r = await runProcess($, ['gh', 'api', 'user', '--jq', '.login'], 8000)
  const gh: Gh = r.exitCode === 0 ? 'connected'
    : /auth login|not logged|authenticat/i.test(r.stderr) ? 'unauth' : 'unreachable'
  runtime.ghCache = { at: now, gh }
  return gh
}

async function ghIssue($: EngineInterface, n: number): Promise<IssueLookup> {
  const r = await runProcess($, ['gh', 'issue', 'view', String(n), '--json', 'state,title,labels'])
  if (r.exitCode !== 0) return { isFound: false, error: r.stderr.trim().split('\n')[0] || 'not found' }
  const j = parseJson(r.stdout)
  if (!isRecord(j)) return { isFound: false, error: 'unreadable gh output' }
  return { isFound: true, state: asString(j.state), title: asString(j.title), labels: asRecords(j.labels).map(l => asString(l.name)) }
}

// A skill counts when it started this turn, or started earlier for the unit while its step is still open:
// an interactive skill asks first, so its write lands in a later turn.
const skillCounts = (p: Position | null, skill: string): boolean =>
  runtime.turnSkills.includes(skill) ||
  (!!p && p.u.skills.includes(skill) && p.states.some(st => st.step.skill === skill && st.state === 'current'))

// Whether an issue-writing skill counts now.
const hasIssueSkill = (p: Position | null): boolean => flowDefs.issueSkills.some(n => skillCounts(p, n))

// The title and labels of an issue gh found.
function issueInfo(issue: Issue): IssueInfo {
  return { title: issue.title, labels: issue.labels }
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: paneId, title: 'Flow' })
}

const sessionKey = async ($: EngineInterface) => `session:${await repoSlug($)}:${await $.session.id()}`
const issueKey = async ($: EngineInterface, n: number) => `issue:${await repoSlug($)}#${n}`
const unitKey = async ($: EngineInterface, s: Session) =>
  s.issues.length && !s.followUp ? issueKey($, s.issues[0]!) : `unit:${await sessionKey($)}`

async function getSession($: EngineInterface) {
  return toSession(await $.store.get(await sessionKey($)))
}
async function putSession($: EngineInterface, s: Session) {
  await $.store.set(await sessionKey($), s)
}
async function getUnit($: EngineInterface, key: string) {
  return toUnit(await $.store.get(key))
}
async function unitKeys($: EngineInterface, s: Session) {
  return s.followUp || !s.issues.length
    ? [await unitKey($, s)]
    : await Promise.all(s.issues.map(n => issueKey($, n)))
}
async function eachUnit($: EngineInterface, s: Session, fn: (u: Unit) => Unit) {
  for (const key of await unitKeys($, s)) {
    await $.store.set(key, fn(await getUnit($, key)))
  }
}

async function position($: EngineInterface, s: Session): Promise<Position | null> {
  const def = s.flow ? flowDefs.flows[s.flow] : undefined
  if (!def) return null
  const saved = await getUnit($, await unitKey($, s))
  const g = await readGit($)
  // The default branch is never an issue's branch, though units saved by older versions may hold it.
  const u = g && saved.branch === g.base ? { ...saved, branch: undefined } : saved
  const verifyCmd = await verifyCommand($)
  const key = verifyCmd ? await treeKey($) : null
  const isVerified = !!key && u.verify === key
  // Commits before the unit's start belong to earlier work on the branch; a unit with no start (Close out) owns them all.
  const own = !g ? 0 : u.start ? await aheadOf($, u.start) : g.ahead
  const verify = { cmd: verifyCmd, isVerified }
  const unchecked = stepStates(def, s, u, g, own, verify)
  const checks = await stepChecks($, unchecked, u, g)
  const states = checks === 'off' ? unchecked : stepStates(def, s, u, g, own, verify, checks)
  return { def, u, g, states, current: states.find(st => st.state === 'current') ?? null, isVerified, verifyCmd, checks }
}

// Skips the issue sync, which takes the lock: declare holds it and has just read its issues.
async function refresh($: EngineInterface, isQuiet = false, isIssuesRead = false) {
  const saved = await getSession($)
  if (saved.flow && !isQuiet) await syncPr($, saved)
  const s = saved.flow && !isQuiet && !isIssuesRead ? await syncIssues($, saved) : saved
  const p = await position($, s)
  if (!p) {
    if (await read($, view)) await update($, view, () => null)
    return
  }
  const gh = isQuiet ? runtime.ghCache?.gh ?? s.gh : await ghStatus($)
  const v = buildView(s, p, gh)
  if (JSON.stringify(await read($, view)) === JSON.stringify(v)) return
  await update($, view, () => v)
}

async function judgeWrite($: EngineInterface, s: Session, path: string): Promise<Verdict | null> {
  // A git that cannot run rejects here rather than reading as "outside a repository": with no root to compare against,
  // the hook's .catch denies every write, those outside the repository (scratchpad, /tmp) included.
  const root = await gitRoot($, true)
  if (!root) return null
  const rel = repoRelative(normalize(path, await $.session.cwd()), root)
  if (rel === null) return null
  if (matches(flowDefs.paths.ephemeral, rel)) {
    return deny(`${rel} is an ephemeral planning file`, 'put plans, specs and todos in a GitHub issue, not in the repo')
  }
  if (matches(flowDefs.paths.generated, rel)) {
    return deny(`${rel} is generated or vendored`, 'edit the source and let the pipeline produce the copy')
  }
  const p = await position($, s)
  if (!p) {
    return deny('no flow declared', 'classify the work per AGENTS.md and call declare_flow before writing (ask the user if unsure; Trivial change and Follow-up are theirs to declare with /flow)')
  }
  if (p.def.repoWrites === 'deny') {
    return deny(`${p.def.label} never writes to the repository`, 'put the outcome in the tracker; code starts in a later session from its ticket')
  }
  const verdicts: Verdict[] = []
  const unlock = p.states.findIndex(st => st.step.unlocks)
  for (const st of p.states.slice(0, Math.max(unlock, 0))) {
    if (st.state !== 'current' && st.state !== 'pending') continue
    const gate = st.step.gate ?? 'deny'
    if (gate === 'none' || (st.step.exempt === 'tests' && matches(flowDefs.testPaths, rel))) continue
    const todo = st.step.human
      ? `stop and ask the user to run /${st.step.skill}, or /flow override ${st.step.id} <reason>`
      : st.step.exempt === 'tests'
        ? `run the ${st.step.skill} skill and write the failing test first; a fix no test can reproduce needs the user's /flow override ${st.step.id} <reason>`
        : `run the ${st.step.skill} skill, then retry`
    verdicts.push((gate === 'deny' ? deny : ask)(`${p.def.label}: ${st.step.label} not done`, todo))
  }
  if (s.issues.some(n => !s.info[n]) && (await ghStatus($)) !== 'connected') {
    verdicts.push(ask('GitHub is unavailable, so the declared issue and its labels are unverified', 'stop and ask the user to fix gh (gh auth status), then declare again'))
  }
  // Every repository-writing flow ends with a PR, which cannot come from the default branch.
  if (onBase(p.g)) verdicts.push(deny(`writing on the default branch (${p.g!.base})`, `${branchFirst}, then retry`))
  if (p.u.branch && p.g && p.u.branch !== p.g.branch) {
    verdicts.push(ask(`this issue's work is on ${p.u.branch}, not ${p.g.branch}`, `switch to ${p.u.branch}, or ask the user to run /flow override branch <reason> to move it here`))
  }
  return strictest(verdicts)
}

// The text a gh pr command carries as its body: its own --body/-b values and --body-file/-F contents.
// Without parsed words (a fallback invocation) the whole command stands in, as does the command for a heredoc fed as `--body-file -`.
async function prBody($: EngineInterface, command: string, run: Invocation) {
  if (!run.isParsed) return command
  const { args, vars } = run
  const parts: string[] = []
  const at = { i: 0 }
  while (at.i < args.length) {
    const arg = args[at.i++]!
    const flag = bodyFlag.exec(arg)
    if (!flag) continue
    const value = flag[2] ? arg.slice(flag[0].length) : args[at.i++] ?? ''
    // A substitution or heredoc inside the value may hold the body text, which tokenizing stripped: the command stands in.
    if (/\$\(|`|<</.test(value)) parts.push(command)
    if (flag[1] === '--body' || flag[1] === '-b') parts.push(value)
    else if (value === '-') parts.push(command)
    else {
      // Only plain $NAME and ${NAME} of variables assigned earlier in the line; any other reference stays as written.
      const path = value.replace(/\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})/g, (ref, a, b) => vars[a ?? b] ?? ref)
      try {
        parts.push(await $.fs.read(path))
      } catch {
        parts.push(command)
      }
    }
  }
  return parts.join('\n')
}

async function writesTest($: EngineInterface, tool: string, args: Record<string, unknown>) {
  const root = await gitRoot($)
  if (!root) return false
  const cwd = await $.session.cwd()
  const paths = fileTools.includes(tool)
    ? [asString(args.file_path ?? args.notebook_path)]
    : shellTargets(asString(args.command), flowDefs.bashWritePatterns)
  return paths.some(p => {
    const rel = repoRelative(normalize(p, cwd), root)
    return !!rel && matches(flowDefs.testPaths, rel)
  })
}

async function judgeCall($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<Judgement> {
  const s = await getSession($)
  if (fileTools.includes(tool)) {
    const v = await judgeWrite($, s, asString(args.file_path ?? args.notebook_path))
    return v ? { ...v, write: { kind: 'edits', isDenied: v.decision === 'deny' } } : { decision: 'allow' }
  }
  if (tool !== 'Bash') return { decision: 'allow' }
  const command = asString(args.command)
  const writes: Verdict[] = []
  for (const t of shellTargets(command, flowDefs.bashWritePatterns)) {
    const v = await judgeWrite($, s, t)
    if (v) writes.push(v)
  }
  const verdicts = [...writes]
  const p = s.flow ? await position($, s) : null

  if (ranCommands(command, 'gh issue create').length && !hasIssueSkill(p)) {
    verdicts.push(ask('gh issue create outside /to-spec or /triage', 'issues come from those skills: stop and ask the user to run one'))
  }
  if (p && ranCommands(command, 'git commit').length && p.verifyCmd && !p.isVerified && !p.u.overrides.some(o => o.step === 'verify')) {
    verdicts.push(ask(p.u.verify ? 'Verify is stale' : 'Verify has not run', `run ${p.verifyCmd} exactly (no pipe, not in background), then commit; an untested commit needs the user's /flow override verify <reason>`))
  }
  // An edit that leaves the body alone (labels, title) cannot drop a required line.
  const prWrites = ranCommands(command, 'gh pr (?:create|edit)').filter(r => r.lead === 'gh pr create' || !r.isParsed || r.args.some(w => bodyFlag.test(w)))
  if (p) for (const run of prWrites) {
    if (p.g?.dirty) verdicts.push(deny('working tree is dirty', 'commit (or stash) everything first so the PR holds what was committed'))
    const req = prStep(p.def)?.requires ?? 'none'
    const body = await prBody($, command, run)
    if ((req === 'refs' || req === 'linked') && s.followUp === undefined) {
      verdicts.push(deny('the follow-up issue is unknown', 'ask the user to run /flow follow-up #<n> again'))
    }
    const missing = missingLines(req, s, body)
    if (missing.length) {
      verdicts.push(deny(`PR body lacks ${missing.join(', ')}`, req === 'linked'
        ? `keep a line linking #${s.followUp} (Closes, Refs, Fixes or Resolves)`
        : `add a "${req === 'refs' ? 'Refs' : 'Closes'} #<n>" line for every declared issue`))
    }
  }
  const merges = ranCommands(command, 'gh pr merge')
  if (merges.length && (await hasCi($))) for (const run of merges) {
    const target = run.isParsed ? mergeTarget(run.args) : undefined
    const checks = await fetchChecks($, target)
    if (checks !== 'passing') {
      const { reason, todo } = checksTodo(checks, target && /^\d+$/.test(target) ? `#${target}` : target ?? '')
      verdicts.push(deny(reason, todo))
    }
  }
  return {
    ...strictest(verdicts),
    ...(writes.length ? { write: { kind: 'shell', isDenied: strictest(writes).decision === 'deny' } } : {}),
  }
}

async function declare($: EngineInterface, flow: string, issues: number[], by: FlowDef['declaredBy']) {
  const def = flowDefs.flows[flow]
  if (!def) return `[working-agreement] unknown flow "${flow}" — use one of ${Object.keys(flowDefs.flows).join(', ')}`
  if (def.declaredBy === 'human' && by === 'agent') {
    return `[working-agreement] ${def.label} is declared only by the user — tell the user why and ask them to run /flow`
  }
  const s = await getSession($)
  if (s.prCreated) return '[working-agreement] a PR was already created in this session — one unit of work per session: run /handoff, then /clear, then declare the next flow'
  if (s.flow && s.output && !s.reclassifyOk) {
    return `[working-agreement] ${flowDefs.flows[s.flow]?.label} already produced output (issue or commit) — reclassification needs /flow override reclassify <reason>`
  }
  if (def.issue === 'required' && !issues.length) return `[working-agreement] ${def.label} needs an issue — pass its number`
  const declared = def.issue === 'none' ? [] : issues

  const gh = await ghStatus($, true)
  const info: Record<string, IssueInfo> = {}
  if (gh === 'connected') {
    for (const n of declared) {
      const r = await ghIssue($, n)
      if (!r.isFound) return `[working-agreement] issue #${n}: ${r.error} — check the number`
      if (r.state !== 'OPEN') return `[working-agreement] issue #${n} is ${r.state.toLowerCase()} — declare an open issue`
      info[n] = issueInfo(r)
    }
  }
  if (flow === 'close-out') {
    const g = await readGit($)
    if (!g || (g.ahead === 0 && !g.dirty)) return '[working-agreement] Close out needs code on the issue branch — nothing ahead of base and no changes here'
  }
  const next: Session = {
    ...s, flow, issues: declared, hadIssue: declared.length > 0, info, gh, reclassifyOk: false, followUp: undefined,
    skills: undefined,
  }
  await putSession($, next)
  // Flow steps that ran before the declaration count for the unit; Close out also owns the commits made before it.
  const before = s.skills ?? []
  const start = flow === 'close-out' ? undefined : await head($)
  await eachUnit($, next, u => ({ ...u, skills: mergeSkills(u.skills, before), start: u.start ?? start }))
  await syncPr($, next, true)
  // This runs inside `serial`, which syncIssues would wait on.
  runtime.issuesCheckedAt = await $.clock.now()
  await refresh($, false, true)
  void openPane($)
  const p = (await position($, next))!
  const warn = gh === 'connected' ? '' : ` (GitHub ${gh}: issues not verified)`
  const which = declared.length ? ` for ${issueRefs(declared, ', ')}` : ''
  const steps = p.states.map(st => `${stepSymbol[st.state]} ${stepLabel(st.step, p.u.pr)} (${requirement(st.step, next, p.verifyCmd, p.u.skills, onBase(p.g), p.u.pr)})`).join('; ')
  return `Flow declared: ${def.label}${which}${warn}. Steps: ${steps}. ${instruction(p, next)}`
}

async function syncPr($: EngineInterface, s: Session, force = false) {
  const now = await $.clock.now()
  if (!force && now - runtime.prCheckedAt < 60000) return
  runtime.prCheckedAt = now
  if ((await ghStatus($)) !== 'connected') return
  for (const key of await unitKeys($, s)) {
    const u = await getUnit($, key)
    // A unit records its branch only on the agent's first write, so code committed from a terminal leaves none;
    // the default branch never carries a unit's PR.
    const g = u.branch ? null : await readGit($)
    const branch = prBranch(u, g)
    if (!branch) continue
    const r = await runProcess($, ['gh', 'pr', 'list', '--head', branch, '--state', 'all', '--json', 'number,state', '--limit', '1'])
    const found = r.exitCode === 0 ? asRecords(parseJson(r.stdout))[0] : undefined
    const pr: Pr | undefined = found && typeof found.number === 'number' ? { number: found.number, state: asString(found.state) } : undefined
    if (pr && (pr.number !== u.pr?.number || pr.state !== u.pr?.state)) await $.store.set(key, { ...u, pr: u.pr?.isCreated && pr.number === u.pr.number ? { ...pr, isCreated: true } : pr })
  }
}

// Reads each of the session's issues back from GitHub; an issue that cannot be read is left out, so the caller keeps its stored info.
async function readIssues($: EngineInterface, s: Session): Promise<Record<string, IssueInfo>> {
  const info: Record<string, IssueInfo> = {}
  for (const n of s.issues) {
    const issue = await ghIssue($, n)
    if (issue.isFound) info[n] = issueInfo(issue)
  }
  return info
}

// Stores the declared issues' info as GitHub reports it, at most once a minute unless forced; returns the session as stored.
// It must not run inside `serial`: the gh reads stay off the lock, and only the re-read, merge of `info` and write take it.
async function syncIssues($: EngineInterface, s: Session, force = false): Promise<Session> {
  const now = await $.clock.now()
  if ((!force && now - runtime.issuesCheckedAt < 60000) || !s.issues.length) return s
  runtime.issuesCheckedAt = now
  if ((await ghStatus($)) !== 'connected') return s
  const fresh = await readIssues($, s)
  return serial(async () => {
    const cur = await getSession($)
    const info = { ...cur.info, ...fresh }
    if (JSON.stringify(info) === JSON.stringify(cur.info)) return cur
    const next = { ...cur, info }
    await putSession($, next)
    return next
  })
}

async function followUp($: EngineInterface, n: number) {
  const s = await getSession($)
  if (s.prCreated) return '[working-agreement] a PR was already created in this session — run /handoff, then /clear, then /flow follow-up in the new session'
  if (s.flow) return '[working-agreement] follow-ups start only in a new session — run /handoff, then /clear'
  if ((await ghStatus($, true)) !== 'connected') return '[working-agreement] follow-up needs GitHub to find the PR — check gh auth status'
  const r = await runProcess($, ['gh', 'pr', 'list', '--state', 'all', '--search', `${n}`, '--json', 'number,state,headRefName,headRefOid,body', '--limit', '50'])
  const prs: PrRef[] = r.exitCode === 0
    ? asRecords(parseJson(r.stdout)).map(p => ({ number: Number(p.number), state: asString(p.state), headRefName: asString(p.headRefName), headRefOid: asString(p.headRefOid), body: asString(p.body) }))
    : []
  const pr = prs.find(p => new RegExp(`\\b(closes|refs|fixes|resolves)\\s+#${n}\\b`, 'i').test(p.body))
  if (!pr) return `[working-agreement] #${n} has no PR yet — continue it in its own flow (declare it), not as a follow-up`
  const flow = pr.state === 'OPEN' ? 'follow-up-open' : pr.state === 'MERGED' ? 'follow-up-merged' : null
  if (!flow) return `[working-agreement] PR #${pr.number} for #${n} is ${pr.state.toLowerCase()} — nothing to follow up on`
  const issue = await ghIssue($, n)
  const next: Session = {
    ...s, flow, issues: [n], hadIssue: true, followUp: n, gh: 'connected',
    info: issue.isFound ? { [n]: issueInfo(issue) } : {},
  }
  await putSession($, next)
  // An open PR's follow-up starts from the PR's head, wherever the checkout is; a merged one's from here.
  await $.store.set(await unitKey($, next), flow === 'follow-up-open'
    ? { ...emptyUnit(), start: pr.headRefOid || await head($), branch: pr.headRefName, pr: { number: pr.number, state: 'OPEN' } }
    : { ...emptyUnit(), start: await head($) })
  await refresh($)
  void openPane($)
  return flow === 'follow-up-open'
    ? `Follow-up on #${n}: continue on ${pr.headRefName} and push to PR #${pr.number}.`
    : `Follow-up on #${n}: PR #${pr.number} is merged — work on a new branch; its PR body must carry "Refs #${n}".`
}

async function override($: EngineInterface, args: string) {
  const m = args.match(/^(\S+)\s+(?:#(\d+)\s+)?(.+)$/)
  if (!m) return 'Usage: /flow override <step> [#issue] <reason>'
  const step = m[1]!
  const reason = m[3]!.replace(/^["']|["']$/g, '')
  const s = await getSession($)
  if (!s.flow) return '[working-agreement] no flow declared — nothing to override'
  if (step === 'reclassify') {
    await putSession($, { ...s, reclassifyOk: true })
    return `Reclassification allowed once — "${reason}"`
  }
  if (step === 'branch') {
    const g = await readGit($)
    if (!g) return '[working-agreement] not in a git repository'
    await eachUnit($, s, u => ({ ...withOverride(u, 'branch', reason), branch: g.branch }))
    await refresh($)
    return `Override: the issue's work now lives on ${g.branch} — "${reason}" (logged)`
  }
  const def = flowDefs.flows[s.flow]
  if (!def) return `[working-agreement] unknown flow "${s.flow}" — nothing to override`
  if (!def.steps.some(st => st.id === step)) {
    return `[working-agreement] no step "${step}" in ${def.label} — steps: ${def.steps.map(st => st.id).join(', ')}, branch, reclassify`
  }
  const n = m[2] ? Number(m[2]) : s.issues[0]
  const key = n !== undefined && !s.followUp ? await issueKey($, n) : await unitKey($, s)
  await $.store.set(key, withOverride(await getUnit($, key), step, reason))
  await refresh($)
  return `Override: ${step}${n !== undefined ? ` on #${n}` : ''} — "${reason}" (logged)`
}

async function failHandoff($: EngineInterface, reason: string) {
  runtime.handoff = null
  const s = await getSession($)
  await putSession($, { ...s, handoff: { state: 'failed', reason } })
  await refresh($)
  if (!s.flow) $.ui.toast(`Handoff not completed — ${reason}. Nothing cleared.`)
}

async function findDocument($: EngineInterface, h: Handoff, root: string | null) {
  if (h.path) return h.path
  const since = `@${Math.floor(h.at / 1000)}`
  const r = await runProcess($, ['sh', '-c',
    'for d in "${TMPDIR:-/tmp}" /tmp; do find "$d" -maxdepth 6 -type f -name "*.md" -newermt "$1" 2>/dev/null; done | sort -u', 'sh', since])
  const found = r.stdout.split('\n').filter(f => f && !(root && f.startsWith(`${root}/`)))
  return found.length === 1 ? found[0]! : null
}

async function startHandoff($: EngineInterface) {
  const s = await getSession($)
  if (s.handoff?.state === 'running' || runtime.handoff) return
  const p = s.flow ? await position($, s) : null
  const isFinished = !!s.flow && isUnitFinished(s, p)
  const pr = p?.u.pr?.number
  const next = !s.flow ? 'The next session continues this work.'
    : isFinished && s.issues.length === 1 ? `Next session: follow-up on #${s.issues[0]}${pr ? ` (PR #${pr})` : ''}.`
    : isFinished ? `Next session: follow-up on one of ${issueRefs(s.issues, ', ')}.`
    : 'The next session continues this unit.'
  const args = [p ? instruction(p, s).replace('[working-agreement] ', 'Flow: ') : '', next].filter(Boolean).join(' ')
  const resolvers: ((reason: string) => void)[] = []
  const ended = new Promise<string>(resolve => { resolvers.push(resolve) })
  const h: Handoff = { at: await $.clock.now(), isFinished, path: null, armed: false, ended: reason => resolvers.forEach(r => r(reason)) }
  runtime.handoff = h
  await putSession($, { ...s, handoff: { state: 'running' } })
  await refresh($)
  // A hook the turn waits on cannot run a command: leave the caller first.
  $.clock.after(0, () => void handoffSequence($, h, args, ended).catch(err => failHandoff($, String(err))))
}

async function handoffSequence($: EngineInterface, h: Handoff, args: string, ended: Promise<string>) {
  await $.command.run({ command: 'handoff', args })
  const reason = await ended
  if (runtime.handoff !== h) return
  if (reason !== 'answer') return failHandoff($, reason === 'aborted' ? 'turn interrupted' : `turn ended with ${reason}`)
  const path = await findDocument($, h, await gitRoot($))
  if (!path) return failHandoff($, 'no single handoff document found')
  const st = await $.fs.stat(path).catch(() => null)
  if (!st || st.size === 0) return failHandoff($, 'handoff document is empty')
  if (st.mtimeMs < h.at) return failHandoff($, 'handoff document was not written by this run')

  const old = await getSession($)
  const oldUnit = await unitKey($, old)
  await putSession($, { ...old, handoff: undefined })
  await $.store.set(`handoff:${await repoSlug($)}`, { path, sid: await $.session.id(), at: h.at })
  runtime.handoff = null
  await $.command.run({ command: 'clear' })
  try {
    await continueAfterClear($, h, old, oldUnit, path)
  } catch (err) {
    $.ui.toast(`Cleared, but the new session could not be set up: ${String(err)}`)
  }
}

async function continueAfterClear($: EngineInterface, h: Handoff, old: Session, oldUnit: string, path: string) {
  const text = await carryOver($, h, old, oldUnit, path)
  await refresh($)
  await $.prompt.submit({ text, asUser: true })
}

// Sets up the new session from the old one and words the prompt that starts it.
async function carryOver($: EngineInterface, h: Handoff, old: Session, oldUnit: string, path: string) {
  const resume = `Continue from the handoff document at ${path}. Read it first, then follow its suggested skills.`
  if (h.isFinished && old.issues.length === 1) {
    const n = old.issues[0]!
    const result = await followUp($, n)
    if (!result.startsWith('[working-agreement]')) {
      return `Continue from the handoff document at ${path}. This session is a follow-up on #${n}; ask me what to change.`
    }
    $.ui.toast(result)
    return resume
  }
  if (h.isFinished && old.issues.length > 1) {
    return `Continue from the handoff document at ${path}. The previous unit closed ${issueRefs(old.issues, ', ')}: ask me which one this session follows up on, so I can run /flow follow-up #n.`
  }
  if (old.flow) {
    const carried: Session = {
      ...emptySession(), flow: old.flow, issues: old.issues, hadIssue: old.hadIssue, info: old.info,
      output: old.output, gh: old.gh, followUp: old.followUp,
    }
    await putSession($, carried)
    // Units without an issue are keyed by session id: move them to the new one.
    const newUnit = await unitKey($, carried)
    if (newUnit !== oldUnit) await $.store.set(newUnit, await getUnit($, oldUnit))
    void openPane($)
  }
  return resume
}

/**
 * Reads the PR back from GitHub after a create or edit and records its head when the body is complete and the head is the local HEAD.
 *
 * @param $ - The engine.
 * @param s - The session.
 * @param stdout - The create or edit output, which carries the PR URL.
 * @returns True when the update was confirmed and recorded.
 */
async function confirmPr($: EngineInterface, s: Session, stdout: string): Promise<boolean> {
  const p = s.flow ? await position($, s) : null
  const step = p ? prStep(p.def) : undefined
  if (!p || !step?.skill || step.requires === 'refs' || !p.g?.head || (step.requires === 'linked' && s.followUp === undefined)) return false
  const branch = prBranch(p.u, p.g)
  const known = (p.u.pr?.state === 'OPEN' ? p.u.pr.number : 0) || (Number(stdout.match(/\/pull\/(\d+)/)?.[1]) || 0)
  const found = known || (branch ? await openPrOn($, branch) : 0)
  if (!found) return false
  const r = await runProcess($, ['gh', 'pr', 'view', String(found), '--json', 'body,headRefOid'])
  const view = r.exitCode === 0 ? parseJson(r.stdout) : null
  if (!isRecord(view) || typeof view.body !== 'string' || typeof view.headRefOid !== 'string') return false
  if (!view.headRefOid || view.headRefOid !== p.g.head || missingLines(step.requires, s, view.body).length) return false
  const prHead = view.headRefOid
  await eachUnit($, s, u => ({ ...u, prHead, pr: u.pr?.state === 'OPEN' ? u.pr : { number: found, state: 'OPEN' } }))
  return true
}

// The number of the open PR whose head is the branch, or 0 when there is none.
async function openPrOn($: EngineInterface, branch: string): Promise<number> {
  const listed = await runProcess($, ['gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--limit', '1'])
  return Number(asRecords(parseJson(listed.stdout))[0]?.number) || 0
}

async function observeBash($: EngineInterface, seen: Session, command: string, ran: ToolRun) {
  const s: Session = { ...seen, info: { ...seen.info } }
  const { isOk, stdout, commit, push, pr } = bashOutcome(ran)
  const writesGh = ranCommands(command, 'gh issue (?:create|edit|comment)').length + ranCommands(command, 'gh pr (?:create|edit)').length > 0
  const p = seen.flow && writesGh ? await position($, seen) : null
  const isSkill = hasIssueSkill(p)
  const made = isOk && ranCommands(command, 'gh issue create').length ? stdout.match(/\/issues\/(\d+)/) : null
  // The outcome can also land on the declared issue itself (gh issue edit/comment).
  const issueRuns = isOk ? ranCommands(command, 'gh issue (?:edit|comment)') : []
  const edited = s.issues.find(n => issueRuns.some(r => r.isParsed
    ? r.args.some(w => new RegExp(`(^|[#/])${n}$`).test(w))
    : new RegExp(`(^|[\\s#/])${n}(\\s|$)`).test(command)))
  if (made && isSkill) {
    const n = Number(made[1])
    if (!s.issues.length && !s.followUp) {
      const before = await getUnit($, await unitKey($, s))
      s.issues = [n]
      const key = await unitKey($, s)
      const u = await getUnit($, key)
      await $.store.set(key, { ...u, ...before, skills: mergeSkills(u.skills, before.skills) })
    }
    s.output = true
  }
  if (edited !== undefined && isSkill) s.output = true
  // The labels decide the step: read the unit's issues back after any write to them.
  if ((made && isSkill) || edited !== undefined) s.info = { ...s.info, ...await readIssues($, s) }
  if (commit) {
    s.output = true
    await eachUnit($, s, u => ({ ...u, committed: true }))
  }
  if (push) await eachUnit($, s, u => ({ ...u, pushed: true }))
  if (pr && (pr.action === 'created' || pr.action === 'merged')) {
    if (pr.action === 'created') s.prCreated = true
    await eachUnit($, s, u => ({ ...u, pr: pr.action === 'merged' ? { number: pr.number, state: 'MERGED' } : { number: pr.number, state: 'OPEN', isCreated: true } }))
  }
  if (isOk && skillCounts(p, 'create-pr') && ranCommands(command, 'gh pr (?:create|edit)').length && (await confirmPr($, s, stdout))) s.prCreated = true
  const verifyCmd = await verifyCommand($)
  if (verifyCmd && isOk && runsVerify(command, verifyCmd)) {
    const key = await treeKey($)
    await eachUnit($, s, u => ({ ...u, verify: key }))
  }
  // A herdr pane run returns at once: the verdict is the marker line a later wait-output prints.
  const launched = verifyCmd && isOk ? herdrVerifyLaunch(command, verifyCmd) : null
  const launchTree = launched ? await treeKey($) : null
  if (launched && launchTree && !runtime.herdrConsumed.has(launched.id)) runtime.herdrVerify[launched.pane] = { id: launched.id, tree: launchTree }
  const waited = isOk ? herdrWaitArgs(command)?.find(w => w in runtime.herdrVerify) : undefined
  if (waited) {
    const parsed = parseJson(stdout)
    const matched = isRecord(parsed) && isRecord(parsed.result) ? asString(parsed.result.matched_line) : ''
    const { id, tree } = runtime.herdrVerify[waited]!
    const code = new RegExp(`^__EXIT_${id}=(\\d+)__$`).exec(matched)?.[1]
    if (code !== undefined) {
      const key = await treeKey($)
      const isPassed = Number(code) === 0 && key === tree
      delete runtime.herdrVerify[waited]
      runtime.herdrConsumed.add(id)
      if (isPassed) await eachUnit($, s, u => ({ ...u, verify: key }))
    }
  }
  await putSession($, s)
}

async function checkCall($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<Judgement> {
  if (runtime.handoff?.armed && tool === 'Bash' && shellTargets(asString(args.command), flowDefs.bashWritePatterns).length) {
    return deny('handoff', 'write the document with the Write tool')
  }
  const judged = await judgeCall($, tool, args)
  return judged.decision === 'ask' && !asksHuman()
    ? { ...judged, decision: 'deny', ...(judged.write ? { write: { ...judged.write, isDenied: true } } : {}) }
    : judged
}

/**
 * Registers the hooks that enforce the working agreement's flows and draw the Flow pane.
 *
 * @param on - Adds a hook for an engine event.
 * @param options - The user's plugin configuration, read for the handoff threshold.
 */
export const register: Register = (on, options) => {
  const tokens = options.handoffTokens
  if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) runtime.handoffTokens = tokens

  on('session.start', async ($, e, next) => {
    if ((await getSession($)).handoff?.state === 'running' && !runtime.handoff) await failHandoff($, 'interrupted by a mod reload')
    await $.command.register({
      name: 'flow',
      description: 'Working agreement: open the pane; status | handoff [cancel] | trivial | follow-up #n | override <step> [#n] <reason>',
      argumentHint: '[status|handoff [cancel]|trivial|follow-up #n|override <step> <reason>]',
    })
    await $.tool.register({
      name: 'declare_flow',
      description:
        'Declare the AGENTS.md flow of this session before its first flow step (grilling, to-spec, triage…) or the first write in the repository; ' +
        'when the session starts from an issue, read it and classify it. ' +
        'flow: large-feature | small-feature | fix | close-out. issues: the GitHub issue numbers this unit of work resolves ' +
        '(omit when the flow will create its issue: Small feature via /to-spec, Fix via /triage, Large feature via /to-tickets). ' +
        'If unsure which flow fits, ask the user with a multiple-choice question first. ' +
        'Trivial change and Follow-up are declared only by the user (/flow trivial, /flow follow-up #n): if a change looks trivial, tell the user and ask them to declare it.',
      inputSchema: {
        type: 'object',
        properties: {
          flow: { type: 'string', enum: ['large-feature', 'small-feature', 'fix', 'close-out'] },
          issues: { type: 'array', items: { type: 'integer' } },
        },
        required: ['flow'],
      },
    })
    if ((await getSession($)).flow) {
      await refresh($)
      void openPane($)
    }
    $.clock.every(tickMs, async () => {
      const s = await getSession($)
      if (!s.flow) return
      await syncIssues($, s)
      await refresh($, true)
    })
    return next(e)
  })

  on('classic.SessionStart', (_$, e, next) => {
    runtime.permissionMode = e.permission_mode ?? runtime.permissionMode
    return next(e)
  })

  on('classic.UserPromptSubmit', (_$, e, next) => {
    runtime.permissionMode = e.permission_mode ?? runtime.permissionMode
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (runtime.handoff && !runtime.handoff.armed && e.origin.kind === 'plugin' && e.origin.name === 'working-agreement' && e.text.startsWith('/handoff')) runtime.handoff.armed = true
    const saved = await getSession($)
    const s = saved.flow ? await syncIssues($, saved) : saved
    const p = s.flow ? await position($, s) : null
    if (isUnitFinished(s, p)) return next(e)
    const line = p
      ? instruction(p, s)
      : '[working-agreement] No flow is declared. Reading and talking need none, but before the first flow step (grilling, to-spec, triage…) or the first write in the repository, ' +
        'classify the work per AGENTS.md and call declare_flow; if unsure, ask the user with a multiple-choice question.'
    const config = await readVerify($)
    return next({ ...e, context: [...(e.context ?? []), line, ...(config.kind === 'ignored' ? [config.notice] : [])] })
  })

  on('skill.prompt', async ($, e, next) => {
    const name = e.skill.split(':').pop()!
    if (!runtime.turnSkills.includes(name)) runtime.turnSkills = [...runtime.turnSkills, name]
    await serial(async () => {
      const s = await getSession($)
      if (!s.flow) {
        // Kept until declare() credits it to the unit.
        if (!s.skills?.includes(name)) await putSession($, { ...s, skills: mergeSkills(s.skills ?? [], [name]) })
        return
      }
      await eachUnit($, s, u => ({ ...u, skills: mergeSkills(u.skills, [name]) }))
      await refresh($, true)
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) return done
    runtime.turnSkills = []
    if (runtime.handoff?.armed) {
      runtime.handoff.armed = false
      runtime.handoff.ended(e.reason)
      return done
    }
    await serial(async () => {
      const s = await getSession($)
      if (!s.flow) return
      const isLong = ((await $.session.usage()).context.tokens ?? 0) >= runtime.handoffTokens
      if (isLong === s.isLong) return
      await putSession($, { ...s, isLong, isToasted: s.isToasted || isLong })
      await refresh($, true)
      if (isLong && !s.isToasted) $.ui.toast('Long session — Continue in new session from the Flow pane, or /flow handoff')
    })
    return done
  })

  on('tool.call', { tool: declareTool }, async ($, e) => {
    if (e.agentId) return { deny: '[working-agreement] subagents inherit the session flow and cannot declare one — return to the main agent' }
    const args: Record<string, unknown> = { ...e }
    const issues = Array.isArray(args.issues) ? args.issues.filter((n): n is number => typeof n === 'number') : []
    const text = await serial(() => declare($, asString(args.flow), issues, 'agent'))
    return text.startsWith('[working-agreement]') ? { deny: text } : { result: text }
  }).catch(() => ({ deny: checkFailed }))

  // Its .catch also answers a call re-entered beneath the hook's own $ calls (next.called false): the check never ran on it, so it is denied.
  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__working-agreement__')) return next(e)
    const args: Record<string, unknown> = { ...e }
    if (e.tool === 'Skill' && !e.agentId) {
      const name = asString(args.skill).split(':').pop()
      const steps = Object.values(flowDefs.flows).flatMap(f => f.steps.map(st => st.skill))
      if (steps.includes(name) && !(await getSession($)).flow) {
        return { deny: `[working-agreement] ${name} is a flow step and no flow is declared — classify the work per AGENTS.md (read the issue if there is one), call declare_flow, then run ${name} again` }
      }
      return next(e)
    }
    if (!isJudgedTool(e.tool)) return next(e)
    const v = await checkCall($, e.tool, args)
    if (v.decision === 'deny') {
      const kind = v.write?.isDenied ? v.write.kind : undefined
      // The deny never waits for the lock: a hook past its budget fails, and its .catch denies without v.reason.
      if (kind) {
        void serial(async () => {
          const s = await getSession($)
          await putSession($, { ...s, blocked: { ...s.blocked, [kind]: s.blocked[kind] + 1 } })
          await refresh($, true)
        }).catch(() => undefined)
      }
      return { deny: v.reason }
    }
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    try {
      const file = asString(args.file_path)
      if (runtime.handoff?.armed && e.tool === 'Write' && ran.isError !== true && file.endsWith('.md')) {
        const root = await gitRoot($)
        const abs = normalize(file, await $.session.cwd())
        if (!root || !repoRelative(abs, root)) runtime.handoff.path = abs
      }
      await serial(async () => {
        const s = await getSession($)
        if (!s.flow) return
        if (v.write && ran.isError !== true) {
          const g = await readGit($)
          const tested = await writesTest($, e.tool, args)
          if (g || tested) {
            const isNewBranch = (u: Unit) => !!g && !onBase(g) && (!u.branch || u.branch === g.base)
            await eachUnit($, s, u => ({
              ...u, branch: isNewBranch(u) ? g?.branch : u.branch, tested: tested || u.tested,
            }))
          }
        }
        if (e.tool === 'Bash') await observeBash($, s, asString(args.command), ran)
        await refresh($, true)
      })
      // GitHub (PR state, gh status) is refreshed off the lock and off the tool result's path.
      void refresh($).catch(() => undefined)
    } catch (err) {
      $.ui.toast(`working-agreement: could not record ${e.tool} (${String(err)})`)
    }
    return ran
  }).catch((_$, e, next) => next.called ? next(e) : { deny: checkFailed })

  on('tool.check', async ($, e, next) => {
    if (!isJudgedTool(e.tool)) return next(e)
    const v = await judgeCall($, e.tool, isRecord(e.input) ? e.input : {})
    const below = await next(e)
    if (v.decision !== 'ask' || below.decision === 'deny') return below
    return { decision: 'ask', reason: v.reason }
  }).catch(() => ({ decision: 'deny', reason: checkFailed }))

  on('command.run', { command: 'flow' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/)
    const tail = rest.join(' ')
    const isHumanOnly = sub === 'trivial' || sub === 'follow-up' || sub === 'override' || sub === 'handoff'
    if (isHumanOnly && e.origin.kind !== 'composer') return { text: `[working-agreement] /flow ${sub} is the user's to run from the prompt` }
    if (sub === 'handoff') {
      if (tail === 'cancel') {
        runtime.handoff = null
        await putSession($, { ...(await getSession($)), handoff: undefined })
        await refresh($)
        return { text: 'Handoff reset. Nothing was cleared.' }
      }
      if ((await getSession($)).handoff?.state === 'running') return { text: 'A handoff is already running — /flow handoff cancel resets it (nothing is cleared).' }
      await startHandoff($)
      return { text: 'Continuing in a new session: /handoff, then /clear once the document is written.' }
    }
    if (sub === 'trivial') return { text: await declare($, 'trivial', [], 'human') }
    if (sub === 'follow-up') {
      const n = Number(tail.replace('#', ''))
      return { text: n ? await followUp($, n) : 'Usage: /flow follow-up #<n>' }
    }
    if (sub === 'override') return { text: await override($, tail) }
    const s = await getSession($)
    if (!s.flow) return { text: 'No flow declared (talk). The agent declares one before writing; you can run /flow trivial or /flow follow-up #n.' }
    await refresh($)
    const v = await read($, view)
    if (sub === 'status') return { text: v ? viewText(v) : '' }
    await openPane($)
    return { text: 'Flow pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: paneId }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const fill = {
      width: e.props.bodyColumns, minHeight: e.props.scroll.bodyRows,
      backgroundColor: palette.bg, paddingX: 2, paddingTop: 1,
    }
    if (!v) return <Box {...fill}><Text color={palette.muted}>No flow declared.</Text></Box>
    const row = (r: FlowRow, isNote = false) => (
      <Box>
        <Box width={keyWidth} flexShrink={0}>
          <Text color={isNote ? toneColor[r.tone] : palette.muted} bold={isNote}>{r.key}</Text>
        </Box>
        <Text color={isNote ? palette.text : toneColor[r.tone]} wrap="truncate-end">{r.value}</Text>
      </Box>
    )
    return (
      <Box flexDirection="column" {...fill}>
        <Box justifyContent="space-between">
          <Text bold color={palette.text}>{v.flow}</Text>
          <Text color={palette.muted}>{v.progress}</Text>
        </Box>
        <Text color={palette.pill}>{paneRule(e.props.bodyColumns)}</Text>
        {v.pending && <Text color={palette.muted}>{v.pending}</Text>}
        {v.issues.map((is, n) => (
          <Box flexDirection="column">
            <Box gap={2}>
              <Text color={palette.accent}>#{is.number}</Text>
              <Button
                key={`open-${is.number}`}
                label="open"
                hotkey={n === 0 ? 'o' : undefined}
                onPress={async () => {
                  const r = await runProcess($, ['gh', 'issue', 'view', String(is.number), '--web'])
                  if (r.exitCode !== 0) $.ui.toast(`Could not open #${is.number}: ${r.stderr.trim().split('\n')[0]}`)
                }}
              />
            </Box>
            {is.title && <Text color={palette.muted}>{is.title}</Text>}
          </Box>
        ))}
        <Text> </Text>
        {v.labels.length > 0 && (
          <Box>
            <Box width={keyWidth} flexShrink={0}><Text color={palette.muted}>Labels</Text></Box>
            <Box gap={1} flexWrap="wrap">
              {v.labels.map(l => <Text backgroundColor={palette.pill} color={palette.text}>{` ${l} `}</Text>)}
            </Box>
          </Box>
        )}
        {v.meta.map(r => row(r))}
        <Text> </Text>
        {v.steps.map(st => (
          <Box flexDirection="column">
            <Text>
              <Text color={symbolColor[st.state]}>{st.symbol} </Text>
              <Text color={labelColor[st.state]} bold={st.state === 'current'}>{st.label}</Text>
              {st.isStale && <Text color={palette.warn}>  stale</Text>}
            </Text>
            {st.hint && <Box paddingLeft={4}><Text color={palette.muted}>{st.hint}</Text></Box>}
          </Box>
        ))}
        {v.notes.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {v.notes.map(r => row(r, true))}
          </Box>
        )}
        {v.footer && (
          <Box flexDirection="column" marginTop={1}>
            <Text color={palette.pill}>{paneRule(e.props.bodyColumns)}</Text>
            <Box justifyContent="space-between">
              <Text color={palette.muted}>{v.footer.text ?? ''}</Text>
              <Button
                key="handoff"
                label="Continue in new session"
                variant="primary"
                hotkey="h"
                dimColor={v.footer.isRunning}
                onPress={() => { if (!v.footer?.isRunning) void startHandoff($) }}
              />
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}
