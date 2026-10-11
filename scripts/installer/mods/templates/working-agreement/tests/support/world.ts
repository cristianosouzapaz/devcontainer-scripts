import type { On } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'

import type { ToolRun } from '../../hooks/core/command-observation'

/** What a tool call returns in a world: a fixed result, or a function called at each call. */
type ToolRunSource = ToolRun | (() => ToolRun | Promise<ToolRun>)

/**
 * The working tree a world answers git with; tests mutate it to move the checkout.
 * `ahead` is how many commits the branch is ahead of its base; HEAD is `c<ahead>`, on a linear history.
 * `isPushed: false` leaves the branch without an upstream; otherwise it is level with its upstream.
 * `changed` lists the paths changed since the unit's start, tracked or untracked, and `before` those committed on the branch ahead of the default branch
 * but before the unit's start, which only a diff against the default branch reports; without `changed`, a dirty tree or a commit past the
 * compared one changed `src/a.ts`, as `git status` reports.
 * `hashes` maps a repo-relative path to its git content hash; a path it omits is absent, so `git hash-object` fails on it.
 * All three are read at each call.
 * `head` overrides HEAD, which is `c<ahead>` otherwise: `c<n>` is the n-th commit of a linear history, and `a<n>` is the amended commit at position n, whose parent is `c<n-1>`,
 * so `c<i>` is an ancestor of `a<j>` only when i < j, and `a<n>` is an ancestor of itself alone.
 * `commitTrees` maps a commit id to its tree id, `tree` for the ones it omits. A diff between two commits reports `src/a.ts` when the second commit is past the first.
 */
export interface Checkout {
  branch: string; isDirty?: boolean; tree?: string; ahead?: number; isPushed?: boolean
  changed?: string[]; before?: string[]; hashes?: Record<string, string>
  head?: string; commitTrees?: Record<string, string>
}

/**
 * What a world holds beyond its checkout; `unit` is the stored unit record, kept under the session's own unit key when `session.followUp` is set, else under issue #1's;
 * `missing` lists the issues gh cannot find, `prs` is what every `gh pr list` prints,
 * `documents` is what the handoff's document search prints, one path per line, `toolRun` is what every tool call returns,
 * read at each call so a test can change it, or a function (sync or async) called at each tool call, whose body runs while the call is in flight, `failing` is a command prefix whose `process.run` throws,
 * `verifyFile` is the raw text of the repository's `.agents/working-agreement.json` (absent when omitted),
 * `isLoggedOut` makes every gh call fail as gh does with no login, `isRepoBroken` makes `session.repo` throw, `isStoreBroken` makes every store read throw,
 * `prView` is what every `gh pr view` answers, read at each call; without it the call prints nothing,
 * `issueLabels` lists the labels gh reports for an issue, none when omitted, read at each call like `isLoggedOut`, so a test can change either mid-way,
 * `workflow` gives the repository a GitHub Actions workflow run on that event, `workflows` maps workflow file names to their YAML text and replaces it,
 * `workflowSearch` makes the search for them fail with a git error, or throw as a git that cannot run does, and `checks` lists the bucket of every check
 * `gh pr checks` reports, read at each call; without it no check is reported,
 * `ownIssues` is what `gh issue list --author @me` reports, read at each call; without it the call prints an empty list,
 * `subIssues` is the sub-issue count GitHub reports for an issue, 0 when omitted, read at each call,
 * `prsGate` holds every `gh pr list` until it resolves, read at each call, so a test can keep a PR sync in flight,
 * `statusGate` holds the next `git status` until it resolves and then clears itself, so a test can keep one checkout read in flight,
 * and `cwd` is the session's working directory, the repository root when omitted.
 */
export interface Options {
  verifyFile?: string
  session?: Record<string, unknown>
  unit?: Record<string, unknown>
  issues?: Record<number, string>
  missing?: number[]
  prs?: Record<string, unknown>[]
  prsGate?: Promise<void>
  statusGate?: Promise<void>
  files?: Record<string, string>
  documents?: string
  toolRun?: ToolRunSource
  failing?: string
  isLoggedOut?: boolean
  isRepoBroken?: boolean
  isStoreBroken?: boolean
  prView?: PrView
  issueLabels?: Record<number, string[]>
  workflow?: 'pull_request' | 'push'
  workflows?: Record<string, string>
  workflowSearch?: 'fails' | 'cannot-run'
  checks?: string[]
  ownIssues?: OwnIssue[]
  subIssues?: Record<number, number>
  cwd?: string
}

/** An issue `gh issue list --author @me` reports: its number, title and creation time as GitHub prints it. */
interface OwnIssue { number: number; title: string; createdAt: string }

/** A `gh pr view` that prints JSON: its `body` and `headRefOid`, each empty when omitted. */
interface PrViewJson { body?: string; headRefOid?: string }

/** A `gh pr view` that fails. */
interface PrViewFailing { isFailing: true }

/** A `gh pr view` that prints this text as is. */
interface PrViewRaw { raw: string }

/** What `gh pr view` answers. */
type PrView = PrViewJson | PrViewFailing | PrViewRaw

/** What a world hands back to its test: the commands the mod ran through `$.command.run`, in order, the prompts submitted, in order, and the mocked clock. */
interface World { commands: string[]; prompts: string[]; clock: MockClock }

/** The repository root every world runs in. */
export const root = '/repo'

/** The session id every world runs in. */
const sid = 'sid'

/** The home directory every world's `$HOME` names, outside the repository. */
const home = '/home/dev'

/**
 * Lists the commits reachable from a commit id of the linear-or-amended history model.
 *
 * @param id - The commit id, `c<n>` or `a<n>`.
 * @returns The ids, or null for an id outside the model.
 */
function listReachableCommits(id: string): Set<string> | null {
  const match = id.match(/^([ca])(\d+)$/)
  if (!match) return null
  const position = Number(match[2])
  const ancestors = Array.from({ length: position - 1 }, (_, index) => `c${index + 1}`)
  return new Set(match[1] === 'c' && position > 0 ? [...ancestors, `c${position}`] : position > 0 ? [...ancestors, id] : [])
}

/**
 * Mocks the engine beneath the mod: a Small feature session at Code on #1 (ready-for-agent) by default,
 * checked out on `git.branch`, with GitHub connected and every gh issue open unless `issues` says otherwise.
 *
 * @param on - The test's hook registrar.
 * @param git - The checkout, read on every git call so a test can change it mid-way.
 * @param options - Store records, gh issues and PRs, readable files, handoff documents and tool results that replace the defaults.
 * @returns The world's command log and clock.
 */
export function createWorld(on: On, git: Checkout, options: Options = {}): World {
  const slug = 'o/r'
  const commands: string[] = []
  const prompts: string[] = []
  if (options.isStoreBroken) {
    on('store.get', () => { throw new Error('store.get failed') })
    on('store.set', () => ({ value: undefined }))
  } else mock.store(on, {
    [`session:${slug}:${sid}`]: {
      flow: 'small-feature', issues: [1], info: { 1: { title: 'feat', labels: ['ready-for-agent'] } },
      prCreated: false, output: false, reclassifyOk: false, blocked: { edits: 0, shell: 0 }, gh: 'connected',
      ...options.session,
    },
    [options.session?.followUp ? `unit:session:${slug}:${sid}` : `issue:${slug}#1`]: { skills: [], verify: null, overrides: [], ...options.unit },
  })
  const clock = mock.clock(on)
  mock.env(on, { HOME: home })
  on('session.id', () => ({ value: sid }))
  on('session.cwd', () => ({ value: options.cwd ?? root }))
  on('session.repo', () => {
    if (options.isRepoBroken) throw new Error('session.repo failed')
    return { value: { root, remote: `git@github.com:${slug}.git`, internal: false, name: 'r' } }
  })
  on('process.run', (_$, e) => {
    const command = e.argv.join(' ')
    if (options.failing !== undefined && command.startsWith(options.failing)) throw new Error(`${command} failed`)
    const buildResult = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (options.isLoggedOut && command.startsWith('gh ')) return buildResult('', 4, 'To get started with GitHub CLI, please run:  gh auth login')
    if (command === 'git rev-parse --show-toplevel') return buildResult(root)
    if (command === 'git rev-parse --abbrev-ref HEAD') return buildResult(git.branch)
    if (command === 'git rev-parse --abbrev-ref origin/HEAD') return buildResult('origin/main')
    if (command.startsWith('git rev-parse --verify')) return buildResult('', 0)
    if (command === 'git rev-list --count @{u}..HEAD') return git.isPushed === false ? buildResult('', 1) : buildResult('0')
    const head = git.head ?? `c${git.ahead ?? 0}`
    if (command === 'git rev-parse HEAD') return buildResult(head)
    const sinceMatch = command.match(/^git rev-list --count c(\d+)\.\.HEAD$/)
    if (sinceMatch && git.head === undefined) return buildResult(String((git.ahead ?? 0) - Number(sinceMatch[1])))
    const range = command.match(/^git rev-list --count (\S+)\.\.(\S+)$/)
    const from = listReachableCommits(range?.[1] ?? '')
    const to = listReachableCommits(range?.[2] === 'HEAD' ? head : range?.[2] ?? '')
    if (from && to) return buildResult(String([...to].filter(id => !from.has(id)).length))
    const ancestry = command.match(/^git merge-base --is-ancestor (\S+) (\S+)$/)
    if (ancestry) {
      const [ancestor, descendant] = [ancestry[1] ?? '', ancestry[2] === 'HEAD' ? head : ancestry[2] ?? '']
      return buildResult('', ancestor === descendant || listReachableCommits(descendant)?.has(ancestor) ? 0 : 1)
    }
    const treeOf = command.match(/^git rev-parse (\S+)\^\{tree\}$/)
    if (treeOf) return buildResult(git.commitTrees?.[treeOf[1] ?? ''] ?? 'tree')
    if (command.startsWith('git rev-list --count')) return buildResult(String(git.ahead ?? 0))
    const between = command.match(/^git -C \/repo diff --name-only --no-renames (\S+) (\S+)$/)
    if (between) {
      const past = [...(listReachableCommits(between[2] === 'HEAD' ? head : between[2] ?? '') ?? [])].filter(id => !listReachableCommits(between[1] ?? '')?.has(id))
      return buildResult(past.length ? 'src/a.ts' : '')
    }
    const diff = command.match(/^git -C \/repo diff --name-only --no-renames (\S+)$/)
    if (diff) {
      const baseIndex = Number(diff[1]?.match(/^c(\d+)$/)?.[1] ?? git.ahead ?? 0)
      const changed = git.changed ?? (git.isDirty || (git.ahead ?? 0) > baseIndex ? ['src/a.ts'] : [])
      return buildResult([...changed, ...(/^c\d+$|^HEAD$/.test(diff[1] ?? '') ? [] : git.before ?? [])].join('\n'))
    }
    if (command === 'git -C /repo ls-files --others --exclude-standard') return buildResult('')
    const blob = command.match(/^git hash-object -- \/repo\/(.+)$/)
    if (blob) {
      const hash = git.hashes?.[blob[1] ?? '']
      return hash === undefined ? buildResult('', 128, 'fatal: could not open') : buildResult(hash)
    }
    if (command === 'git status --porcelain') {
      const gate = options.statusGate
      options.statusGate = undefined
      return gate ? gate.then(() => buildResult(git.isDirty ? ' M src/a.ts' : '')) : buildResult(git.isDirty ? ' M src/a.ts' : '')
    }
    if (command.startsWith('sh -c') && command.includes('find')) return buildResult(options.documents ?? '')
    if (command.startsWith('sh -c')) return buildResult(git.tree ?? 'tree')
    if (command.startsWith('gh api user')) return buildResult('me')
    const subIssues = command.match(/^gh api repos\/\{owner\}\/\{repo\}\/issues\/(\d+) --jq \.sub_issues_summary/)
    if (subIssues) return buildResult(String(options.subIssues?.[Number(subIssues[1])] ?? 0))
    if (command.startsWith('gh pr view')) {
      const view = options.prView
      if (!view) return buildResult('')
      if ('isFailing' in view) return buildResult('', 1, 'unreachable')
      if ('raw' in view) return buildResult(view.raw)
      return buildResult(JSON.stringify({ body: view.body ?? '', headRefOid: view.headRefOid ?? '' }))
    }
    if (command.startsWith('git grep -I --full-name --null') || command.startsWith(`git -C ${root} grep -I --full-name --null`)) {
      if (options.workflowSearch === 'cannot-run') throw new Error('git grep could not run')
      if (options.workflowSearch === 'fails') return buildResult('', 128, 'fatal: unable to read tree')
      // Git resolves the pathspec against the cwd (or `-C`), so only a root-anchored one finds the workflows from a subfolder.
      const pathspec = e.argv[e.argv.length - 1]
      const isAtRoot = e.argv[1] === '-C' ? e.argv[2] === root : (options.cwd ?? root) === root
      const isFound = pathspec === ':/.github/workflows' || (pathspec === '.github/workflows' && isAtRoot)
      const shorthand = options.workflow === 'pull_request' ? 'on:\n  pull_request:\n    branches: [main]\n' : 'on: push\n'
      const workflows = options.workflows ?? (options.workflow ? { 'ci.yml': shorthand } : {})
      const lines = Object.entries(workflows).flatMap(([path, text]) => text.split('\n').filter(Boolean).map(line => `.github/workflows/${path}\0${line}`))
      return isFound && lines.length ? buildResult(lines.join('\n')) : buildResult('', 1)
    }
    if (command.startsWith('gh pr checks')) return options.checks ? buildResult(JSON.stringify(options.checks.map(bucket => ({ bucket })))) : buildResult('', 1, 'no checks reported')
    if (command.startsWith('gh pr list')) return options.prsGate ? options.prsGate.then(() => buildResult(JSON.stringify(options.prs ?? []))) : buildResult(JSON.stringify(options.prs ?? []))
    if (command.startsWith('gh issue list --author @me')) return buildResult(JSON.stringify(options.ownIssues ?? []))
    const issue = command.match(/^gh issue view (\d+) --json/)
    if (issue && options.missing?.includes(Number(issue[1]))) return buildResult('', 1)
    if (issue) {
      const number = Number(issue[1])
      const labels = (options.issueLabels?.[number] ?? []).map(name => ({ name }))
      return buildResult(JSON.stringify({ state: options.issues?.[number] ?? 'OPEN', title: 't', labels }))
    }
    return buildResult('')
  })
  on('fs.read', (_$, e) => {
    const text = e.path === `${root}/.agents/working-agreement.json` ? options.verifyFile : options.files?.[e.path]
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  // Any path the mod stats is a fresh, non-empty file: only the document search decides a handoff's fate.
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: clock.now(), isLink: false } }))
  on('command.run', (_$, e) => {
    commands.push(e.command)
    return {}
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => (typeof options.toolRun === 'function' ? options.toolRun() : options.toolRun ?? { result: 'written' }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))
  return { commands, prompts, clock }
}
