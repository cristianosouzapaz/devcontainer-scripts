import { mock } from 'claude-code/testing'
import type { MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { ToolRun } from '../hooks/outcome'

/**
 * The working tree a world answers git with; tests mutate it to move the checkout.
 * `ahead` is how many commits the branch is ahead of its base; HEAD is `c<ahead>`, on a linear history.
 * `isPushed` makes the branch level with its upstream; without it the upstream is missing.
 * `changed` lists the paths changed since the unit's start, tracked or untracked, and `before` those committed on the branch ahead of the default branch
 * but before the unit's start, which only a diff against the default branch reports.
 * `hashes` maps a repo-relative path to its git content hash; a path it omits is absent, so `git hash-object` fails on it.
 * All three are read at each call.
 */
export interface Checkout {
  branch: string; isDirty?: boolean; tree?: string; ahead?: number; isPushed?: boolean
  changed?: string[]; before?: string[]; hashes?: Record<string, string>
}

/**
 * What a world holds beyond its checkout; `unit` is the stored unit record, kept under the session's own unit key when `session.followUp` is set, else under issue #1's;
 * `missing` lists the issues gh cannot find, `prs` is what every `gh pr list` prints,
 * `documents` is what the handoff's document search prints, one path per line, `toolRun` is what every tool call returns,
 * read at each call so a test can change it, `failing` is a command prefix whose `process.run` throws,
 * `verifyFile` is the raw text of the repository's `.agents/working-agreement.json` (absent when omitted),
 * `isLoggedOut` makes every gh call fail as gh does with no login, and `isRepoBroken` makes `session.repo` throw,
 * `prView` is what every `gh pr view` answers, read at each call; without it the call prints nothing,
 * `issueLabels` lists the labels gh reports for an issue, none when omitted, read at each call like `isLoggedOut`, so a test can change either mid-way,
 * `workflow` gives the repository a GitHub Actions workflow run on that event, and `checks` lists the bucket of every check
 * `gh pr checks` reports, read at each call; without it no check is reported.
 */
export interface Options {
  verifyFile?: string
  session?: Record<string, unknown>
  unit?: Record<string, unknown>
  issues?: Record<number, string>
  missing?: number[]
  prs?: Record<string, unknown>[]
  files?: Record<string, string>
  documents?: string
  toolRun?: ToolRun
  failing?: string
  isLoggedOut?: boolean
  isRepoBroken?: boolean
  prView?: PrView
  issueLabels?: Record<number, string[]>
  workflow?: 'pull_request' | 'push'
  checks?: string[]
}

/** What `gh pr view` answers: `body` and `headRefOid` as JSON, `isFailing` for a failed call, or `raw` for text printed as is. */
export interface PrView { body?: string; headRefOid?: string; isFailing?: boolean; raw?: string }

/** What a world hands back to its test: the commands the mod ran through `$.command.run`, in order, and the mocked clock. */
export interface World { commands: string[]; clock: MockClock }

/** The repository root every world runs in. */
export const root = '/repo'

/** The session id every world runs in. */
export const sid = 'sid'

/**
 * Mocks the engine beneath the mod: a Small feature session at Code on #1 (ready-for-agent) by default,
 * checked out on `git.branch`, with GitHub connected and every gh issue open unless `issues` says otherwise.
 *
 * @param on - The test's hook registrar.
 * @param git - The checkout, read on every git call so a test can change it mid-way.
 * @param options - Store records, gh issues and PRs, readable files, handoff documents and tool results that replace the defaults.
 * @returns The world's command log and clock.
 */
export function world(on: On, git: Checkout, options: Options = {}): World {
  const slug = 'o/r'
  const commands: string[] = []
  mock.store(on, {
    [`session:${slug}:${sid}`]: {
      flow: 'small-feature', issues: [1], hadIssue: true, info: { 1: { title: 'feat', labels: ['ready-for-agent'] } },
      prCreated: false, output: false, reclassifyOk: false, blocked: { edits: 0, shell: 0 }, gh: 'connected',
      ...options.session,
    },
    [options.session?.followUp ? `unit:session:${slug}:${sid}` : `issue:${slug}#1`]: { skills: [], verify: null, overrides: [], ...options.unit },
  })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: sid }))
  on('session.cwd', () => ({ value: root }))
  on('session.repo', () => {
    if (options.isRepoBroken) throw new Error('session.repo failed')
    return { value: { root, remote: `git@github.com:${slug}.git`, internal: false, name: 'r' } }
  })
  on('process.run', (_$, e) => {
    const cmd = e.argv.join(' ')
    if (options.failing !== undefined && cmd.startsWith(options.failing)) throw new Error(`${cmd} failed`)
    const out = (stdout: string, exitCode = 0, stderr = '') => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (options.isLoggedOut && cmd.startsWith('gh ')) return out('', 4, 'To get started with GitHub CLI, please run:  gh auth login')
    if (cmd === 'git rev-parse --show-toplevel') return out(root)
    if (cmd === 'git rev-parse --abbrev-ref HEAD') return out(git.branch)
    if (cmd === 'git rev-parse --abbrev-ref origin/HEAD') return out('origin/main')
    if (cmd.startsWith('git rev-parse --verify')) return out('', 0)
    if (cmd === 'git rev-list --count @{u}..HEAD') return git.isPushed ? out('0') : out('', 1)
    if (cmd === 'git rev-parse HEAD') return out(`c${git.ahead ?? 0}`)
    const since = cmd.match(/^git rev-list --count c(\d+)\.\.HEAD$/)
    if (since) return out(String((git.ahead ?? 0) - Number(since[1])))
    if (cmd.startsWith('git rev-list --count')) return out(String(git.ahead ?? 0))
    const diff = cmd.match(/^git -C \/repo diff --name-only --no-renames (\S+)$/)
    if (diff) return out([...(git.changed ?? []), ...(/^c\d+$|^HEAD$/.test(diff[1] ?? '') ? [] : git.before ?? [])].join('\n'))
    if (cmd === 'git -C /repo ls-files --others --exclude-standard') return out('')
    const blob = cmd.match(/^git hash-object -- \/repo\/(.+)$/)
    if (blob) {
      const hash = git.hashes?.[blob[1] ?? '']
      return hash === undefined ? out('', 128, 'fatal: could not open') : out(hash)
    }
    if (cmd === 'git status --porcelain') return out(git.isDirty ? ' M src/a.ts' : '')
    if (cmd.startsWith('sh -c') && cmd.includes('find')) return out(options.documents ?? '')
    if (cmd.startsWith('sh -c')) return out(git.tree ?? 'tree')
    if (cmd.startsWith('gh api user')) return out('me')
    if (cmd.startsWith('gh pr view')) {
      const v = options.prView
      if (!v) return out('')
      if (v.isFailing) return out('', 1, 'unreachable')
      return out(v.raw ?? JSON.stringify({ body: v.body ?? '', headRefOid: v.headRefOid ?? '' }))
    }
    if (cmd.startsWith('git grep -qE pull_request')) return out('', options.workflow === 'pull_request' ? 0 : 1)
    if (cmd.startsWith('gh pr checks')) return options.checks ? out(JSON.stringify(options.checks.map(bucket => ({ bucket })))) : out('', 1, 'no checks reported')
    if (cmd.startsWith('gh pr list')) return out(JSON.stringify(options.prs ?? []))
    const issue = cmd.match(/^gh issue view (\d+) --json/)
    if (issue && options.missing?.includes(Number(issue[1]))) return out('', 1)
    if (issue) {
      const n = Number(issue[1])
      const labels = (options.issueLabels?.[n] ?? []).map(name => ({ name }))
      return out(JSON.stringify({ state: options.issues?.[n] ?? 'OPEN', title: 't', labels }))
    }
    return out('')
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
  on('tool.call', () => options.toolRun ?? { result: 'written' })
  on('tool.check', () => ({ decision: 'allow' }))
  on('skill.prompt', (_$, e) => ({ text: e.text }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('turn.complete', () => ({ text: '' }))
  on('classic.UserPromptSubmit', () => ({}))
  return { commands, clock }
}
