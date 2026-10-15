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
 * `dirty` maps each file that differs from HEAD to its content hash, '' for a deleted one, as the tree snapshot reads it;
 * without it a dirty tree holds `src/a.ts` alone, at a fixed hash.
 * All four are read at each call.
 * `head` overrides HEAD, which is `c<ahead>` otherwise: `c<n>` is the n-th commit of a linear history, and `a<n>` is the amended commit at position n, whose parent is `c<n-1>`,
 * so `c<i>` is an ancestor of `a<j>` only when i < j, and `a<n>` is an ancestor of itself alone.
 * `commitTrees` maps a commit id to its tree id, `tree` for the ones it omits. A diff between two commits reports `src/a.ts` when the second commit is past the first.
 * `atStart` maps a repo-relative path to its blob id at the unit's start commit; a path it omits is absent there, so reading its blob fails.
 */
export interface Checkout {
  branch: string; isDirty?: boolean; tree?: string; ahead?: number; isPushed?: boolean
  changed?: string[]; before?: string[]; hashes?: Record<string, string>; dirty?: Record<string, string>
  head?: string; commitTrees?: Record<string, string>; atStart?: Record<string, string>
}

/**
 * A linked worktree under `.claude/worktrees/<name>` of the world's checkout, on branch `worktree-<name>` at its `base` commit until a
 * `git reset --hard` in it moves its HEAD, which the world then keeps; `changed` lists the paths changed in it since `base`, and `hashes`
 * maps its repo-relative paths to their content hashes, as `Checkout` does. Both are read at each call. A git command run in it answers from it, with the worktree as its root;
 * one run in the main checkout answers from the checkout. An `EnterWorktree` call moves the session into it, and an `ExitWorktree` call back to the root.
 * `isRemoved` stops `git worktree list` from listing it and `isBranchDeleted` removes its branch, each read at each call.
 */
export interface Worktree { name: string; base: string; changed?: string[]; hashes?: Record<string, string>; isRemoved?: boolean; isBranchDeleted?: boolean }

/**
 * What a world holds beyond its checkout; `unit` is the stored unit record, kept under the session's own unit key when `session.followUp` is set, else under issue #1's;
 * `missing` lists the issues gh cannot find, `prs` is what every `gh pr list` prints,
 * `documents` is what the handoff's document search prints, one path per line, `toolRun` is what every tool call returns,
 * read at each call so a test can change it, or a function (sync or async) called at each tool call, whose body runs while the call is in flight, `failing` is a command prefix whose `process.run` throws,
 * `verifyFile` is the raw text of the repository's `.agents/working-agreement.json` (absent when omitted),
 * `isLoggedOut` makes every gh call fail as gh does with no login, `isRepoBroken` makes `session.repo` throw, `isStoreBroken` makes every store read throw,
 * `issueComments` lists each issue's comments, oldest first, which `gh issue view --json comments` reads at each call and `gh issue comment` appends to;
 * `units` adds the stored unit of further issues, each under its own issue key;
 * `prView` is what every `gh pr view` answers, read at each call; without it the call prints nothing,
 * `issueLabels` lists the labels gh reports for an issue, none when omitted, read at each call like `isLoggedOut`, so a test can change either mid-way,
 * `workflow` gives the repository a GitHub Actions workflow run on that event, `workflows` maps workflow file names to their YAML text and replaces it,
 * `workflowSearch` makes the search for them fail with a git error, or throw as a git that cannot run does, and `checks` lists the bucket of every check
 * `gh pr checks` reports, read at each call; without it no check is reported,
 * `ownIssues` is what `gh issue list --author @me` reports, read at each call; without it the call prints an empty list,
 * `subIssues` is the sub-issue count GitHub reports for an issue, 0 when omitted, read at each call,
 * `prsGate` holds every `gh pr list` until it resolves, read at each call, so a test can keep a PR sync in flight,
 * `statusGate` holds the next `git status` until it resolves and then clears itself, so a test can keep one checkout read in flight,
 * `worktree` adds a linked worktree, which `git worktree list` reports after the main checkout,
 * and `cwd` is the session's working directory until an `EnterWorktree` call: the worktree when there is one, the repository root otherwise.
 */
export interface Options {
  verifyFile?: string
  session?: Record<string, unknown>
  unit?: Record<string, unknown>
  units?: Record<number, Record<string, unknown>>
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
  issueComments?: Record<number, IssueComment[]>
  issueLabels?: Record<number, string[]>
  workflow?: 'pull_request' | 'push'
  workflows?: Record<string, string>
  workflowSearch?: 'fails' | 'cannot-run'
  checks?: string[]
  ownIssues?: OwnIssue[]
  subIssues?: Record<number, number>
  worktree?: Worktree
  cwd?: string
}

/** An issue `gh issue list --author @me` reports: its number, title and creation time as GitHub prints it. */
interface OwnIssue { number: number; title: string; createdAt: string }

/** An issue comment: the URL that links to it and its body. */
export interface IssueComment { url: string; body: string }

/** A `gh pr view` that prints JSON: its `body` and `headRefOid`, each empty when omitted. */
interface PrViewJson { body?: string; headRefOid?: string }

/** A `gh pr view` that fails. */
interface PrViewFailing { isFailing: true }

/** A `gh pr view` that prints this text as is. */
interface PrViewRaw { raw: string }

/** What `gh pr view` answers. */
type PrView = PrViewJson | PrViewFailing | PrViewRaw

/**
 * What a world hands back to its test: the commands the mod ran through `$.command.run`, in order, the prompts submitted, in order,
 * the mocked clock, the readable files by path, `files` as given plus every file the mod wrote, and the worktree's HEAD as a
 * `git reset --hard` in it last left it, its `base` before any.
 */
interface World { commands: string[]; prompts: string[]; clock: MockClock; files: Record<string, string>; readWorktreeHead: () => string | undefined }

/** The repository root every world runs in. */
export const root = '/repo'

/** The session id every world runs in. */
const sid = 'sid'

/** The home directory every world's `$HOME` names, outside the repository. */
const home = '/home/dev'

/** The repository's `info/exclude`, as git names it from any checkout. */
export const excludePath = `${root}/.git/info/exclude`

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
 * @param checkout - The checkout, read on every git call so a test can change it mid-way.
 * @param options - Store records, gh issues and PRs, readable files, handoff documents and tool results that replace the defaults.
 * @returns The world's command log and clock.
 */
export function createWorld(on: On, checkout: Checkout, options: Options = {}): World {
  const slug = 'o/r'
  const worktreeRoot = options.worktree ? `${root}/.claude/worktrees/${options.worktree.name}` : undefined
  const session = { cwd: options.cwd ?? worktreeRoot ?? root, worktreeHead: options.worktree?.base }
  const files: Record<string, string> = { ...options.files }
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
    ...Object.fromEntries(Object.entries(options.units ?? {}).map(([issue, unit]) => [`issue:${slug}#${issue}`, { skills: [], verify: null, overrides: [], ...unit }])),
    [options.session?.followUp ? `unit:session:${slug}:${sid}` : `issue:${slug}#1`]: { skills: [], verify: null, overrides: [], ...options.unit },
  })
  const clock = mock.clock(on)
  mock.env(on, { HOME: home })
  on('session.id', () => ({ value: sid }))
  on('session.cwd', () => ({ value: session.cwd }))
  on('session.repo', () => {
    if (options.isRepoBroken) throw new Error('session.repo failed')
    return { value: { root, remote: `git@github.com:${slug}.git`, internal: false, name: 'r' } }
  })
  on('process.run', (_$, e) => {
    const command = e.argv.join(' ')
    if (options.failing !== undefined && command.startsWith(options.failing)) throw new Error(`${command} failed`)
    const buildResult = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (options.isLoggedOut && command.startsWith('gh ')) return buildResult('', 4, 'To get started with GitHub CLI, please run:  gh auth login')
    // A command answers from the worktree when it runs there (its cwd, its `-C` or the file it hashes), from the main checkout otherwise; `here` is the root it sees.
    const hashedPath = command.match(/^git hash-object -- (\/.+)$/)?.[1]
    const at = hashedPath ?? (e.argv[1] === '-C' ? e.argv[2] ?? '' : e.init?.cwd ?? session.cwd)
    const worktree = options.worktree
    const isInWorktree = !!worktree && !!worktreeRoot && (at === worktreeRoot || at.startsWith(`${worktreeRoot}/`))
    const here = isInWorktree && worktreeRoot ? worktreeRoot : root
    const git: Checkout = isInWorktree && worktree
      ? { branch: `worktree-${worktree.name}`, head: session.worktreeHead ?? worktree.base, changed: worktree.changed ?? [], hashes: worktree.hashes, isDirty: !!worktree.changed?.length }
      : checkout
    if (command === 'git worktree list --porcelain') {
      const main = `worktree ${root}\nHEAD ${checkout.head ?? `c${checkout.ahead ?? 0}`}\nbranch refs/heads/${checkout.branch}\n`
      return buildResult(worktree && worktreeRoot && !worktree.isRemoved ? `${main}\nworktree ${worktreeRoot}\nHEAD ${session.worktreeHead ?? worktree.base}\nbranch refs/heads/worktree-${worktree.name}\n` : main)
    }
    if (command === 'git rev-parse --show-toplevel') return buildResult(here)
    if (command === 'git rev-parse --path-format=absolute --git-path info/exclude') return buildResult(excludePath)
    if (command === 'git rev-parse --abbrev-ref HEAD') return buildResult(git.branch)
    if (command === 'git rev-parse --abbrev-ref origin/HEAD') return buildResult('origin/main')
    if (command === `git rev-parse --verify --quiet refs/heads/worktree-${worktree?.name}`) return buildResult('', worktree?.isBranchDeleted ? 1 : 0)
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
    const blobAt = command.match(/^git rev-parse c\d+:(\S+)$/)
    if (blobAt) {
      const blob = git.atStart?.[blobAt[1] ?? '']
      return blob === undefined ? buildResult('', 128, 'fatal: path does not exist') : buildResult(blob)
    }
    if (command.startsWith('git rev-list --count')) return buildResult(String(git.ahead ?? 0))
    // `git -C <root>` runs in that root, so the rest of the command is matched alone.
    const local = command.startsWith(`git -C ${here} `) ? command.slice(`git -C ${here} `.length) : ''
    const between = local.match(/^diff --name-only --no-renames (\S+) (\S+)$/)
    if (between) {
      const past = [...(listReachableCommits(between[2] === 'HEAD' ? head : between[2] ?? '') ?? [])].filter(id => !listReachableCommits(between[1] ?? '')?.has(id))
      return buildResult(past.length ? 'src/a.ts' : '')
    }
    const diff = local.match(/^diff --name-only --no-renames (\S+)$/)
    if (diff) {
      const baseIndex = Number(diff[1]?.match(/^c(\d+)$/)?.[1] ?? git.ahead ?? 0)
      const changed = git.changed ?? (git.isDirty || (git.ahead ?? 0) > baseIndex ? ['src/a.ts'] : [])
      return buildResult([...changed, ...(/^c\d+$|^HEAD$/.test(diff[1] ?? '') ? [] : git.before ?? [])].join('\n'))
    }
    if (local === 'ls-files --others --exclude-standard') return buildResult('')
    if (local === 'rev-parse HEAD') return buildResult(head)
    if (local === 'status --porcelain') return buildResult((git.changed ?? []).map(path => ` M ${path}`).join('\n'))
    const reset = local.match(/^reset --hard (\S+)$/)
    if (reset && isInWorktree && worktree) {
      session.worktreeHead = reset[1] ?? session.worktreeHead
      return buildResult(`HEAD is now at ${session.worktreeHead}`)
    }
    if (hashedPath) {
      const hash = hashedPath.startsWith(`${here}/`) ? git.hashes?.[hashedPath.slice(here.length + 1)] : undefined
      return hash === undefined ? buildResult('', 128, 'fatal: could not open') : buildResult(hash)
    }
    const dirty = git.dirty ?? (git.isDirty ? { 'src/a.ts': 'h-a' } : {})
    if (local === 'status --porcelain -z --no-renames --untracked-files=all') {
      return buildResult(Object.entries(dirty).map(([path, hash]) => `${hash ? ' M' : ' D'} ${path}\0`).join(''))
    }
    const hashed = local.match(/^hash-object -- (.+)$/)
    if (hashed) return buildResult((hashed[1] ?? '').split(' ').map(path => `${dirty[path]}\n`).join(''))
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
      const isAtRoot = at === root
      const isFound = pathspec === ':/.github/workflows' || (pathspec === '.github/workflows' && isAtRoot)
      const shorthand = options.workflow === 'pull_request' ? 'on:\n  pull_request:\n    branches: [main]\n' : 'on: push\n'
      const workflows = options.workflows ?? (options.workflow ? { 'ci.yml': shorthand } : {})
      const lines = Object.entries(workflows).flatMap(([path, text]) => text.split('\n').filter(Boolean).map(line => `.github/workflows/${path}\0${line}`))
      return isFound && lines.length ? buildResult(lines.join('\n')) : buildResult('', 1)
    }
    if (command.startsWith('gh pr checks')) return options.checks ? buildResult(JSON.stringify(options.checks.map(bucket => ({ bucket })))) : buildResult('', 1, 'no checks reported')
    if (command.startsWith('gh pr list')) return options.prsGate ? options.prsGate.then(() => buildResult(JSON.stringify(options.prs ?? []))) : buildResult(JSON.stringify(options.prs ?? []))
    if (command.startsWith('gh issue list --author @me')) return buildResult(JSON.stringify(options.ownIssues ?? []))
    const commented = command.match(/^gh issue comment (\d+) /)
    if (commented) {
      const comments = (options.issueComments ??= {})
      const list = (comments[Number(commented[1])] ??= [])
      list.push({ url: `https://github.com/o/r/issues/${commented[1]}#issuecomment-${list.length + 1}`, body: e.argv[e.argv.indexOf('--body') + 1] ?? '' })
      return buildResult('')
    }
    const viewedComments = command.match(/^gh issue view (\d+) --json comments$/)
    if (viewedComments) return buildResult(JSON.stringify({ comments: options.issueComments?.[Number(viewedComments[1])] ?? [] }))
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
    const text = e.path === `${root}/.agents/working-agreement.json` ? options.verifyFile : files[e.path]
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  // Any path the mod stats is a fresh, non-empty file: only the document search decides a handoff's fate.
  on('fs.write', (_$, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: clock.now(), isLink: false } }))
  on('command.run', (_$, e) => {
    commands.push(e.command)
    return {}
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'EnterWorktree' && worktreeRoot && options.worktree) {
      session.cwd = worktreeRoot
      return { result: { worktreePath: worktreeRoot, worktreeBranch: `worktree-${options.worktree.name}`, message: `Created worktree at ${worktreeRoot}` } }
    }
    if (e.tool === 'ExitWorktree' && worktreeRoot && options.worktree) {
      session.cwd = root
      return { result: { action: 'keep', originalCwd: root, worktreePath: worktreeRoot } }
    }
    return typeof options.toolRun === 'function' ? options.toolRun() : options.toolRun ?? { result: 'written' }
  })
  on('tool.check', () => ({ decision: 'allow' }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)
    return { text: e.text, context: e.context }
  })
  on('turn.complete', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.Stop', () => ({}))
  return { commands, prompts, clock, files, readWorktreeHead: () => session.worktreeHead }
}
