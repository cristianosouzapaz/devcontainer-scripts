import type { Options } from './world'

/** An issue as the fake GitHub keeps it. */
interface FakeIssue { labels: string[]; assignees: string[]; parent: number | null; blockedBy: number[]; state: string; stateReason: string | null }

/** A posted issue comment. */
interface FakeComment { issue: number; url: string; body: string }

/** What the fake GitHub starts with, and the faults it injects. */
interface IssueGithubOptions {
  labels?: string[]
  issueTypes?: string[] | null
  issues?: Record<number, Partial<FakeIssue>>
  isParentDropped?: boolean
  isLabelReadFailing?: boolean
}

/** The fake GitHub, its state and its call log. */
export interface IssueGithub { calls: string[][]; issues: Map<number, FakeIssue>; comments: FakeComment[]; gh: NonNullable<Options['gh']> }

/** The triage labels every repository carries. */
export const triageLabels = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix']

const defaultTypes = ['build', 'chore', 'ci', 'config', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style']

/** The labels `/flow setup-labels` creates without an `issues` config, which the issue tools then require. */
export const defaultIssueLabels = [...triageLabels, 'delegated-review', ...defaultTypes.map(type => `type::${type}`), 'priority::high', 'priority::medium', 'priority::low']

/** A complete ticket under the default issues config. */
export const ticket = {
  title: 'feat(mod): issue tools', kind: 'ticket', triage: 'ready-for-agent', type: 'feat', priority: 'medium', parent: 419, blockedBy: [445],
  sections: { 'Parent': '#419', 'What to build': 'The tools.', 'Acceptance criteria': '- [ ] works', 'Blocked by': '#445' },
}

/**
 * Collects every value of a repeatable flag.
 * @param args - The gh arguments.
 * @param flag - The flag.
 * @returns Its values in order.
 */
export const values = (args: string[], flag: string): string[] => args.flatMap((arg, index) => arg === flag ? [args[index + 1] ?? ''] : [])

/**
 * Builds a GitHub that keeps issues, labels and comments in memory and records every gh call.
 * @param options - Its labels, issues, native types and faults.
 * @returns The fake.
 */
export function createIssueGithub(options: IssueGithubOptions = {}): IssueGithub {
  const calls: string[][] = []
  const comments: FakeComment[] = []
  const seeded = Object.entries(options.issues ?? { 7: { labels: ['needs-triage'] } })
  const issues = new Map<number, FakeIssue>(seeded.map(([number, issue]) =>
    [Number(number), { labels: [], assignees: ['me'], parent: null, blockedBy: [], state: 'OPEN', stateReason: null, ...issue }]))
  const login = (name: string): string => name === '@me' ? 'me' : name
  const gh: IssueGithub['gh'] = args => {
    calls.push(args)
    if (args.join(' ') === 'api repos/{owner}/{repo}/labels --paginate --jq .[].name') {
      return options.isLabelReadFailing ? { exitCode: 1, stderr: 'HTTP 502' } : { stdout: (options.labels ?? defaultIssueLabels).join('\n') }
    }
    const listed = /^api repos\/\{owner\}\/\{repo\}\/issues\/(\d+)\/comments --paginate/.exec(args.join(' '))
    if (listed) {
      return { stdout: comments.filter(comment => comment.issue === Number(listed[1])).map(({ url, body }) => JSON.stringify({ url, body, createdAt: new Date(0).toISOString() })).join('\n') }
    }
    const fetched = /^repos\/\{owner\}\/\{repo\}\/issues\/(\d+)$/.exec(args[0] === 'api' ? args[1] ?? '' : '')
    const audited = fetched && issues.get(Number(fetched[1]))
    if (audited) return { stdout: JSON.stringify({ title: 'feat: x', body: '', labels: audited.labels, assignees: audited.assignees }) }
    const query = args.at(-1) ?? ''
    if (args[1] === 'graphql' && query.includes('issueTypes')) {
      const types = options.issueTypes ?? null
      return { stdout: JSON.stringify({ data: { repository: { issueTypes: types && { nodes: types.map(name => ({ name })) } } } }) }
    }
    const snapshot = /issue\(number:(\d+)\)\{state title labels/.exec(query)
    const viewed = snapshot && issues.get(Number(snapshot[1]))
    if (viewed) return { stdout: JSON.stringify({ data: { repository: { issue: { state: viewed.state, title: 'feat: x', labels: { nodes: viewed.labels.map(name => ({ name })) } } } } }) }
    const read = /issue\(number:(\d+)\)\{state stateReason/.exec(query)
    if (read) {
      const issue = issues.get(Number(read[1]))
      if (!issue) return { exitCode: 1, stderr: 'not found' }
      return { stdout: JSON.stringify({ data: { repository: { issue: { state: issue.state, stateReason: issue.stateReason,
        labels: { nodes: issue.labels.map(name => ({ name })) }, assignees: { nodes: issue.assignees.map(name => ({ login: name })) },
        parent: issue.parent === null ? null : { number: issue.parent }, blockedBy: { nodes: issue.blockedBy.map(number => ({ number })) } } } } }) }
    }
    if (args[0] === 'issue' && args[1] === 'create') {
      const number = 100 + issues.size
      const parent = values(args, '--parent')[0]
      issues.set(number, { labels: values(args, '--label'), assignees: values(args, '--assignee').map(login), state: 'OPEN', stateReason: null,
        parent: parent && !options.isParentDropped ? Number(parent) : null, blockedBy: values(args, '--blocked-by').map(Number) })
      return { stdout: `https://github.com/o/r/issues/${number}\n` }
    }
    const number = Number(args[2])
    const issue = issues.get(number)
    if (args[0] === 'issue' && issue && args[1] === 'edit') {
      const unknown = values(args, '--add-label').find(label => !(options.labels ?? defaultIssueLabels).includes(label))
      if (unknown) return { exitCode: 1, stderr: `'${unknown}' not found` }
      const removed = values(args, '--remove-label')
      issue.labels = [...new Set([...issue.labels.filter(label => !removed.includes(label)), ...values(args, '--add-label')])]
      issue.assignees.push(...values(args, '--add-assignee').map(login))
      return { stdout: `https://github.com/o/r/issues/${number}\n` }
    }
    if (args[0] === 'issue' && issue && args[1] === 'close') {
      Object.assign(issue, { state: 'CLOSED', stateReason: (values(args, '--reason')[0] ?? '').toUpperCase().replace(' ', '_') })
      return { stdout: '' }
    }
    if (args[0] === 'issue' && args[1] === 'comment') {
      const url = `https://github.com/o/r/issues/${number}#issuecomment-${comments.length + 1}`
      comments.push({ issue: number, url, body: values(args, '--body')[0] ?? '' })
      return { stdout: `${url}\n` }
    }
    if (args[0] === 'label' && args[1] === 'create') return { stdout: '' }
    return undefined
  }
  return { calls, issues, comments, gh }
}
