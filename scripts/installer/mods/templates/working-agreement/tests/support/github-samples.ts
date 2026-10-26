interface GithubSample {
  status: number | null
  body: unknown
}

/** Representative GitHub responses shared by the test fakes and the manual shape check. */
export const githubSamples = {
  issue: [{ status: null, body: { data: { repository: { issue: { state: 'OPEN', title: 't', labels: { nodes: [{ name: 'ready-for-agent' }] } } } } } }] satisfies [GithubSample],
  'sub-issues': [{ status: null, body: [{ state: 'open', labels: ['ready-for-agent'] }] }] satisfies [GithubSample],
  'issue-comments': [{ status: null, body: [{ url: 'https://github.com/o/r/issues/1#issuecomment-1', createdAt: '1970-01-01T00:00:00.003Z' }] }] satisfies [GithubSample],
  'pull-requests': [{ status: null, body: { data: { repository: { nameWithOwner: 'owner/repo', defaultBranchRef: { name: 'main' }, pullRequests: {
    nodes: [{ number: 5, state: 'OPEN', url: 'https://github.test/pull/5', headRefOid: 'c1', baseRefName: 'main', body: '', isCrossRepository: false,
      closingIssuesReferences: { nodes: [{ number: 1 }, { number: 2 }], pageInfo: { hasNextPage: false } } }],
    pageInfo: { hasNextPage: false },
  } } } } }] satisfies [GithubSample],
  compare: [
    { status: 200, body: { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1 } },
    { status: 404, body: { message: 'Not Found' } },
  ] satisfies [GithubSample, GithubSample],
  'check-runs': [{ status: null, body: [{ name: 'mods', status: 'in_progress', conclusion: null as string | null }] }] satisfies [GithubSample],
  statuses: [{ status: null, body: [{ context: 'mods', state: 'pending' }] }] satisfies [GithubSample],
  'branch-rules': [
    { status: 200, body: [{ type: 'pull_request', ruleset_id: 42 }, { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'required' }] } }] },
    { status: 403, body: { message: 'rules unavailable' } },
  ] satisfies [GithubSample, GithubSample],
  ruleset: [{ status: 200, body: { id: 42, current_user_can_bypass: 'never' } }] satisfies [GithubSample],
  branch: [{ status: 200, body: { protected: false, protection: { enabled: false } } }] satisfies [GithubSample],
  'closing-pull-requests': [{ status: null, body: { data: { repository: { nameWithOwner: 'owner/repo', defaultBranchRef: { name: 'main' }, issue: {
    closedByPullRequestsReferences: {
      nodes: [{ number: 5, state: 'OPEN', headRefName: 'feat-1', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } }],
      pageInfo: { hasNextPage: false },
    },
    timelineItems: {
      nodes: [{ source: { __typename: 'PullRequest', number: 5, state: 'OPEN', headRefName: 'feat-1', baseRefName: 'main', body: 'Closes #1', isCrossRepository: false, baseRepository: { nameWithOwner: 'owner/repo' } } }],
      pageInfo: { hasNextPage: false },
    },
  } } } } }] satisfies [GithubSample],
  'pr-fields': [{ status: null, body: { data: { repository: { pullRequest: {
    state: 'OPEN', closedAt: null, autoMergeRequest: null, isInMergeQueue: false, reviews: { totalCount: 0 },
  } } } } }] satisfies [GithubSample],
} satisfies Record<string, GithubSample[]>
